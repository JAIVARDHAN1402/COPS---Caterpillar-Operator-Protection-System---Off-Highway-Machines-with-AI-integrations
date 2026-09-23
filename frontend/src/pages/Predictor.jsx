import { useEffect, useState } from 'react'
import { api } from '../api'
import { AIBadge, TASK_ICON, WEATHER_ICON, Waterfall } from '../components'

export default function Predictor({ profile }) {
  const [stats, setStats] = useState(null)
  const [form, setForm] = useState({ task_type: 'Trenching', weather: 'Rainy', operator_skill: 'Intermediate', machine_age: 4 })
  const [pred, setPred] = useState(null)
  const [compare, setCompare] = useState([])

  useEffect(() => { api.modelStats().then(setStats).catch(() => {}) }, [])
  useEffect(() => {
    if (profile) setForm((f) => ({ ...f, operator_skill: profile.skill, machine_age: profile.machine_age }))
  }, [profile])
  useEffect(() => {
    api.predict(form).then(setPred).catch(() => {})
    // What-if: same task & conditions, every skill level
    if (stats) Promise.all(stats.skills.map((s) => api.predict({ ...form, operator_skill: s }).then((r) => ({ skill: s, ...r }))))
      .then(setCompare).catch(() => {})
  }, [form, stats])

  if (!stats) return <div className="muted">Loading model…</div>
  const set = (k) => (v) => setForm({ ...form, [k]: v })
  const Seg = ({ k, options, icons }) => (
    <div className="row wrap" style={{ gap: 6 }}>
      {options.map((o) => (
        <button key={o} className={`btn sm ${form[k] === o ? 'primary' : ''}`} onClick={() => set(k)(o)}>{icons?.[o]} {o}</button>
      ))}
    </div>
  )
  const improvement = stats.baseline_mae / stats.mae

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="grid g4">
        <div className="card kpi">
          <AIBadge c={stats.confidence} />
          <span className="label">AI prediction error</span>
          <span className="value" style={{ color: 'var(--green)' }}>±{stats.mae} min</span>
          <span className="hint">Mean absolute error on held-out tasks</span>
        </div>
        <div className="card kpi">
          <span className="label">Site's static estimates</span>
          <span className="value" style={{ color: 'var(--red)' }}>±{stats.baseline_mae} min</span>
          <span className="hint">Same data, current planning method</span>
        </div>
        <div className="card kpi">
          <span className="label">Accuracy gain</span>
          <span className="value">{improvement.toFixed(1)}×</span>
          <span className="hint">More accurate than today's estimates</span>
        </div>
        <div className="card kpi">
          <span className="label">Training samples</span>
          <span className="value">{stats.samples}</span>
          <span className="hint">Grows with every completed task (online learning)</span>
        </div>
      </div>

      <div className="split rev">
        <div className="card">
          <h3>🎛️ What-if planner</h3>
          <div className="grid" style={{ gap: 14 }}>
            <label className="field">Task<Seg k="task_type" options={stats.task_types} icons={TASK_ICON} /></label>
            <label className="field">Weather<Seg k="weather" options={stats.weathers} icons={WEATHER_ICON} /></label>
            <label className="field">Operator skill<Seg k="operator_skill" options={stats.skills} /></label>
            <label className="field">Machine age: {form.machine_age} years
              <input type="range" min="1" max="12" value={form.machine_age} onChange={(e) => set('machine_age')(Number(e.target.value))} />
            </label>
          </div>
        </div>

        <div className="card hero">
          <AIBadge c={pred?.confidence} />
          <h3>⏱️ Prediction & explanation</h3>
          {pred && (
            <>
              <div className="row wrap" style={{ alignItems: 'baseline', marginBottom: 14 }}>
                <span className="mono" style={{ fontSize: 44, fontWeight: 800, color: 'var(--yellow)' }}>{pred.predicted_min}</span>
                <span className="muted">min · 80% range {pred.low_min}–{pred.high_min}</span>
                <div className="spacer" />
                <span className={`chip ${pred.predicted_min > pred.site_estimate_min * 1.1 ? 'bad' : 'good'}`}>
                  Site estimate {pred.site_estimate_min} min ({pred.predicted_min >= pred.site_estimate_min ? '+' : ''}{(pred.predicted_min - pred.site_estimate_min).toFixed(1)})
                </span>
              </div>
              <Waterfall breakdown={pred.breakdown} predicted={pred.predicted_min} siteEstimate={pred.site_estimate_min} />
            </>
          )}
          {compare.length > 0 && (
            <div style={{ marginTop: 18 }}>
              <b className="small">Who should do it? Same job, by skill level:</b>
              <div className="grid g3" style={{ marginTop: 8 }}>
                {compare.map((c) => (
                  <div key={c.skill} className="list-item" style={{ borderColor: c.skill === form.operator_skill ? 'var(--yellow)' : undefined }}>
                    <div className="small muted">{c.skill}</div>
                    <div className="mono" style={{ fontSize: 22, fontWeight: 800 }}>{c.predicted_min} min</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <h3>🧠 How the model works</h3>
        <div className="grid g3 small">
          <div className="advice"><span className="ic">📊</span><span>Gradient-boosted trees trained on the 5 provided tasks + {stats.samples - 5} synthetic tasks calibrated to reproduce them.</span></div>
          <div className="advice"><span className="ic">🎯</span><span>Three models (10th / 50th / 90th percentile) give a prediction <b>and</b> an honest uncertainty range.</span></div>
          <div className="advice"><span className="ic">🔁</span><span>Each completed task is added to the data and the model retrains instantly — accuracy improves every shift.</span></div>
        </div>
      </div>
    </div>
  )
}
