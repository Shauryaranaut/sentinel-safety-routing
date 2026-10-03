const j = async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `Request failed (${r.status})`); return r.json() }
const post = (u, b) => fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }).then(j)
export const api = {
  search: (start, destination) => post('/api/routes/search', { start, destination }),
  recent: () => fetch('/api/incidents/recent').then(j),
  start: (route_id) => post('/api/navigation/start', { route_id }),
  status: (id) => fetch(`/api/navigation/${id}/status`).then(j),
  inject: (journey_id) => post('/api/demo/inject-incident', { journey_id }),
  switchTo: (id, alt) => post(`/api/navigation/${id}/switch`, { alternative_route_id: alt }),
  dismiss: (id) => post(`/api/navigation/${id}/dismiss`),
  stop: (id) => post(`/api/navigation/${id}/stop`),
  geocode: (q) => fetch(`/api/routes/geocode?q=${encodeURIComponent(q)}`).then(j),
  pointSafety: (latitude, longitude) => fetch(`/api/routes/point-safety?latitude=${latitude}&longitude=${longitude}`).then(j),
  safePoints: (latitude, longitude) => fetch(`/api/routes/safe-points?latitude=${latitude}&longitude=${longitude}`).then(j),
  getGuardianSettings: () => fetch('/settings/guardians').then(j),
  saveGuardianSettings: (body) => post('/settings/guardians', body),
  startSafetyMonitor: (body) => post('/journeys/start', body),
  safetyStatus: (journey_id) => fetch(`/journeys/${journey_id}/status`).then(j),
  signal: (body) => post('/signals', body),
  createEmergency: (body) => post('/emergencies', body),
  shareTrip: (body) => post('/monitor/share', body),
}
export const PLACES = [
  { name: 'Amber Fort', latitude: 26.9855, longitude: 75.8513 },
  { name: 'Hawa Mahal', latitude: 26.9239, longitude: 75.8267 },
  { name: 'Albert Hall Museum', latitude: 26.9116, longitude: 75.8195 },
  { name: 'Jal Mahal', latitude: 26.9533, longitude: 75.8462 },
]
export const POLL_MS = (Number(import.meta.env.VITE_POLLING_INTERVAL_SECONDS) || 10) * 1000
