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
import { Briefing, HandoverDialog, PunchIn } from './pages/Shift'

const TABS = [
  { id: 'today', label: 'Today', icon: '📋' },
  { id: 'twin', label: 'Digital Twin', icon: '🚜' },
  { id: 'safety', label: 'Safety', icon: '🛡️' },
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

  if (!session) return <PunchIn onPunched={onPunched} notice={notice} />
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
  const engineKey = `engine-${opId}-${machineId}`
  const [engineOn, setEngineOn] = useState(() => store.get(engineKey, false))
  const [engineBlocked, setEngineBlocked] = useState(false)
  const [proximity, setProximity] = useState({ level: 'clear' })
  const [fatigue, setFatigue] = useState({ level: 'off' })
  const [toast, setToast] = useState(null)
  const [lang, setLang] = useState(() => store.get('lang', 'en-IN'))
  const [listening, setListening] = useState(false)
  const [heard, setHeard] = useState('')
  const [incidentDraft, setIncidentDraft] = useState(null)
  const [completeFor, setCompleteFor] = useState(null)
  const [showScore, setShowScore] = useState(false)
  const [handoverOpen, setHandoverOpen] = useState(false)
  const [perfKey, setPerfKey] = useState(0)
  const today = new Date().toISOString().slice(0, 10)
  const walkKey = `walk-${opId}-${machineId}-${today}`
  const [checks, setChecks] = useState(() => store.get(walkKey, []))
  const recRef = useRef(null)
  const P = PHRASES[lang]

  const notify = useCallback((text, ms) => setToast({ text, ms, id: Date.now() }), [])
  const refreshProfile = useCallback(() => api.operator(opId).then(setProfile).catch(() => {}), [opId])
  const refreshSchedule = useCallback(() => api.schedule(opId, machineId).then(setSchedule).catch(() => notify('⚠️ Backend not reachable. Start the API on port 8000.', 8000)), [opId, machineId, notify])
  const refreshAll = useCallback(() => { refreshProfile(); refreshSchedule(); setPerfKey((k) => k + 1) }, [refreshProfile, refreshSchedule])

  useEffect(() => { refreshProfile(); refreshSchedule() }, [refreshProfile, refreshSchedule, ackCount])
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

  useEffect(() => store.set(engineKey, engineOn), [engineKey, engineOn])

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
    setEngineOn(true)
    setEngineBlocked(false)
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
    setEngineOn(false)
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
      speak(`Your safety score is ${profile?.safety.score}.`, { force: true })
    } else if (said(/twin|3d|model/)) setTab('twin')
    else if (said(/perform|progress|improve/)) setTab('performance')
    else if (said(/train|learn|सीख/)) setTab('training')
    else if (said(/insight|fuel|idle|machine/)) setTab('insights')
    else if (said(/safety|camera|proximity|fatigue|tired/)) setTab('safety')
    else if (said(/predict|estimate/)) setTab('predictor')
    else speak(P.unknown, { lang, force: true })
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
        <div style={{ position: 'relative' }}>
          <button className="score-ring" onClick={() => setShowScore((s) => !s)} title="Safety score">
            <ScoreRing score={profile?.safety.score ?? 0} />
            <div style={{ textAlign: 'left' }}>
              <div className="small muted">Safety</div>
              <div style={{ fontWeight: 800, color: scoreColor(profile?.safety.score ?? 0) }}>Grade {profile?.safety.grade}</div>
            </div>
          </button>
          {showScore && profile && (
            <div className="card score-pop" style={{ right: 0 }}>
              <h3>Safety score: {profile.safety.score}/100</h3>
              <div className="small muted" style={{ marginBottom: 8 }}>Starts at 100. Every point is explained.</div>
              {profile.safety.breakdown.map((b) => (
                <div key={b.label} className="row small" style={{ justifyContent: 'space-between', padding: '4px 0' }}>
                  <span>{b.label}</span>
                  <b className="mono" style={{ color: b.points > 0 ? 'var(--green)' : 'var(--red)' }}>{b.points > 0 ? '+' : ''}{b.points}</b>
                </div>
              ))}
            </div>
          )}
        </div>
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
        {alerts.map((a, i) => <div key={i} className={`alert-banner ${a.cls}`}>{a.text}</div>)}
        <nav className="tabs">
          {TABS.map((t) => (
            <button key={t.id} className={`tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
              <span>{t.icon}</span>{t.label}
              {t.id === 'today' && !walkaroundDone && <span className="badge-dot">!</span>}
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
          <Safety
            opId={opId} machineId={machineId} seatbelt={seatbelt} beltLevel={beltLevel} ladder={LADDER} machineWorking={engineOn}
            onProximity={setProximity} onFatigue={setFatigue} incidentDraft={incidentDraft} notify={notify}
            refreshProfile={refreshAll} visible={tab === 'safety'}
          />
        </div>
        {tab === 'twin' && (
          <Twin schedule={schedule} profile={profile} seatbelt={seatbelt} engineOn={engineOn} proximity={proximity} fatigue={fatigue}
            checks={checks} toggleCheck={toggleCheck} onProximity={setProximity} notify={notify} />
        )}
        {tab === 'performance' && <Performance opId={opId} profile={profile} refreshKey={perfKey} onGoTraining={() => setTab('training')} />}
        {tab === 'insights' && <Insights opId={opId} />}
        {tab === 'training' && <Training opId={opId} profile={profile} refreshProfile={refreshAll} refreshSchedule={refreshSchedule} notify={notify} />}
        {tab === 'predictor' && <Predictor profile={profile} />}
      </main>

      <footer className="footer">
        <span>Tip: <b>E</b> = engine start/stop · <b>B</b> = seatbelt sensor · 🎙️ for hands-free commands</span>
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
            const r = await api.completeTask(machineId, completeFor.task_id, opId, minutes)
            setCompleteFor(null)
            chime()
            const diff = minutes - completeFor.prediction.predicted_min
            notify(`✅ ${completeFor.task_type} done in ${minutes} min (${diff >= 0 ? '+' : ''}${diff.toFixed(1)} vs prediction). Model retrained on ${r.model.samples} samples; error now ±${r.model.mae} min`, 7000)
            speak('Task complete. Good job.', { force: true })
            refreshAll()
          }}
        />
      )}
      <Toast toast={toast} onDone={() => setToast(null)} />
    </div>
  )
}

function CompleteDialog({ task, onClose, onDone }) {
  // Demo clock: pre-fill a realistic time around the prediction; operator can adjust.
  const [minutes, setMinutes] = useState(() => Math.round(task.prediction.predicted_min * (0.92 + Math.random() * 0.16)))
  return (
    <div className="overlay" onClick={onClose}>
      <div className="card dialog" onClick={(e) => e.stopPropagation()}>
        <h3>✅ Complete: {task.task_type}</h3>
        <p className="muted small">Actual time feeds the prediction model. It retrains instantly and gets more accurate every shift.</p>
        <label className="field">Actual time (minutes)
          <input type="number" value={minutes} min={1} onChange={(e) => setMinutes(Number(e.target.value))} />
        </label>
        <p className="small muted">Predicted: <b className="mono">{task.prediction.predicted_min}</b> min (range {task.prediction.low_min}–{task.prediction.high_min})</p>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn good" onClick={() => onDone(minutes)} disabled={!minutes}>Confirm & retrain</button>
        </div>
      </div>
    </div>
  )
}
