import { useEffect, useState } from 'react'
import { Bar, CartesianGrid, Cell, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { api } from '../api'
import { AIBadge } from '../components'

const inr = (n) => `₹${Number(n).toLocaleString('en-IN')}`

export default function Insights({ opId }) {
  const [data, setData] = useState(null)
  const [onlyAnomalies, setOnlyAnomalies] = useState(true)

  useEffect(() => { setData(null); api.insights(opId).then(setData).catch(() => {}) }, [opId])
  if (!data) return <div className="muted">Analysing machine telemetry…</div>

  const { summary: s, fleet, records } = data
  const chart = records.map((r) => ({
    label: `${r.timestamp.slice(5, 10)} ${r.timestamp.slice(11, 16)}`,
    idle: r.idling_min, cycles: r.load_cycles, anomaly: r.anomaly, belt: r.seatbelt,
  }))
  const perRecord = (x) => x.idle_cost_inr / Math.max(1, x.records)
  const vsFleet = perRecord(s) / Math.max(1, perRecord(fleet))
  const list = records.filter((r) => !onlyAnomalies || r.anomaly).slice().reverse()

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="grid g4">
        <div className="card kpi">
          <span className="label">Idle fuel cost</span>
          <span className="value" style={{ color: 'var(--red)' }}>{inr(s.idle_cost_inr)}</span>
          <span className="hint">{s.idle_fuel_l} L burned idling · {s.total_idle_min} min</span>
        </div>
        <div className="card kpi">
          <span className="label">Avoidable with auto-shutdown</span>
          <span className="value" style={{ color: 'var(--green)' }}>{inr(s.avoidable_cost_inr)}</span>
          <span className="hint">Idle beyond 20 min per 2-h window</span>
        </div>
        <div className="card kpi">
          <span className="label">CO₂ from idling</span>
          <span className="value">{s.idle_co2_kg} kg</span>
          <span className="hint">2.68 kg CO₂ per litre of diesel</span>
        </div>
        <div className="card kpi">
          <span className="label">Unusual windows</span>
          <span className="value" style={{ color: 'var(--amber)' }}>{s.anomalies}/{s.records}</span>
          <span className="hint">{s.unfastened} seatbelt-off · {s.excess_idle_events} excessive idle</span>
        </div>
      </div>

      {s.insight && (
        <div className="card hero" style={{ borderColor: 'var(--yellow)' }}>
          <AIBadge c={data.confidence} />
          <h3>💡 Pattern discovered by COPS</h3>
          <div style={{ fontSize: 16, lineHeight: 1.5 }}>{s.insight}</div>
          <div className="small muted" style={{ marginTop: 8 }}>
            Idle cost per shift window is <b style={{ color: vsFleet > 1.2 ? 'var(--red)' : 'var(--green)' }}>{vsFleet.toFixed(1)}×</b> the fleet average.
            {s.unfastened > 0 && ' Recommended training has been added to the Training Hub.'}
          </div>
        </div>
      )}

      <div className="card">
        <h3>📈 Idling vs productive work</h3>
        <p className="card-sub">Bars = idle minutes per 2-hour window (red = flagged as unusual). Line = load cycles (real work). Tall red bars with a low line = engine on, no work.</p>
        <div style={{ width: '100%', height: 320 }}>
          <ResponsiveContainer>
            <ComposedChart data={chart} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
              <CartesianGrid stroke="var(--line)" vertical={false} />
              <XAxis dataKey="label" tick={{ fill: 'var(--muted)', fontSize: 11 }} interval={Math.ceil(chart.length / 12)} />
              <YAxis yAxisId="l" tick={{ fill: 'var(--muted)', fontSize: 11 }} />
              <YAxis yAxisId="r" orientation="right" tick={{ fill: 'var(--muted)', fontSize: 11 }} />
              <Tooltip contentStyle={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 10 }}
                formatter={(v, n) => [v, n === 'idle' ? 'Idle (min)' : 'Load cycles']} />
              <Legend formatter={(v) => (v === 'idle' ? 'Idle minutes' : 'Load cycles')} />
              <Bar yAxisId="l" dataKey="idle" radius={[4, 4, 0, 0]}>
                {chart.map((d, i) => <Cell key={i} fill={d.anomaly ? 'var(--red)' : 'var(--muted)'} />)}
              </Bar>
              <Line yAxisId="r" dataKey="cycles" stroke="var(--yellow)" strokeWidth={2} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="card">
        <div className="row wrap" style={{ marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>🔎 Explained anomalies</h3>
          <AIBadge c={data.confidence} inline />
          <div className="spacer" />
          <button className="btn sm" onClick={() => setOnlyAnomalies(!onlyAnomalies)}>{onlyAnomalies ? 'Show all windows' : 'Only unusual'}</button>
        </div>
        <div style={{ maxHeight: 460, overflow: 'auto' }}>
          {list.map((r) => (
            <div key={r.timestamp + r.machine_id} className="list-item" style={{ borderColor: r.anomaly ? 'color-mix(in srgb, var(--red) 50%, var(--line))' : undefined }}>
              <div className="row wrap small">
                <b className="mono">{r.timestamp.slice(0, 16)}</b>
                <span className="chip">{r.machine_id}</span>
                <span className="chip">⛏ {r.load_cycles} cycles</span>
                <span className="chip">⏸ {r.idling_min} min idle</span>
                <span className="chip">⛽ {r.fuel_used_l} L</span>
                <span className={`chip ${r.seatbelt === 'Fastened' ? 'good' : 'bad'}`}>🪢 {r.seatbelt}</span>
                <div className="spacer" />
                <span className="mono" style={{ color: r.anomaly ? 'var(--red)' : 'var(--muted)' }}>{inr(r.idle_cost_inr)} idle</span>
              </div>
              {r.reasons.map((x, i) => <div key={i} className="small" style={{ marginTop: 6 }}>• {x.text}</div>)}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
