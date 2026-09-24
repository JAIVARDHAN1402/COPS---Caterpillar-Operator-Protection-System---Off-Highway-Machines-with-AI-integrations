import { useEffect, useState } from 'react'
import { api } from '../api'
import { AIBadge, Modal, SkillChip, TASK_ICON, WEATHER_ICON } from '../components'
import { chime, listenOnce, speak } from '../voice'

// ------------------------------------------------------------------ punch-in
export function PunchIn({ onPunched, notice, onSupervisor }) {
  const [id, setId] = useState('')
  const [ops, setOps] = useState([])
  const [pending, setPending] = useState([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    // Poll: picks up new handovers, and recovers by itself if the API was still starting.
    const load = () => Promise.all([api.operators(), api.pendingHandovers()])
      .then(([o, p]) => { setOps(o); setPending(p); setError((e) => (e.startsWith('Backend') ? '' : e)) })
      .catch(() => setError('Backend not reachable. Start the API on port 8000.'))
    load()
    const t = setInterval(load, 4000)
    return () => clearInterval(t)
  }, [])

  const full = `OP${id}`
  const submit = async (opId = full) => {
    setBusy(true)
    setError('')
    try {
      const r = await api.punchIn(opId)
      chime()
      onPunched(r)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }
  const press = (k) => {
    if (k === '⌫') setId(id.slice(0, -1))
    else if (k === '✓') submit()
    else if (id.length < 4) setId(id + k)
  }

  return (
    <div className="punch">
      <div className="punch-card">
        <div className="row" style={{ marginBottom: 18 }}>
          <div className="brand-mark" style={{ width: 52, height: 52, fontSize: 19, borderRadius: 12 }}>CAT</div>
          <div>
            <div style={{ fontSize: 22, fontWeight: 800 }}>COPS</div>
            <div className="small muted">Caterpillar Operator Protection System</div>
          </div>
        </div>
        <div className="xpbar" style={{ height: 8 }}><div style={{ width: '100%' }} /></div>
        <div className="era"><span>1925 · BATTLESHIP GRAY</span><span>1931 → HI-WAY YELLOW</span></div>

        {notice && <div className="card" style={{ marginTop: 16, borderColor: 'var(--green)' }}>{notice}</div>}

        {pending.map((p) => (
          <div key={p.id} className="card pending-ho" style={{ marginTop: 16 }}>
            <b>⚠️ Handover waiting on {p.machine_id}</b>
            <div className="small" style={{ marginTop: 4 }}>{p.from} left the shift ({p.reason.toLowerCase()}). Next operator: punch in to receive the briefing.</div>
          </div>
        ))}

        <div className="card hero" style={{ marginTop: 16 }}>
          <h3>🪪 Punch in with your Operator ID</h3>
          <div className={`id-display ${id.length === 4 ? 'ok' : ''}`}>OP{id.padEnd(4, '·')}</div>
          <div className="keypad">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', '✓'].map((k) => (
              <button key={k} className={`btn ${k === '✓' ? 'primary' : ''}`} disabled={busy || (k === '✓' && id.length !== 4)} onClick={() => press(k)}>{k}</button>
            ))}
          </div>
          {error && <div className="small" style={{ color: 'var(--red)', marginTop: 10 }}>⚠️ {error}</div>}
          <div className="small muted" style={{ marginTop: 14 }}>Demo operators (tap to punch in):</div>
          <div className="grid g3" style={{ marginTop: 8 }}>
            {ops.map((o) => (
              <button key={o.id} className="btn" style={{ flexDirection: 'column', minHeight: 76, gap: 4 }} onClick={() => submit(o.id)} disabled={busy}>
                <span>👷 {o.name.split(' ')[0]}</span>
                <span className="small mono muted">{o.id}</span>
                <SkillChip skill={o.skill} />
              </button>
            ))}
          </div>
        </div>
        <button className="btn" style={{ width: '100%', marginTop: 14 }} onClick={onSupervisor}>🧑‍💼 Supervisor console: live SOS, machine health & replays</button>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ handover (outgoing operator)
