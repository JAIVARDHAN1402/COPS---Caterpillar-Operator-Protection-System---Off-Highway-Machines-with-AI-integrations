import { useEffect, useState } from 'react'
import { api } from '../api'
import { TRIGGER_LABEL } from '../blackbox'
import { ScoreRing, TASK_ICON } from '../components'

const hm = (s) => { s = Math.round(s || 0); return s >= 3600 ? `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` }
const ICON = { seatbelt: '🪢', proximity: '👷', fatigue: '😴', health: '🛢️', sos: '🆘', machine_stop: '⛔', man_down: '🚜', idle: '💤' }
const LEVEL = { ok: ['✅', 'win'], info: ['ℹ️', 'tip'], warn: ['⚠️', 'warn'], bad: ['🛑', 'fix'] } // icon, .coach colour
const STATUS = { sent: 'good', simulated: 'info', queued: 'warn', failed: 'bad', rate_limited: 'warn' }

export default function ShiftReport({ opId, machineId, notify }) {
  const [r, setR] = useState(null)
  const [sending, setSending] = useState(false)
  const load = () => api.shiftReport(opId, machineId).then(setR).catch(() => {})
  useEffect(() => { load(); const i = setInterval(load, 5000); return () => clearInterval(i) }, [opId, machineId]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!r) return <div className="muted">Building the shift report…</div>

  const u = r.utilisation
  const workPct = u.engine_s ? Math.round((100 * u.work_s) / u.engine_s) : 0
  const send = async () => {
    setSending(true)
    await api.sendShiftReport(opId, machineId).catch(() => {})
    notify?.('📤 Shift report sent to the supervisor on WhatsApp + SMS')
    setSending(false)
    load()
  }

  return (
    <div className="grid shift-report" style={{ gap: 16 }}>
      <div className="card hero">
        <div className="row wrap" style={{ gap: 16 }}>
          <ScoreRing score={r.rating} size={74} stroke={8} />
          <div>
            <div className="small muted">Shift report · {r.date} · shift {r.shift.start}–{r.shift.end}</div>
            <div style={{ fontSize: 22, fontWeight: 800 }}>👷 {r.operator.name} · 🚜 {r.machine.machine} ({r.machine.machine_id})</div>
            <div className="small muted">Shift rating {r.rating}/100 · auto-generated {r.generated.slice(11, 19)} · updates live</div>
            <div className="row wrap small" style={{ gap: 6, marginTop: 6 }}>
              {r.rating_breakdown.length
                ? r.rating_breakdown.map((b) => <span key={b.label} className="chip bad">−{-b.points} {b.label}</span>)
                : <span className="chip good">No deductions</span>}
              <span className="muted">SOS and machine faults never lower the rating.</span>
            </div>
          </div>
          <div className="spacer" />
          <div className="row no-print" style={{ gap: 8 }}>
            <button className="btn sm primary" onClick={send} disabled={sending}>🟢 Send to supervisor (WhatsApp)</button>
            <button className="btn sm" onClick={() => window.print()}>🖨️ Print / PDF</button>
          </div>
        </div>
      </div>

      <div className="grid g4">
        <div className="card kpi"><span className="label">Engine running</span><span className="value">{hm(u.engine_s)}</span><span className="hint">{u.idle_episodes} idle episode(s), longest {hm(u.longest_idle_s)}</span></div>
        <div className="card kpi"><span className="label">Working</span><span className="value" style={{ color: 'var(--green)' }}>{hm(u.work_s)}</span><span className="hint">{workPct}% of engine time</span></div>
        <div className="card kpi"><span className="label">Idle, no work</span><span className="value" style={{ color: u.idle_pct > 30 ? 'var(--red)' : undefined }}>{hm(u.idle_s)}</span><span className="hint">{u.idle_pct}% of engine time</span></div>
        <div className="card kpi"><span className="label">Fuel wasted idling</span><span className="value" style={{ color: 'var(--red)' }}>{u.idle_fuel_l.toFixed(2)} L</span><span className="hint">≈ ₹{u.idle_cost_inr} · {u.idle_co2_kg} kg CO₂ · total fuel {u.fuel_l.toFixed(2)} L (₹{u.fuel_cost_inr})</span></div>
      </div>

      <div className="card">
        <h3>⏱️ Engine time split</h3>
        <div className="util-bar">
          {!u.engine_s && <div className="empty">Engine not started yet</div>}
          {u.engine_s > 0 && workPct > 0 && <div className="work" style={{ width: `${workPct}%` }}>{workPct >= 14 ? `Working ${workPct}%` : ''}</div>}
          {u.engine_s > 0 && workPct < 100 && <div className="idle" style={{ width: `${100 - workPct}%` }}>{100 - workPct >= 14 ? `Idle ${100 - workPct}%` : ''}</div>}
        </div>
        <div className="small muted" style={{ marginTop: 6 }}>Fuel from real burn rates: {u.work_lph} L/h working, {u.idle_lph} L/h idling. Idle without work for {60} s+ sends a WhatsApp alert to the supervisor.</div>
      </div>

      <div className="split">
        <div className="card">
          <h3>🧠 Smart findings</h3>
          {r.findings.map((f, i) => (
            <div key={i} className={`coach ${LEVEL[f.level][1]}`}>
              <span>{LEVEL[f.level][0]}</span><span>{f.text}</span>
            </div>
          ))}
        </div>
        <div className="card">
          <h3>📋 Tasks</h3>
          {r.tasks.map((t) => (
            <div key={t.task_id} className="list-item row small">
              <span>{TASK_ICON[t.task_type]} <b>{t.task_type}</b></span>
              <div className="spacer" />
              {t.status === 'done'
                ? <span className="chip good">✓ {t.actual_min} min <span className="muted">(AI {t.predicted_min})</span>{t.done_by ? ` · ${t.done_by.split(' ')[0]}` : ''}</span>
                : <span className={`chip ${t.status === 'in_progress' ? 'yellow' : t.status === 'paused' ? 'warn' : ''}`}>{t.status.replace('_', ' ')}</span>}
            </div>
          ))}
          <div className="row wrap small" style={{ gap: 6, marginTop: 12 }}>
            {Object.entries(r.counts).filter(([, n]) => n).map(([k, n]) => <span key={k} className="chip">{ICON[k]} {n} {k.replace('_', ' ')}</span>)}
          </div>
        </div>
      </div>

      <div className="split">
        <div className="card">
          <h3>🆘 SOS & incidents</h3>
          {r.sos.length === 0 && r.incidents.length === 0 && <div className="small muted">None this shift.</div>}
          {r.sos.map((x) => (
            <div key={x.id} className="list-item small">
              <b className="mono">{x.id}</b> <span className={`chip ${x.risk === 'high' ? 'bad' : 'warn'}`}>{x.risk === 'high' ? (x.escalated ? 'Escalated' : 'High-risk') : 'Manageable'}</span>{' '}
              {x.category || x.type} · {x.time.slice(11, 16)} · <span className="muted">{x.status.replace('_', ' ')}{x.resolved_note ? `: ${x.resolved_note}` : ''}</span>
            </div>
          ))}
          {r.incidents.map((i) => <div key={i.id} className="list-item small"><b className="mono">{i.id}</b> {i.primary_type} ({i.severity}) · {i.location} · {i.time.slice(11, 16)}</div>)}
          {r.recordings.length > 0 && <div className="small muted" style={{ marginTop: 8 }}>🎬 {r.recordings.length} black-box recording(s): {r.recordings.map((x) => TRIGGER_LABEL[x.trigger] || x.trigger).join(', ')}. Replay them in the Digital Twin.</div>}
        </div>
        <div className="card">
          <h3>📨 Messages sent to the supervisor</h3>
          {r.notifications.length === 0 && <div className="small muted">None this shift.</div>}
          <div style={{ maxHeight: 280, overflow: 'auto' }}>
            {r.notifications.map((n) => (
              <div key={n.id} className="list-item small">
                <div className="row wrap" style={{ gap: 6 }}>
                  <span>{n.channel === 'whatsapp' ? '🟢 WhatsApp' : '📱 SMS'}</span>
                  <span className={`chip ${n.severity === 'CRITICAL' ? 'bad' : n.severity === 'HIGH' ? 'warn' : ''}`}>{n.severity}</span>
                  <span className={`chip ${STATUS[n.status] || ''}`}>{n.status}</span>
                  <span className="muted">{n.time.slice(11, 19)} → {n.to.join(', ')}</span>
                </div>
                <div className="sms-text" style={{ whiteSpace: 'pre-wrap' }}>{n.text}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="card">
        <h3>📜 Full shift log</h3>
        {r.timeline.length === 0 && <div className="small muted">No events yet.</div>}
        <div className="timeline">
          {r.timeline.map((e, i) => (
            <div key={i} className={`tl-item ${e.type}`}>
              <span className="mono small muted">{e.time.slice(11, 19)}</span>
              <span>{ICON[e.type] || '•'}</span>
              <span className="small"><b style={{ textTransform: 'capitalize' }}>{e.type.replace('_', ' ')}</b>: {e.detail}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
