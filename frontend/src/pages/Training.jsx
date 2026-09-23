import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { AIBadge, Modal, SkillChip } from '../components'
import { beep, chime, speak } from '../voice'

// ------------------------------------------------------------------ lesson player
function LessonPlayer({ module, opId, onClose, onFinished }) {
  const [step, setStep] = useState(0) // slides, then quiz
  const [answers, setAnswers] = useState({})
  const [result, setResult] = useState(null)
  const slides = module.slides.length
  const inQuiz = step >= slides

  useEffect(() => { if (step < slides) speak(module.slides[step], { force: true }) }, [step, module, slides])
  useEffect(() => () => window.speechSynthesis?.cancel(), [])

  const finish = async () => {
    const correct = module.quiz.filter((q, i) => answers[i] === q.answer).length
    const score = correct / module.quiz.length
    const r = await api.completeTraining(opId, module.id, score)
    setResult({ ...r, correct })
    if (r.passed) chime()
    if (r.leveled_up) speak(`Congratulations! You are now ${r.skill_after} level.`, { force: true })
    onFinished()
  }

  return (
    <Modal onClose={onClose}>
      <div className="row"><span style={{ fontSize: 30 }}>{module.icon}</span><h3 style={{ margin: 0 }}>{module.title}</h3><div className="spacer" /><button className="btn sm ghost" onClick={onClose}>✕</button></div>
      <div className="xpbar" style={{ margin: '14px 0' }}><div style={{ width: `${(Math.min(step, slides) / slides) * 100}%` }} /></div>

      {result ? (
        <div className="levelup">
          <div className="big">{result.leveled_up ? '🏆' : result.passed ? '✅' : '🔁'}</div>
          <div>{result.correct}/{module.quiz.length} correct</div>
          {result.passed ? <div style={{ color: 'var(--yellow)' }}>+{result.xp_gained} XP {result.xp_gained === 0 && '(already completed)'}</div> : <div className="muted">Score 50% to pass — try again</div>}
          {result.leveled_up && (
            <div style={{ marginTop: 10 }}>
              Level up: {result.skill_before} → <span style={{ color: 'var(--green)' }}>{result.skill_after}</span>
              <div className="small muted" style={{ fontWeight: 500, marginTop: 6 }}>Your task-time predictions have been updated for your new skill level.</div>
            </div>
          )}
          <button className="btn primary" style={{ marginTop: 16 }} onClick={onClose}>Done</button>
        </div>
      ) : !inQuiz ? (
        <>
          <div className="slide">{module.slides[step]}</div>
          <div className="row"><span className="muted small">Card {step + 1} of {slides} · read aloud 🔊</span><div className="spacer" />
            {step > 0 && <button className="btn ghost" onClick={() => setStep(step - 1)}>Back</button>}
            <button className="btn primary" onClick={() => setStep(step + 1)}>{step === slides - 1 ? 'Quick quiz →' : 'Next →'}</button>
          </div>
        </>
      ) : (
        <>
          {module.quiz.map((q, i) => (
            <div key={i} style={{ marginBottom: 16 }}>
              <b>{i + 1}. {q.q}</b>
              {q.options.map((o, j) => (
                <button key={j} className={`btn opt ${answers[i] === j ? 'primary' : ''}`} onClick={() => setAnswers({ ...answers, [i]: j })}>{o}</button>
              ))}
            </div>
          ))}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn primary" disabled={Object.keys(answers).length < module.quiz.length} onClick={finish}>Submit</button>
          </div>
        </>
      )}
    </Modal>
  )
}

