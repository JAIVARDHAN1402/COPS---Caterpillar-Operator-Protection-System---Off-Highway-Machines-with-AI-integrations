import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { AIBadge, makeConf } from '../components'
import { alarm, beep, listenOnce, speak } from '../voice'
import FatigueMonitor from './Fatigue'

const DANGER_M = 3
const WARN_M = 6
const CAM_FOV_DEG = 60

// ------------------------------------------------------------------------
// Proximity: live person detection (COCO-SSD in the browser, no server/GPU),
// distance estimated from the person's height in the frame.
// ------------------------------------------------------------------------
function ProximityCam({ opId, machineId, onProximity, onDanger }) {
  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const modelRef = useRef(null)
  const streamRef = useRef(null)
  const runningRef = useRef(false)
  const levelRef = useRef('clear')
  const lastLogRef = useRef(0)
  const lastAlarmRef = useRef(0)
  const simRef = useRef(null)
  const [status, setStatus] = useState('off') // off | loading | on | sim | error
  const [error, setError] = useState('')
  const [people, setPeople] = useState([])
  const [calib, setCalib] = useState(1.5) // metres of distance when a person fills the frame height
  const calibRef = useRef(calib)
  calibRef.current = calib

  const report = useCallback((persons) => {
    setPeople(persons)
    const nearest = persons.reduce((m, p) => (p.dist < m ? p.dist : m), Infinity)
    const level = nearest < DANGER_M ? 'danger' : nearest < WARN_M ? 'warn' : 'clear'
    const who = persons.find((p) => p.dist === nearest)
    // x = horizontal position in the camera frame (0..1): the digital twin uses it as bearing
    onProximity({ level, distance: Number.isFinite(nearest) ? nearest : null, x: who?.x })
    if (level !== levelRef.current) {
      if (level === 'danger') {
        alarm()
        speak('Stop! Person in the danger zone behind the machine.', { force: true })
        if (Date.now() - lastLogRef.current > 15000) {
          lastLogRef.current = Date.now()
          api.logEvent(opId, 'proximity', `Person detected at ${nearest.toFixed(1)} m`, machineId).catch(() => {})
          onDanger?.(nearest)
        }
      } else if (level === 'warn' && levelRef.current === 'clear') beep({ freq: 900, repeat: 2 })
      levelRef.current = level
    } else if (level === 'danger' && Date.now() - lastAlarmRef.current > 1500) {
      lastAlarmRef.current = Date.now()
      alarm()
    }
  }, [onProximity, onDanger, opId, machineId])

  const stop = useCallback(() => {
    runningRef.current = false
    clearInterval(simRef.current)
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    levelRef.current = 'clear'
    setStatus('off')
    setPeople([])
    onProximity({ level: 'clear' })
    const c = canvasRef.current
    c?.getContext('2d').clearRect(0, 0, c.width, c.height)
  }, [onProximity])

  useEffect(() => () => stop(), [stop])
  useEffect(() => { stop() }, [opId]) // eslint-disable-line react-hooks/exhaustive-deps

  const start = async () => {
    setError('')
    setStatus('loading')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: 'environment' }, audio: false,
      })
      streamRef.current = stream
      const v = videoRef.current
      v.srcObject = stream
      await v.play()
      if (!modelRef.current) {
        const tf = await import('@tensorflow/tfjs')
        await tf.ready()
        const coco = await import('@tensorflow-models/coco-ssd')
        modelRef.current = await coco.load({ base: 'lite_mobilenet_v2' })
      }
      setStatus('on')
      runningRef.current = true
      loop()
    } catch (e) {
      setStatus('error')
      setError(e.name === 'NotAllowedError' ? 'Camera permission denied' : e.message || String(e))
    }
  }

  const loop = async () => {
    if (!runningRef.current) return
    const v = videoRef.current
    const c = canvasRef.current
    if (v.readyState >= 2) {
      const preds = await modelRef.current.detect(v, 10, 0.45)
      const W = v.videoWidth
      const H = v.videoHeight
      c.width = W
      c.height = H
      const ctx = c.getContext('2d')
      ctx.clearRect(0, 0, W, H)
      const persons = preds.filter((p) => p.class === 'person').map((p) => {
        const [x, y, w, h] = p.bbox
        const dist = Math.max(0.5, Math.min(20, calibRef.current / (h / H)))
        const color = dist < DANGER_M ? '#ff4d4f' : dist < WARN_M ? '#ffa62b' : '#3ecf6e'
        ctx.strokeStyle = color
        ctx.lineWidth = 4
        ctx.strokeRect(x, y, w, h)
        ctx.fillStyle = color
        ctx.fillRect(x, y - 30, 150, 30)
        ctx.fillStyle = '#000'
        ctx.font = 'bold 18px Inter, sans-serif'
        ctx.fillText(`PERSON ${dist.toFixed(1)} m`, x + 8, y - 9)
        return { dist, x: (x + w / 2) / W, score: p.score }
      })
      report(persons)
    }
    setTimeout(() => requestAnimationFrame(loop), 120)
  }

  // Fallback for demos without a camera: a worker walks toward the machine and away.
  const simulate = () => {
    stop()
    setStatus('sim')
    let t = 0
    simRef.current = setInterval(() => {
      t += 0.1
      const dist = t < 4 ? 11 - t * 2.4 : t < 7 ? 1.6 + Math.sin(t * 3) * 0.2 : 1.6 + (t - 7) * 3
      if (t > 10) { clearInterval(simRef.current); report([]); setStatus('off'); return }
      report([{ dist, x: 0.35 + t * 0.02, score: 0.9 }])
    }, 100)
  }

  const nearest = people.reduce((m, p) => (p.dist < m ? p.dist : m), Infinity)
  const level = nearest < DANGER_M ? 'danger' : nearest < WARN_M ? 'warn' : 'clear'
  const avgScore = people.length ? people.reduce((a, p) => a + p.score, 0) / people.length : null
  const conf = status === 'on'
    ? makeConf(avgScore != null ? avgScore * 0.85 : 0.72, 'COCO-SSD person detector (MobileNet v2) + size-based distance',
      [avgScore != null ? `Detector certainty ${Math.round(avgScore * 100)}% on ${people.length} person(s)` : 'No person in view (zone clear)',
        `Distance from body height in frame, calibration ${calib.toFixed(1)} m`, 'Danger < 3 m, warning < 6 m'],
      ['Distance estimate is roughly ±30%; calibrate per camera mount', 'Partly hidden or crouching people are harder to detect', 'Single camera: covers the rear zone only'])
    : status === 'sim' ? makeConf(0.9, 'Simulated worker for demo', ['Synthetic distance track'], ['Not a real detection']) : null

  return (
    <div className="card">
      <AIBadge c={conf} />
      <h3>📷 Rear proximity detection <span className="chip info">AI · on-device</span></h3>
      <p className="card-sub">Rear/blind-spot camera + person detection running in the browser. Distance estimated from body size in frame. Red zone {'<'} {DANGER_M} m, amber {'<'} {WARN_M} m.</p>
      <div className="split">
        <div>
          <div className={`cam-wrap ${status !== 'off' ? level : ''}`}>
            <video ref={videoRef} muted playsInline style={{ display: status === 'on' || status === 'loading' ? 'block' : 'none' }} />
            <canvas ref={canvasRef} />
            {status !== 'on' && status !== 'loading' && (
              <div className="cam-empty">
                {status === 'sim' ? <div style={{ fontSize: 60 }}>🚶</div> : (
                  <div>
                    <div style={{ fontSize: 40 }}>📷</div>
                    <div>{status === 'error' ? `⚠️ ${error}` : 'Camera off'}</div>
                  </div>
                )}
              </div>
            )}
            {status === 'loading' && <div className="cam-empty" style={{ background: 'rgba(0,0,0,.5)' }}>Loading AI model…</div>}
            {(status === 'on' || status === 'sim') && (
              <div className="zone-label">
                <span className={`chip ${level === 'danger' ? 'bad' : level === 'warn' ? 'warn' : 'good'}`} style={{ background: '#000c' }}>
                  {level === 'danger' ? '🛑 DANGER ZONE' : level === 'warn' ? '⚠️ WARNING ZONE' : '✓ ZONE CLEAR'}
                  {Number.isFinite(nearest) && ` · ${nearest.toFixed(1)} m`}
                </span>
              </div>
            )}
          </div>
          <div className="row wrap" style={{ marginTop: 12 }}>
            {status === 'on' || status === 'loading' ? (
              <button className="btn danger" onClick={stop}>■ Stop camera</button>
            ) : (
              <button className="btn primary" onClick={start}>▶ Start camera</button>
            )}
            <button className="btn" onClick={simulate}>🚶 Simulate worker approaching</button>
          </div>
          <label className="field" style={{ marginTop: 12 }}>
            Calibration: {calib.toFixed(1)} m when a person fills the frame height
            <input type="range" min="0.5" max="4" step="0.1" value={calib} onChange={(e) => setCalib(Number(e.target.value))} />
          </label>
        </div>
        <Radar people={people} />
      </div>
    </div>
  )
}

