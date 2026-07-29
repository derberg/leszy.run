// Thin fetch wrapper for the checkpoint-agent API (see checkpoint-agent/src/app.js).
// Every response is { data: ... } on success, { error: 'message' } on failure —
// this module unwraps both into a plain return value / thrown Error(status).

const BASE = '/api'

async function request(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })

  let json = null
  try {
    json = await res.json()
  } catch {
    // empty/non-JSON body — fall through, treated below
  }

  if (!res.ok) {
    const err = new Error(json?.error ?? `Żądanie nieudane (${res.status})`)
    err.status = res.status
    throw err
  }

  return json?.data
}

export const getState = () => request('/state')
export const getEvents = () => request('/events')
export const getCheckpoints = (eventId) => request(`/events/${encodeURIComponent(eventId)}/checkpoints`)
export const postSetup = (body) => request('/setup', { method: 'POST', body })
export const postStart = (body) => request('/start', { method: 'POST', body })
export const postStop = () => request('/stop', { method: 'POST' })
export const postReset = () => request('/reset', { method: 'POST' })
export const getReaderStatus = () => request('/reader/status')
