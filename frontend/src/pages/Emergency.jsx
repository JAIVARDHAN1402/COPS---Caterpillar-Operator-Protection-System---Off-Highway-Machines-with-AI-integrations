import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { chime, listenOnce, siren, speak } from '../voice'

// Man-down & rollover detection + SOS.
const TILT_LIMIT_DEG = 30          // machine tilt that counts as a (near) rollover
const TILT_HOLD_MS = 1000          // must stay over the limit this long
const IMPACT_MS2 = 29              // ~3 g total acceleration = impact
const ARE_YOU_OK_S = 15            // answer window before auto-SOS
const CHECKIN_ANSWER_S = 20        // Active mode check-in answer window
export const CHECKIN_EVERY_S = 60  // demo interval (a real site would use ~30 min)
const SITE_FALLBACK = { lat: 12.9692, lon: 79.1559, label: 'Site 12 · Block A (site default: GPS unavailable)' }

export const SELF_HANDLE_S = 60    // manageable SOS: operator gets this long (demo) before auto-escalation

// SOS categories: high-risk goes straight to the supervisor (WhatsApp + SMS);
// manageable is handled by the operator with guided steps and escalates only if unresolved.
export const HIGH_RISK = [
  ['🩸', 'Injury / medical'], ['🚜', 'Rollover / machine unstable'], ['🔥', 'Fire / smoke'],
  ['👷', 'Person hit or trapped'], ['⚡', 'Utility strike (gas / power)'], ['⚠️', 'Other serious danger'],
]
export const MANAGEABLE = {
  'Machine breakdown': ['Lower the bucket to the ground and park safely', 'Switch off and check for visible leaks or damage', 'Try one restart; if it fails, escalate'],
  'Stuck in mud / soft ground': ['Stop spinning the tracks', 'Use the bucket to push yourself out slowly', 'If still stuck, escalate for a tow'],
  'Warning light / minor fault': ['Check Machine Health for the exact reading', 'Reduce load and let the machine idle 3 min', 'If the light stays on, escalate'],
  'Fuel / fluid top-up needed': ['Park on level ground and stop the engine', 'Top up from the service truck', 'Confirm levels in Machine Health'],
  'Blocked path / material': ['Stop and sound the horn', 'Clear the path only if it is safe', 'If blocked by people or vehicles, escalate'],
}

const OK_WORDS = /\b(ok|okay|fine|i am|i'm|theek|thik|ठीक|हाँ|haan)\b/i
const HELP_WORDS = /(help|sos|emergency|madad|bachao|मदद|बचाओ)/i

function getLocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(SITE_FALLBACK)
    const timer = setTimeout(() => resolve(SITE_FALLBACK), 3500)
    navigator.geolocation.getCurrentPosition(
      (p) => { clearTimeout(timer); resolve({ lat: +p.coords.latitude.toFixed(5), lon: +p.coords.longitude.toFixed(5), label: `GPS ±${Math.round(p.coords.accuracy)} m` }) },
      () => { clearTimeout(timer); resolve(SITE_FALLBACK) },
      { enableHighAccuracy: true, timeout: 3000, maximumAge: 60000 },
    )
  })
}

