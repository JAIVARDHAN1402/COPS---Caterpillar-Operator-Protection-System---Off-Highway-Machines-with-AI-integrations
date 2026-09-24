import { useEffect, useRef, useState } from 'react'

/*
  Live safety score: exists only while the engine runs.
  Starts at 100 on every engine start, then changes every second with how the work is going:
  unsafe conditions drain it at a per-second rate, clean safe operation slowly earns it back.
  Engine off = scoring paused (a parked machine can't be operated unsafely).
*/

// Per-second deductions while a condition is true (points / second).
export const LIVE_RULES = [
  { key: 'belt', label: 'Seatbelt off', rate: 2.0, test: (s) => s.seatbelt !== 'Fastened' },
  { key: 'micro', label: 'Microsleep (eyes closed)', rate: 3.0, test: (s) => s.fatigue === 'microsleep' },
  { key: 'drowsy', label: 'Drowsy operator', rate: 1.0, test: (s) => s.fatigue === 'drowsy' },
  { key: 'tired', label: 'Fatigue signs (yawning)', rate: 0.15, test: (s) => s.fatigue === 'tired' },
  { key: 'danger', label: 'Person in danger zone', rate: 1.5, test: (s) => s.proximity === 'danger' },
  { key: 'warn', label: 'Person approaching', rate: 0.3, test: (s) => s.proximity === 'warn' },
  // Idling is mostly fuel waste, not danger: gentle, and capped so it can't sink the score on its own.
  { key: 'idle', label: 'Idling with no work', rate: 0.05, max: 15, test: (s) => !s.working && s.idleS >= 60 },
]
export const RECOVERY_PER_S = 0.05 // +3 points per minute of clean operation
const HISTORY_EVERY_S = 5
const HISTORY_MAX = 72 // 6 minutes of trend

export const grade = (score) => (score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : 'D')

const load = (k) => { try { return JSON.parse(localStorage.getItem(k)) } catch { return null } }
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* ignore */ } }

export function useLiveSafety({ opId, machineId, engineOn, seatbelt, proximity, fatigue, working, idleS, onThreshold }) {
  const key = `live-safety-${opId}-${machineId}`
  const [live, setLive] = useState(() => load(key)?.current || null)
  const [last, setLast] = useState(() => load(key)?.last || null)
  const inputs = useRef({})
  inputs.current = { seatbelt, proximity: proximity?.level, fatigue: fatigue?.level, working, idleS }
  const thresholdRef = useRef(onThreshold)
  thresholdRef.current = onThreshold

  // Engine start -> new session at 100. Engine stop -> freeze and remember the final score.
  // Only a real on -> off change ends a session: after a page reload the engine reads "off"
  // for a moment until the server confirms it, and that must not wipe the running session.
  const liveRef = useRef(live)
  liveRef.current = live
  const wasOn = useRef(false)
  useEffect(() => {
    if (engineOn) {
      const stale = !liveRef.current || Date.now() - (liveRef.current.tickAt || 0) > 30000
      if (stale) setLive({ score: 100, startedAt: Date.now(), tickAt: Date.now(), lost: {}, recovered: 0, history: [100], cleanS: 0, seconds: 0 })
    } else if (wasOn.current && liveRef.current) {
      const cur = liveRef.current
      const summary = { score: Math.round(cur.score), grade: grade(cur.score), endedAt: Date.now(),
        minutes: Math.round(cur.seconds / 60), lost: cur.lost }
      setLast(summary)
      setLive(null)
      save(key, { current: null, last: summary })
    }
    wasOn.current = engineOn
  }, [engineOn, key])

  // 1 Hz scoring tick while the engine runs.
  useEffect(() => {
    if (!engineOn) return
    const i = setInterval(() => {
      setLive((cur) => {
        if (!cur) return cur
        const s = inputs.current
        const active = LIVE_RULES.filter((r) => r.test(s))
        const lost = { ...cur.lost }
        let delta = 0
        active.forEach((r) => {
          const take = Math.max(0, Math.min(r.rate, (r.max ?? Infinity) - (lost[r.key] || 0)))
          delta -= take
          lost[r.key] = (lost[r.key] || 0) + take
        })
        let recovered = cur.recovered
        let cleanS = active.length ? 0 : cur.cleanS + 1
        if (!active.length && cur.score < 100) {
          const gain = Math.min(RECOVERY_PER_S, 100 - cur.score)
          delta += gain
          recovered += gain
        }
        const score = Math.max(0, Math.min(100, cur.score + delta))
        const seconds = cur.seconds + 1
        const history = seconds % HISTORY_EVERY_S === 0 ? [...cur.history, score].slice(-HISTORY_MAX) : cur.history
        // Tell the operator when the score falls through a grade boundary.
        for (const t of [85, 70, 55]) if (cur.score >= t && score < t) thresholdRef.current?.(Math.round(score), grade(score))
        const next = { ...cur, score, lost, recovered, cleanS, seconds, history, tickAt: Date.now(), active: active.map((r) => r.key) }
        save(key, { current: next, last })
        return next
      })
    }, 1000)
    return () => clearInterval(i)
  }, [engineOn, key, last])

  const trend = live && live.history.length > 1 ? live.score - live.history[Math.max(0, live.history.length - 7)] : 0
  return { live, last, trend }
}

/** Tiny inline trend graph for the score popup. */
export function Sparkline({ values, width = 240, height = 48 }) {
  if (!values || values.length < 2) return null
  const min = Math.min(40, ...values)
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * width},${height - ((v - min) / (100 - min || 1)) * height}`)
  return (
    <svg width={width} height={height} style={{ display: 'block' }} aria-label="Live score trend">
      <polyline points={pts.join(' ')} fill="none" stroke="var(--yellow)" strokeWidth="2" />
    </svg>
  )
}
