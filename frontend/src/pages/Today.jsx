import { useState } from 'react'
import { AIBadge, CHECKLIST, TASK_ICON, WEATHER_ICON, Waterfall } from '../components'

function conditionAdvice(forecast) {
  const out = []
  const maxHeat = Math.max(...forecast.map((h) => h.heat_index))
  const rain = forecast.filter((h) => h.condition === 'Rainy').map((h) => h.hour)
  const wind = forecast.filter((h) => h.condition === 'Windy')
  if (maxHeat >= 38) {
    const hot = forecast.filter((h) => h.heat_index >= 38).map((h) => h.hour)
    out.push({ ic: '💧', text: `Heat index up to ${maxHeat}°C between ${hot[0]}:00–${hot[hot.length - 1] + 1}:00. Drink water every 30 min; COPS will remind you.` })
  }
  if (rain.length) out.push({ ic: '🌧️', text: `Rain ${rain[0]}:00–${rain[rain.length - 1] + 1}:00. Keep machine & spoil pile ≥1 m from trench edges; watch for wall cracks.` })
  if (wind.length) out.push({ ic: '💨', text: `Wind up to ${Math.max(...wind.map((w) => w.wind_kmh))} km/h at ${wind.map((w) => w.hour + ':00').join(', ')}. Pause high-reach demolition; use dust suppression.` })
  out.push({ ic: '👀', text: 'Rear swing zone: keep 3 m + swing radius clear. Proximity camera is active.' })
  return out
}

