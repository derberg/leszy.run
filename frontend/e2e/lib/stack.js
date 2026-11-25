// Test data and fake RFID reads for the admin e2e suite.
//
// Every test makes its own event through the backend API, so tests never share
// state. Reads are published to the stack's own Mosquitto in the R700's
// tagInventory format, the only thing the crossing detector consumes.
import mqtt from 'mqtt'
import postgres from 'postgres'

const API = process.env.ADMIN_E2E_API ?? 'http://127.0.0.1:3071/api'
const MQTT_URL = process.env.ADMIN_E2E_MQTT ?? 'mqtt://127.0.0.1:18871'
// The throwaway Postgres of frontend/e2e/stack.sh. Never configurable: this
// helper writes rows directly, so it must not be pointed at a real database.
const SCRATCH_DB = 'postgres://leszyrun:leszyrun@127.0.0.1:55471/leszyrun'

async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`)
  return json.data
}

export const api = {
  get: (path) => call('GET', path),
  post: (path, body) => call('POST', path, body ?? {}),
  patch: (path, body) => call('PATCH', path, body),
}

/**
 * One event with one category and `runners` participants, each with a tag.
 * The finish window is shortened so a race fits in a test.
 */
export async function seedEvent({ name = 'E2E', runners = [], minFinishSeconds = 5 } = {}) {
  const event = await api.post('/events', {
    name: `${name} ${Date.now()}`,
    date: new Date().toISOString().slice(0, 10),
    location: 'Testowo',
  })
  await api.patch(`/events/${event.id}`, { minFinishSeconds, rssiThreshold: -9000 })
  const category = await api.post(`/events/${event.id}/categories`, { name: '10 km', slug: '10km' })
  // EPCs are unique per seed: races of earlier tests stay active, and a shared
  // tag would be timed in every one of them.
  const prefix = Math.floor(Math.random() * 0xffffff).toString(16).toUpperCase().padStart(6, '0')
  const people = []
  for (const [i, r] of runners.entries()) {
    const p = await api.post(`/events/${event.id}/participants`, {
      firstName: r.firstName, lastName: r.lastName, gender: r.gender ?? 'M',
      club: r.club, categoryId: category.id,
    })
    const epc = `E2E${prefix}${String(i + 1).padStart(15, '0')}`
    people.push(await api.patch(`/participants/${p.id}`, { rfidEpc: epc }))
  }
  await pinEmojis(people)
  return { event, category, people: await participantsOf(event.id).then((all) => people.map((p) => all.find((a) => a.id === p.id))) }
}

// The backend gives each runner a random emoji, and the table names each row
// by it. The replay cache finds a control by its row's name, so a random emoji
// makes every recorded table action miss on the next run.
const EMOJIS = ['🦊', '🦉', '🐻', '🦌', '🐗', '🦔', '🐿️', '🦅']
async function pinEmojis(people) {
  const sql = postgres(SCRATCH_DB, { max: 1 })
  try {
    for (const [i, p] of people.entries()) {
      await sql`UPDATE participants SET emoji = ${EMOJIS[i]} WHERE id = ${p.id}`
    }
  } finally {
    await sql.end()
  }
}

/**
 * Checks runners in. The admin panel's check-in writes to Supabase first and
 * the stack has none, so the rows go straight into the scratch database, as
 * checkinSync would pull them on a real host.
 */
export async function checkIn(eventId, people) {
  const sql = postgres(SCRATCH_DB, { max: 1 })
  try {
    for (const p of people) {
      await sql`INSERT INTO checkins (participant_id, event_id, checked_in_at) VALUES (${p.id}, ${eventId}, now())`
    }
  } finally {
    await sql.end()
  }
}

export const participantsOf = (eventId) => api.get(`/events/${eventId}/participants`)
export const resultsOf = (raceRunId) => api.get(`/races/${raceRunId}/results`)

/** Publishes R700 tagInventory reads: [{ epc, atMs, rssi }], atMs from now. */
export async function publishReads(reads, { topic = 'leszyrun' } = {}) {
  const client = await mqtt.connectAsync(MQTT_URL, { clientId: `e2e-reader-${process.pid}-${Date.now()}` })
  try {
    const t0 = Date.now()
    for (const r of [...reads].sort((a, b) => a.atMs - b.atMs)) {
      const wait = t0 + r.atMs - Date.now()
      if (wait > 0) await new Promise((ok) => setTimeout(ok, wait))
      await client.publishAsync(topic, JSON.stringify({
        eventType: 'tagInventory',
        tagInventoryEvent: {
          epc: Buffer.from(r.epc, 'hex').toString('base64'),
          antennaPort: 1,
          peakRssiCdbm: r.rssi ?? -5000,
          frequency: 865700,
        },
      }))
    }
  } finally {
    await client.endAsync()
  }
}

/** A pass under the antenna: reads every 100 ms for `durationMs`, strongest at the middle. */
export function pass(epc, startMs, durationMs = 800) {
  const reads = []
  for (let t = 0; t <= durationMs; t += 100) {
    const fromPeak = Math.abs(t - durationMs / 2)
    reads.push({ epc, atMs: startMs + t, rssi: -4000 - fromPeak * 5 })
  }
  return reads
}
