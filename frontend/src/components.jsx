import { useEffect, useRef, useState } from 'react'

const confColor = (s) => (s >= 0.8 ? 'var(--green)' : s >= 0.6 ? 'var(--amber)' : 'var(--red)')

/**
 * AI confidence report. Sits in the corner of every AI-driven card.
 * `c` = { score, level, method, basis[], caveats[] } (same shape from backend and frontend models).
 */
export function AIBadge({ c, inline = false, label = 'AI' }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  if (!c) return null
  const pct = Math.round(c.score * 100)
  return (
    <span ref={ref} className={inline ? '' : 'ai-badge-wrap'} style={inline ? { position: 'relative', display: 'inline-block' } : undefined}>
      <button className="ai-badge" onClick={() => setOpen(!open)} title="AI confidence report" aria-expanded={open}>
        <span className="dot" style={{ background: confColor(c.score) }} />{label} {pct}%
      </button>
      {open && (
        <div className="card ai-pop">
          <h4>🤖 AI confidence: {pct}% · {c.level}</h4>
          <div className="conf-bar"><div style={{ width: `${pct}%`, background: confColor(c.score) }} /></div>
          <div className="small muted"><b>Method:</b> {c.method}</div>
          <div className="small" style={{ marginTop: 8, fontWeight: 700 }}>Based on</div>
          <ul>{c.basis.map((b, i) => <li key={i}>{b}</li>)}</ul>
          {c.caveats?.length > 0 && (
            <>
              <div className="small" style={{ marginTop: 8, fontWeight: 700, color: 'var(--amber)' }}>Limitations</div>
              <ul className="muted">{c.caveats.map((b, i) => <li key={i}>{b}</li>)}</ul>
            </>
          )}
        </div>
      )}
    </span>
  )
}

/** Local helper for confidence computed in the browser (camera models). */
export function makeConf(score, method, basis, caveats = []) {
  const s = Math.max(0.05, Math.min(0.95, score))
  return { score: s, level: s >= 0.8 ? 'High' : s >= 0.6 ? 'Medium' : 'Low', method, basis, caveats }
}

export function SkillChip({ skill, xp }) {
  return <span className={`chip skill-${skill}`} title="Operators grow from gray (Beginner) to yellow (Expert)">{skill}{xp != null && ` · ${xp} XP`}</span>
}

export const CHECKLIST = [
  'Walk around: no people or obstacles near machine',
  'Tracks / tyres & undercarriage OK',
  'No hydraulic leaks under boom & cylinders',
  'Mirrors & camera clean, lights working',
  'Fire extinguisher present',
  'Fluid levels (engine oil, coolant, hydraulic) OK',
]

export const WEATHER_ICON ={ Sunny: '☀️', Cloudy: '⛅', Windy: '💨', Rainy: '🌧️' }
export const TASK_ICON = {
  'Earth Excavation': '⛏️',
  Trenching: '🚧',
  'Material Loading': '🚚',
  Grading: '🛣️',
  Demolition: '🏚️',
}

export function scoreColor(score) {
  return score >= 85 ? 'var(--green)' : score >= 70 ? 'var(--yellow)' : score >= 55 ? 'var(--amber)' : 'var(--red)'
}

export function ScoreRing({ score = 0, size = 48, stroke = 6, label = true }) {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const color = scoreColor(score)
  return (
    <svg width={size} height={size} role="img" aria-label={`Safety score ${score}`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line)" strokeWidth={stroke} />
      <circle
        cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={c * (1 - score / 100)} transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dashoffset 0.8s ease' }}
      />
      {label && (
        <text x="50%" y="54%" textAnchor="middle" dominantBaseline="middle" fill="var(--text)"
          fontSize={size * 0.3} fontWeight="800" fontFamily="JetBrains Mono">{score}</text>
      )}
    </svg>
  )
}

export function Modal({ children, onClose }) {
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose?.()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  return (
    <div className="overlay" onClick={onClose}>
      <div className="card dialog" onClick={(e) => e.stopPropagation()}>{children}</div>
    </div>
  )
}

export function Toast({ toast, onDone }) {
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(onDone, toast.ms || 4500)
    return () => clearTimeout(t)
  }, [toast, onDone])
  if (!toast) return null
  return <div className="toast">{toast.text}</div>
}

/** Explainable prediction: base + each factor's contribution = final minutes. */
export function Waterfall({ breakdown, predicted, siteEstimate }) {
  if (!breakdown) return null
  const total = predicted
  const max = Math.max(total, siteEstimate || 0, ...breakdown.map((b) => b.delta)) * 1.08
  let running = 0
  const W = 100
  const colors = { base: 'var(--muted)', weather: 'var(--blue)', skill: 'var(--amber)', age: '#b48cff' }
  return (
    <div>
      {breakdown.map((b, i) => {
        const start = b.kind === 'base' ? 0 : running
        const end = b.kind === 'base' ? b.delta : running + b.delta
        running = end
        const left = (Math.min(start, end) / max) * W
        const width = Math.max(0.6, (Math.abs(end - start) / max) * W)
        return (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '170px 1fr 64px', gap: 10, alignItems: 'center', marginBottom: 6 }}>
            <div className="small" style={{ fontWeight: 600 }}>{b.factor}</div>
            <div style={{ position: 'relative', height: 22, background: 'var(--panel-2)', borderRadius: 6 }}>
              <div style={{ position: 'absolute', left: `${left}%`, width: `${width}%`, top: 3, bottom: 3, borderRadius: 4, background: colors[b.kind] }} />
            </div>
            <div className="mono small" style={{ textAlign: 'right', fontWeight: 700 }}>
              {b.kind === 'base' ? '' : b.delta >= 0 ? '+' : ''}{b.delta}
            </div>
          </div>
        )
      })}
      <div style={{ display: 'grid', gridTemplateColumns: '170px 1fr 64px', gap: 10, alignItems: 'center', borderTop: '1px solid var(--line)', paddingTop: 8 }}>
        <div className="small" style={{ fontWeight: 800 }}>= Predicted</div>
        <div style={{ position: 'relative', height: 22 }}>
          <div style={{ position: 'absolute', left: 0, width: `${(total / max) * W}%`, top: 3, bottom: 3, borderRadius: 4, background: 'var(--yellow)' }} />
          {siteEstimate && (
            <div title="Site's static estimate" style={{ position: 'absolute', left: `${(siteEstimate / max) * W}%`, top: -2, bottom: -2, width: 2, background: 'var(--text)' }} />
          )}
        </div>
        <div className="mono" style={{ textAlign: 'right', fontWeight: 800 }}>{total}</div>
      </div>
      {siteEstimate && <div className="small muted" style={{ marginTop: 6 }}>│ white marker = site's static estimate ({siteEstimate} min)</div>}
    </div>
  )
}