/** Top-down view: machine at bottom, rear camera looking up. */
function Radar({ people }) {
  const S = 260
  const cx = S / 2
  const cy = S - 20
  const maxM = 10
  const scale = (S - 40) / maxM
  const arc = (m) => {
    const r = m * scale
    const a = (CAM_FOV_DEG / 2 + 25) * (Math.PI / 180)
    return `M ${cx - r * Math.sin(a)} ${cy - r * Math.cos(a)} A ${r} ${r} 0 0 1 ${cx + r * Math.sin(a)} ${cy - r * Math.cos(a)}`
  }
  return (
    <div>
      <svg className="radar" viewBox={`0 0 ${S} ${S}`} width="100%">
        <path d={`${arc(maxM)} L ${cx} ${cy} Z`} fill="color-mix(in srgb, var(--green) 10%, transparent)" />
        <path d={`${arc(WARN_M)} L ${cx} ${cy} Z`} fill="color-mix(in srgb, var(--amber) 20%, transparent)" />
        <path d={`${arc(DANGER_M)} L ${cx} ${cy} Z`} fill="color-mix(in srgb, var(--red) 30%, transparent)" />
        {[DANGER_M, WARN_M, maxM].map((m) => (
          <text key={m} x={cx + 4} y={cy - m * scale + 12} fill="var(--muted)" fontSize="10">{m} m</text>
        ))}
        <rect x={cx - 16} y={cy - 6} width={32} height={22} rx={4} fill="var(--yellow)" />
        <text x={cx} y={cy + 9} textAnchor="middle" fontSize="9" fontWeight="800" fill="#000">MACHINE</text>
        {people.map((p, i) => {
          const ang = ((p.x - 0.5) * CAM_FOV_DEG * Math.PI) / 180
          const r = Math.min(p.dist, maxM) * scale
          const color = p.dist < DANGER_M ? 'var(--red)' : p.dist < WARN_M ? 'var(--amber)' : 'var(--green)'
          return (
            <g key={i}>
              <circle cx={cx + r * Math.sin(ang)} cy={cy - r * Math.cos(ang)} r={9} fill={color} stroke="#fff" strokeWidth="2" />
              <text x={cx + r * Math.sin(ang)} y={cy - r * Math.cos(ang) - 14} textAnchor="middle" fontSize="11" fontWeight="700" fill="var(--text)">{p.dist.toFixed(1)}m</text>
            </g>
          )
        })}
      </svg>
      <div className="small muted" style={{ textAlign: 'center' }}>Top-down swing-zone radar</div>
    </div>
  )
}

