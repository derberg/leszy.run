const BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001'

async function request(method, path, body, isFile = false) {
  const opts = { method, headers: {} }
  if (isFile) {
    if (body) opts.body = body
  } else if (body !== undefined && body !== null) {
    opts.headers['Content-Type'] = 'application/json'
    opts.body = JSON.stringify(body)
  }

  const res = await fetch(`${BASE}/api${path}`, opts)
  if (res.status === 204) return null
  const json = await res.json()
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
  return json.data
}

export const api = {
  // Events
  events: {
    list: () => request('GET', '/events'),
    get: (id) => request('GET', `/events/${id}`),
    create: (body) => request('POST', '/events', body),
    update: (id, body) => request('PATCH', `/events/${id}`, body),
    delete: (id) => request('DELETE', `/events/${id}`),
  },

  // Categories
  categories: {
    list: (eventId) => request('GET', `/events/${eventId}/categories`),
    create: (eventId, body) => request('POST', `/events/${eventId}/categories`, body),
    update: (id, body) => request('PATCH', `/categories/${id}`, body),
    delete: (id) => request('DELETE', `/categories/${id}`),
    importCsv: (eventId, formData) => request('POST', `/events/${eventId}/import/categories`, formData, true),
  },

  // Participants
  participants: {
    list: (eventId) => request('GET', `/events/${eventId}/participants`),
    create: (eventId, body) => request('POST', `/events/${eventId}/participants`, body),
    update: (id, body) => request('PATCH', `/participants/${id}`, body),
    delete: (id) => request('DELETE', `/participants/${id}`),
    importCsv: (eventId, formData) => request('POST', `/events/${eventId}/import/participants`, formData, true),
    checkin: (id, documents) => request('POST', `/participants/${id}/checkin`, { documents }),
    startScan: () => request('POST', '/rfid/scan-mode/start'),
    stopScan: () => request('POST', '/rfid/scan-mode/stop'),
  },

  // Races
  races: {
    list: (eventId) => request('GET', `/events/${eventId}/races`),
    listForCategory: (categoryId) => request('GET', `/categories/${categoryId}/races`),
    start: (categoryId) => request('POST', `/categories/${categoryId}/races`, {}),
    update: (id, body) => request('PATCH', `/races/${id}`, body),
    audit: (raceRunId) => request('GET', `/races/${raceRunId}/audit`),
  },

  // RFID
  rfid: {
    status: () => request('GET', '/rfid/status'),
  },

  // Reader (R700 management)
  reader: {
    getConfig: () => request('GET', '/reader/config'),
    saveConfig: (body) => request('PATCH', '/reader/config', body),
    preset: () => request('GET', '/reader/preset'),
    savePreset: (body) => request('PUT', '/reader/preset', body),
    status: (role) => request('GET', `/reader/${role}/status`),
    antennas: (role) => request('GET', `/reader/${role}/antennas`),
    configure: (role) => request('POST', `/reader/${role}/configure`),
    start: (role) => request('POST', `/reader/${role}/start`),
    stop: (role) => request('POST', `/reader/${role}/stop`),
  },

  // Checkpoints
  checkpoints: {
    list: (eventId) => request('GET', `/events/${eventId}/checkpoints`),
    create: (eventId, body) => request('POST', `/events/${eventId}/checkpoints`, body),
    update: (id, body) => request('PATCH', `/checkpoints/${id}`, body),
    delete: (id) => request('DELETE', `/checkpoints/${id}`),
    observationsForRace: (raceRunId) => request('GET', `/races/${raceRunId}/checkpoint-observations`),
    postObservation: (checkpointId, body) => request('POST', `/checkpoints/${checkpointId}/observations`, body),
  },

  // Results
  results: {
    list: (raceRunId) => request('GET', `/races/${raceRunId}/results`),
    listForEvent: (eventId) => request('GET', `/events/${eventId}/results`),
    update: (id, body) => request('PATCH', `/results/${id}`, body),
    exportCsv: (raceRunId) => `${BASE}/api/races/${raceRunId}/export/csv`,
    exportPdf: (raceRunId) => `${BASE}/api/races/${raceRunId}/export/pdf`,
    importCheckpoint: (raceRunId, formData, label) =>
      request('POST', `/races/${raceRunId}/checkpoint-imports?label=${encodeURIComponent(label)}`, formData, true),
  },

  // Event Documents
  documents: {
    list: (eventId) => request('GET', `/events/${eventId}/documents`),
    create: (eventId, body) => request('POST', `/events/${eventId}/documents`, body),
    update: (id, body) => request('PATCH', `/documents/${id}`, body),
    delete: (id) => request('DELETE', `/documents/${id}`),
  },

  // SMS
  sms: {
    sendToParticipants: (eventId, participantIds) =>
      request('POST', `/events/${eventId}/sms/checkin`, { participantIds }),
    sendToAll: (eventId) =>
      request('POST', `/events/${eventId}/sms/checkin-all`),
  },

  // Event Secrets
  secrets: {
    getCheckinPin: (eventId) => request('GET', `/events/${eventId}/secrets/checkin-pin`),
    generateCheckinPin: (eventId) => request('POST', `/events/${eventId}/secrets/checkin-pin`),
  },

  // Checkin Sync
  checkinSync: {
    pullNow: (eventId) => request('POST', `/events/${eventId}/sync/checkins`),
  },
}
