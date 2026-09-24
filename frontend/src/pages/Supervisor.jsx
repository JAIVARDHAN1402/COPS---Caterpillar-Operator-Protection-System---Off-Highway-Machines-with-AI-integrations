import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { TRIGGER_LABEL } from '../blackbox'
import { siren, speak } from '../voice'
import Twin from './Twin'

const HEALTH = { ok: ['✅ Normal', 'good'], warn: ['⚠️ Attention', 'warn'], crit: ['🛑 Critical', 'bad'] }
const EVENT_ICON = { seatbelt: '🪢', proximity: '👷', fatigue: '😴', health: '🛢️', sos: '🆘', man_down: '🚜' }

const SMS_STATUS = {
  sent: ['✓ Sent', 'good'], simulated: ['Simulated', 'info'], queued: ['Sending…', 'warn'],
  failed: ['✗ Failed', 'bad'], rate_limited: ['Rate-limited', 'warn'],
}
const SEV_CLS = { CRITICAL: 'bad', HIGH: 'warn', MEDIUM: 'info', INFO: '' }

function SmsPanel({ sms, onChange }) {
  const [to, setTo] = useState(sms.to.join(', '))
  const [msg, setMsg] = useState('')
  useEffect(() => { setTo((cur) => cur || sms.to.join(', ')) }, [sms.to])
  const save = async () => {
    try { await api.smsConfig(to); setMsg('✓ Saved'); onChange() } catch (e) { setMsg(`⚠️ ${e.message}`) }
  }
  const test = async () => { await api.smsTest(); setMsg('Test SMS queued'); onChange() }
  return (
    <div className="card" style={{ borderColor: sms.live ? 'var(--green)' : 'var(--amber)' }}>
      <h3>📨 WhatsApp & SMS alerts to supervisor</h3>
      <div className="row wrap small" style={{ gap: 8 }}>
        <span className={`chip ${sms.wa_live ? 'good' : 'warn'}`}>
          {sms.wa_live ? `🟢 WhatsApp live via ${sms.wa_provider === 'callmebot' ? 'CallMeBot' : 'Twilio'}` : '🟡 WhatsApp simulated: no key'}
        </span>
        <span className={`chip ${sms.live ? 'good' : 'warn'}`}>
          {sms.live ? `📱 SMS live via ${sms.provider === 'fast2sms' ? 'Fast2SMS' : 'Twilio'}` : '🟡 SMS simulated: no key'}
        </span>
        <span className="chip">{sms.wa_sent_last_hour} WhatsApp · {sms.sent_last_hour} SMS this hour (cap {sms.hourly_cap})</span>
        <span className="chip">Duplicates suppressed for {sms.dedupe_s / 60} min</span>
      </div>
      <p className="small muted">
        <b>WhatsApp + SMS</b> for high-risk situations: high-risk or escalated SOS, emergency machine stop, engine idling with no work
        (fuel waste), microsleep and critical machine faults. <b>SMS</b> for other discrepancies: seatbelt, danger-zone, fluid warnings,
        incidents, handovers. <b>Manageable</b> SOS are handled by the operator and only escalate if unresolved.
        {(!sms.live || !sms.wa_live) && ' To send for real, add CALLMEBOT_API_KEY (WhatsApp) and/or FAST2SMS_API_KEY (SMS) to backend/.env and restart the API.'}
      </p>
      <div className="row wrap" style={{ gap: 8 }}>
        <input type="text" value={to} onChange={(e) => setTo(e.target.value)} placeholder="Supervisor mobile number(s)" style={{ maxWidth: 320 }} />
        <button className="btn sm" onClick={save}>Save number</button>
        <button className="btn sm primary" onClick={test}>📱 Test SMS</button>
        <button className="btn sm good" onClick={async () => { await api.smsTest('whatsapp'); setMsg('Test WhatsApp queued'); onChange() }}>🟢 Test WhatsApp</button>
        <span className="small">{msg}</span>
      </div>
      <div style={{ maxHeight: 300, overflow: 'auto', marginTop: 12 }}>
        {sms.outbox.length === 0 && <div className="small muted">No SMS alerts yet.</div>}
        {sms.outbox.map((m) => {
          const [label, cls] = SMS_STATUS[m.status] || [m.status, '']
          return (
            <div key={m.id} className="list-item small">
              <div className="row wrap" style={{ gap: 6 }}>
                <b className="mono">{m.id}</b>
                <span>{m.channel === 'whatsapp' ? '🟢 WhatsApp' : '📱 SMS'}</span>
                <span className={`chip ${SEV_CLS[m.severity] || ''}`}>{m.severity}</span>
                <span className={`chip ${cls}`}>{label}</span>
                <span className="muted">→ {m.to.join(', ') || 'no number'} · {m.time.slice(11, 19)}</span>
              </div>
              <div className="sms-text">{m.text}</div>
              {m.detail && <div className="muted" style={{ marginTop: 4 }}>{m.detail}</div>}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default function Supervisor({ onBack }) {
  const [d, setD] = useState(null)
  const [sound, setSound] = useState(false)
  const [replay, setReplay] = useState(null)
  const [error, setError] = useState('')
  const known = useRef(new Set())

  useEffect(() => {
    const load = () => api.supervisor().then((x) => { setD(x); setError('') }).catch(() => setError('Backend not reachable'))
    load()
    const i = setInterval(load, 3000)
    return () => clearInterval(i)
  }, [])

  // New SOS → voice announcement; keep the siren going while any SOS is unacknowledged
  const active = d?.sos.filter((s) => s.status === 'active') || []
  useEffect(() => {
    if (!d || !sound) return
    d.sos.forEach((s) => {
      if (!known.current.has(s.id)) {
        known.current.add(s.id)
        if (s.status === 'active') speak(`Emergency! SOS from ${s.operator_name} on ${s.machine_id}. ${s.type.replace('_', ' ')}.`, { force: true })
      }
    })
  }, [d, sound])
  useEffect(() => {
    if (!sound || active.length === 0) return
    siren()
    const i = setInterval(siren, 2500)
    return () => clearInterval(i)
  }, [sound, active.length])

  const act = async (fn) => { await fn(); setD(await api.supervisor()) }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">CAT</div>
          <div>COPS · Supervisor Console<small>Live fleet safety & emergencies</small></div>
        </div>
        <div className="spacer" />
        {active.length > 0 && <span className="chip bad" style={{ fontSize: 14 }}>🆘 {active.length} active SOS</span>}
        <button className={`btn sm ${sound ? 'good' : 'danger'}`} onClick={() => { setSound(!sound); if (!sound) speak('Supervisor alerts on.', { force: true }) }}>
          {sound ? '🔊 Alert sound ON' : '🔇 Enable alert sound'}
        </button>
        <button className="btn sm ghost" onClick={onBack}>← Operator punch-in</button>
      </header>

      <main>
        {error && <div className="card" style={{ borderColor: 'var(--red)' }}>⚠️ {error}</div>}
        {!d ? <div className="muted">Loading fleet…</div> : (
          <div className="grid" style={{ gap: 16 }}>
            <div className="card" style={{ borderColor: active.length ? 'var(--red)' : 'var(--line)' }}>
              <h3>🆘 Emergencies</h3>
              {d.sos.length === 0 && <div className="small muted">No active SOS. Operators can raise one from the SOS button, by voice ("Help!"), or automatically after a rollover or a missed check-in.</div>}
              {d.sos.map((s) => (
                <div key={s.id} className={`sos-card ${s.status}`}>
                  <div className="row wrap">
                    <b style={{ fontSize: 18 }}>🆘 {s.operator_name} · {s.machine_id}</b>
                    <span className={`chip ${s.risk === 'manageable' ? 'warn' : 'bad'}`}>{s.risk === 'manageable' ? '🛠️ Manageable' : s.escalated ? '⬆️ Escalated' : '🚨 High-risk'}</span>
                    <span className="chip">{s.category || s.type.replace('_', ' ')}</span>
                    <span className="chip">{s.time.slice(11, 19)}</span>
                    <span className={`chip ${s.status === 'active' ? 'bad' : 'warn'}`}>{s.status === 'active' ? 'UNACKNOWLEDGED' : s.status === 'self_handling' ? 'Operator handling it' : `Acknowledged by ${s.acknowledged_by}`}</span>
                  </div>
                  <div className="small" style={{ marginTop: 6 }}>{s.detail}</div>
                  <div className="small" style={{ marginTop: 6 }}>
                    📍 {s.location_label} · <span className="mono">{s.lat}, {s.lon}</span>{' '}
                    {s.lat != null && <a href={`https://www.google.com/maps?q=${s.lat},${s.lon}`} target="_blank" rel="noreferrer" style={{ color: 'var(--yellow)' }}>Open in Maps ↗</a>}
                  </div>
                  <div className="row wrap" style={{ marginTop: 10, gap: 8 }}>
                    {s.status === 'active' && <button className="btn sm danger" onClick={() => act(() => api.ackSos(s.id, 'Supervisor'))}>✋ Acknowledge: help on the way</button>}
                    <button className="btn sm good" onClick={() => act(() => api.resolveSos(s.id, 'Operator safe'))}>✓ Resolve: operator safe</button>
                  </div>
                </div>
              ))}
            </div>

            <SmsPanel sms={d.sms} onChange={async () => setD(await api.supervisor())} />

            <div className="grid g3">
              {d.machines.map((m) => {
                const h = m.health
                const [label, cls] = HEALTH[h.overall]
                return (
                  <div key={m.machine_id} className="card">
                    <div className="row"><b>🚜 {m.machine} · {m.machine_id}</b><div className="spacer" /><span className={`chip ${cls}`}>{label}</span></div>
                    <div className="small muted" style={{ marginTop: 4 }}>{m.operator ? `👷 ${m.operator}` : 'No operator punched in'} · {h.engine_on ? (h.working ? '⚙️ working' : '⚙️ idle') : '⏻ engine off'}</div>
                    <div className="mini-gauges">
                      {h.channels.filter((c) => ['engine_oil', 'coolant', 'hydraulic_oil', 'fuel', 'engine_temp', 'hydraulic_temp'].includes(c.key)).map((c) => (
                        <div key={c.key} className={`mini ${c.status}`}>
                          <span className="small muted">{c.label.replace(' level', '').replace('Engine coolant temp', 'Engine temp')}</span>
                          <b className="mono">{c.value}{c.unit}</b>
                        </div>
                      ))}
                    </div>
                    {h.anomalies.map((a) => <div key={a.key} className="small" style={{ color: 'var(--red)', marginTop: 6 }}>🔎 {a.title}</div>)}
                    {h.alerts.filter((a) => a.status === 'crit').map((a) => <div key={a.key} className="small" style={{ color: 'var(--red)', marginTop: 4 }}>🛑 {a.label}: {a.value}{a.unit}</div>)}
                  </div>
                )
              })}
            </div>

            <div className="split">
              <div className="card">
                <h3>📡 Live safety events (all operators)</h3>
                <div style={{ maxHeight: 360, overflow: 'auto' }}>
                  {d.events.length === 0 && <div className="small muted">No events yet.</div>}
                  {d.events.map((e, i) => (
                    <div key={i} className="list-item row small">
                      <span>{EVENT_ICON[e.type] || '•'}</span>
                      <span><b>{e.operator_id}</b> {e.machine_id && `· ${e.machine_id}`}: {e.detail}</span>
                      <div className="spacer" />
                      <span className="muted mono">{e.time.slice(11, 19)}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="grid" style={{ gap: 16 }}>
                <div className="card">
                  <h3>🎬 Black-box recordings</h3>
                  {d.blackbox.length === 0 && <div className="small muted">None yet.</div>}
                  {d.blackbox.slice(0, 8).map((r) => (
                    <div key={r.id} className="list-item row small">
                      <span><b className="mono">{r.id}</b> {TRIGGER_LABEL[r.trigger] || r.trigger}<br /><span className="muted">{r.operator_name} · {r.machine_id} · {r.time.slice(11, 19)}</span></span>
                      <div className="spacer" />
                      <button className="btn sm primary" onClick={async () => setReplay(await api.blackbox(r.id))}>▶ Replay</button>
                    </div>
                  ))}
                </div>
                <div className="card">
                  <h3>⇄ Pending handovers</h3>
                  {d.handovers.length === 0 && <div className="small muted">None.</div>}
                  {d.handovers.map((h) => <div key={h.id} className="list-item small">{h.machine_id}: {h.from_name} left ({h.reason.toLowerCase()})</div>)}
                </div>
                <div className="card">
                  <h3>📝 Recent incidents</h3>
                  {d.incidents.length === 0 && <div className="small muted">None.</div>}
                  {d.incidents.map((i) => <div key={i.id} className="list-item small"><b className="mono">{i.id}</b> {i.primary_type} · {i.severity} · {i.location}</div>)}
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {replay && (
        <div className="overlay" onClick={() => setReplay(null)}>
          <div className="card dialog" style={{ width: 'min(1200px, 100%)' }} onClick={(e) => e.stopPropagation()}>
            <div className="row" style={{ marginBottom: 10 }}><h3 style={{ margin: 0 }}>🎬 Black-box replay</h3><div className="spacer" /><button className="btn sm ghost" onClick={() => setReplay(null)}>✕</button></div>
            <Twin key={replay.id} replayOnly initialReplay={replay} machineId={replay.machine_id} />
          </div>
        </div>
      )}
    </div>
  )
}