// ------------------------------------------------------------------ simulation game
const ROUNDS = 5
function SwingGame({ onClose }) {
  const canvasRef = useRef(null)
  const g = useRef({ phase: 'ready', angle: 0, worker: null, appearAt: 0, times: [], fails: 0, round: 0 })
  const [ui, setUi] = useState({ phase: 'ready', round: 0, last: null, times: [], fails: 0 })

  const sync = () => setUi({ phase: g.current.phase, round: g.current.round, last: g.current.last, times: [...g.current.times], fails: g.current.fails })

  const nextRound = () => {
    const s = g.current
    if (s.round >= ROUNDS) { s.phase = 'over'; sync(); return }
    s.round += 1
    s.phase = 'waiting'
    s.worker = null
    s.appearAt = performance.now() + 1200 + Math.random() * 2500
    sync()
  }

  const stop = () => {
    const s = g.current
    if (s.phase === 'ready' || s.phase === 'over') { Object.assign(s, { times: [], fails: 0, round: 0, last: null }); nextRound(); return }
    if (s.phase === 'waiting') { s.fails += 1; s.last = 'False stop — only stop when someone enters the zone'; beep({ freq: 300 }); nextRound(); return }
    if (s.phase === 'danger') {
      const rt = performance.now() - s.worker.enteredAt
      s.times.push(rt)
      s.last = `Stopped in ${(rt / 1000).toFixed(2)} s ${rt < 800 ? '⚡ excellent' : rt < 1500 ? '👍 ok' : '🐢 too slow'}`
      chime()
      s.phase = 'stopped'
      sync()
      setTimeout(nextRound, 900)
    }
  }

  useEffect(() => {
    const k = (e) => { if (e.code === 'Space') { e.preventDefault(); stop() } }
    window.addEventListener('keydown', k)
    let raf
    const draw = (now) => {
      const s = g.current
      const c = canvasRef.current
      if (!c) return
      const ctx = c.getContext('2d')
      const W = c.width, H = c.height, cx = W / 2, cy = H / 2, R = 110
      ctx.fillStyle = '#6b5a3e'; ctx.fillRect(0, 0, W, H)
      ctx.fillStyle = 'rgba(255,77,79,0.18)'; ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill()
      ctx.strokeStyle = '#ff4d4f'; ctx.setLineDash([8, 6]); ctx.lineWidth = 2; ctx.stroke(); ctx.setLineDash([])
      if (s.phase !== 'stopped' && s.phase !== 'ready' && s.phase !== 'over') s.angle += 0.025
      // machine + boom
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(s.angle)
      ctx.fillStyle = '#ffcd11'; ctx.fillRect(-28, -22, 56, 44)
      ctx.fillStyle = '#222'; ctx.fillRect(-34, 14, 20, 10) // counterweight side
      ctx.fillStyle = '#ffcd11'; ctx.fillRect(20, -6, R - 20, 12)
      ctx.fillStyle = '#333'; ctx.fillRect(R - 8, -12, 16, 24)
      ctx.restore()
      // worker
      if (s.phase === 'waiting' && now > s.appearAt) {
        const a = Math.random() * Math.PI * 2
        s.worker = { a, r: 190, enteredAt: 0 }
        s.phase = 'approach'
      }
      if (s.worker) {
        const w = s.worker
        if (s.phase === 'approach' || s.phase === 'danger') w.r -= 1.6
        if (s.phase === 'approach' && w.r < R) { s.phase = 'danger'; w.enteredAt = now; beep({ freq: 1000, duration: 0.08 }); sync() }
        if (s.phase === 'danger' && now - w.enteredAt > 2000) {
          s.fails += 1; s.last = '💥 Too late — the worker was struck'; beep({ freq: 200, duration: 0.4 }); s.phase = 'stopped'; sync(); setTimeout(nextRound, 1200)
        }
        const x = cx + Math.cos(w.a) * w.r, y = cy + Math.sin(w.a) * w.r
        ctx.fillStyle = '#ff8c00'; ctx.beginPath(); ctx.arc(x, y, 11, 0, Math.PI * 2); ctx.fill()
        ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill()
      }
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => { cancelAnimationFrame(raf); window.removeEventListener('keydown', k) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const avg = ui.times.length ? ui.times.reduce((a, b) => a + b, 0) / ui.times.length / 1000 : null
  return (
    <Modal onClose={onClose}>
      <div className="row"><h3 style={{ margin: 0 }}>🎮 Swing-Zone Reflex Simulator</h3><div className="spacer" /><button className="btn sm ghost" onClick={onClose}>✕</button></div>
      <p className="small muted">The excavator is swinging. When a worker enters the red swing zone, hit <b>STOP</b> (or Space) as fast as you can. Don't stop early.</p>
      <canvas ref={canvasRef} width={560} height={380} style={{ width: '100%', borderRadius: 12, display: 'block' }} />
      <div className="row wrap" style={{ marginTop: 12 }}>
        <span className="chip">Round {ui.round}/{ROUNDS}</span>
        {avg && <span className="chip info">Avg reaction {avg.toFixed(2)} s</span>}
        {ui.fails > 0 && <span className="chip bad">{ui.fails} failed</span>}
        <span className="small">{ui.last}</span>
        <div className="spacer" />
        <button className="btn danger" style={{ minWidth: 160 }} onClick={stop}>
          {ui.phase === 'ready' ? '▶ Start' : ui.phase === 'over' ? '↺ Play again' : '🛑 STOP'}
        </button>
      </div>
      {ui.phase === 'over' && (
        <div className="levelup" style={{ marginTop: 12 }}>
          {ui.fails === 0 && avg < 1.2 ? '🏅 Certified: safe reflexes' : '🔁 Practise again — target: 0 fails, < 1.2 s average'}
        </div>
      )}
    </Modal>
  )
}

// ------------------------------------------------------------------ instructor booking
const INSTRUCTORS = [
  { name: 'Suresh Patil', topic: 'Excavator advanced techniques', slots: ['Mon 10:00', 'Wed 15:00', 'Fri 09:00'] },
  { name: 'Meena Iyer', topic: 'Site safety & rigging', slots: ['Tue 11:00', 'Thu 14:00'] },
  { name: 'Ravi Menon', topic: 'Fuel-efficient operation', slots: ['Mon 16:00', 'Sat 10:00'] },
]

export default function Training({ opId, profile, refreshProfile, refreshSchedule, notify }) {
  const [modules, setModules] = useState([])
  const [conf, setConf] = useState(null)
  const [playing, setPlaying] = useState(null)
  const [game, setGame] = useState(false)
  const [booked, setBooked] = useState(() => { try { return JSON.parse(localStorage.getItem(`book-${opId}`)) || [] } catch { return [] } })

  const load = () => api.training(opId).then((r) => { setModules(r.modules); setConf(r.confidence) }).catch(() => {})
  useEffect(() => { load() }, [opId]) // eslint-disable-line react-hooks/exhaustive-deps

  const book = (name, slot) => {
    const next = [...booked, `${name} · ${slot}`]
    setBooked(next)
    try { localStorage.setItem(`book-${opId}`, JSON.stringify(next)) } catch { /* ignore */ }
    notify(`📅 Session booked with ${name} on ${slot}`)
  }

  const recommended = modules.filter((m) => m.recommended)
  const others = modules.filter((m) => !m.recommended)
  const xpPct = profile?.next_level_xp ? Math.min(100, (profile.xp / profile.next_level_xp) * 100) : 100

  const Card = (m) => (
    <div key={m.id} className={`card module ${m.recommended ? 'recommended' : ''}`}>
      <div className="row"><span className="icon">{m.icon}</span><div className="spacer" />
        {m.completed ? <span className="chip good">✓ Completed</span> : m.recommended ? <span className="chip yellow">For you</span> : null}
      </div>
      <b style={{ fontSize: 16 }}>{m.title}</b>
      {m.reason && <div className="small" style={{ color: 'var(--blue)' }}>🎯 {m.reason}</div>}
      <div className="small muted">⏱ {m.duration_sec}s micro-lesson · {m.quiz.length}-question quiz · +{m.xp} XP</div>
      <button className={`btn ${m.completed ? '' : 'primary'}`} onClick={() => setPlaying(m)}>{m.completed ? 'Review' : '▶ Start lesson'}</button>
    </div>
  )

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="card hero">
        <AIBadge c={conf} />
        <div className="row wrap">
          <div>
            <div className="muted small">Your level</div>
            <div style={{ fontSize: 26, fontWeight: 800, marginTop: 4 }}>{profile && <SkillChip skill={profile.skill} />}</div>
          </div>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div className="row small" style={{ justifyContent: 'space-between' }}>
              <span className="mono">{profile?.xp} XP</span>
              <span className="muted">{profile?.next_level_xp ? `${profile.next_level_xp} XP → next level` : 'Max level'}</span>
            </div>
            <div className="xpbar"><div style={{ width: `${xpPct}%` }} /></div>
            <div className="era"><span>BEGINNER · GRAY</span><span>INTERMEDIATE</span><span>EXPERT · CAT YELLOW</span></div>
          </div>
        </div>
        <p className="small muted" style={{ marginBottom: 0 }}>
          Lessons are picked from <b>your own telemetry</b> and <b>today's conditions</b>. Your level feeds the task-time predictor, so training visibly changes your schedule.
        </p>
      </div>

      {recommended.length > 0 && <h3 style={{ margin: '4px 0 -4px' }}>🎯 Recommended for you</h3>}
      <div className="grid g3">{recommended.map(Card)}</div>

      <div className="grid g2">
        <div className="card" style={{ borderColor: 'var(--blue)' }}>
          <h3>🎮 Simulation: Swing-Zone Reflex</h3>
          <p className="card-sub">Practise stopping the machine when someone walks into the swing zone. Measures your real reaction time.</p>
          <button className="btn primary" onClick={() => setGame(true)}>▶ Play simulator</button>
        </div>
        <div className="card">
          <h3>👨‍🏫 Book an instructor</h3>
          {INSTRUCTORS.map((i) => (
            <div key={i.name} className="list-item">
              <b>{i.name}</b> <span className="small muted">· {i.topic}</span>
              <div className="row wrap" style={{ marginTop: 6, gap: 6 }}>
                {i.slots.map((s) => {
                  const taken = booked.includes(`${i.name} · ${s}`)
                  return <button key={s} className={`btn sm ${taken ? 'good' : ''}`} disabled={taken} onClick={() => book(i.name, s)}>{taken ? '✓ ' : ''}{s}</button>
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      <h3 style={{ margin: '4px 0 -4px' }}>📚 All lessons</h3>
      <div className="grid g3">{others.map(Card)}</div>

      {playing && (
        <LessonPlayer module={playing} opId={opId} onClose={() => setPlaying(null)}
          onFinished={() => { load(); refreshProfile(); refreshSchedule() }} />
      )}
      {game && <SwingGame onClose={() => setGame(false)} />}
    </div>
  )
}
