import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'
import { CHECKLIST, ScoreRing, SkillChip, Toast, WEATHER_ICON, scoreColor } from './components'
import { alarm, chime, engineStartSound, listenOnce, siren, speak } from './voice'
import Today from './pages/Today'
import Safety from './pages/Safety'
import Insights from './pages/Insights'
import Training from './pages/Training'
import Predictor from './pages/Predictor'
import Performance from './pages/Performance'
import Twin from './pages/Twin'
import Health from './pages/Health'
import Supervisor from './pages/Supervisor'
import AskCops from './pages/AskCops'
import { LIVE_RULES, RECOVERY_PER_S, Sparkline, useLiveSafety } from './liveSafety'
import { AreYouOkModal, EmergencyPanel, SosBanner, SosPicker, useEmergency } from './pages/Emergency'
import ShiftReport from './pages/ShiftReport'
import { Briefing, HandoverDialog, PunchIn } from './pages/Shift'
import { useBlackBox } from './blackbox'

const TABS = [
  { id: 'today', label: 'Today', icon: '📋' },
  { id: 'twin', label: 'Digital Twin', icon: '🚜' },
  { id: 'health', label: 'Machine Health', icon: '🛢️' },
  { id: 'safety', label: 'Safety', icon: '🛡️' },
  { id: 'report', label: 'Shift Report', icon: '📄' },
  { id: 'performance', label: 'Performance', icon: '🔁' },
  { id: 'insights', label: 'Machine Insights', icon: '📊' },
  { id: 'training', label: 'Training Hub', icon: '🎓' },
  { id: 'predictor', label: 'Time Predictor', icon: '⏱️' },
]

// Seatbelt escalation ladder (seconds after belt is released while machine is working)
// Seatbelt removed while the ENGINE is running: siren starts immediately and repeats.
const LADDER = [
  { at: 0, level: 1, label: 'Siren + voice alert' },
  { at: 8, level: 2, label: 'Final warning' },
  { at: 16, level: 3, label: 'Supervisor notified' },
]

const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d } catch { return d } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* ignore */ } },
}

const PHRASES = {
  'en-IN': {
    belt: 'Please fasten your seatbelt.',
    beltAlarm: 'Warning! Seatbelt unfastened while machine is working.',
    beltSup: 'Supervisor has been notified about the seatbelt.',
    beltOk: 'Seatbelt fastened. Thank you.',
    beltRemoved: 'Warning! Seatbelt removed while the engine is running. Fasten it now.',
    engineBlocked: 'Engine start blocked. Fasten your seatbelt before starting the engine.',
    engineOn: 'Engine started.',
    engineOff: 'Engine stopped.',
    unknown: 'Sorry, I did not get that. Try: next task, task done, or report incident.',
  },
  'hi-IN': {
    belt: 'कृपया अपनी सीट बेल्ट लगाइए।',
    beltAlarm: 'चेतावनी! मशीन चल रही है और सीट बेल्ट खुली है।',
    beltSup: 'सीट बेल्ट के बारे में सुपरवाइज़र को सूचित कर दिया गया है।',
    beltOk: 'सीट बेल्ट लग गई। धन्यवाद।',
    beltRemoved: 'चेतावनी! इंजन चालू है और सीट बेल्ट खोल दी गई है। तुरंत लगाइए।',
    engineBlocked: 'इंजन शुरू नहीं होगा। पहले सीट बेल्ट लगाइए।',
    engineOn: 'इंजन चालू हो गया।',
    engineOff: 'इंजन बंद हो गया।',
    unknown: 'माफ़ कीजिए, समझ नहीं आया। बोलिए: अगला काम, काम खत्म, या घटना दर्ज करो।',
  },
}

const liveGradeOf = (x) => (x >= 85 ? 'A' : x >= 70 ? 'B' : x >= 55 ? 'C' : 'D')

export default function App() {
  const [session, setSession] = useState(() => store.get('session', null)) // { opId, machineId }
  const [brief, setBrief] = useState(null)
  const [notice, setNotice] = useState(null)
  const [theme, setTheme] = useState(() => store.get('theme', 'dark'))
  useEffect(() => { document.documentElement.dataset.theme = theme; store.set('theme', theme) }, [theme])

  const onPunched = (r) => {
    const s = { opId: r.operator.id, machineId: r.machine.machine_id }
    store.set('session', s)
    setSession(s)
    setNotice(null)
    if (r.handover) setBrief({ ...r.handover, incomingName: r.operator.name })
    else speak(`Welcome ${r.operator.name.split(' ')[0]}. ${r.machine.machine} is ready.`, { force: true })
  }
  const endSession = (msg) => {
    store.set('session', null)
    setSession(null)
    setNotice(msg)
  }

  const [ackCount, setAckCount] = useState(0) // bumps so the cockpit refreshes after acknowledging
  const openBrief = async (id) => {
    const [b, op] = await Promise.all([api.handover(id, session.opId), api.operator(session.opId)])
    setBrief({ ...b, incomingName: op.name })
  }

  const [supervisor, setSupervisor] = useState(() => window.location.hash === '#supervisor')
  const openSupervisor = (on) => { setSupervisor(on); window.location.hash = on ? 'supervisor' : '' }
  if (supervisor) return <Supervisor onBack={() => openSupervisor(false)} />
  if (!session) return <PunchIn onPunched={onPunched} notice={notice} onSupervisor={() => openSupervisor(true)} />
  return (
    <>
      <Cockpit key={`${session.opId}-${session.machineId}`} session={session} theme={theme} setTheme={setTheme}
        endSession={endSession} openBrief={openBrief} ackCount={ackCount} />
      {brief && (
        <Briefing brief={brief} operator={{ name: brief.incomingName || session.opId }}
          onClose={() => { window.speechSynthesis?.cancel(); setBrief(null) }}
          onAck={async () => {
            await api.ackHandover(brief.id, session.opId)
            window.speechSynthesis?.cancel()
            chime()
            speak('Handover acknowledged. Complete the walkaround, then continue the work.', { force: true })
            setBrief(null)
            setAckCount((n) => n + 1)
          }} />
      )}
    </>
  )
}

