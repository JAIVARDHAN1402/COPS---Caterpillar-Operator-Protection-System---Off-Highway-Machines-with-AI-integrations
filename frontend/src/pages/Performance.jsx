import { useEffect, useState } from 'react'
import { Bar, CartesianGrid, Cell, ComposedChart, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { api } from '../api'
import { AIBadge } from '../components'

const fmtDelta = (c) => {
  const arrow = c.delta_pct > 0 ? '▲' : c.delta_pct < 0 ? '▼' : '■'
  return `${arrow} ${Math.abs(c.delta_pct)}%`
}
const fmtVal = (v, unit) => (unit === '₹' ? `₹${Math.round(v).toLocaleString('en-IN')}` : `${v}${unit === '%' ? '%' : unit ? ` ${unit}` : ''}`)

export default function Performance({ opId, profile, onGoTraining, refreshKey }) {
  const [d, setD] = useState(null)
  useEffect(() => { api.performance(opId).then(setD).catch(() => {}) }, [opId, refreshKey])
  if (!d) return <div className="muted">Building your performance report…</div>

  const chart = d.days.map((x) => ({ ...x, label: x.date.slice(5) + (x.source === 'live' ? ' (today)' : '') }))
  const fixes = d.coach.filter((c) => c.kind === 'fix').length
  const loop = [
    { icon: '📡', label: 'Measured', value: `${d.days.length}d`, hint: 'telemetry + live shift' },
    { icon: '🔎', label: 'Detected', value: d.days.reduce((a, x) => a + (x.anomalies || 0), 0), hint: 'unusual windows' },
    { icon: '🧑‍🏫', label: 'Coached', value: d.coach.length, hint: `${fixes} to fix` },
    { icon: '🎓', label: 'Trained', value: d.training_log.length, hint: 'lessons passed' },
    { icon: '📈', label: 'Improved', value: `${d.wins}/${d.comparison.length}`, hint: 'metrics better vs last week' },
  ]

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="card hero">
        <AIBadge c={d.confidence} />
        <h3>🔁 Your improvement loop · {profile?.name}</h3>
        <p className="card-sub">Every shift is measured, compared with last week, turned into coaching and lessons, then measured again.</p>
        <div className="loop">
          {loop.map((x, i) => (
            <div key={x.label}>
              <div style={{ fontSize: 20 }}>{x.icon}</div>
              <b className="mono">{x.value}</b>
              <div style={{ fontWeight: 700 }}>{x.label}</div>
              <div className="muted">{x.hint}</div>
              {i < loop.length - 1 && <span style={{ position: 'absolute', right: -9, top: '42%', color: 'var(--yellow)', fontWeight: 900 }}>›</span>}
            </div>
          ))}
        </div>
      </div>

      <div className="grid g4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(200px, 100%), 1fr))' }}>
        {d.comparison.map((c) => (
          <div key={c.key} className="card kpi">
            <span className="label">{c.label}</span>
            <span className="value" style={{ fontSize: 24 }}>{fmtVal(c.curr, c.unit)}</span>
            <span className="hint">
              <span className={`delta ${c.better ? 'up' : c.better === false ? 'down' : ''}`}>{fmtDelta(c)}</span> vs last week ({fmtVal(c.prev, c.unit)})
            </span>
          </div>
        ))}
      </div>

      <div className="card">
        <AIBadge c={d.confidence} />
        <h3>📈 14-day trend</h3>
        <p className="card-sub">Line = daily safety score & seatbelt compliance. Bars = average idle minutes per 2-h window. The last point is today's live shift.</p>
        <div style={{ width: '100%', height: 300 }}>
          <ResponsiveContainer>
            <ComposedChart data={chart} margin={{ top: 8, right: 8, left: -14, bottom: 0 }}>
              <CartesianGrid stroke="var(--line)" vertical={false} />
              <XAxis dataKey="label" tick={{ fill: 'var(--muted)', fontSize: 11 }} />
              <YAxis yAxisId="l" domain={[0, 100]} tick={{ fill: 'var(--muted)', fontSize: 11 }} />
              <YAxis yAxisId="r" orientation="right" tick={{ fill: 'var(--muted)', fontSize: 11 }} />
              <Tooltip contentStyle={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 10 }} />
              <Legend />
              <Bar yAxisId="r" dataKey="idle_avg" name="Idle min / window" radius={[4, 4, 0, 0]}>
                {chart.map((x, i) => <Cell key={i} fill={x.idle_avg > 30 ? 'var(--steel)' : 'var(--khaki)'} />)}
              </Bar>
              <Line yAxisId="l" dataKey="score" name="Safety score" stroke="var(--yellow)" strokeWidth={3} dot={{ r: 3 }} connectNulls />
              <Line yAxisId="l" dataKey="belt_pct" name="Seatbelt %" stroke="var(--green)" strokeWidth={2} dot={false} connectNulls />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="split">
        <div className="card">
          <AIBadge c={d.confidence} />
          <h3>🧑‍🏫 Coach feedback</h3>
          {d.coach.map((c, i) => (
            <div key={i} className={`coach ${c.kind}`}>
              <span style={{ fontSize: 20 }}>{c.kind === 'win' ? '🏆' : c.kind === 'fix' ? '🔧' : '💡'}</span>
              <div style={{ flex: 1 }}>
                <div>{c.text}</div>
                {c.module && <button className="btn sm primary" style={{ marginTop: 8 }} onClick={onGoTraining}>▶ Fix it: take the lesson</button>}
              </div>
            </div>
          ))}
        </div>
        <div className="card">
          <h3>🎯 Goals this week</h3>
          {d.goals.map((g) => (
            <div key={g.label} style={{ marginBottom: 14 }}>
              <div className="row small" style={{ justifyContent: 'space-between' }}>
                <b>{g.label}</b><span className="mono">{g.current}</span>
              </div>
              <div className="progress" style={{ marginTop: 6 }}><div style={{ width: `${Math.round(g.progress * 100)}%` }} /></div>
            </div>
          ))}
          <div className="small muted">Bars grow from gray to CAT yellow as you approach each goal.</div>
        </div>
      </div>

      <div className="grid g2">
        <div className="card">
          <h3>⏱️ You vs the AI (today)</h3>
          {d.prediction_feedback.length === 0 ? (
            <div className="small muted">Complete a task on the Today tab. Your actual time is compared with the prediction, and the model learns from it.</div>
          ) : d.prediction_feedback.map((p, i) => (
            <div key={i} className="list-item row small">
              <b>{p.task_type}</b><div className="spacer" />
              <span className="mono">AI {p.predicted_min} → you {p.actual_min} min</span>
              <span className={`delta ${p.diff_pct <= 0 ? 'up' : 'down'}`}>{p.diff_pct > 0 ? '+' : ''}{p.diff_pct}%</span>
            </div>
          ))}
        </div>
        <div className="card">
          <h3>🧠 The AI is learning too</h3>
          {d.model_history.length > 1 ? (
            <div style={{ width: '100%', height: 160 }}>
              <ResponsiveContainer>
                <LineChart data={d.model_history.map((h, i) => ({ ...h, i: i + 1 }))} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                  <CartesianGrid stroke="var(--line)" vertical={false} />
                  <XAxis dataKey="samples" tick={{ fill: 'var(--muted)', fontSize: 11 }} />
                  <YAxis tick={{ fill: 'var(--muted)', fontSize: 11 }} />
                  <Tooltip contentStyle={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 10 }} formatter={(v) => [`±${v} min`, 'Error']} />
                  <Line dataKey="mae" stroke="var(--yellow)" strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="small muted">Model error is ±{d.model_history[0]?.mae} min on {d.model_history[0]?.samples} tasks. Each completed task retrains it; the curve appears here.</div>
          )}
          {d.training_log.length > 0 && (
            <>
              <div className="small" style={{ fontWeight: 700, marginTop: 10 }}>Lessons passed</div>
              {d.training_log.map((t, i) => (
                <div key={i} className="small" style={{ marginTop: 4 }}>✅ {t.title} <span className="muted">· +{t.xp} XP · {t.time.slice(11, 16)}</span></div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