export function useEmergency({ opId, machineId, notify, onSos }) {
  const [prompt, setPrompt] = useState(null)       // { kind: 'areyouok'|'checkin', reason, type, deadline }
  const [remaining, setRemaining] = useState(0)
  const [sos, setSos] = useState(null)
  const [sensor, setSensor] = useState({ enabled: false, supported: null, angle: 0 })
  const [simAngle, setSimAngle] = useState(0)
  const [activeMode, setActiveModeRaw] = useState(false) // opt-in; the panel suggests it on night shifts
  const setActiveMode = (on) => { setActiveModeRaw(on); if (on) setNextCheckin(Date.now() + CHECKIN_EVERY_S * 1000) }
  const [nextCheckin, setNextCheckin] = useState(() => Date.now() + CHECKIN_EVERY_S * 1000)
  const baseline = useRef(null)
  const overSince = useRef(null)
  const promptRef = useRef(null)
  const sosRef = useRef(null)
  promptRef.current = prompt
  sosRef.current = sos
  const onSosRef = useRef(onSos) // latest callback without re-creating triggerSOS every render
  onSosRef.current = onSos
  const angle = Math.max(sensor.angle, simAngle)

  const [picker, setPicker] = useState(false)
  const triggerSOS = useCallback(async (type, detail = '', { risk = 'high', category = '' } = {}) => {
    if (sosRef.current) return sosRef.current
    setPrompt(null)
    setPicker(false)
    if (risk === 'high') {
      siren()
      speak('High risk SOS sent. Your supervisor has been alerted on WhatsApp with your location. Help is on the way.', { force: true })
    } else {
      chime()
      speak(`${category}. Follow the steps on screen. If it is not solved in ${SELF_HANDLE_S} seconds, your supervisor will be alerted.`, { force: true })
    }
    const loc = await getLocation()
    try {
      const rec = await api.raiseSos({ operator_id: opId, machine_id: machineId, type, detail, risk, category,
        lat: loc.lat, lon: loc.lon, location_label: loc.label })
      setSos(rec)
      if (risk === 'high') onSosRef.current?.(type, detail)
      return rec
    } catch (e) {
      notify?.(`⚠️ SOS could not reach the server: ${e.message}. Use the radio!`, 10000)
      return null
    }
  }, [opId, machineId, notify])

  const openPrompt = useCallback((kind, reason, type) => {
    if (promptRef.current || sosRef.current) return
    const secs = kind === 'checkin' ? CHECKIN_ANSWER_S : ARE_YOU_OK_S
    setPrompt({ kind, reason, type, deadline: Date.now() + secs * 1000 })
    if (kind === 'areyouok') {
      siren()
      speak(`${reason}. Are you OK? Tap I am OK, or say "I am OK". Say "help" if you need help.`, { force: true })
    } else {
      chime()
      speak('Active mode check-in. Tap to confirm you are OK.', { force: true })
    }
  }, [])

  const respondOk = useCallback(() => {
    const p = promptRef.current
    setPrompt(null)
    setSimAngle(0)
    overSince.current = null
    setNextCheckin(Date.now() + CHECKIN_EVERY_S * 1000)
    chime()
    speak('Glad you are OK.', { force: true })
    if (p?.kind === 'areyouok') api.logEvent(opId, 'man_down', `Operator confirmed OK after: ${p.reason}`, machineId).catch(() => {})
  }, [opId, machineId])

  const sendHelp = useCallback(() => {
    const p = promptRef.current
    triggerSOS(p?.type || 'manual', p?.reason || 'Operator requested help')
  }, [triggerSOS])

  // countdown, siren repeat and escalation
  useEffect(() => {
    if (!prompt) return
    const i = setInterval(() => {
      const left = Math.max(0, Math.ceil((prompt.deadline - Date.now()) / 1000))
      setRemaining(left)
      if (left === 0) {
        clearInterval(i)
        if (prompt.kind === 'checkin') {
          setPrompt(null)
          setTimeout(() => openPrompt('areyouok', 'Missed Active mode check-in', 'missed_checkin'), 50)
        } else {
          triggerSOS(prompt.type, `${prompt.reason}: no response in ${ARE_YOU_OK_S} s`)
        }
      }
    }, 250)
    const s = prompt.kind === 'areyouok' ? setInterval(siren, 2500) : null
    return () => { clearInterval(i); clearInterval(s) }
  }, [prompt, openPrompt, triggerSOS])

  // voice answer while "Are you OK?" is open
  useEffect(() => {
    if (prompt?.kind !== 'areyouok') return
    let alive = true
    let rec
    const t = setTimeout(() => {
      rec = listenOnce({
        onResult: (text, isFinal) => {
          if (!isFinal || !alive) return
          if (HELP_WORDS.test(text)) sendHelp()
          else if (OK_WORDS.test(text)) respondOk()
        },
        onError: () => {},
      })
    }, 3500) // after the spoken question
    return () => { alive = false; clearTimeout(t); try { rec?.stop() } catch { /* ignore */ } }
  }, [prompt, sendHelp, respondOk])

  // tilt detection (sensor or simulation)
  useEffect(() => {
    if (angle > TILT_LIMIT_DEG) {
      overSince.current ??= Date.now()
      const i = setTimeout(() => {
        if (overSince.current && Date.now() - overSince.current >= TILT_HOLD_MS) {
          openPrompt('areyouok', `Rollover risk: machine tilted ${Math.round(angle)}°`, 'rollover')
        }
      }, TILT_HOLD_MS)
      return () => clearTimeout(i)
    }
    overSince.current = null
  }, [angle, openPrompt])

  // Active mode check-ins
  useEffect(() => {
    if (!activeMode) return
    const i = setInterval(() => {
      if (Date.now() >= nextCheckin && !promptRef.current && !sosRef.current) openPrompt('checkin', 'Active mode check-in', 'missed_checkin')
    }, 1000)
    return () => clearInterval(i)
  }, [activeMode, nextCheckin, openPrompt])

  const [selfLeft, setSelfLeft] = useState(0)
  const escalate = useCallback(async (reason) => {
    const cur = sosRef.current
    if (!cur || cur.status !== 'self_handling') return
    const r = await api.escalateSos(cur.id, reason).catch(() => null)
    if (r) {
      setSos(r)
      siren()
      speak('Escalated. Your supervisor has been alerted on WhatsApp.', { force: true })
      onSosRef.current?.(r.type, r.detail)
    }
  }, [])
  useEffect(() => {
    if (sos?.status !== 'self_handling') return
    const deadline = new Date(sos.time).getTime() + SELF_HANDLE_S * 1000
    const i = setInterval(() => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
      setSelfLeft(left)
      if (left === 0) { clearInterval(i); escalate(`Not resolved by the operator within ${SELF_HANDLE_S} s`) }
    }, 500)
    return () => clearInterval(i)
  }, [sos?.id, sos?.status, sos?.time, escalate])

  // follow the SOS status (supervisor acknowledgement)
  useEffect(() => {
    if (!sos || sos.status === 'resolved') return
    const i = setInterval(() => api.sos(sos.id).then((r) => {
      if (r.status === 'acknowledged' && sosRef.current?.status !== 'acknowledged') {
        chime()
        speak(`Your SOS was acknowledged by ${r.acknowledged_by}. Help is coming.`, { force: true })
      }
      setSos(r.status === 'resolved' ? null : r)
    }).catch(() => {}), 3000)
    return () => clearInterval(i)
  }, [sos])

  const enableSensors = async () => {
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        const r = await DeviceOrientationEvent.requestPermission()
        if (r !== 'granted') throw new Error('Motion permission denied')
      }
    } catch (e) {
      notify?.(`📱 ${e.message}`)
      return
    }
    baseline.current = null
    setSensor((s) => ({ ...s, enabled: true, supported: null }))
    const onOrient = (e) => {
      if (e.beta == null || e.gamma == null) { setSensor((s) => ({ ...s, supported: false })); return }
      baseline.current ??= { b: e.beta, g: e.gamma }
      const a = Math.max(Math.abs(e.beta - baseline.current.b), Math.abs(e.gamma - baseline.current.g))
      setSensor({ enabled: true, supported: true, angle: Math.round(a) })
    }
    const onMotion = (e) => {
      const g = e.accelerationIncludingGravity
      if (!g || g.x == null) return
      if (Math.hypot(g.x, g.y, g.z) > IMPACT_MS2) openPrompt('areyouok', 'Heavy impact detected', 'impact')
    }
    window.addEventListener('deviceorientation', onOrient)
    window.addEventListener('devicemotion', onMotion)
    setTimeout(() => setSensor((s) => (s.supported === null ? { ...s, supported: false } : s)), 2500)
  }

  const simulateRollover = () => {
    let a = 0
    const i = setInterval(() => { a += 3; setSimAngle(a); if (a >= 42) clearInterval(i) }, 60)
  }
  const simulateImpact = () => openPrompt('areyouok', 'Heavy impact detected', 'impact')

  return {
    prompt, remaining, sos, angle, sensor, simAngle, setSimAngle, activeMode, setActiveMode, nextCheckin,
    triggerSOS, respondOk, sendHelp, enableSensors, simulateRollover, simulateImpact,
    picker, openPicker: () => { if (!sosRef.current) setPicker(true) }, closePicker: () => setPicker(false),
    selfLeft, escalate, resolveSelf: async () => {
      const cur = sosRef.current
      if (!cur) return
      await api.resolveSos(cur.id, 'Resolved by operator').catch(() => {})
      setSos(null)
      chime()
      speak('Marked as resolved. Well handled.', { force: true })
    },
    checkinNow: () => openPrompt('checkin', 'Active mode check-in', 'missed_checkin'),
    cancelSos: async () => {
      if (!sos) return
      await api.resolveSos(sos.id, 'Cancelled by operator (false alarm)').catch(() => {})
      setSos(null)
      speak('SOS cancelled.', { force: true })
    },
  }
}

