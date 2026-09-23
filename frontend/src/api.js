async function req(path, options = {}) {
  const res = await fetch(`/api${path}`, {
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

  training: (id) => req(`/training/${id}`),
  completeTraining: (id, module_id, score) => post(`/training/${id}/complete`, { module_id, score }),
  resetDemo: () => post('/demo/reset'),
}
