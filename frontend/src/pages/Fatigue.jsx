import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { AIBadge, makeConf } from '../components'
import { alarm, beep, speak } from '../voice'

// Thresholds (tuned for a demo; industry systems use similar PERCLOS logic)
const EYE_CLOSED = 0.5        // eyeBlink blendshape above this = eye closed
const DROWSY_S = 1.5          // eyes closed this long -> drowsy warning
const MICROSLEEP_S = 3        // eyes closed this long -> microsleep alarm
const YAWN_JAW = 0.5          // jawOpen above this...
const YAWN_MIN_S = 1.0        // ...for this long = one yawn
const YAWN_WINDOW_S = 180     // yawns counted over the last 3 minutes
const YAWN_LIMIT = 3
const PERCLOS_WINDOW_S = 60   // % of time eyes closed over the last minute
const PERCLOS_LIMIT = 0.2
const NOFACE_S = 3

const LEVELS = {
  off: { label: 'Monitor off', color: 'var(--muted)', icon: '⏻' },
  alert: { label: 'Alert', color: 'var(--green)', icon: '🙂' },
  noface: { label: 'Face not visible', color: 'var(--amber)', icon: '🫥' },
  tired: { label: 'Signs of fatigue', color: 'var(--amber)', icon: '🥱' },
  drowsy: { label: 'Drowsy: eyes closing', color: 'var(--amber)', icon: '😪' },
  microsleep: { label: 'MICROSLEEP', color: 'var(--red)', icon: '😴' },
}

const EYE_PTS = [33, 160, 158, 133, 153, 144, 362, 385, 387, 263, 373, 380]
const MOUTH_PTS = [61, 291, 13, 14, 78, 308]

