import { Line, LineChart, ReferenceLine, ResponsiveContainer, YAxis } from 'recharts'
import { api } from '../api'
import { AIBadge } from '../components'

const ICON = {
  engine_oil: '🛢️', oil_pressure: '⏲️', coolant: '💧', engine_temp: '🌡️', hydraulic_oil: '🔧',
  hydraulic_temp: '♨️', fuel: '⛽', def: '🧪', battery: '🔋', air_filter: '🌪️',
}
const ST = {
  ok: { label: 'OK', cls: 'good', color: 'var(--green)' },
  warn: { label: 'WARNING', cls: 'warn', color: 'var(--amber)' },
  crit: { label: 'CRITICAL', cls: 'bad', color: 'var(--red)' },
  off: { label: 'Engine off', cls: '', color: 'var(--steel-light)' },
}
const FAULT_BUTTONS = [
  ['hydraulic_leak', '💦 Hydraulic leak'],
  ['overheat', '🔥 Overheating'],
  ['oil_leak', '🛢️ Engine oil leak'],
  ['clogged_filter', '🌪️ Clogged air filter'],
  ['low_fuel', '⛽ Low fuel'],
  ['battery', '🔋 Charging fault'],
]

export const fmtEta = (s) => (s == null ? null : s < 60 ? 'under 1 min' : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`)

function Gauge({ c }) {
  const st = ST[c.status]
  const pct = Math.max(0, Math.min(100, (c.value / c.max) * 100))
  const warnPct = (c.warn / c.max) * 100
  const critPct = (c.crit / c.max) * 100
  return (
    <div className={`card gauge ${c.status}`}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="small" style={{ fontWeight: 700 }}>{ICON[c.key]} {c.label}</span>
        <span className={`chip ${st.cls}`}>{st.label}</span>
      </div>
      <div className="row" style={{ alignItems: 'baseline', gap: 6, marginTop: 8 }}>
        <span className="mono" style={{ fontSize: 30, fontWeight: 800, color: st.color }}>{c.value}</span>
        <span className="muted">{c.unit}</span>
        <div className="spacer" />
        <span className="small muted">{c.trend === 'falling' ? '▼' : c.trend === 'rising' ? '▲' : '■'} {c.rate_per_min > 0 ? '+' : ''}{c.rate_per_min}/min</span>
      </div>
      <div className="gauge-bar">
        <div className="fill" style={{ width: `${pct}%`, background: st.color }} />
        <div className="mark warn" style={{ left: `${warnPct}%` }} title={`Warning ${c.warn}${c.unit}`} />
        <div className="mark crit" style={{ left: `${critPct}%` }} title={`Critical ${c.crit}${c.unit}`} />
      </div>
      <div className="small muted" style={{ marginTop: 4 }}>
        {c.dir === 'low' ? 'Low' : 'High'} warn {c.warn}{c.unit} · critical {c.crit}{c.unit}
      </div>
      <div style={{ height: 44, marginTop: 6 }}>
        <ResponsiveContainer>
          <LineChart data={c.history.map((v, i) => ({ i, v }))} margin={{ top: 2, right: 2, left: 2, bottom: 2 }}>
            <YAxis hide domain={['auto', 'auto']} />
            <ReferenceLine y={c.warn} stroke="var(--amber)" strokeDasharray="3 3" />
            <ReferenceLine y={c.crit} stroke="var(--red)" strokeDasharray="3 3" />
            <Line dataKey="v" stroke={st.color} strokeWidth={2} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      {c.time_to_critical_s != null && (
        <div className="small" style={{ marginTop: 6, color: c.time_to_critical_s < 300 ? 'var(--red)' : 'var(--amber)', fontWeight: 700 }}>
          ⏱ Critical in {fmtEta(c.time_to_critical_s)} at the current rate
        </div>
      )}
    </div>
  )
}

export default function Health({ machineId, report, refresh, notify }) {
  if (!report) return <div className="muted">Connecting to machine sensors…</div>
  const run = async (fn, msg) => { await fn(); notify?.(msg); refresh() }
  const overall = ST[report.overall]

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="card hero">
        <AIBadge c={report.confidence} />
        <div className="row wrap" style={{ gap: 14 }}>
          <div>
            <div className="small muted">Machine health · {machineId}</div>
            <div style={{ fontSize: 26, fontWeight: 800, color: overall.color }}>
              {report.overall === 'ok' ? '✅ All systems normal' : report.overall === 'warn' ? '⚠️ Attention needed' : '🛑 Critical condition'}
            </div>
          </div>
          <div className="spacer" />
          <span className={`chip ${report.engine_on ? 'good' : ''}`}>{report.engine_on ? (report.working ? '⚙️ Engine on · working' : '⚙️ Engine on · idle') : '⏻ Engine off'}</span>
          <span className={`chip ${report.start_allowed ? 'good' : 'bad'}`}>{report.start_allowed ? '🔑 Start allowed' : `🔒 Start blocked: ${report.block_reason}`}</span>
        </div>
        <p className="small muted" style={{ marginBottom: 0 }}>
          Live sensor stream updated every 2 s: fluid levels, temperatures, oil pressure and electrical. Each channel has warning/critical
          thresholds, a trend, and a <b>time-to-critical prediction</b>. Fluid loss much faster than normal consumption is flagged as a <b>leak</b>.
        </p>
      </div>

      {(report.anomalies.length > 0 || report.alerts.length > 0) && (
        <div className="split">
          <div className="card" style={{ borderColor: 'var(--red)' }}>
            <h3>🚨 Active alerts & what to do</h3>
            {report.alerts.length === 0 && <div className="small muted">No threshold alerts.</div>}
            {report.alerts.map((a) => (
              <div key={a.key} className={`coach ${a.status === 'crit' ? 'fix' : 'warn'}`}>
                <span style={{ fontSize: 20 }}>{ICON[a.key]}</span>
                <div>
                  <b>{a.label}: {a.value}{a.unit}</b> <span className={`chip ${ST[a.status].cls}`}>{ST[a.status].label}</span>
                  <div className="small" style={{ marginTop: 4 }}>{a.action}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="card">
            <AIBadge c={report.confidence} />
            <h3>🧠 Anomaly detection</h3>
            {report.anomalies.length === 0 && <div className="small muted">No abnormal trends detected.</div>}
            {report.anomalies.map((a) => (
              <div key={a.key} className="coach fix">
                <span style={{ fontSize: 20 }}>🔎</span>
                <div><b>{a.title}</b><div className="small" style={{ marginTop: 4 }}>{a.detail}</div></div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid g4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(250px, 100%), 1fr))' }}>
        {report.channels.map((c) => <Gauge key={c.key} c={c} />)}
      </div>

      <div className="card">
        <h3>🧪 Demo controls <span className="chip">simulated sensor faults</span></h3>
        <p className="card-sub">Inject a fault to watch COPS detect it live. Start the engine (E) first: most faults develop while running.</p>
        <div className="row wrap" style={{ gap: 8 }}>
          {FAULT_BUTTONS.map(([k, l]) => (
            <button key={k} className="btn sm" onClick={() => run(() => api.injectFault(machineId, k), `Simulating: ${l}`)}>{l}</button>
          ))}
          <div className="spacer" />
          <button className="btn sm good" onClick={() => run(() => api.service(machineId, 'all'), '🔧 Serviced: fluids refilled, filter replaced, faults cleared')}>🔧 Service / refill all</button>
        </div>
        {report.faults.length > 0 && (
          <div className="small" style={{ marginTop: 10 }}>Active simulated faults: {report.faults.map((f) => f.label).join(', ')}</div>
        )}
      </div>
    </div>
  )
}