export function HandoverDialog({ opId, machineId, schedule, onClose, onDone }) {
  const [reasons, setReasons] = useState([])
  const [reason, setReason] = useState('')
  const current = schedule?.tasks.find((t) => t.status === 'in_progress' || t.status === 'paused')
  const [progress, setProgress] = useState(50)
  const [note, setNote] = useState('')
  const [listening, setListening] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => { api.handoverReasons().then((r) => { setReasons(r); setReason(r[0]) }) }, [])

  const dictate = () => {
    setListening(true)
    let finalText = ''
    listenOnce({
      onResult: (t, isFinal) => { if (isFinal) finalText = t },
      onEnd: () => { setListening(false); if (finalText) setNote((n) => (n ? `${n} ${finalText}` : finalText)) },
      onError: () => setListening(false),
    })
  }

  const submit = async () => {
    setBusy(true)
    const h = await api.createHandover({ operator_id: opId, machine_id: machineId, reason, note, progress: progress / 100 })
    speak('Handover recorded. The next operator will be briefed.', { force: true })
    onDone(h)
  }

  const done = schedule?.tasks.filter((t) => t.status === 'done') || []
  return (
    <Modal onClose={onClose}>
      <h3>⇄ End shift / emergency handover</h3>
      <p className="small muted">Your work is saved to the machine. The next operator who punches in on {machineId} gets an automatic briefing.</p>
      <div className="small"><b>Reason</b></div>
      <div className="row wrap" style={{ gap: 6, marginTop: 6 }}>
        {reasons.map((r) => <button key={r} className={`btn sm ${reason === r ? 'primary' : ''}`} onClick={() => setReason(r)}>{r}</button>)}
      </div>
      <div className="list-item" style={{ marginTop: 14 }}>
        ✅ {done.length} task{done.length !== 1 ? 's' : ''} completed this shift{done.length ? `: ${done.map((t) => t.task_type).join(', ')}` : ''}
      </div>
      {current && (
        <label className="field" style={{ marginTop: 14 }}>
          How far did you get with {TASK_ICON[current.task_type]} {current.task_type}? <b style={{ color: 'var(--text)' }}>{progress}%</b>
          <input type="range" min="0" max="95" step="5" value={progress} onChange={(e) => setProgress(Number(e.target.value))} />
        </label>
      )}
      <label className="field" style={{ marginTop: 10 }}>Note for the next operator (optional)
        <div className="row" style={{ alignItems: 'stretch' }}>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Trench at East gate is open, barricade not placed yet" />
          <button className={`btn round ${listening ? 'danger mic live' : ''}`} onClick={dictate} aria-label="Dictate note">🎙️</button>
        </div>
      </label>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn danger" onClick={submit} disabled={busy || !reason}>Hand over & punch out</button>
      </div>
    </Modal>
  )
}