export default function FatigueMonitor({ opId, machineId, onFatigue, notify, onLogged }) {
  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const lmRef = useRef(null)
  const streamRef = useRef(null)
  const runningRef = useRef(false)
  const simRef = useRef(null)
  const lastVideoTime = useRef(-1)
  const t = useRef({ closedSince: null, yawnStart: null, yawns: [], frames: [], blinks: [], lastFace: 0, level: 'off', lastAlarm: 0, lastLog: {} })
  const [status, setStatus] = useState('off')
  const [error, setError] = useState('')
  const [m, setM] = useState({ eye: 1, jaw: 0, perclos: 0, yawns: 0, closedFor: 0, blinkRate: 0, face: false, score: 0, presence: 0 })
  const [level, setLevel] = useState('off')
  const [breakUntil, setBreakUntil] = useState(null)
  const [, tick] = useState(0)

  const logOnce = (key, detail, every = 30000) => {
    const now = Date.now()
    if (now - (t.current.lastLog[key] || 0) < every) return
    t.current.lastLog[key] = now
    api.logEvent(opId, 'fatigue', detail, machineId).then(() => onLogged?.()).catch(() => {})
  }

  // One sample = { face: bool, blink: 0..1, jaw: 0..1 } from camera OR simulation.
  const process = useCallback((sample) => {
    const s = t.current
    const now = performance.now() / 1000
    const closed = sample.face && sample.blink > EYE_CLOSED

    s.frames.push({ t: now, closed, face: sample.face })
    while (s.frames.length && now - s.frames[0].t > PERCLOS_WINDOW_S) s.frames.shift()
    const faceFrames = s.frames.filter((f) => f.face)
    const perclos = faceFrames.length ? faceFrames.filter((f) => f.closed).length / faceFrames.length : 0
    const span = s.frames.length ? now - s.frames[0].t : 0
    const presence = s.frames.length ? faceFrames.length / s.frames.length : 0

    if (closed && s.closedSince == null) s.closedSince = now
    if (!closed && s.closedSince != null) {
      if (now - s.closedSince < 0.5) s.blinks.push(now)
      s.closedSince = null
    }
    s.blinks = s.blinks.filter((b) => now - b < 60)
    const closedFor = s.closedSince != null ? now - s.closedSince : 0

    if (sample.face && sample.jaw > YAWN_JAW) s.yawnStart ??= now
    else if (s.yawnStart != null) {
      if (now - s.yawnStart >= YAWN_MIN_S) s.yawns.push(now)
      s.yawnStart = null
    }
    s.yawns = s.yawns.filter((y) => now - y < YAWN_WINDOW_S)
    if (sample.face) s.lastFace = now

    let lvl = 'alert'
    if (closedFor >= MICROSLEEP_S) lvl = 'microsleep'
    else if (closedFor >= DROWSY_S) lvl = 'drowsy'
    else if (s.yawns.length >= YAWN_LIMIT || (perclos > PERCLOS_LIMIT && span > 20)) lvl = 'tired'
    else if (now - s.lastFace > NOFACE_S) lvl = 'noface'

    // Escalation on level change
    if (lvl !== s.level) {
      if (lvl === 'microsleep') {
        alarm()
        speak('Wake up! Microsleep detected. Stop the machine now.', { force: true })
        logOnce('micro', `Microsleep: eyes closed ${closedFor.toFixed(1)} s`, 10000)
      } else if (lvl === 'drowsy') {
        beep({ freq: 800, repeat: 3 })
        speak('Stay alert. Your eyes are closing.', { force: true })
      } else if (lvl === 'tired') {
        beep({ freq: 600, repeat: 2, type: 'sine' })
        const why = s.yawns.length >= YAWN_LIMIT ? `${s.yawns.length} yawns in 3 minutes` : `eyes closed ${Math.round(perclos * 100)}% of the last minute`
        speak('Signs of fatigue detected. Please take a ten minute break.', { force: true })
        logOnce('tired', `Fatigue signs: ${why}`)
      }
      s.level = lvl
    } else if (lvl === 'microsleep' && Date.now() - s.lastAlarm > 1200) {
      s.lastAlarm = Date.now()
      alarm()
    }

    const score = Math.min(100, Math.round(perclos * 220 + s.yawns.length * 15 + closedFor * 22))
    setLevel(lvl)
    setM({ eye: 1 - sample.blink, jaw: sample.jaw, perclos, yawns: s.yawns.length, closedFor, blinkRate: s.blinks.length, face: sample.face, score, presence, span })
    onFatigue({ level: lvl, closedFor, yawns: s.yawns.length, perclos })
  }, [onFatigue, opId, machineId]) // eslint-disable-line react-hooks/exhaustive-deps
  const processRef = useRef(process)
  processRef.current = process

  const reset = () => {
    Object.assign(t.current, { closedSince: null, yawnStart: null, yawns: [], frames: [], blinks: [], lastFace: performance.now() / 1000, level: 'off' })
  }

  const stop = useCallback(() => {
    runningRef.current = false
    clearInterval(simRef.current)
    streamRef.current?.getTracks().forEach((tr) => tr.stop())
    streamRef.current = null
    setStatus('off')
    setLevel('off')
    t.current.level = 'off'
    onFatigue({ level: 'off' })
    const c = canvasRef.current
    c?.getContext('2d').clearRect(0, 0, c.width, c.height)
  }, [onFatigue])
  useEffect(() => () => stop(), [stop])

  const start = async () => {
    stop()
    setError('')
    setStatus('loading')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' }, audio: false })
      streamRef.current = stream
      videoRef.current.srcObject = stream
      await videoRef.current.play()
      if (!lmRef.current) {
        const { FaceLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision')
        const fileset = await FilesetResolver.forVisionTasks('/mediapipe/wasm')
        lmRef.current = await FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: '/models/face_landmarker.task', delegate: 'GPU' },
          outputFaceBlendshapes: true, runningMode: 'VIDEO', numFaces: 1,
        })
      }
      reset()
      setStatus('on')
      runningRef.current = true
      loop()
    } catch (e) {
      setStatus('error')
      setError(e.name === 'NotAllowedError' ? 'Camera permission denied' : e.message || String(e))
    }
  }

  const loop = () => {
    if (!runningRef.current) return
    const v = videoRef.current
    if (v.readyState >= 2 && v.currentTime !== lastVideoTime.current) {
      lastVideoTime.current = v.currentTime
      const res = lmRef.current.detectForVideo(v, performance.now())
      const shapes = res.faceBlendshapes?.[0]?.categories
      const c = canvasRef.current
      c.width = v.videoWidth
      c.height = v.videoHeight
      const ctx = c.getContext('2d')
      ctx.clearRect(0, 0, c.width, c.height)
      if (shapes) {
        const g = (n) => shapes.find((x) => x.categoryName === n)?.score ?? 0
        const lm = res.faceLandmarks[0]
        const closed = (g('eyeBlinkLeft') + g('eyeBlinkRight')) / 2 > EYE_CLOSED
        ctx.fillStyle = closed ? '#ff4d4f' : '#3ecf6e'
        EYE_PTS.forEach((i) => { ctx.beginPath(); ctx.arc(lm[i].x * c.width, lm[i].y * c.height, 3, 0, 7); ctx.fill() })
        ctx.fillStyle = g('jawOpen') > YAWN_JAW ? '#ffa62b' : '#ffcd11'
        MOUTH_PTS.forEach((i) => { ctx.beginPath(); ctx.arc(lm[i].x * c.width, lm[i].y * c.height, 3, 0, 7); ctx.fill() })
        processRef.current({ face: true, blink: (g('eyeBlinkLeft') + g('eyeBlinkRight')) / 2, jaw: g('jawOpen') })
      } else processRef.current({ face: false, blink: 0, jaw: 0 })
    }
    requestAnimationFrame(loop)
  }

  // Demo without falling asleep on stage :)
  const simulate = (kind) => {
    stop()
    reset()
    setStatus('sim')
    const t0 = performance.now()
    simRef.current = setInterval(() => {
      const s = (performance.now() - t0) / 1000
      let blink = 0.05
      let jaw = 0.05
      if (kind === 'micro') {
        if (s > 1 && s < 5) blink = 0.9
        if (s > 7) { clearInterval(simRef.current); setStatus('off'); return }
      } else {
        const phase = s % 2.6
        if (s < 7.8 && phase > 0.4 && phase < 2.0) jaw = 0.8
        if (s > 9) { clearInterval(simRef.current); setStatus('off'); return }
      }
      processRef.current({ face: true, blink, jaw })
    }, 80)
  }

  useEffect(() => {
    if (!breakUntil) return
    const i = setInterval(() => { if (Date.now() >= breakUntil) { setBreakUntil(null); speak('Break over. Welcome back.', { force: true }) } tick((x) => x + 1) }, 1000)
    return () => clearInterval(i)
  }, [breakUntil])

  const startBreak = () => {
    setBreakUntil(Date.now() + 10 * 60 * 1000)
    reset()
    notify('☕ 10-minute break started. Machine parked, bucket lowered.')
    speak('Break started. Lower the bucket and rest for ten minutes.', { force: true })
  }

  const L = LEVELS[level]
  const conf = status === 'on'
    ? makeConf(0.45 + 0.45 * m.presence + (m.span > 20 ? 0.05 : 0), 'MediaPipe Face Landmarker: eyeBlink & jawOpen blendshapes, PERCLOS',
      [`Face tracked in ${Math.round(m.presence * 100)}% of frames (last ${Math.round(m.span || 0)} s)`,
        `Eye-closure threshold ${EYE_CLOSED}, microsleep at ${MICROSLEEP_S} s`, `Yawn = jaw open > ${YAWN_MIN_S} s`],
      ['Sunglasses, low light or a turned head reduce accuracy', 'Screening aid only, not a medical assessment'])
    : status === 'sim' ? makeConf(0.9, 'Simulated signal for demo', ['Synthetic eye/jaw signal'], ['Not a real measurement']) : null
  const bars = [
    { label: 'Eye openness', v: m.eye, color: m.eye < 1 - EYE_CLOSED ? 'var(--red)' : 'var(--green)', text: `${Math.round(m.eye * 100)}%` },
    { label: 'Mouth open', v: m.jaw, color: m.jaw > YAWN_JAW ? 'var(--amber)' : 'var(--steel-light)', text: `${Math.round(m.jaw * 100)}%` },
    { label: 'PERCLOS (1 min)', v: Math.min(1, m.perclos / 0.4), color: m.perclos > PERCLOS_LIMIT ? 'var(--red)' : 'var(--blue)', text: `${Math.round(m.perclos * 100)}%` },
    { label: 'Fatigue score', v: m.score / 100, color: m.score > 60 ? 'var(--red)' : m.score > 30 ? 'var(--amber)' : 'var(--green)', text: m.score },
  ]

  return (
    <div className="card">
      <AIBadge c={conf} />
      <h3>😴 Operator fatigue monitor <span className="chip info">cab camera · on-device</span></h3>
      <p className="card-sub">Tracks eye closure (microsleep), PERCLOS and yawning. No video leaves the machine.</p>
      <div className="split">
        <div>
          <div className={`cam-wrap ${level === 'microsleep' ? 'danger' : ['drowsy', 'tired'].includes(level) ? 'warn' : ''}`}>
            <video ref={videoRef} muted playsInline className="mirror" style={{ display: status === 'on' || status === 'loading' ? 'block' : 'none' }} />
            <canvas ref={canvasRef} className="mirror" />
            {status !== 'on' && status !== 'loading' && (
              <div className="cam-empty">
                {status === 'sim' ? <div style={{ fontSize: 64 }}>{L.icon}</div> : (
                  <div><div style={{ fontSize: 40 }}>🧑‍✈️</div><div>{status === 'error' ? `⚠️ ${error}` : 'Cab camera off'}</div></div>
                )}
              </div>
            )}
            {status === 'loading' && <div className="cam-empty" style={{ background: 'rgba(0,0,0,.5)' }}>Loading face model…</div>}
            {level !== 'off' && (
              <div className="zone-label">
                <span className="chip" style={{ background: '#000c', color: L.color, borderColor: L.color }}>{L.icon} {L.label}
                  {m.closedFor > 0.3 && ` · eyes closed ${m.closedFor.toFixed(1)} s`}</span>
              </div>
            )}
          </div>
          <div className="row wrap" style={{ marginTop: 12 }}>
            {status === 'on' || status === 'loading'
              ? <button className="btn danger" onClick={stop}>■ Stop</button>
              : <button className="btn primary" onClick={start}>▶ Start cab camera</button>}
            <button className="btn" onClick={() => simulate('micro')}>😴 Simulate microsleep</button>
            <button className="btn" onClick={() => simulate('yawn')}>🥱 Simulate yawning</button>
          </div>
        </div>
        <div>
          <div className="fatigue-state" style={{ color: L.color }}>{L.icon} {L.label}</div>
          {bars.map((b) => (
            <div key={b.label} className="meter">
              <span className="muted">{b.label}</span>
              <div className="bar"><div style={{ width: `${Math.max(2, b.v * 100)}%`, background: b.color }} /></div>
              <b className="mono">{b.text}</b>
            </div>
          ))}
          <div className="row wrap small" style={{ marginTop: 12 }}>
            <span className="chip">🥱 {m.yawns} yawns / 3 min</span>
            <span className="chip">👁️ {m.blinkRate} blinks / min</span>
          </div>
          {['tired', 'drowsy', 'microsleep'].includes(level) && !breakUntil && (
            <button className="btn primary" style={{ marginTop: 12, width: '100%' }} onClick={startBreak}>☕ Start 10-min break</button>
          )}
          {breakUntil && (
            <div className="list-item" style={{ marginTop: 12 }}>
              ☕ On break · {Math.max(0, Math.ceil((breakUntil - Date.now()) / 60000))} min left
              <button className="btn sm ghost" style={{ marginLeft: 8 }} onClick={() => setBreakUntil(null)}>End</button>
            </div>
          )}
          <p className="small muted" style={{ marginTop: 12 }}>
            Rules: eyes closed ≥{DROWSY_S}s → warning · ≥{MICROSLEEP_S}s → alarm & log · {YAWN_LIMIT}+ yawns in 3 min or PERCLOS &gt; {PERCLOS_LIMIT * 100}% → break advised.
          </p>
        </div>
      </div>
    </div>
  )
}
