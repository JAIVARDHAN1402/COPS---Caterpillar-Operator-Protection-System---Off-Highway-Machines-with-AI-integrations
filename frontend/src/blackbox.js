import { useCallback, useEffect, useRef } from 'react'
import { api } from './api'

// Aircraft-style black box: the machine state is sampled 4×/s into a rolling
// 60-second buffer. When something happens (incident, near-miss, microsleep,
// SOS, rollover, critical fault) the buffer is saved and can be replayed in 3D.
const HZ = 4
const KEEP_S = 65
const AFTER_S = 5          // keep recording a few seconds after the trigger
const SAME_TRIGGER_GAP_MS = 20000

export function useBlackBox({ opId, machineId, frameRef, notify }) {
  const buf = useRef([])
  const last = useRef({})

  useEffect(() => {
    const i = setInterval(() => {
      buf.current.push({ t: Date.now(), ...frameRef.current })
      if (buf.current.length > KEEP_S * HZ) buf.current.shift()
    }, 1000 / HZ)
    return () => clearInterval(i)
  }, [frameRef])

  return useCallback((trigger, detail = '') => {
    const at = Date.now()
    if (at - (last.current[trigger] || 0) < SAME_TRIGGER_GAP_MS) return
    last.current[trigger] = at
    setTimeout(() => {
      const frames = buf.current.filter((f) => f.t >= at - (60 - AFTER_S) * 1000)
      if (frames.length < 4) return
      api.saveBlackBox({ operator_id: opId, machine_id: machineId, trigger, detail, trigger_at: at, frames })
        .then((r) => notify?.(`🎬 Black box saved (${r.id}: ${trigger}). Replay it in Digital Twin.`, 6000))
        .catch(() => {})
    }, AFTER_S * 1000)
  }, [opId, machineId, notify])
}

export const TRIGGER_LABEL = {
  proximity: '👷 Person in danger zone',
  near_miss: '📝 Near-miss reported',
  incident: '📝 Incident reported',
  microsleep: '😴 Microsleep',
  seatbelt: '🪢 Seatbelt violation',
  sos: '🆘 SOS',
  rollover: '🚜 Rollover / tilt',
  health: '🛢️ Critical machine fault',
  manual: '🎬 Manual capture',
}
