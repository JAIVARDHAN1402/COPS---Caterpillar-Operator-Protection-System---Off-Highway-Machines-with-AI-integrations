// Locally the Vite dev server proxies /api to port 8000. When the site is deployed
// (e.g. Vercel) and the API runs elsewhere (e.g. Render), set VITE_API_BASE at build time
// to the API's origin, like https://cops-api.onrender.com
const API_BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/+$/, '')

async function req(path, options = {}) {
  const res = await fetch(`${API_BASE}/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.detail || `Request failed (${res.status})`)
    err.status = res.status
    throw err
  }
  return data
}

const post = (path, body) => req(path, { method: 'POST', body })

export const api = {
  operators: () => req('/operators'),
  operator: (id) => req(`/operators/${id}`),

  // shift & handover
  punchIn: (operator_id, machine_id) => post('/shift/punch-in', { operator_id, machine_id }),
  pendingHandovers: () => req('/shift/pending'),
  handoverReasons: () => req('/shift/reasons'),
  createHandover: (body) => post('/shift/handover', body),
  ackHandover: (id, operator_id) => post(`/shift/handover/${id}/ack`, { operator_id }),
  handover: (id, operator_id) => req(`/shift/handover/${id}?operator_id=${operator_id}`),

  // tasks (tasks belong to the machine so a new operator can continue them)
  schedule: (opId, machineId) => req(`/schedule/${opId}?machine_id=${machineId}`),
  startTask: (machineId, taskId, operator_id, seatbelt) =>
    post(`/machines/${machineId}/tasks/${taskId}/start`, { operator_id, seatbelt }),
  completeTask: (machineId, taskId, operator_id, actual_min) =>
    post(`/machines/${machineId}/tasks/${taskId}/complete`, { operator_id, actual_min }),

  predict: (body) => post('/predict', body),
  modelStats: () => req('/model/stats'),
  insights: (id) => req(`/insights/${id}`),
  performance: (id) => req(`/performance/${id}`),

  logEvent: (operator_id, type, detail, machine_id) => post('/safety/events', { operator_id, type, detail, machine_id }),
  events: (id) => req(`/safety/events/${id}`),
  parseIncident: (text) => post('/incidents/parse', { text }),
  createIncident: (body) => post('/incidents', body),
  incidents: (id) => req(`/incidents?operator_id=${id}`),

  // machine health (runtime monitoring)
  health: (mid) => req(`/machines/${mid}/health`),
  setEngine: (mid, on, working) => post(`/machines/${mid}/engine`, { on, working }),
  injectFault: (mid, fault) => post(`/machines/${mid}/health/fault`, { fault }),
  service: (mid, what = 'all') => post(`/machines/${mid}/health/service`, { what }),

  // emergency
  raiseSos: (body) => post('/sos', body),
  sos: (id) => req(`/sos/${id}`),
  ackSos: (id, by) => post(`/sos/${id}/ack`, { by }),
  resolveSos: (id, note) => post(`/sos/${id}/resolve`, { note }),
  escalateSos: (id, reason) => post(`/sos/${id}/escalate`, { reason }),
  shiftReport: (opId, mid) => req(`/shift-report/${opId}?machine_id=${mid}`),
  sendShiftReport: (opId, mid) => post(`/shift-report/${opId}/send?machine_id=${mid}`),

  // black box
  saveBlackBox: (body) => post('/blackbox', body),
  blackboxList: (mid) => req(`/blackbox${mid ? `?machine_id=${mid}` : ''}`),
  blackbox: (id) => req(`/blackbox/${id}`),

  supervisor: () => req('/supervisor/overview'),

  // emergency stop + supervisor SMS
  emergencyStop: (mid, body) => post(`/machines/${mid}/stop`, body),
  smsStatus: () => req('/sms'),
  smsConfig: (to) => post('/sms/config', { to }),
  smsTest: (channel = 'sms') => post(`/sms/test?channel=${channel}`),

  // ASK COPS assistant
  ask: (body) => post('/assistant', body),
  askSuggestions: () => req('/assistant/suggestions'),

  training: (id) => req(`/training/${id}`),
  completeTraining: (id, module_id, score) => post(`/training/${id}/complete`, { module_id, score }),
  resetDemo: () => post('/demo/reset'),
}