export function AreYouOkModal({ em }) {
  const p = em.prompt
  if (!p) return null
  const check = p.kind === 'checkin'
  return (
    <div className={`overlay emergency ${check ? 'checkin' : ''}`}>
      <div className="card dialog emergency-card">
        <div style={{ fontSize: 52 }}>{check ? '👷' : '⚠️'}</div>
        <div className="emergency-title">{check ? 'Active mode check-in' : 'ARE YOU OK?'}</div>
        <div style={{ fontSize: 17, marginTop: 6 }}>{p.reason}</div>
        <div className="countdown mono">{em.remaining}</div>
        <div className="small">{check
          ? 'Tap to confirm you are OK. If you don\'t, COPS will ask again and then alert your supervisor.'
          : 'No answer = automatic SOS with your location to the supervisor and nearby crew.'}</div>
        <div className="row" style={{ justifyContent: 'center', marginTop: 18, gap: 12 }}>
          <button className="btn good big" onClick={em.respondOk}>✅ I'm OK</button>
          {!check && <button className="btn danger big" onClick={em.sendHelp}>🆘 Send help now</button>}
        </div>
        {!check && <div className="small muted" style={{ marginTop: 10 }}>🎙️ You can also say “I'm OK” or “Help”.</div>}
      </div>
    </div>
  )
}

export function SosPicker({ em }) {
  if (!em.picker) return null
  return (
    <div className="overlay" onClick={em.closePicker}>
      <div className="card dialog sos-picker" onClick={(e) => e.stopPropagation()}>
        <div className="row"><h3 style={{ margin: 0 }}>🆘 What's happening?</h3><div className="spacer" /><button className="btn sm ghost" onClick={em.closePicker}>✕</button></div>
        <div className="picker-section high">
          <div className="picker-head">🚨 HIGH RISK: alert the supervisor NOW <span className="small">(WhatsApp + SMS + emergency stop)</span></div>
          <div className="picker-grid">
            {HIGH_RISK.map(([ic, label]) => (
              <button key={label} className="btn danger" onClick={() => em.triggerSOS('manual', label, { risk: 'high', category: label })}>{ic} {label}</button>
            ))}
          </div>
        </div>
        <div className="picker-section manage">
          <div className="picker-head">🛠️ MANAGEABLE: I can handle it with guidance <span className="small">(escalates after {SELF_HANDLE_S} s if not solved)</span></div>
          <div className="picker-grid">
            {Object.keys(MANAGEABLE).map((label) => (
              <button key={label} className="btn" onClick={() => em.triggerSOS('manual', label, { risk: 'manageable', category: label })}>{label}</button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

export function SosBanner({ em }) {
  const s = em.sos
  if (!s) return null
  if (s.status === 'self_handling') {
    const steps = MANAGEABLE[s.category] || []
    return (
      <div className="alert-banner warn self-handle">
        <div style={{ flex: 1 }}>
          🛠️ <b>{s.category}</b>: handle it yourself · supervisor alerted on WhatsApp in <b className="mono">{em.selfLeft}s</b> if not resolved
          <div className="small" style={{ fontWeight: 600, marginTop: 4 }}>{steps.map((x, i) => `${i + 1}. ${x}`).join('   ')}</div>
        </div>
        <button className="btn sm good" onClick={em.resolveSelf}>✅ Resolved</button>
        <button className="btn sm danger" onClick={() => em.escalate('Operator asked for help')}>⬆️ Escalate now</button>
      </div>
    )
  }
  return (
    <div className="alert-banner sos-banner">
      🆘 {s.escalated ? 'ESCALATED SOS' : 'HIGH-RISK SOS'} SENT ({s.category || s.type.replace('_', ' ')}) · 🟢 WhatsApp + SMS · 📍 {s.location_label || `${s.lat}, ${s.lon}`} ·{' '}
      {s.status === 'acknowledged' ? `✅ Acknowledged by ${s.acknowledged_by}: help is coming` : '⏳ Waiting for supervisor…'}
      <div className="spacer" />
      <button className="btn sm" style={{ background: '#fff', color: '#000' }} onClick={em.cancelSos}>Cancel (false alarm)</button>
    </div>
  )
}

export function EmergencyPanel({ em }) {
  const pct = Math.min(100, (em.angle / 60) * 100)
  const tiltColor = em.angle > TILT_LIMIT_DEG ? 'var(--red)' : em.angle > 20 ? 'var(--amber)' : 'var(--green)'
  const nextIn = Math.max(0, Math.round((em.nextCheckin - Date.now()) / 1000))
  const [, tick] = useState(0)
  useEffect(() => { const i = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(i) }, [])

  return (
    <div className="card" style={{ borderColor: 'var(--red)' }}>
      <h3>🆘 Man-down, rollover & SOS</h3>
      <p className="card-sub">From preventing accidents to responding to them: rollover and impact detection, an “Are you OK?” check, and an automatic SOS with location.</p>
      <div className="split">
        <div>
          <div className="small muted">Machine tilt (tablet/phone motion sensor)</div>
          <div className="row" style={{ alignItems: 'baseline', gap: 8 }}>
            <span className="mono" style={{ fontSize: 34, fontWeight: 800, color: tiltColor }}>{Math.round(em.angle)}°</span>
            <span className="small muted">rollover limit {TILT_LIMIT_DEG}°</span>
          </div>
          <div className="gauge-bar"><div className="fill" style={{ width: `${pct}%`, background: tiltColor }} /><div className="mark crit" style={{ left: `${(TILT_LIMIT_DEG / 60) * 100}%` }} /></div>
          <div className="row wrap" style={{ gap: 8, marginTop: 12 }}>
            <button className="btn sm" onClick={em.enableSensors} disabled={em.sensor.enabled && em.sensor.supported !== false}>
              📱 {em.sensor.enabled ? (em.sensor.supported === false ? 'No motion sensor on this device' : em.sensor.supported ? 'Sensor active' : 'Starting…') : 'Enable tilt sensor'}
            </button>
            <button className="btn sm" onClick={em.simulateRollover}>🚜↘️ Simulate rollover</button>
            <button className="btn sm" onClick={em.simulateImpact}>💥 Simulate impact</button>
          </div>
          <label className="field" style={{ marginTop: 10 }}>Manual tilt (demo): {em.simAngle}°
            <input type="range" min="0" max="60" value={em.simAngle} onChange={(e) => em.setSimAngle(Number(e.target.value))} />
          </label>
        </div>
        <div>
          <button className="btn danger sos-big" onClick={em.openPicker} disabled={!!em.sos}>
            🆘 {em.sos ? 'SOS ACTIVE' : 'SEND SOS'}
          </button>
          <div className="small muted" style={{ marginTop: 6, textAlign: 'center' }}>or say “Help!” / “Emergency” / “मदद” with the 🎙️ button</div>
          <div className="list-item" style={{ marginTop: 14 }}>
            <label className="row" style={{ cursor: 'pointer' }}>
              <input type="checkbox" checked={em.activeMode} onChange={(e) => em.setActiveMode(e.target.checked)} style={{ width: 20, height: 20 }} />
              <b>Active mode</b>
              <span className="small muted">(periodic “are you OK?” check-ins)</span>
            </label>
            {!em.activeMode && (new Date().getHours() >= 19 || new Date().getHours() < 6) && (
              <div className="small" style={{ marginTop: 6, color: 'var(--amber)' }}>🌙 Night shift detected: turning on Active mode is recommended.</div>
            )}
            {em.activeMode && (
              <div className="small" style={{ marginTop: 8 }}>
                Next check-in in <b className="mono">{nextIn}s</b> (demo: every {CHECKIN_EVERY_S}s).
                <button className="btn sm ghost" style={{ marginLeft: 8, minHeight: 28 }} onClick={em.checkinNow}>Check in now</button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