function Cockpit({ session, theme, setTheme, endSession, openBrief, ackCount }) {
  const { opId, machineId } = session
  const [profile, setProfile] = useState(null)
  const [schedule, setSchedule] = useState(null)
  const [tab, setTab] = useState('today')
  const [seatbelt, setSeatbelt] = useState('Fastened')
  const [beltLevel, setBeltLevel] = useState(0)
  // The server owns the engine state, so every window showing this machine agrees.
  // This cab adopts it on each health poll and only sends the changes made here.
  const [engineOn, setEngineOn] = useState(false)
  const engineLocalAt = useRef(0)
  const setEngineLocal = (on) => { engineLocalAt.current = Date.now(); setEngineOn(on) }
  const [engineBlocked, setEngineBlocked] = useState(false)
  const [proximity, setProximity] = useState({ level: 'clear' })
  const [fatigue, setFatigue] = useState({ level: 'off' })
  const [toast, setToast] = useState(null)
  const [lang, setLang] = useState(() => store.get('lang', 'en-IN'))
  const [listening, setListening] = useState(false)
  const [heard, setHeard] = useState('')
  const [incidentDraft, setIncidentDraft] = useState(null)
  const [completeFor, setCompleteFor] = useState(null)
  const [showScore, setShowScore] = useState(null) // null = closed, else { left, top, width } in viewport px
  const scoreWrapRef = useRef(null)
  // Place the popup under the score badge but always inside the window, wherever the header wraps.
  const toggleScore = () => {
    if (showScore) { setShowScore(null); return }
    const r = scoreWrapRef.current.getBoundingClientRect()
    const width = Math.min(300, window.innerWidth - 32)
    const left = Math.max(16, Math.min(r.right - width, window.innerWidth - width - 16))
    setShowScore({ left, top: r.bottom + 8, width })
  }
  useEffect(() => {
    if (!showScore) return
    const close = (e) => { if (!scoreWrapRef.current?.contains(e.target)) setShowScore(null) }
    const closeNow = () => setShowScore(null)
    document.addEventListener('mousedown', close)
    window.addEventListener('resize', closeNow)
    window.addEventListener('scroll', closeNow, true)
    return () => {
      document.removeEventListener('mousedown', close)
      window.removeEventListener('resize', closeNow)
      window.removeEventListener('scroll', closeNow, true)
    }
  }, [showScore])
  const [handoverOpen, setHandoverOpen] = useState(false)
  const [perfKey, setPerfKey] = useState(0)
  const today = new Date().toISOString().slice(0, 10)
  const walkKey = `walk-${opId}-${machineId}-${today}`
  const [checks, setChecks] = useState(() => store.get(walkKey, []))
  const recRef = useRef(null)
  const askRef = useRef(null)
  const [health, setHealth] = useState(null)
  const prevHealth = useRef({})
  const [stopInfo, setStopInfo] = useState(null) // last emergency stop (reason + time)
  const P = PHRASES[lang]

  const notify = useCallback((text, ms) => setToast({ text, ms, id: Date.now() }), [])
  const refreshProfile = useCallback(() => api.operator(opId).then(setProfile).catch(() => {}), [opId])
  const refreshSchedule = useCallback(() => api.schedule(opId, machineId).then(setSchedule).catch(() => notify('⚠️ Backend not reachable. Start the API on port 8000.', 8000)), [opId, machineId, notify])
  const refreshAll = useCallback(() => { refreshProfile(); refreshSchedule(); setPerfKey((k) => k + 1) }, [refreshProfile, refreshSchedule])

  useEffect(() => { refreshProfile(); refreshSchedule() }, [refreshProfile, refreshSchedule, ackCount])
  // The API may still be starting (both servers launched together): keep trying until the day loads.
  useEffect(() => {
    if (profile && schedule) return
    const i = setInterval(() => { if (!profile) refreshProfile(); if (!schedule) refreshSchedule() }, 2000)
    return () => clearInterval(i)
  }, [profile, schedule, refreshProfile, refreshSchedule])
  useEffect(() => store.set('lang', lang), [lang])

  const toggleCheck = (i) => {
    setChecks((prev) => {
      const next = prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i]
      store.set(walkKey, next)
      return next
    })
  }
  const walkaroundDone = checks.length === CHECKLIST.length
  const activeTask = schedule?.tasks.find((t) => t.status === 'in_progress')
  const working = engineOn && !!activeTask
  const frozen = working && (seatbelt !== 'Fastened' || proximity.level === 'danger' || ['microsleep', 'drowsy'].includes(fatigue.level))

  // ---------------- live safety score: only while the engine runs, changes every second
  const safety = useLiveSafety({
    opId, machineId, engineOn, seatbelt, proximity, fatigue, working,
    idleS: health?.utilisation?.idle_now_s || 0,
    onThreshold: (score, g) => {
      speak(`Safety score dropped to ${score}. Grade ${g}.`, { force: true })
      notify(`📉 Live safety score dropped to ${score} (grade ${g})`)
    },
  })

  // ---------------- runtime machine health: poll sensors and follow the server's engine state
  const engineRef = useRef(engineOn)
  engineRef.current = engineOn
  const syncedRef = useRef(false)   // has this machine's engine state come from the server yet?
  const adoptedRef = useRef(false)  // the pending engine change came from the server: don't echo it back
  const refreshHealth = useCallback(() => api.health(machineId).then((h) => {
    setHealth(h)
    // Skip if the operator switched the engine here in the last 4 s: that request may still be in flight.
    const localChange = Date.now() - engineLocalAt.current < 4000
    if (h.engine_on !== engineRef.current && (!syncedRef.current || !localChange)) {
      adoptedRef.current = true
      setEngineOn(h.engine_on)
    }
    syncedRef.current = true
  }).catch(() => {}), [machineId])
  useEffect(() => {
    syncedRef.current = false
    refreshHealth()
    const i = setInterval(refreshHealth, 2000)
    return () => clearInterval(i)
  }, [refreshHealth])
  useEffect(() => {
    if (!syncedRef.current) return
    if (adoptedRef.current) { adoptedRef.current = false; return }
    api.setEngine(machineId, engineOn, working).then(setHealth).catch(() => {})
  }, [machineId, engineOn, working])

  // ---------------- shared dig clock + black-box frame (4 Hz recorder reads frameRef)
  const digRef = useRef({ dig: 0 })
  useEffect(() => {
    if (!working || frozen) return
    const i = setInterval(() => { digRef.current.dig += 0.05 }, 50)
    return () => clearInterval(i)
  }, [working, frozen])
  const frameRef = useRef({})

  // ---------------- seatbelt removed while the ENGINE is running (with or without a task)
  useEffect(() => {
    if (seatbelt === 'Fastened' || !engineOn) { setBeltLevel(0); return }
    const started = Date.now()
    const during = activeTask ? `during ${activeTask.task_type}` : 'with engine running'
    const timers = LADDER.map((step) =>
      setTimeout(() => {
        setBeltLevel(step.level)
        if (step.level === 1) { siren(); speak(P.beltRemoved, { lang, force: true }) }
        if (step.level === 2) { siren(); speak(P.beltAlarm, { lang, force: true }) }
        if (step.level === 3) {
          siren()
          speak(P.beltSup, { lang, force: true })
          api.logEvent(opId, 'seatbelt', `Unfastened ${during} for ${Math.round((Date.now() - started) / 1000)}s`, machineId)
            .then(refreshAll)
        }
      }, step.at * 1000))
    const repeat = setInterval(siren, 2000) // keeps sounding until the belt is fastened again
    return () => { timers.forEach(clearTimeout); clearInterval(repeat) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seatbelt, engineOn, opId, lang])

  const toggleBelt = () => {
    const next = seatbelt === 'Fastened' ? 'Unfastened' : 'Fastened'
    setSeatbelt(next)
    if (next === 'Fastened') { chime(); if (beltLevel) speak(P.beltOk, { lang, force: true }) }
  }

  // ---------------- engine: cannot start without the seatbelt
  const startEngine = () => {
    if (engineOn) return true
    if (health && !health.start_allowed) {
      siren()
      speak(`Engine start blocked. ${health.block_reason}. Service the machine first.`, { force: true })
      notify(`🔒 Engine start blocked: ${health.block_reason}. Open Machine Health.`)
      setTab('health')
      return false
    }
    if (seatbelt !== 'Fastened') {
      siren()
      setTimeout(siren, 1400)
      speak(P.engineBlocked, { lang, force: true })
      notify('🔑 Engine start blocked: fasten your seatbelt first')
      setEngineBlocked(true)
      setTimeout(() => setEngineBlocked(false), 6000)
      api.logEvent(opId, 'seatbelt', 'Attempted engine start without seatbelt (blocked)', machineId).then(refreshAll)
      return false
    }
    setEngineLocal(true)
    setEngineBlocked(false)
    setStopInfo(null)
    engineStartSound()
    speak(P.engineOn, { lang, force: true })
    return true
  }
  const stopEngine = () => {
    if (!engineOn) return
    if (activeTask) {
      notify(`⚙️ ${activeTask.task_type} is in progress. Complete it or hand over before stopping the engine.`)
      speak('Complete the task before stopping the engine.', { force: true })
      return
    }
    setEngineLocal(false)
    speak(P.engineOff, { lang, force: true })
  }
  const toggleEngine = () => (engineOn ? stopEngine() : startEngine())

  useEffect(() => {
    const k = (e) => {
      if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return
      if (e.key.toLowerCase() === 'b') toggleBelt()
      if (e.key.toLowerCase() === 'e') toggleEngine()
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  })

  // ---------------- task actions (shared by UI + voice)
  const briefPending = schedule?.handover?.status === 'pending' && schedule.handover.from_id !== opId
  const startTask = async (task) => {
    if (briefPending) {
      speak('Please read and acknowledge the handover briefing first.', { force: true })
      notify('📋 Acknowledge the handover briefing before starting work')
      openBrief(schedule.handover.id)
      return
    }
    if (!walkaroundDone) {
      speak('Complete the pre-shift walkaround checklist first.', { force: true })
      notify('🔒 Complete the pre-shift walkaround checklist to unlock tasks')
      setTab('today')
      return
    }
    if (fatigue.level === 'microsleep' || fatigue.level === 'drowsy') {
      alarm()
      speak('You are too drowsy to operate. Take a break first.', { force: true })
      notify('😴 Task blocked: drowsiness detected. Take a break first.')
      return
    }
    if (!startEngine()) return // starting work starts the engine, through the same seatbelt interlock
    try {
      await api.startTask(machineId, task.task_id, opId, seatbelt)
      chime()
      speak(`Starting ${task.task_type}. Predicted time ${Math.round(task.prediction.predicted_min)} minutes.`, { force: true })
      refreshSchedule()
    } catch (e) {
      if (e.status === 423) {
        alarm()
        speak(P.belt, { lang, force: true })
        notify('🔒 Interlock: fasten your seatbelt to start the task')
      } else notify(e.message)
    }
  }
  const nextTask = () => schedule?.tasks.find((t) => t.status === 'pending' || t.status === 'paused')

  // ---------------- voice commands (English + Hindi)
  const handleCommand = (raw) => {
    const t = raw.toLowerCase()
    const said = (re) => re.test(t)
    const short = t.split(/\s+/).length <= 4
    if (short && said(/\b(help|emergency|sos|mayday)\b|bachao|madad|मदद|बचाओ|आपातकाल/)) {
      em.triggerSOS('voice', `Voice: "${raw}"`, { risk: 'high', category: 'Voice call for help' })
      return
    }
    if (said(/^(ask cops|hey cops|cops)\b/)) {
      askRef.current?.ask(raw.replace(/^(ask cops|hey cops|cops)[,:]?\s*/i, '') || 'What can you do?')
      return
    }
    if (said(/\?$|^(why|how|what is|what's|when|where|is my|is the|kya|kyun|kaise)\b|kitna|कितना|क्या/) && !said(/what'?s next|what now/)) {
      askRef.current?.ask(raw)
      return
    }
    if (said(/(start|on).{0,10}engine|engine.{0,5}(start|on)|इंजन (चालू|शुरू)/)) {
      startEngine()
    } else if (said(/(stop|off).{0,10}engine|engine.{0,5}(stop|off)|इंजन बंद/)) {
      stopEngine()
    } else if (said(/incident|accident|report|घटना|दुर्घटना|रिपोर्ट/)) {
      const text = raw.replace(/^(please\s+)?(log|report|record)?\s*(an\s+)?(incident|accident)\s*[:,-]?\s*/i, '')
      setTab('safety')
      setIncidentDraft({ text: text || raw, id: Date.now() })
      speak('Incident captured. Please review and submit.', { force: true })
    } else if (said(/hand ?over|end (my )?shift|punch out|शिफ्ट/)) {
      setHandoverOpen(true)
    } else if (said(/(complete|done|finish|खत्म|ख़त्म|पूरा)/)) {
      if (activeTask) setCompleteFor(activeTask)
      else speak('No task is in progress.', { force: true })
    } else if (said(/(start|next|begin|अगला|शुरू)/)) {
      const n = nextTask()
      if (n) startTask(n)
      else speak('All tasks are done for today. Great work!', { force: true })
    } else if (said(/(what|status|schedule|my day|आज)/)) {
      const n = nextTask()
      speak(n ? `Next task: ${n.task_type} at ${n.site}, starting ${n.start}, about ${Math.round(n.prediction.predicted_min)} minutes. Weather ${n.weather}.`
        : 'All tasks complete.', { force: true })
    } else if (said(/score|safety score/)) {
      speak(safety.live ? `Your live safety score is ${Math.round(safety.live.score)}.`
        : `Engine is off, so safety scoring is paused.${safety.last ? ` Last session scored ${safety.last.score}.` : ''}`, { force: true })
    } else if (said(/twin|3d|model/)) setTab('twin')
    else if (said(/perform|progress|improve/)) setTab('performance')
    else if (said(/train|learn|सीख/)) setTab('training')
    else if (said(/insight|fuel|idle|machine/)) setTab('insights')
    else if (said(/safety|camera|proximity|fatigue|tired/)) setTab('safety')
    else if (said(/predict|estimate/)) setTab('predictor')
    else if (said(/oil|coolant|hydraulic|fuel|health|leak/)) setTab('health')
    else askRef.current?.ask(raw) // anything else: let ASK COPS answer
  }

  const toggleMic = () => {
    if (listening) { recRef.current?.stop(); return }
    setHeard('')
    setListening(true)
    let finalText = ''
    recRef.current = listenOnce({
      lang,
      onResult: (text, isFinal) => { setHeard(text); if (isFinal) finalText = text },
      onEnd: () => {
        setListening(false)
        if (finalText) handleCommand(finalText)
        setTimeout(() => setHeard(''), 2500)
      },
      onError: (err) => { setListening(false); notify(`🎙️ ${err}`) },
    })
  }

  // ---------------- emergency stop: a critical incident shuts the engine down mid-shift and SMSes the supervisor
  const STOP_KEYS = ['engine_oil', 'oil_pressure', 'coolant', 'engine_temp', 'hydraulic_oil']
  const emergencyStop = (reason, detail = '') => {
    if (!engineOn) return
    setEngineLocal(false)
    setStopInfo({ reason, time: new Date().toLocaleTimeString() })
    siren()
    speak(`Emergency stop. Engine shut down: ${reason}. Your supervisor has been alerted by SMS.`, { force: true })
    api.emergencyStop(machineId, { operator_id: opId, reason, detail, task: activeTask?.task_type || null }).catch(() => {})
  }

  // ---------------- black box + emergency
  frameRef.current = {
    dig: +digRef.current.dig.toFixed(3), engineOn, working, frozen, seatbelt,
    prox: { level: proximity.level, distance: proximity.distance ?? null, x: proximity.x ?? 0.5 },
    fatigue: { level: fatigue.level, closedFor: fatigue.closedFor || 0 }, task: activeTask?.task_type || null,
    health: health?.overall || 'ok', tilt: 0,
  }
  const capture = useBlackBox({ opId, machineId, frameRef, notify })
  const em = useEmergency({
    opId, machineId, notify,
    onSos: (type, detail) => { capture('sos', `${type}: ${detail}`); emergencyStop(`SOS: ${type.replace('_', ' ')}`, detail) },
  })
  frameRef.current.tilt = Math.round(em.angle)

  useEffect(() => { if (proximity.level === 'danger') capture('proximity', `Person at ${proximity.distance?.toFixed(1)} m`) }, [proximity.level]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (fatigue.level !== 'microsleep') return
    capture('microsleep', `Eyes closed ${fatigue.closedFor?.toFixed(1)} s`)
    emergencyStop('Operator microsleep detected', `Eyes closed ${fatigue.closedFor?.toFixed(1)} s`)
  }, [fatigue.level]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (beltLevel === 3) capture('seatbelt', 'Seatbelt off with engine running: supervisor notified') }, [beltLevel]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (em.prompt?.type === 'rollover') capture('rollover', em.prompt.reason) }, [em.prompt]) // eslint-disable-line react-hooks/exhaustive-deps

  // health alerts: announce new warnings/criticals once, record criticals in the black box
  useEffect(() => {
    if (!health) return
    health.channels.forEach((c) => {
      const before = prevHealth.current[c.key]
      if (before && before !== c.status && (c.status === 'crit' || (c.status === 'warn' && before === 'ok'))) {
        const a = health.alerts.find((x) => x.key === c.key)
        if (c.status === 'crit') {
          siren()
          speak(`Critical: ${c.label} ${c.value} ${c.unit === '%' ? 'percent' : c.unit}. ${a?.action || ''}`, { force: true })
          capture('health', `${c.label} critical: ${c.value}${c.unit}`)
          if (STOP_KEYS.includes(c.key)) emergencyStop(`${c.label} critical (${c.value}${c.unit})`, a?.action || '')
        } else {
          alarm()
          speak(`Warning: ${c.label} ${c.value} ${c.unit === '%' ? 'percent' : c.unit}.`, { force: true })
        }
      }
      prevHealth.current[c.key] = c.status
    })
    health.anomalies.forEach((a) => {
      if (!prevHealth.current[`anom-${a.key}`]) speak(a.title, { force: true })
      prevHealth.current[`anom-${a.key}`] = true
    })
    Object.keys(prevHealth.current).filter((k) => k.startsWith('anom-') && !health.anomalies.some((a) => `anom-${a.key}` === k)).forEach((k) => delete prevHealth.current[k])
  }, [health]) // eslint-disable-line react-hooks/exhaustive-deps

  const machine = schedule?.machine
  const nowHour = new Date().getHours()
  const nowWx = schedule?.forecast.find((h) => h.hour === Math.min(18, Math.max(7, nowHour)))
  const alerts = []
  if (fatigue.level === 'microsleep') alerts.push({ cls: '', text: `😴 MICROSLEEP: EYES CLOSED ${fatigue.closedFor?.toFixed(1)} s. STOP THE MACHINE AND TAKE A BREAK` })
  else if (fatigue.level === 'drowsy') alerts.push({ cls: 'warn', text: '😪 Drowsiness detected: eyes closing. Stay alert or take a break.' })
  else if (fatigue.level === 'tired') {
    const why = fatigue.yawns >= 3 ? `${fatigue.yawns} yawns in 3 min` : `eyes closed ${Math.round((fatigue.perclos || 0) * 100)}% of the last minute`
    alerts.push({ cls: 'info', text: `🥱 Fatigue signs: ${why}. A 10-min break is advised.` })
  }
  if (proximity.level === 'danger') alerts.push({ cls: '', text: `🛑 STOP: PERSON ${proximity.distance?.toFixed(1)} m FROM MACHINE. MOVEMENT INHIBITED` })
  else if (proximity.level === 'warn') alerts.push({ cls: 'warn', text: `⚠️ Person approaching: ${proximity.distance?.toFixed(1)} m. Slow down, check mirrors` })
  const idleNow = health?.utilisation?.idle_now_s || 0
  if (engineOn && !working && idleNow >= 60) {
    const wasted = health.utilisation.idle_now_fuel_l ?? (idleNow / 3600) * (health.utilisation.idle_lph || 3.5)
    alerts.push({ cls: 'warn', text: `💤 Engine idling ${Math.floor(idleNow / 60)}m ${idleNow % 60}s with NO WORK: ~${wasted.toFixed(2)} L diesel (₹${Math.round(wasted * 92)}) wasted. Supervisor alerted on WhatsApp. Start a task or switch off (E).` })
  }
  if (stopInfo) alerts.push({ cls: '', text: `⛔ EMERGENCY STOP at ${stopInfo.time}: engine shut down (${stopInfo.reason}). Supervisor alerted by SMS. Inspect before restarting.` })
  health?.alerts.filter((a) => a.status === 'crit').slice(0, 2).forEach((a) => alerts.push({ cls: '', text: `🛢️ CRITICAL: ${a.label} ${a.value}${a.unit}. ${a.action}` }))
  health?.anomalies.slice(0, 1).forEach((a) => alerts.push({ cls: 'warn', text: `🔎 ${a.title}. Open Machine Health.` }))
  if (engineBlocked) alerts.push({ cls: '', text: '🔑 ENGINE START BLOCKED: FASTEN YOUR SEATBELT FIRST' })
  if (beltLevel >= 1) alerts.push({ cls: '', text: `🪢 SEATBELT REMOVED WHILE ENGINE IS RUNNING${activeTask ? ` (${activeTask.task_type})` : ''}. FASTEN IT NOW${beltLevel === 3 ? ': SUPERVISOR NOTIFIED' : beltLevel === 2 ? ': FINAL WARNING' : ''}` })

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" title="1925 battleship gray → 1931 Hi-Way Yellow">CAT</div>
          <div>COPS<small>Caterpillar Operator Protection System</small></div>
        </div>
        {profile && <span className="chip" style={{ fontSize: 14, padding: '6px 12px' }}>👷 {profile.name} · {opId}</span>}
        {profile && <SkillChip skill={profile.skill} xp={profile.xp} />}
        {machine && <span className="chip">🚜 {machine.machine} · {machine.machine_id}</span>}
        {nowWx && <span className="chip">{WEATHER_ICON[nowWx.condition]} {nowWx.temp_c}°C · {nowWx.condition}</span>}
        <div className="spacer" />
        <button className={`engine ${engineOn ? 'on' : ''}`} onClick={toggleEngine} title="Engine start/stop (shortcut: E). Needs the seatbelt fastened.">
          {engineOn ? '⚙️ Engine ON' : '🔑 Engine OFF'}
        </button>
        <button className={`belt ${seatbelt === 'Fastened' ? '' : 'off'}`} onClick={toggleBelt} title="Simulated seatbelt sensor (shortcut: B)">
          🪢 {seatbelt === 'Fastened' ? 'Belt ON' : 'BELT OFF'}
        </button>
        <div style={{ position: 'relative' }} ref={scoreWrapRef}>
          {safety.live ? (
            <button className="score-ring live" onClick={toggleScore} title="Live safety score (engine running)">
              <ScoreRing score={Math.round(safety.live.score)} />
              <div style={{ textAlign: 'left' }}>
                <div className="small muted"><span className="live-dot" /> LIVE safety</div>
                <div style={{ fontWeight: 800, color: scoreColor(safety.live.score) }}>
                  Grade {liveGradeOf(safety.live.score)}{' '}
                  <span className="small mono" style={{ color: safety.trend < -0.5 ? 'var(--red)' : safety.trend > 0.5 ? 'var(--green)' : 'var(--muted)' }}>
                    {safety.trend < -0.5 ? '▼' : safety.trend > 0.5 ? '▲' : '■'}
                  </span>
                </div>
              </div>
            </button>
          ) : (
            <button className="score-ring paused" onClick={toggleScore} title="Safety scoring is paused while the engine is off">
              <div className="paused-ring">⏻</div>
              <div style={{ textAlign: 'left' }}>
                <div className="small muted">Safety scoring</div>
                <div style={{ fontWeight: 700 }} className="small">Paused: engine off{safety.last ? ` · last ${safety.last.score}` : ''}</div>
              </div>
            </button>
          )}
          {showScore && (
            <div className="card score-pop" style={{ left: showScore.left, top: showScore.top, width: showScore.width }}>
              {safety.live ? (
                <>
                  <h3>Live safety score: {Math.round(safety.live.score)}/100</h3>
                  <div className="small muted" style={{ marginBottom: 8 }}>
                    Started at 100 when the engine started ({Math.floor(safety.live.seconds / 60)}m {safety.live.seconds % 60}s ago).
                    Unsafe conditions drain it every second; clean work earns it back (+{Math.round(RECOVERY_PER_S * 60)}/min).
                  </div>
                  <Sparkline values={safety.live.history} width={showScore.width - 36} />
                  <div className="small" style={{ fontWeight: 700, margin: '10px 0 4px' }}>Right now</div>
                  {safety.live.active?.length ? LIVE_RULES.filter((r) => safety.live.active.includes(r.key)).map((r) => (
                    <div key={r.key} className="row small" style={{ justifyContent: 'space-between' }}>
                      <span>🔴 {r.label}</span><b className="mono" style={{ color: 'var(--red)' }}>−{r.rate}/s</b>
                    </div>
                  )) : <div className="small" style={{ color: 'var(--green)' }}>🟢 Operating safely: score recovering</div>}
                  <div className="small" style={{ fontWeight: 700, margin: '10px 0 4px' }}>This session</div>
                  {LIVE_RULES.filter((r) => safety.live.lost[r.key]).map((r) => (
                    <div key={r.key} className="row small" style={{ justifyContent: 'space-between', padding: '2px 0' }}>
                      <span>{r.label}</span><b className="mono" style={{ color: 'var(--red)' }}>−{safety.live.lost[r.key].toFixed(1)}</b>
                    </div>
                  ))}
                  {safety.live.recovered > 0.05 && (
                    <div className="row small" style={{ justifyContent: 'space-between', padding: '2px 0' }}>
                      <span>Clean operation recovered</span><b className="mono" style={{ color: 'var(--green)' }}>+{safety.live.recovered.toFixed(1)}</b>
                    </div>
                  )}
                  {!Object.keys(safety.live.lost).length && <div className="small muted">No deductions yet. Keep it up.</div>}
                </>
              ) : (
                <>
                  <h3>⏻ Safety scoring paused</h3>
                  <div className="small muted">The engine is off, so there is nothing to score. A live score starts at 100 the moment you start the engine (E).</div>
                  {safety.last && (
                    <div className="list-item small" style={{ marginTop: 10 }}>
                      Last session: <b>{safety.last.score}/100 (grade {safety.last.grade})</b> over {safety.last.minutes} min
                    </div>
                  )}
                  {profile && (
                    <div className="small muted" style={{ marginTop: 10 }}>
                      14-day profile score: <b>{profile.safety.score}/100</b> (see Performance tab)
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
        <button className="btn sm sos-btn" onClick={em.openPicker} title="Emergency SOS: sends your location to the supervisor">🆘 SOS</button>
        <button className="btn sm" onClick={() => setHandoverOpen(true)} title="End shift / emergency handover">⇄ Handover</button>
        <button className="btn sm ghost" onClick={() => setLang(lang === 'en-IN' ? 'hi-IN' : 'en-IN')} title="Voice language">
          {lang === 'en-IN' ? 'EN' : 'हिं'}
        </button>
        <button className="btn sm ghost" onClick={() => setTheme(theme === 'dark' ? 'sun' : 'dark')} title="Sunlight (high-contrast) mode">
          {theme === 'dark' ? '☀️' : '🌙'}
        </button>
        <div className="mic">
          <button className={`btn round primary mic ${listening ? 'live' : ''}`} onClick={toggleMic} title="Voice command" aria-label="Voice command">🎙️</button>
          {(listening || heard) && (
            <div className="transcript">
              <div className="small muted">{listening ? 'Listening…' : 'Heard:'}</div>
              <div style={{ fontWeight: 700, marginTop: 4 }}>{heard || '…'}</div>
              {listening && !heard && (
                <div className="small muted" style={{ marginTop: 8 }}>
                  Try: “next task” · “task done” · “what's next” · “end shift” · “report incident: rock hit the windshield near trench 3”
                  {lang === 'hi-IN' && ' · “अगला काम” · “काम खत्म”'}
                </div>
              )}
            </div>
          )}
        </div>
      </header>

      <div>
        <SosBanner em={em} />
        {alerts.map((a, i) => <div key={i} className={`alert-banner ${a.cls}`}>{a.text}</div>)}
        <nav className="tabs">
          {TABS.map((t) => (
            <button key={t.id} className={`tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
              <span>{t.icon}</span>{t.label}
              {t.id === 'today' && !walkaroundDone && <span className="badge-dot">!</span>}
              {t.id === 'health' && health && health.overall !== 'ok' && <span className="badge-dot" style={{ background: health.overall === 'crit' ? 'var(--red)' : 'var(--amber)' }}>!</span>}
            </button>
          ))}
        </nav>
      </div>

      <main>
        {tab === 'today' && (
          <Today
            schedule={schedule} profile={profile} checks={checks} toggleCheck={toggleCheck}
            walkaroundDone={walkaroundDone} startTask={startTask} seatbelt={seatbelt}
            onComplete={setCompleteFor} briefPending={briefPending} openBrief={openBrief}
          />
        )}
        {/* Safety stays mounted so the cameras keep watching on every tab */}
        <div style={{ display: tab === 'safety' ? 'block' : 'none' }}>
          <div style={{ marginBottom: 16 }}><EmergencyPanel em={em} /></div>
          <Safety onIncident={(inc) => capture(inc.source === 'auto-proximity' ? 'near_miss' : 'incident', `${inc.primary_type} at ${inc.location}`)}
            opId={opId} machineId={machineId} seatbelt={seatbelt} beltLevel={beltLevel} ladder={LADDER} machineWorking={engineOn}
            onProximity={setProximity} onFatigue={setFatigue} incidentDraft={incidentDraft} notify={notify}
            refreshProfile={refreshAll} visible={tab === 'safety'}
          />
        </div>
        {tab === 'twin' && (
          <Twin schedule={schedule} profile={profile} seatbelt={seatbelt} engineOn={engineOn} proximity={proximity} fatigue={fatigue}
            checks={checks} toggleCheck={toggleCheck} onProximity={setProximity} notify={notify}
            digRef={digRef} tilt={em.angle} health={health} machineId={machineId} />
        )}
        {tab === 'health' && <Health machineId={machineId} report={health} refresh={refreshHealth} notify={notify} />}
        {tab === 'report' && <ShiftReport opId={opId} machineId={machineId} notify={notify} />}
        {tab === 'performance' && <Performance opId={opId} profile={profile} refreshKey={perfKey} onGoTraining={() => setTab('training')} />}
        {tab === 'insights' && <Insights opId={opId} />}
        {tab === 'training' && <Training opId={opId} profile={profile} refreshProfile={refreshAll} refreshSchedule={refreshSchedule} notify={notify} />}
        {tab === 'predictor' && <Predictor profile={profile} />}
      </main>

      <footer className="footer">
        <span>Tip: <b>E</b> = engine · <b>B</b> = seatbelt · 🎙️ voice (say “Help!” for SOS) · 💬 ASK COPS for any question</span>
        <div className="spacer" />
        <button className="btn sm ghost" onClick={async () => {
          await api.resetDemo()
          Object.keys(localStorage).filter((k) => k.startsWith('walk-')).forEach((k) => localStorage.removeItem(k))
          endSession('Demo reset. Punch in to start a fresh shift.')
        }}>
          ↺ Reset demo
        </button>
      </footer>

      {handoverOpen && (
        <HandoverDialog opId={opId} machineId={machineId} schedule={schedule} onClose={() => setHandoverOpen(false)}
          onDone={() => { setHandoverOpen(false); endSession(`✅ Handover recorded for ${machineId}. Next operator: punch in with your ID to get the briefing.`) }} />
      )}
      {completeFor && (
        <CompleteDialog
          task={completeFor}
          onClose={() => setCompleteFor(null)}
          onDone={async (minutes) => {
            const task = completeFor
            const r = await api.completeTask(machineId, task.task_id, opId, minutes)
            setCompleteFor(null)
            chime()
            const diff = minutes - task.prediction.predicted_min
            notify(`✅ ${task.task_type} done in ${minutes} min (${diff >= 0 ? '+' : ''}${diff.toFixed(1)} vs prediction). 🧠 Model retraining in the background…`, 5000)
            speak('Task complete. Good job.', { force: true })
            refreshAll()
            if (!r.retraining) return
            // Report the retrained model once the background training finishes (a few seconds).
            const before = r.model.samples
            for (let i = 0; i < 20; i++) {
              await new Promise((ok) => setTimeout(ok, 1000))
              const st = await api.modelStats().catch(() => null)
              if (st && !st.retraining && st.samples > before) {
                notify(`🧠 Model retrained on ${st.samples} tasks: prediction error now ±${st.mae} min`, 6000)
                refreshSchedule()
                break
              }
            }
          }}
        />
      )}
      <AreYouOkModal em={em} />
      <SosPicker em={em} />
      <AskCops ref={askRef} opId={opId} machineId={machineId} lang={lang} walkaroundDone={walkaroundDone} onNavigate={setTab} />
      <Toast toast={toast} onDone={() => setToast(null)} />
    </div>
  )
}

function CompleteDialog({ task, onClose, onDone }) {
  // Demo clock: pre-fill a realistic time around the prediction; operator can adjust.
  const [minutes, setMinutes] = useState(() => Math.round(task.prediction.predicted_min * (0.92 + Math.random() * 0.16)))
  const [saving, setSaving] = useState(false)
  const confirm = async () => {
    if (saving) return // ignore double clicks
    setSaving(true)
    try { await onDone(minutes) } catch { setSaving(false) }
  }
  return (
    <div className="overlay" onClick={onClose}>
      <div className="card dialog" onClick={(e) => e.stopPropagation()}>
        <h3>✅ Complete: {task.task_type}</h3>
        <p className="muted small">Actual time feeds the prediction model. It retrains in the background and gets more accurate every shift.</p>
        <label className="field">Actual time (minutes)
          <input type="number" value={minutes} min={1} onChange={(e) => setMinutes(Number(e.target.value))} />
        </label>
        <p className="small muted">Predicted: <b className="mono">{task.prediction.predicted_min}</b> min (range {task.prediction.low_min}–{task.prediction.high_min})</p>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn good" onClick={confirm} disabled={!minutes || saving}>{saving ? '⏳ Saving…' : 'Confirm & retrain'}</button>
        </div>
      </div>
    </div>
  )
}