export default function Today({ schedule, profile, checks, toggleCheck, walkaroundDone, startTask, seatbelt, onComplete, briefPending, openBrief }) {
  const [open, setOpen] = useState(null)
  if (!schedule) return <div className="muted">Loading your day…</div>
  const nowHour = new Date().getHours()
  const done = schedule.tasks.filter((t) => t.status === 'done').length
  const saved = schedule.naive_risky_tasks - schedule.planned_risky_tasks

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="row wrap" style={{ justifyContent: 'space-between' }}>
        <div>
          <h2 style={{ margin: 0 }}>Good {nowHour < 12 ? 'morning' : nowHour < 17 ? 'afternoon' : 'evening'}, {profile?.name.split(' ')[0]} 👋</h2>
          <div className="muted">{new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })} · {done}/{schedule.tasks.length} tasks done</div>
        </div>
        <span className="chip">🕗 Shift {schedule.shift.start}–{schedule.shift.end} · {schedule.machine.machine_id}</span>
      </div>

      {schedule.handover && (
        <div className="card row wrap" style={{ borderColor: briefPending ? 'var(--amber)' : 'var(--line)' }}>
          <span style={{ fontSize: 22 }}>⇄</span>
          <span style={{ flex: 1 }}>
            Taken over from <b>{schedule.handover.from}</b> at {schedule.handover.at} ({schedule.handover.reason.toLowerCase()}).
            {briefPending ? ' Briefing not yet acknowledged. Tasks are locked until you read it.' : ' Briefing acknowledged ✓'}
          </span>
          <button className={`btn sm ${briefPending ? 'primary' : ''}`} onClick={() => openBrief(schedule.handover.id)}>📋 {briefPending ? 'Read briefing' : 'View briefing'}</button>
        </div>
      )}

      <div className="grid g4">
        <div className="card kpi">
          <span className="label">Tasks today</span>
          <span className="value">{schedule.tasks.length}</span>
          <span className="hint">{done} completed</span>
        </div>
        <div className="card kpi">
          <AIBadge c={schedule.tasks[0]?.prediction.confidence} />
          <span className="label">AI predicted work time</span>
          <span className="value">{Math.floor(schedule.predicted_total / 60)}h {schedule.predicted_total % 60}m</span>
          <span className="hint">Site's static estimate: {Math.floor(schedule.site_estimate_total / 60)}h {schedule.site_estimate_total % 60}m</span>
        </div>
        <div className="card kpi">
          <span className="label">Weather risks avoided</span>
          <span className="value" style={{ color: saved > 0 ? 'var(--green)' : undefined }}>{saved}</span>
          <span className="hint">Tasks moved out of risky weather by the smart scheduler</span>
        </div>
        <div className="card kpi">
          <span className="label">Pre-shift check</span>
          <span className="value" style={{ color: walkaroundDone ? 'var(--green)' : 'var(--amber)' }}>{checks.length}/{CHECKLIST.length}</span>
          <span className="hint">{walkaroundDone ? 'Machine cleared for work' : 'Required before first task'}</span>
        </div>
      </div>

      <div className="card">
        <h3>🌤️ Site forecast</h3>
        <div className="forecast">
          {schedule.forecast.map((h) => (
            <div key={h.hour} className={`hour ${h.condition} ${h.hour === nowHour ? 'now' : ''}`}>
              <div className="muted">{h.hour}:00</div>
              <div className="ic">{WEATHER_ICON[h.condition]}</div>
              <div className="mono" style={{ fontWeight: 700 }}>{Math.round(h.temp_c)}°</div>
              {h.condition === 'Windy' && <div className="small">{h.wind_kmh}km/h</div>}
            </div>
          ))}
        </div>
      </div>

      <div className="split">
        <div className="card hero">
          <AIBadge c={schedule.confidence} />
          <h3>📋 Smart schedule <span className="chip info">weather-optimised</span></h3>
          <p className="card-sub">Tasks are re-ordered so trenching & grading avoid rain and demolition avoids wind. Times are ML predictions for <b>your</b> skill, machine and weather.</p>
          {schedule.tasks.map((t) => {
            const locked = !walkaroundDone
            return (
              <div key={t.task_id}>
                {t.wait_before > 0 && (
                  <div className="wait">⏸ Wait {t.wait_before} min for the weather to clear — use it as a hydration break</div>
                )}
                <div className={`task ${t.status}`}>
                  <div>
                    <div className="time">{t.start}</div>
                    <div className="small muted mono">→ {t.end}</div>
                  </div>
                  <div>
                    <div className="row wrap" style={{ gap: 8 }}>
                      <span className="title">{TASK_ICON[t.task_type]} {t.task_type}</span>
                      <span className="chip">{WEATHER_ICON[t.weather]} {t.weather}</span>
                      {t.risk !== 'low' && <span className={`chip ${t.risk === 'high' ? 'bad' : 'warn'}`}>{t.risk} weather risk</span>}
                      <span className={`chip ${t.priority === 'High' ? 'yellow' : ''}`}>{t.priority}</span>
                      {t.status === 'done' && <span className="chip good">✓ Done in {t.actual_min} min{t.done_by_name && profile && t.done_by_name !== profile.name ? ` · by ${t.done_by_name.split(' ')[0]}` : ''}</span>}
                      {t.status === 'paused' && <span className="chip warn">⏸ Paused at {Math.round(t.progress * 100)}%{t.done_by_name ? ` by ${t.done_by_name.split(' ')[0]}` : ''}</span>}
                      {t.status === 'in_progress' && <span className="chip yellow">● In progress</span>}
                    </div>
                    <div className="small muted" style={{ marginTop: 4 }}>{t.task_id} · {t.site}</div>
                    {t.status === 'paused' && t.progress > 0 && (
                      <div className="progress" style={{ marginTop: 8, maxWidth: 320 }}><div style={{ width: `${t.progress * 100}%` }} /></div>
                    )}
                    <div className="small" style={{ marginTop: 6 }}>
                      ⏱️ Predicted <span className="range">{t.prediction.predicted_min} min</span>
                      <span className="muted"> (80% range {t.prediction.low_min}–{t.prediction.high_min}) · site estimate {t.prediction.site_estimate_min} </span>
                      <AIBadge c={t.prediction.confidence} inline />
                      <button className="btn sm ghost" style={{ minHeight: 28, marginLeft: 6 }} onClick={() => setOpen(open === t.task_id ? null : t.task_id)}>
                        {open === t.task_id ? 'Hide' : 'Why?'}
                      </button>
                    </div>
                    {t.reason && <div className="reason">🔀 {t.reason}</div>}
                    {open === t.task_id && (
                      <div style={{ marginTop: 12 }}>
                        <Waterfall breakdown={t.prediction.breakdown} predicted={t.prediction.predicted_min} siteEstimate={t.prediction.site_estimate_min} />
                      </div>
                    )}
                  </div>
                  <div>
                    {t.status === 'in_progress' ? (
                      <button className="btn good" onClick={() => onComplete(t)}>✓ Complete</button>
                    ) : t.status !== 'done' ? (
                      <button className="btn primary" onClick={() => startTask(t)} title={locked ? 'Complete walkaround first' : seatbelt !== 'Fastened' ? 'Fasten seatbelt first' : ''}>
                        {locked ? '🔒' : seatbelt !== 'Fastened' ? '🪢' : '▶'} {t.status === 'paused' ? 'Resume' : 'Start'}
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        <div className="grid" style={{ gap: 16 }}>
          <div className="card">
            <h3>✅ Pre-shift walkaround</h3>
            <p className="card-sub">Required daily inspection. Tasks unlock when complete.</p>
            {CHECKLIST.map((c, i) => (
              <div key={i} className={`check ${checks.includes(i) ? 'on' : ''}`} onClick={() => toggleCheck(i)} role="checkbox" aria-checked={checks.includes(i)}>
                <div className="box">{checks.includes(i) ? '✓' : ''}</div>
                <span className="small">{c}</span>
              </div>
            ))}
          </div>
          <div className="card">
            <h3>🦺 Working conditions today</h3>
            {conditionAdvice(schedule.forecast).map((a, i) => (
              <div className="advice" key={i}><span className="ic">{a.ic}</span><span>{a.text}</span></div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