// ------------------------------------------------------------------ briefing (incoming operator)
export function Briefing({ brief, operator, onAck, onClose }) {
  const [read, setRead] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => speak(`Handover briefing. ${brief.summary}`, { force: true }), 400)
    return () => { clearTimeout(t); window.speechSynthesis?.cancel() }
  }, [brief])
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  const emergency = !brief.reason.toLowerCase().startsWith('planned')

  return (
    <div className="overlay" onClick={onClose}>
      <div className="card dialog hero" style={{ width: 'min(760px, 100%)', paddingBottom: 0 }} onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ marginBottom: 12, paddingRight: 90 }}>
          <h3 style={{ margin: 0, padding: 0 }}>📋 Shift handover briefing · {brief.machine_id}</h3>
          <div className="spacer" />
          <button className="btn sm ghost" onClick={onClose} title="Close and read later (Esc)" aria-label="Close">✕</button>
        </div>
        <AIBadge c={brief.confidence} />
        <div className="row wrap small" style={{ marginBottom: 12 }}>
          <span className={`chip ${emergency ? 'bad' : 'info'}`}>{emergency ? '⚠️' : '🕗'} {brief.reason}</span>
          <span className="chip">From {brief.from_operator.name}</span>
          <span className="chip">Shift {brief.shift.start}–{brief.shift.end}</span>
          <span className="chip">Handed over {brief.shift.handover_at}</span>
          <span className="chip info">Left in shift: {brief.shift.left_in_shift}</span>
        </div>
        <div className="brief-summary">🔊 {brief.summary}
          <button className="btn sm ghost" style={{ marginLeft: 8, minHeight: 28 }} onClick={() => speak(brief.summary, { force: true })}>Replay</button>
        </div>

        <div className="grid g2" style={{ marginTop: 4 }}>
          <div className="brief-sec">
            <h4>✅ Done ({brief.done.length})</h4>
            {brief.done.length === 0 && <div className="small muted">Nothing completed yet.</div>}
            {brief.done.map((t) => (
              <div key={t.task_id} className="list-item small">{TASK_ICON[t.task_type]} <b>{t.task_type}</b> · {t.actual_min} min <span className="muted">· {t.done_by}</span></div>
            ))}
          </div>
          <div className="brief-sec">
            <h4>⏸ In progress</h4>
            {brief.current ? (
              <div className="list-item small">
                {TASK_ICON[brief.current.task_type]} <b>{brief.current.task_type}</b> · {brief.current.site}
                <div className="progress" style={{ margin: '8px 0 4px' }}><div style={{ width: `${brief.current.progress * 100}%` }} /></div>
                {Math.round(brief.current.progress * 100)}% done · ~{brief.current.remaining_min} min left
              </div>
            ) : <div className="small muted">No task was mid-way.</div>}
          </div>
        </div>

        <div className="brief-sec">
          <h4>⏳ Remaining ({brief.remaining.length}) · about {Math.floor(brief.remaining_min / 60)}h {brief.remaining_min % 60}m at your pace · ETA {brief.eta}</h4>
          {brief.remaining.map((t) => (
            <div key={t.task_id} className="list-item small row">
              <span>{TASK_ICON[t.task_type]} <b>{t.task_type}</b> · {t.site}</span>
              <div className="spacer" />
              <span className="chip">{WEATHER_ICON[t.weather]} {t.weather}</span>
              <span className="mono">{t.predicted_min} min</span>
            </div>
          ))}
          {brief.overflow_min > 0 && (
            <div className="advice" style={{ marginTop: 8, borderLeft: '4px solid var(--amber)' }}>
              <span className="ic">⏰</span><span>Work runs about <b>{brief.overflow_min} min past the {brief.shift.end} shift end</b>. Tell your supervisor, or leave low-priority tasks for the next shift.</span>
            </div>
          )}
        </div>

        {brief.hazards.length > 0 && (
          <div className="brief-sec">
            <h4>⚠️ Watch out</h4>
            {brief.hazards.map((h, i) => <div key={i} className="advice"><span className="ic">⚠️</span><span>{h}</span></div>)}
            {brief.events && <div className="small muted" style={{ marginTop: 6 }}>Safety alerts in previous shift: {brief.events}</div>}
          </div>
        )}

        {brief.note && (
          <div className="brief-sec">
            <h4>📝 Note from {brief.from_operator.name.split(' ')[0]}</h4>
            <div className="list-item">“{brief.note}”</div>
          </div>
        )}

        {brief.machine?.engine_hours && (
          <div className="small muted" style={{ marginTop: 10 }}>
            🚜 Machine: {brief.machine.engine_hours} engine hours · last seatbelt reading {brief.machine.seatbelt}
          </div>
        )}

        {/* Sticky footer: acknowledging is always one tap away, no scrolling needed */}
        <div className="brief-footer">
          <div className={`check ${read ? 'on' : ''}`} onClick={() => setRead(!read)} role="checkbox" aria-checked={read} style={{ flex: 1 }}>
            <div className="box">{read ? '✓' : ''}</div>
            <span className="small">I, {operator.name}, have read the briefing and checked the hazards.</span>
          </div>
          <button className="btn ghost" onClick={onClose}>Read later</button>
          <button className="btn primary" disabled={!read} onClick={onAck}>Acknowledge & take over</button>
        </div>
      </div>
    </div>
  )
}