// ------------------------------------------------------------------------
// Voice-to-report incident logging
// ------------------------------------------------------------------------
const SAMPLES = [
  'A rock hit the windshield near trench 3, nobody was hurt',
  'Worker almost got hit behind the machine at the east gate',
  'Hydraulic oil leak from the boom at stockpile 2',
  'Bucket touched a cable while digging near the utility line',
]
const TYPES = ['Near Miss', 'Collision', 'Injury', 'Equipment Damage', 'Utility Strike', 'Spill / Leak', 'Rollover / Tip', 'Ground Collapse', 'Other']
const SEVERITIES = ['Low', 'Medium', 'High', 'Critical']

function IncidentLogger({ opId, machineId, draftFromVoice, notify, onSaved }) {
  const [text, setText] = useState('')
  const [draft, setDraft] = useState(null)
  const [listening, setListening] = useState(false)
  const [source, setSource] = useState('manual')

  const parse = async (t, src = source) => {
    if (!t.trim()) return
    setSource(src)
    setDraft(await api.parseIncident(t))
  }
  useEffect(() => {
    if (draftFromVoice?.text) { setText(draftFromVoice.text); parse(draftFromVoice.text, draftFromVoice.source || 'voice') }
  }, [draftFromVoice]) // eslint-disable-line react-hooks/exhaustive-deps

  const mic = () => {
    setListening(true)
    let finalText = ''
    listenOnce({
      onResult: (t, isFinal) => { setText(t); if (isFinal) finalText = t },
      onEnd: () => { setListening(false); if (finalText) parse(finalText, 'voice') },
      onError: (e) => { setListening(false); notify(`🎙️ ${e}`) },
    })
  }

  const submit = async () => {
    const { confidence: _c, types: _t, body_parts: _b, recommended_action: _r, notify_supervisor: _n, ...fields } = draft
    const inc = await api.createIncident({ operator_id: opId, machine_id: machineId, ...fields, source })
    notify(`📝 ${inc.id} logged (${inc.severity})${draft.notify_supervisor ? ' — supervisor notified' : ''}. Telemetry black-box attached.`)
    speak('Incident report submitted.', { force: true })
    setDraft(null)
    setText('')
    onSaved()
  }

  const sevClass = { Low: 'good', Medium: 'warn', High: 'bad', Critical: 'bad' }

  return (
    <div className="card">
      <h3>🎙️ Incident & near-miss report <span className="chip info">speak → structured report</span></h3>
      <p className="card-sub">Just say what happened. COPS classifies type & severity, extracts the location, suggests an action and attaches the machine's telemetry black-box.</p>
      <div className="row" style={{ alignItems: 'stretch' }}>
        <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. A rock hit the windshield near trench 3, nobody was hurt" />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button className={`btn round ${listening ? 'danger mic live' : 'primary'}`} onClick={mic} aria-label="Speak">🎙️</button>
          <button className="btn round" onClick={() => parse(text, 'manual')} aria-label="Analyse" title="Analyse text">⚡</button>
        </div>
      </div>
      <div className="row wrap" style={{ marginTop: 8, gap: 6 }}>
        {SAMPLES.map((s) => (
          <button key={s} className="btn sm ghost" onClick={() => { setText(s); parse(s, 'manual') }}>“{s.slice(0, 34)}…”</button>
        ))}
      </div>
      {draft && (
        <div className="list-item" style={{ marginTop: 14, borderColor: 'var(--yellow)' }}>
          <div className="row wrap" style={{ marginBottom: 10 }}>
            <b>Auto-filled report</b>
            <AIBadge c={draft.confidence} inline />
            <span className={`chip ${sevClass[draft.severity]}`}>{draft.severity}</span>
            {draft.persons_involved && <span className="chip warn">👷 Person involved</span>}
            {draft.body_parts.length > 0 && <span className="chip bad">Body: {draft.body_parts.join(', ')}</span>}
          </div>
          <div className="grid g3">
            <label className="field">Type
              <select value={draft.primary_type} onChange={(e) => setDraft({ ...draft, primary_type: e.target.value })}>
                {TYPES.map((t) => <option key={t}>{t}</option>)}
              </select>
            </label>
            <label className="field">Severity
              <select value={draft.severity} onChange={(e) => setDraft({ ...draft, severity: e.target.value })}>
                {SEVERITIES.map((t) => <option key={t}>{t}</option>)}
              </select>
            </label>
            <label className="field">Location
              <input type="text" value={draft.location} onChange={(e) => setDraft({ ...draft, location: e.target.value })} />
            </label>
          </div>
          <div className="advice" style={{ marginTop: 10 }}><span className="ic">🧭</span><span><b>Immediate action:</b> {draft.recommended_action}</span></div>
          <div className="row" style={{ marginTop: 10, justifyContent: 'flex-end' }}>
            <button className="btn ghost" onClick={() => setDraft(null)}>Discard</button>
            <button className="btn primary" onClick={submit}>Submit report{draft.notify_supervisor ? ' & notify supervisor' : ''}</button>
          </div>
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------------
export default function Safety({ opId, machineId, onFatigue, seatbelt, beltLevel, ladder, machineWorking, onProximity, incidentDraft, notify, refreshProfile, visible }) {
  const [events, setEvents] = useState([])
  const [incidents, setIncidents] = useState([])
  const [autoDraft, setAutoDraft] = useState(null)
  const [openInc, setOpenInc] = useState(null)
  const [lastDanger, setLastDanger] = useState(null)

  const load = useCallback(() => {
    api.events(opId).then(setEvents).catch(() => {})
    api.incidents(opId).then(setIncidents).catch(() => {})
  }, [opId])
  useEffect(() => { if (visible) load() }, [visible, load])
  useEffect(() => { if (incidentDraft) setAutoDraft(incidentDraft) }, [incidentDraft])

  const onDanger = useCallback((d) => {
    setTimeout(() => { load(); refreshProfile() }, 500)
    setLastDanger(d)
  }, [load, refreshProfile])

  return (
    <div className="grid" style={{ gap: 16 }}>
      <FatigueMonitor opId={opId} machineId={machineId} onFatigue={onFatigue} notify={notify} onLogged={() => { load(); refreshProfile() }} />
      <ProximityCam opId={opId} machineId={machineId} onProximity={onProximity} onDanger={onDanger} />
      {lastDanger && (
        <div className="card row wrap" style={{ borderColor: 'var(--amber)' }}>
          <span>⚠️ A person entered the danger zone ({lastDanger.toFixed(1)} m). Near-misses are the best predictor of future accidents.</span>
          <div className="spacer" />
          <button className="btn primary sm" onClick={() => { setAutoDraft({ text: `Near miss: worker came within ${lastDanger.toFixed(1)} m behind the machine in the swing zone`, source: 'auto-proximity', id: Date.now() }); setLastDanger(null) }}>
            📝 Log as near-miss
          </button>
          <button className="btn ghost sm" onClick={() => setLastDanger(null)}>Dismiss</button>
        </div>
      )}

      <div className="grid g2" style={{ alignItems: 'start' }}>
        <div className="card">
          <h3>🪢 Seatbelt compliance <span className={`chip ${seatbelt === 'Fastened' ? 'good' : 'bad'}`}>{seatbelt}</span></h3>
          <p className="card-sub">
            <b>Engine interlock:</b> the engine (and any task) cannot start unless the belt is fastened. If the belt is released while the engine runs, a siren sounds immediately and escalates:
          </p>
          <div className="ladder">
            {ladder.map((s) => (
              <div key={s.level} className={`step ${beltLevel >= s.level ? 'on' : ''}`}>
                <b>{s.level}. {s.label}</b>
                <span className="muted">{s.at === 0 ? 'Immediately' : `After ${s.at}s`}</span>
              </div>
            ))}
          </div>
          <p className="small muted" style={{ marginTop: 12 }}>
            {machineWorking ? '● Engine running: belt is being monitored.' : '○ Engine off. Press E or 🔑 in the header to start it.'} Press <b>B</b> (or the belt button) to simulate the sensor.
          </p>
        </div>

        <div className="card">
          <h3>📡 Live safety events</h3>
          {events.length === 0 && <div className="muted small">No events yet this session.</div>}
          <div style={{ maxHeight: 260, overflow: 'auto' }}>
            {events.map((e, i) => (
              <div key={i} className="list-item row small">
                <span>{e.type === 'proximity' ? '👷' : e.type === 'seatbelt' ? '🪢' : '😴'}</span>
                <span><b style={{ textTransform: 'capitalize' }}>{e.type}</b> — {e.detail}</span>
                <div className="spacer" />
                <span className="muted mono">{e.time.slice(11, 19)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <IncidentLogger opId={opId} machineId={machineId} draftFromVoice={autoDraft} notify={notify} onSaved={() => { load(); refreshProfile() }} />

      <div className="card">
        <h3>🗂️ Incident log</h3>
        {incidents.length === 0 && <div className="muted small">No incidents reported. Reporting near-misses earns safety-culture points.</div>}
        {incidents.map((i) => (
          <div key={i.id} className="list-item">
            <div className="row wrap">
              <b className="mono">{i.id}</b>
              <span className={`chip ${i.severity === 'Low' ? 'good' : i.severity === 'Medium' ? 'warn' : 'bad'}`}>{i.severity}</span>
              <span className="chip">{i.primary_type}</span>
              <span className="chip">📍 {i.location}</span>
              {i.source !== 'manual' && <span className="chip info">{i.source}</span>}
              <div className="spacer" />
              <span className="small muted">{i.time.replace('T', ' ')}</span>
            </div>
            <div className="small" style={{ marginTop: 6 }}>{i.description}</div>
            <button className="btn sm ghost" style={{ marginTop: 6 }} onClick={() => setOpenInc(openInc === i.id ? null : i.id)}>
              🧾 Black-box telemetry ({i.telemetry_snapshot.length} records)
            </button>
            {openInc === i.id && (
              <div className="small mono" style={{ marginTop: 6, overflowX: 'auto' }}>
                {i.telemetry_snapshot.map((t, k) => (
                  <div key={k}>{t.timestamp} · {t.machine_id} · fuel {t.fuel_used_l}L · cycles {t.load_cycles} · idle {t.idling_min}m · belt {t.seatbelt}</div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
