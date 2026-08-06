import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp } from '../src/app.js'

// Polls `fn` (which may be async) until it returns a truthy value, instead of
// a fixed sleep — avoids flakiness from exact interval timing.
async function waitFor(fn, { timeout = 2000, interval = 10 } = {}) {
  const start = Date.now()
  while (true) {
    if (await fn()) return
    if (Date.now() - start > timeout) throw new Error('waitFor: timed out')
    await new Promise((r) => setTimeout(r, interval))
  }
}

async function makeApp(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cpapp-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const deps = {
    config: { dataDir: dir, mqttUrl: 'mqtt://localhost:1883', mqttTopic: 'leszyrun/checkpoint', goneWindowMs: 3000, uploadIntervalMs: 999999, supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'anon' },
    supabase: {
      from: (table) => ({
        select: () => ({
          gte: () => ({ order: () => ({ limit: async () => ({ data: [{ id: 'ev1', name: 'Race', date: '2026-08-01' }], error: null }) }) }),
          eq: () => ({ order: async () => ({ data: [{ id: 'cp1', name: 'CP 1', km_marker: '5.00' }], error: null }) }),
        }),
        insert: async () => ({ error: null }),
        upsert: async () => ({ error: null }),
      }),
    },
    fetchRoster: async ({ eventId, pin }) =>
      pin === '123456' ? { ok: true, roster: [{ bib_number: 101, rfid_epc: 'AABBCC01' }] } : { ok: false, status: 401, error: 'Invalid PIN' },
    createReader: () => ({ getStatus: async () => ({ status: 'idle' }), configure: async () => {}, start: async () => {}, stop: async () => {} }),
    connectMqtt: () => ({ on: () => {}, subscribe: () => {}, end: () => {} }),
    clockStatus: async () => ({ synced: true, source: 'test' }),
    detectLanIp: () => '10.0.0.99',
    ...overrides,
  }
  const app = await buildApp(deps)
  t.after(() => app.close())
  return app
}

test('GET /api/state before setup: no session, not running', async (t) => {
  const app = await makeApp(t)
  const res = await app.inject({ method: 'GET', url: '/api/state' })
  assert.equal(res.statusCode, 200)
  const { data } = res.json()
  assert.equal(data.session, null)
  assert.equal(data.running, false)
})

test('GET /api/events lists events', async (t) => {
  const app = await makeApp(t)
  const res = await app.inject({ method: 'GET', url: '/api/events' })
  assert.deepEqual(res.json().data[0].id, 'ev1')
})

test('GET /api/events/:eventId/checkpoints lists checkpoints', async (t) => {
  const app = await makeApp(t)
  const res = await app.inject({ method: 'GET', url: '/api/events/ev1/checkpoints' })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json().data[0].id, 'cp1')
})

test('setup with wrong PIN returns 401 and stores nothing', async (t) => {
  const app = await makeApp(t)
  const res = await app.inject({ method: 'POST', url: '/api/setup', payload: { eventId: 'ev1', eventName: 'Race', checkpointId: 'cp1', checkpointName: 'CP 1', pin: '000000', readerIp: '10.0.0.5' } })
  assert.equal(res.statusCode, 401)
  const state = await app.inject({ method: 'GET', url: '/api/state' })
  assert.equal(state.json().data.session, null)
})

test('setup missing fields returns 400', async (t) => {
  const app = await makeApp(t)
  const res = await app.inject({ method: 'POST', url: '/api/setup', payload: { eventId: 'ev1' } })
  assert.equal(res.statusCode, 400)
})

// Path traversal: checkpointId flows straight into ObservationQueue's
// queue-<checkpointId>.jsonl filename. The agent listens on 0.0.0.0 with no
// auth, so an unvalidated checkpointId is an unauthenticated arbitrary-path
// file-append primitive — /api/setup must reject it before calling fetchRoster.
test('setup with a path-traversal checkpointId returns 400 and stores no session', async (t) => {
  const app = await makeApp(t)
  const res = await app.inject({ method: 'POST', url: '/api/setup', payload: { eventId: 'ev1', eventName: 'Race', checkpointId: '../../etc/passwd', checkpointName: 'CP 1', pin: '123456', readerIp: '10.0.0.5' } })
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().error, 'Invalid eventId or checkpointId')
  const state = await app.inject({ method: 'GET', url: '/api/state' })
  assert.equal(state.json().data.session, null)
})

test('setup with a path-traversal eventId returns 400 and stores no session', async (t) => {
  const app = await makeApp(t)
  const res = await app.inject({ method: 'POST', url: '/api/setup', payload: { eventId: '../../etc/passwd', eventName: 'Race', checkpointId: 'cp1', checkpointName: 'CP 1', pin: '123456', readerIp: '10.0.0.5' } })
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().error, 'Invalid eventId or checkpointId')
  const state = await app.inject({ method: 'GET', url: '/api/state' })
  assert.equal(state.json().data.session, null)
})

test('setup without explicit mqttHost defaults to detectLanIp()', async (t) => {
  const app = await makeApp(t)
  const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { eventId: 'ev1', eventName: 'Race', checkpointId: 'cp1', checkpointName: 'CP 1', pin: '123456', readerIp: '10.0.0.5' } })
  assert.equal(setup.statusCode, 200)
  assert.equal(app.deps.session.mqttHost, '10.0.0.99')
})

test('setup with explicit mqttHost keeps operator value (does not call detectLanIp)', async (t) => {
  const app = await makeApp(t, { detectLanIp: () => { throw new Error('should not be called') } })
  const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { eventId: 'ev1', eventName: 'Race', checkpointId: 'cp1', checkpointName: 'CP 1', pin: '123456', readerIp: '10.0.0.5', mqttHost: '192.168.1.50' } })
  assert.equal(setup.statusCode, 200)
  assert.equal(app.deps.session.mqttHost, '192.168.1.50')
})

test('setup without detectLanIp result falls back to localhost', async (t) => {
  const app = await makeApp(t, { detectLanIp: () => null })
  const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { eventId: 'ev1', eventName: 'Race', checkpointId: 'cp1', checkpointName: 'CP 1', pin: '123456', readerIp: '10.0.0.5' } })
  assert.equal(setup.statusCode, 200)
  assert.equal(app.deps.session.mqttHost, 'localhost')
})

test('setup → start → state shows running; stop stops', async (t) => {
  const app = await makeApp(t)
  const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { eventId: 'ev1', eventName: 'Race', checkpointId: 'cp1', checkpointName: 'CP 1', pin: '123456', readerIp: '10.0.0.5' } })
  assert.equal(setup.statusCode, 200)
  assert.equal(setup.json().data.rosterCount, 1)
  const start = await app.inject({ method: 'POST', url: '/api/start', payload: {} })
  assert.equal(start.statusCode, 200)
  let state = (await app.inject({ method: 'GET', url: '/api/state' })).json().data
  assert.equal(state.running, true)
  assert.equal(state.knownCount, 1)
  const stop = await app.inject({ method: 'POST', url: '/api/stop' })
  assert.equal(stop.statusCode, 200)
  state = (await app.inject({ method: 'GET', url: '/api/state' })).json().data
  assert.equal(state.running, false)
})

test('start without setup returns 409', async (t) => {
  const app = await makeApp(t)
  const res = await app.inject({ method: 'POST', url: '/api/start', payload: {} })
  assert.equal(res.statusCode, 409)
})

test('start blocked when clock unsynced, allowed with overrideClock', async (t) => {
  const app = await makeApp(t, { clockStatus: async () => ({ synced: false, source: 'test' }) })
  await app.inject({ method: 'POST', url: '/api/setup', payload: { eventId: 'ev1', eventName: 'Race', checkpointId: 'cp1', checkpointName: 'CP 1', pin: '123456', readerIp: '10.0.0.5' } })
  const blocked = await app.inject({ method: 'POST', url: '/api/start', payload: {} })
  assert.equal(blocked.statusCode, 423)
  const forced = await app.inject({ method: 'POST', url: '/api/start', payload: { overrideClock: true } })
  assert.equal(forced.statusCode, 200)
})

test('GET /api/reader/status proxies reader status; 409 without session', async (t) => {
  const app = await makeApp(t)
  const noSession = await app.inject({ method: 'GET', url: '/api/reader/status' })
  assert.equal(noSession.statusCode, 409)
  await app.inject({ method: 'POST', url: '/api/setup', payload: { eventId: 'ev1', eventName: 'Race', checkpointId: 'cp1', checkpointName: 'CP 1', pin: '123456', readerIp: '10.0.0.5' } })
  const res = await app.inject({ method: 'GET', url: '/api/reader/status' })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json().data, { status: 'idle' })
})

test('GET /api/reader/status returns 502 when reader unreachable', async (t) => {
  const app = await makeApp(t, { createReader: () => ({ getStatus: async () => { throw new Error('unreachable') }, configure: async () => {}, start: async () => {}, stop: async () => {} }) })
  await app.inject({ method: 'POST', url: '/api/setup', payload: { eventId: 'ev1', eventName: 'Race', checkpointId: 'cp1', checkpointName: 'CP 1', pin: '123456', readerIp: '10.0.0.5' } })
  const res = await app.inject({ method: 'GET', url: '/api/reader/status' })
  assert.equal(res.statusCode, 502)
})

test('reset stops and clears session (queue files kept on disk)', async (t) => {
  const app = await makeApp(t)
  await app.inject({ method: 'POST', url: '/api/setup', payload: { eventId: 'ev1', eventName: 'Race', checkpointId: 'cp1', checkpointName: 'CP 1', pin: '123456', readerIp: '10.0.0.5' } })
  await app.inject({ method: 'POST', url: '/api/start', payload: {} })
  const res = await app.inject({ method: 'POST', url: '/api/reset' })
  assert.equal(res.statusCode, 200)
  const state = (await app.inject({ method: 'GET', url: '/api/state' })).json().data
  assert.equal(state.session, null)
  assert.equal(state.running, false)
})

// Finding 3: reset must null out queue/confirmer/resolver/uploader refs (and
// zero the reads counter) so /api/state doesn't keep reporting the dead
// session's counts after a reset.
test('reset clears stale queue/confirmer/resolver/uploader state — /api/state reports zeros', async (t) => {
  const app = await makeApp(t)
  await app.inject({ method: 'POST', url: '/api/setup', payload: { eventId: 'ev1', eventName: 'Race', checkpointId: 'cp1', checkpointName: 'CP 1', pin: '123456', readerIp: '10.0.0.5' } })
  await app.inject({ method: 'POST', url: '/api/start', payload: {} })
  // knownCount should be 1 while the session is live (roster has one entry)
  let state = (await app.inject({ method: 'GET', url: '/api/state' })).json().data
  assert.equal(state.knownCount, 1)
  await app.inject({ method: 'POST', url: '/api/reset' })
  state = (await app.inject({ method: 'GET', url: '/api/state' })).json().data
  assert.deepEqual(state.counts, { total: 0, pending: 0 })
  assert.equal(state.confirmedCount, 0)
  assert.equal(state.knownCount, 0)
  assert.equal(state.inRangeCount, 0)
  assert.deepEqual(state.reads, { total: 0, lastAt: null })
})

// Finding 2: a second /api/start while already running must not spin up a
// duplicate reader/MQTT client/Uploader interval — stopAll() only ever stops
// the LATEST set of live services, so a leaked earlier set would run forever.
test('POST /api/start while already running returns 409 and does not replace live services', async (t) => {
  const app = await makeApp(t)
  await app.inject({ method: 'POST', url: '/api/setup', payload: { eventId: 'ev1', eventName: 'Race', checkpointId: 'cp1', checkpointName: 'CP 1', pin: '123456', readerIp: '10.0.0.5' } })
  const first = await app.inject({ method: 'POST', url: '/api/start', payload: {} })
  assert.equal(first.statusCode, 200)
  const uploaderRef = app.deps.uploader
  const queueRef = app.deps.queue
  const mqttClientRef = app.deps.mqttClient
  assert.ok(uploaderRef)
  const second = await app.inject({ method: 'POST', url: '/api/start', payload: {} })
  assert.equal(second.statusCode, 409)
  assert.equal(second.json().error, 'Already running')
  // nothing was replaced by the rejected second start
  assert.equal(app.deps.uploader, uploaderRef)
  assert.equal(app.deps.queue, queueRef)
  assert.equal(app.deps.mqttClient, mqttClientRef)
})

// Finding 1: the queue must be scoped per checkpoint. Before the fix,
// Confirmer.seed(queue.epcs()) blacklisted every EPC the device had EVER
// seen across every checkpoint session, so the same tag replayed at a
// different checkpoint would silently never confirm again.
test('checkpoint sessions use isolated queues: same EPC confirms again at a different checkpoint', async (t) => {
  let messageHandler
  const inserted = []
  const dir = await mkdtemp(join(tmpdir(), 'cpapp-scope-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const app = await buildApp({
    config: { dataDir: dir, mqttUrl: 'mqtt://localhost:1883', mqttTopic: 'leszyrun/checkpoint', goneWindowMs: 50, uploadIntervalMs: 999999, supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'anon' },
    supabase: {
      from: (table) => table === 'checkpoint_observations'
        ? { insert: async (row) => { inserted.push(row); return { error: null } } }
        : { select: () => ({ order: () => ({ limit: async () => ({ data: [], error: null }) }), eq: () => ({ order: async () => ({ data: [], error: null }) }) }) },
    },
    fetchRoster: async ({ pin }) =>
      pin === '123456' ? { ok: true, roster: [{ bib_number: 101, rfid_epc: 'AABBCC01' }] } : { ok: false, status: 401, error: 'Invalid PIN' },
    createReader: () => ({ getStatus: async () => ({ status: 'idle' }), configure: async () => {}, start: async () => {}, stop: async () => {} }),
    connectMqtt: () => ({
      on: (ev, fn) => { if (ev === 'message') messageHandler = fn },
      subscribe: () => {}, end: () => {},
    }),
    clockStatus: async () => ({ synced: true, source: 'test' }),
    detectLanIp: () => '10.0.0.99',
  })
  t.after(() => app.close())

  const payload = Buffer.from(JSON.stringify({ eventType: 'tagInventory', tagInventoryEvent: { epc: 'qrvMAQ==', peakRssiCdbm: -4000, antennaPort: 1 } }))

  // --- Session 1: checkpoint cp1
  // armMode: 'immediate' — this test exercises queue scoping, not arming.
  await app.inject({ method: 'POST', url: '/api/setup', payload: { eventId: 'ev1', eventName: 'Race', checkpointId: 'cp1', checkpointName: 'CP 1', pin: '123456', readerIp: '10.0.0.5', armMode: 'immediate' } })
  await app.inject({ method: 'POST', url: '/api/start', payload: {} })
  messageHandler('leszyrun/checkpoint', payload)
  await new Promise((r) => setTimeout(r, 150))
  await app.deps.uploader.flush()
  assert.equal(inserted.length, 1)
  assert.equal(inserted[0].checkpoint_id, 'cp1')

  await app.inject({ method: 'POST', url: '/api/stop' })
  await app.inject({ method: 'POST', url: '/api/reset' })

  // --- Session 2: checkpoint cp2, same roster EPC, same physical tag read
  await app.inject({ method: 'POST', url: '/api/setup', payload: { eventId: 'ev1', eventName: 'Race', checkpointId: 'cp2', checkpointName: 'CP 2', pin: '123456', readerIp: '10.0.0.5', armMode: 'immediate' } })
  await app.inject({ method: 'POST', url: '/api/start', payload: {} })
  messageHandler('leszyrun/checkpoint', payload) // replay the SAME tag read
  await new Promise((r) => setTimeout(r, 150))
  await app.deps.uploader.flush()

  assert.equal(inserted.length, 2)
  assert.equal(inserted[1].checkpoint_id, 'cp2')
  assert.equal(inserted[1].bib_number, 101)
})

test('MQTT read → confirm → queue → flush inserts observation', async (t) => {
  let messageHandler
  const inserted = []
  const app = await makeApp(t, {
    config: { dataDir: (await mkdtemp(join(tmpdir(), 'cpapp-flush-'))), mqttUrl: 'mqtt://localhost:1883', mqttTopic: 'leszyrun/checkpoint', goneWindowMs: 50, uploadIntervalMs: 999999, supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'anon' },
    connectMqtt: () => ({
      on: (ev, fn) => { if (ev === 'message') messageHandler = fn },
      subscribe: () => {}, end: () => {},
    }),
    supabase: {
      from: (table) => table === 'checkpoint_observations'
        ? { insert: async (row) => { inserted.push(row); return { error: null } } }
        : { select: () => ({ order: () => ({ limit: async () => ({ data: [], error: null }) }), eq: () => ({ order: async () => ({ data: [], error: null }) }) }) },
    },
  })
  await app.inject({ method: 'POST', url: '/api/setup', payload: { eventId: 'ev1', eventName: 'Race', checkpointId: 'cp1', checkpointName: 'CP 1', pin: '123456', readerIp: '10.0.0.5', armMode: 'immediate' } })
  await app.inject({ method: 'POST', url: '/api/start', payload: {} })
  // EPC AABBCC01 = base64 qrvMAQ==
  const payload = Buffer.from(JSON.stringify({ eventType: 'tagInventory', tagInventoryEvent: { epc: 'qrvMAQ==', peakRssiCdbm: -4000, antennaPort: 1 } }))
  messageHandler('leszyrun/checkpoint', payload)
  // goneWindowMs: 50 (config override above) — wait past the gone window with margin
  await new Promise((r) => setTimeout(r, 150))
  await app.deps.uploader.flush()
  assert.equal(inserted.length, 1)
  assert.equal(inserted[0].bib_number, 101)
  assert.equal(inserted[0].checkpoint_id, 'cp1')
  assert.equal(inserted[0].source, 'rfid') // RFID reads are marked authoritative
})

// Live raw-reads feed: every parsed MQTT read is mirrored into
// state.recentReads (newest first) for display, resolving the bib via the
// non-mutating resolver.lookup() — a known EPC shows its bib, an unknown one
// shows null without polluting unknownList()/knownCount.
test('recentReads: records known and unknown reads, newest first, with resolved bib', async (t) => {
  let messageHandler
  const app = await makeApp(t, {
    connectMqtt: () => ({
      on: (ev, fn) => { if (ev === 'message') messageHandler = fn },
      subscribe: () => {}, end: () => {},
    }),
  })
  await app.inject({ method: 'POST', url: '/api/setup', payload: { eventId: 'ev1', eventName: 'Race', checkpointId: 'cp1', checkpointName: 'CP 1', pin: '123456', readerIp: '10.0.0.5', armMode: 'immediate' } })
  await app.inject({ method: 'POST', url: '/api/start', payload: {} })

  // EPC AABBCC01 = base64 qrvMAQ== (on the roster, bib 101)
  const known = Buffer.from(JSON.stringify({ eventType: 'tagInventory', tagInventoryEvent: { epc: 'qrvMAQ==', peakRssiCdbm: -4000, antennaPort: 1 } }))
  // EPC DEADBEEF = base64 3q2+7w== (not on the roster)
  const unknown = Buffer.from(JSON.stringify({ eventType: 'tagInventory', tagInventoryEvent: { epc: '3q2+7w==', peakRssiCdbm: -5500, antennaPort: 2 } }))

  messageHandler('leszyrun/checkpoint', known)
  messageHandler('leszyrun/checkpoint', unknown)

  const state = (await app.inject({ method: 'GET', url: '/api/state' })).json().data
  assert.equal(state.recentReads.length, 2)
  // newest first: the unknown read (sent second) is at index 0
  assert.equal(state.recentReads[0].epc, 'DEADBEEF')
  assert.equal(state.recentReads[0].bib, null)
  assert.equal(state.recentReads[0].rssiCdbm, -5500)
  assert.equal(state.recentReads[0].antennaPort, 2)
  assert.equal(state.recentReads[0].armed, true)
  assert.ok(state.recentReads[0].at)
  assert.equal(state.recentReads[1].epc, 'AABBCC01')
  assert.equal(state.recentReads[1].bib, 101)
  assert.equal(state.recentReads[1].rssiCdbm, -4000)
  assert.equal(state.recentReads[1].antennaPort, 1)

  // lookup() must not have polluted the unknown-tag tracking used elsewhere.
  assert.deepEqual(state.unknown, [])
})

test('recentReads: ring buffer caps at 30 entries, newest first', async (t) => {
  let messageHandler
  const app = await makeApp(t, {
    connectMqtt: () => ({
      on: (ev, fn) => { if (ev === 'message') messageHandler = fn },
      subscribe: () => {}, end: () => {},
    }),
  })
  await app.inject({ method: 'POST', url: '/api/setup', payload: { eventId: 'ev1', eventName: 'Race', checkpointId: 'cp1', checkpointName: 'CP 1', pin: '123456', readerIp: '10.0.0.5', armMode: 'immediate' } })
  await app.inject({ method: 'POST', url: '/api/start', payload: {} })

  // EPC AABBCC01 = base64 qrvMAQ==; vary rssi per read so each entry is distinguishable.
  for (let i = 0; i < 35; i++) {
    const payload = Buffer.from(JSON.stringify({ eventType: 'tagInventory', tagInventoryEvent: { epc: 'qrvMAQ==', peakRssiCdbm: -4000 - i, antennaPort: 1 } }))
    messageHandler('leszyrun/checkpoint', payload)
  }

  const state = (await app.inject({ method: 'GET', url: '/api/state' })).json().data
  assert.equal(state.recentReads.length, 30)
  // Newest first: the last read pushed (i=34, rssi -4034) must be at index 0;
  // the oldest surviving entry (i=5, rssi -4005) is at the end.
  assert.equal(state.recentReads[0].rssiCdbm, -4034)
  assert.equal(state.recentReads[29].rssiCdbm, -4005)
})

// Companion to the race_start arm-mode test above: the whole point of the
// raw-reads feed is visibility into reads arriving BEFORE the race starts —
// they must still show up in recentReads (armed: false) even though they
// never reach the confirmer.
test('recentReads: reads arriving while disarmed still appear (armed: false), confirmedCount stays 0', async (t) => {
  let messageHandler
  const dir = await mkdtemp(join(tmpdir(), 'cpapp-arm-raw-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const app = await buildApp({
    config: {
      dataDir: dir, mqttUrl: 'mqtt://localhost:1883', mqttTopic: 'leszyrun/checkpoint',
      goneWindowMs: 50, uploadIntervalMs: 999999, armPollMs: 999999,
      supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'anon',
    },
    supabase: {
      from: (table) => {
        if (table === 'categories') return { select: () => ({ eq: async () => ({ data: [], error: null }) }) }
        if (table === 'race_runs') return { select: () => ({ in: () => ({ in: async () => ({ data: [], error: null }) }) }) }
        return { upsert: async () => ({ error: null }), insert: async () => ({ error: null }) }
      },
    },
    fetchRoster: async ({ pin }) =>
      pin === '123456' ? { ok: true, roster: [{ bib_number: 101, rfid_epc: 'AABBCC01' }] } : { ok: false, status: 401, error: 'Invalid PIN' },
    createReader: () => ({ getStatus: async () => ({ status: 'idle' }), configure: async () => {}, start: async () => {}, stop: async () => {} }),
    connectMqtt: () => ({
      on: (ev, fn) => { if (ev === 'message') messageHandler = fn },
      subscribe: () => {}, end: () => {},
    }),
    clockStatus: async () => ({ synced: true, source: 'test' }),
    detectLanIp: () => '10.0.0.99',
  })
  t.after(() => app.close())

  await app.inject({ method: 'POST', url: '/api/setup', payload: { eventId: 'ev1', eventName: 'Race', checkpointId: 'cp1', checkpointName: 'CP 1', pin: '123456', readerIp: '10.0.0.5', armMode: 'race_start' } })
  await app.inject({ method: 'POST', url: '/api/start', payload: {} })

  let state = (await app.inject({ method: 'GET', url: '/api/state' })).json().data
  assert.equal(state.armed, false)

  const payload = Buffer.from(JSON.stringify({ eventType: 'tagInventory', tagInventoryEvent: { epc: 'qrvMAQ==', peakRssiCdbm: -4000, antennaPort: 1 } }))
  messageHandler('leszyrun/checkpoint', payload)
  await new Promise((r) => setTimeout(r, 150))

  state = (await app.inject({ method: 'GET', url: '/api/state' })).json().data
  assert.equal(state.recentReads.length, 1)
  assert.equal(state.recentReads[0].epc, 'AABBCC01')
  assert.equal(state.recentReads[0].bib, 101)
  assert.equal(state.recentReads[0].armed, false)
  assert.equal(app.deps.confirmer.confirmedCount, 0)
})

// Reader auto-recovery: a mid-race R700 power cycle wipes its MQTT +
// inventory-preset config. Coming back "reachable" isn't enough — the agent
// must notice and re-run configure()+start(), or the reader silently stays
// idle forever. The poll: getStatus() throws => readerDown; once it succeeds
// again (previous poll had failed, or status isn't 'running') => reconfigure.
test('reader auto-recovery: getStatus failure then success reconfigures and clears readerDown', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cpapp-recover-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  let getStatusCalls = 0
  let configureCalls = 0
  let startCalls = 0
  const app = await buildApp({
    config: { dataDir: dir, mqttUrl: 'mqtt://localhost:1883', mqttTopic: 'leszyrun/checkpoint', goneWindowMs: 3000, uploadIntervalMs: 999999, readerPollMs: 30, supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'anon' },
    supabase: {
      from: () => ({
        select: () => ({ order: () => ({ limit: async () => ({ data: [], error: null }) }), eq: () => ({ order: async () => ({ data: [], error: null }) }) }),
        insert: async () => ({ error: null }),
      }),
    },
    fetchRoster: async ({ pin }) => pin === '123456' ? { ok: true, roster: [] } : { ok: false, status: 401, error: 'Invalid PIN' },
    createReader: () => ({
      getStatus: async () => {
        getStatusCalls += 1
        if (getStatusCalls === 1) throw new Error('unreachable')
        return { status: 'idle' }
      },
      configure: async () => { configureCalls += 1 },
      start: async () => { startCalls += 1 },
      stop: async () => {},
    }),
    connectMqtt: () => ({ on: () => {}, subscribe: () => {}, end: () => {} }),
    clockStatus: async () => ({ synced: true, source: 'test' }),
    detectLanIp: () => '10.0.0.99',
  })
  t.after(() => app.close())

  await app.inject({ method: 'POST', url: '/api/setup', payload: { eventId: 'ev1', eventName: 'Race', checkpointId: 'cp1', checkpointName: 'CP 1', pin: '123456', readerIp: '10.0.0.5' } })
  await app.inject({ method: 'POST', url: '/api/start', payload: {} })
  assert.equal(configureCalls, 1) // from /api/start itself
  assert.equal(startCalls, 1)

  // First poll tick: getStatus() throws → readerDown flips true, visible via GET /api/state
  await waitFor(async () => {
    const s = (await app.inject({ method: 'GET', url: '/api/state' })).json().data
    return s.readerDown === true
  })

  // Next poll tick: getStatus() succeeds with {status:'idle'}; since the previous
  // poll had failed, the agent must reconfigure+restart the reader and clear readerDown.
  await waitFor(async () => {
    const s = (await app.inject({ method: 'GET', url: '/api/state' })).json().data
    return s.readerDown === false
  })
  assert.equal(configureCalls, 2)
  assert.equal(startCalls, 2)
})

// Test mode without a reader: setup accepts noReader:true with no readerIp,
// start skips createReader entirely (a createReader that throws proves it's
// never called), and the MQTT/confirm/resolve/queue/upload pipeline still
// runs end-to-end off the simulator.
test('noReader mode: setup without readerIp succeeds, start never calls createReader, MQTT read flows to insert', async (t) => {
  let messageHandler
  const inserted = []
  const dir = await mkdtemp(join(tmpdir(), 'cpapp-noreader-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const app = await buildApp({
    config: { dataDir: dir, mqttUrl: 'mqtt://localhost:1883', mqttTopic: 'leszyrun/checkpoint', goneWindowMs: 50, uploadIntervalMs: 999999, supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'anon' },
    supabase: {
      from: (table) => table === 'checkpoint_observations'
        ? { insert: async (row) => { inserted.push(row); return { error: null } } }
        : { select: () => ({ order: () => ({ limit: async () => ({ data: [], error: null }) }), eq: () => ({ order: async () => ({ data: [], error: null }) }) }) },
    },
    fetchRoster: async ({ pin }) =>
      pin === '123456' ? { ok: true, roster: [{ bib_number: 101, rfid_epc: 'AABBCC01' }] } : { ok: false, status: 401, error: 'Invalid PIN' },
    createReader: () => { throw new Error('createReader must not be called in noReader mode') },
    connectMqtt: () => ({
      on: (ev, fn) => { if (ev === 'message') messageHandler = fn },
      subscribe: () => {}, end: () => {},
    }),
    clockStatus: async () => ({ synced: true, source: 'test' }),
    detectLanIp: () => '10.0.0.99',
  })
  t.after(() => app.close())

  const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { eventId: 'ev1', eventName: 'Race', checkpointId: 'cp1', checkpointName: 'CP 1', pin: '123456', noReader: true, armMode: 'immediate' } })
  assert.equal(setup.statusCode, 200)
  assert.equal(setup.json().data.rosterCount, 1)

  const start = await app.inject({ method: 'POST', url: '/api/start', payload: {} })
  assert.equal(start.statusCode, 200)
  let state = (await app.inject({ method: 'GET', url: '/api/state' })).json().data
  assert.equal(state.running, true)
  assert.equal(state.noReader, true)
  assert.equal(app.deps.reader, null)

  const payload = Buffer.from(JSON.stringify({ eventType: 'tagInventory', tagInventoryEvent: { epc: 'qrvMAQ==', peakRssiCdbm: -4000, antennaPort: 1 } }))
  messageHandler('leszyrun/checkpoint', payload)
  await new Promise((r) => setTimeout(r, 150))
  await app.deps.uploader.flush()
  assert.equal(inserted.length, 1)
  assert.equal(inserted[0].bib_number, 101)
  assert.equal(inserted[0].checkpoint_id, 'cp1')
})

test('noReader mode: GET /api/reader/status returns simulated flag without contacting a reader', async (t) => {
  const app = await makeApp(t, { createReader: () => { throw new Error('createReader must not be called in noReader mode') } })
  const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { eventId: 'ev1', eventName: 'Race', checkpointId: 'cp1', checkpointName: 'CP 1', pin: '123456', noReader: true } })
  assert.equal(setup.statusCode, 200)
  const res = await app.inject({ method: 'GET', url: '/api/reader/status' })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json().data, { simulated: true })
})

// Normal mode must stay unchanged: readerIp is still required, GET
// /api/state reports noReader: false, and /api/reader/status still proxies
// the real reader.
test('normal mode unaffected: readerIp still required, noReader false in state', async (t) => {
  const app = await makeApp(t)
  const missingIp = await app.inject({ method: 'POST', url: '/api/setup', payload: { eventId: 'ev1', eventName: 'Race', checkpointId: 'cp1', checkpointName: 'CP 1', pin: '123456' } })
  assert.equal(missingIp.statusCode, 400)

  const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { eventId: 'ev1', eventName: 'Race', checkpointId: 'cp1', checkpointName: 'CP 1', pin: '123456', readerIp: '10.0.0.5' } })
  assert.equal(setup.statusCode, 200)
  const state = (await app.inject({ method: 'GET', url: '/api/state' })).json().data
  assert.equal(state.noReader, false)

  await app.inject({ method: 'POST', url: '/api/start', payload: {} })
  const res = await app.inject({ method: 'GET', url: '/api/reader/status' })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json().data, { status: 'idle' })
})

// Arm-at-race-start gating: all the other MQTT tests above use armMode:
// 'immediate', so the disarmed-drop path (and the transition out of it) is
// otherwise untested. Build a fake supabase whose categories/race_runs
// queries mirror armer.js's own query shape exactly (select().eq() for
// categories, select().in().in() for race_runs) and flip its answer once the
// "race" starts.
test('race_start arm mode: reads are dropped while disarmed, recorded once the armer sees the race start', async (t) => {
  let messageHandler
  const inserted = []
  let raceStarted = false
  const dir = await mkdtemp(join(tmpdir(), 'cpapp-arm-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const app = await buildApp({
    config: {
      dataDir: dir, mqttUrl: 'mqtt://localhost:1883', mqttTopic: 'leszyrun/checkpoint',
      goneWindowMs: 50, uploadIntervalMs: 999999, armPollMs: 30,
      supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'anon',
    },
    supabase: {
      from: (table) => {
        if (table === 'checkpoint_observations') {
          return { insert: async (row) => { inserted.push(row); return { error: null } } }
        }
        if (table === 'categories') {
          // armer.js: supabase.from('categories').select('id').eq('event_id', eventId)
          return { select: () => ({ eq: async () => ({ data: raceStarted ? [{ id: 'cat1' }] : [], error: null }) }) }
        }
        if (table === 'race_runs') {
          // armer.js: supabase.from('race_runs').select('id').in('category_id', ids).in('status', [...])
          return { select: () => ({ in: () => ({ in: async () => ({ data: raceStarted ? [{ id: 'run1' }] : [], error: null }) }) }) }
        }
        // checkpoint_agents heartbeat upsert — display-only, not asserted here
        return { upsert: async () => ({ error: null }), insert: async () => ({ error: null }) }
      },
    },
    fetchRoster: async ({ pin }) =>
      pin === '123456' ? { ok: true, roster: [{ bib_number: 101, rfid_epc: 'AABBCC01' }] } : { ok: false, status: 401, error: 'Invalid PIN' },
    createReader: () => ({ getStatus: async () => ({ status: 'idle' }), configure: async () => {}, start: async () => {}, stop: async () => {} }),
    connectMqtt: () => ({
      on: (ev, fn) => { if (ev === 'message') messageHandler = fn },
      subscribe: () => {}, end: () => {},
    }),
    clockStatus: async () => ({ synced: true, source: 'test' }),
    detectLanIp: () => '10.0.0.99',
  })
  t.after(() => app.close())

  await app.inject({ method: 'POST', url: '/api/setup', payload: { eventId: 'ev1', eventName: 'Race', checkpointId: 'cp1', checkpointName: 'CP 1', pin: '123456', readerIp: '10.0.0.5', armMode: 'race_start' } })
  await app.inject({ method: 'POST', url: '/api/start', payload: {} })

  let state = (await app.inject({ method: 'GET', url: '/api/state' })).json().data
  assert.equal(state.armMode, 'race_start')
  assert.equal(state.armed, false)
  assert.equal(state.status, 'armed_waiting')

  // EPC AABBCC01 = base64 qrvMAQ==
  const payload = Buffer.from(JSON.stringify({ eventType: 'tagInventory', tagInventoryEvent: { epc: 'qrvMAQ==', peakRssiCdbm: -4000, antennaPort: 1 } }))
  messageHandler('leszyrun/checkpoint', payload)
  // Well past the (short) gone window — but disarmed, so this must never
  // reach the confirmer at all.
  await new Promise((r) => setTimeout(r, 150))
  await app.deps.uploader.flush()
  assert.equal(inserted.length, 0)
  assert.equal(app.deps.confirmer.confirmedCount, 0)
  assert.equal(app.deps.ignoredReads, 1)

  // Race "starts": flip the fake supabase data and wait for the armer's next
  // poll (armPollMs: 30) to notice and flip status to 'listening'.
  raceStarted = true
  await waitFor(async () => {
    const s = (await app.inject({ method: 'GET', url: '/api/state' })).json().data
    return s.status === 'listening'
  })
  state = (await app.inject({ method: 'GET', url: '/api/state' })).json().data
  assert.equal(state.armed, true)

  // A subsequent read now flows through to a confirmed, queued, uploaded observation.
  messageHandler('leszyrun/checkpoint', payload)
  await new Promise((r) => setTimeout(r, 150))
  await app.deps.uploader.flush()
  assert.equal(inserted.length, 1)
  assert.equal(inserted[0].bib_number, 101)
})

// Rebind bug: ensureHeartbeat() used to no-op whenever a heartbeat already
// existed, even across a second /api/setup for a DIFFERENT checkpoint — so
// the heartbeat kept upserting under the OLD checkpoint_id forever. Assert
// that setup → setup(different checkpointId) produces upserts keyed to BOTH
// checkpoints, and that the heartbeat instance itself is replaced.
test('ensureHeartbeat rebinds when setup targets a different checkpointId', async (t) => {
  const upserts = []
  const dir = await mkdtemp(join(tmpdir(), 'cpapp-hb-rebind-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const app = await buildApp({
    config: { dataDir: dir, mqttUrl: 'mqtt://localhost:1883', mqttTopic: 'leszyrun/checkpoint', goneWindowMs: 3000, uploadIntervalMs: 999999, heartbeatMs: 999999, supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'anon' },
    supabase: {
      from: (table) => {
        if (table === 'checkpoint_agents') {
          return { upsert: async (row) => { upserts.push(row); return { error: null } } }
        }
        return {
          select: () => ({
            gte: () => ({ order: () => ({ limit: async () => ({ data: [{ id: 'ev1', name: 'Race', date: '2026-08-01' }], error: null }) }) }),
            eq: () => ({ order: async () => ({ data: [{ id: 'cp1', name: 'CP 1', km_marker: '5.00' }], error: null }) }),
          }),
          insert: async () => ({ error: null }),
          upsert: async () => ({ error: null }),
        }
      },
    },
    fetchRoster: async ({ pin }) =>
      pin === '123456' ? { ok: true, roster: [{ bib_number: 101, rfid_epc: 'AABBCC01' }] } : { ok: false, status: 401, error: 'Invalid PIN' },
    createReader: () => ({ getStatus: async () => ({ status: 'idle' }), configure: async () => {}, start: async () => {}, stop: async () => {} }),
    connectMqtt: () => ({ on: () => {}, subscribe: () => {}, end: () => {} }),
    clockStatus: async () => ({ synced: true, source: 'test' }),
    detectLanIp: () => '10.0.0.99',
  })
  t.after(() => app.close())

  await app.inject({ method: 'POST', url: '/api/setup', payload: { eventId: 'ev1', eventName: 'Race', checkpointId: 'cp1', checkpointName: 'CP 1', pin: '123456', readerIp: '10.0.0.5' } })
  await waitFor(() => upserts.some((u) => u.checkpoint_id === 'cp1'))
  const cp1Heartbeat = app.deps.heartbeat
  assert.ok(cp1Heartbeat)

  await app.inject({ method: 'POST', url: '/api/setup', payload: { eventId: 'ev1', eventName: 'Race', checkpointId: 'cp2', checkpointName: 'CP 2', pin: '123456', readerIp: '10.0.0.5' } })
  await waitFor(() => upserts.some((u) => u.checkpoint_id === 'cp2'))
  assert.notEqual(app.deps.heartbeat, cp1Heartbeat)
})

// --- bootstrapFromEnv() — headless auto-config from AUTOCONFIG_* env vars,
// parsed by config.js into config.autoconfig and consumed here. See the
// "same setup/start logic" refactor above (doSetup/doStart) that both the
// HTTP routes and bootstrapFromEnv() now share.

function autoconfigBase(overrides = {}) {
  return {
    present: true,
    eventId: 'ev1',
    checkpointId: 'cp1',
    pin: '123456',
    readerIp: null,
    mqttHost: null,
    readerUsername: null,
    readerPassword: null,
    armMode: 'immediate',
    noReader: true,
    eventName: 'Race',
    checkpointName: 'CP 1',
    ...overrides,
  }
}

function fakeSupabaseForBootstrap(inserted = []) {
  return {
    from: (table) => table === 'checkpoint_observations'
      ? { insert: async (row) => { inserted.push(row); return { error: null } } }
      : {
          select: () => ({
            gte: () => ({ order: () => ({ limit: async () => ({ data: [], error: null }) }) }),
            order: () => ({ limit: async () => ({ data: [], error: null }) }),
            eq: () => ({ order: async () => ({ data: [], error: null }) }),
          }),
          upsert: async () => ({ error: null }),
          insert: async () => ({ error: null }),
        },
  }
}

test('bootstrapFromEnv: no prior session, autoconfig present → configures and starts headlessly', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cpapp-bootstrap-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  let fetchRosterCalls = 0
  const app = await buildApp({
    config: {
      dataDir: dir, mqttUrl: 'mqtt://localhost:1883', mqttTopic: 'leszyrun/checkpoint',
      goneWindowMs: 3000, uploadIntervalMs: 999999, port: 8080,
      supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'anon',
      autoconfig: autoconfigBase(),
    },
    supabase: fakeSupabaseForBootstrap(),
    fetchRoster: async ({ pin }) => {
      fetchRosterCalls += 1
      return pin === '123456' ? { ok: true, roster: [{ bib_number: 101, rfid_epc: 'AABBCC01' }] } : { ok: false, status: 401, error: 'Invalid PIN' }
    },
    createReader: () => { throw new Error('createReader must not be called in noReader autoconfig') },
    connectMqtt: () => ({ on: () => {}, subscribe: () => {}, end: () => {} }),
    clockStatus: async () => ({ synced: true, source: 'test' }),
    detectLanIp: () => '10.0.0.99',
  })
  t.after(() => app.close())

  await app.bootstrapFromEnv()

  const state = (await app.inject({ method: 'GET', url: '/api/state' })).json().data
  assert.equal(state.session.checkpointId, 'cp1')
  assert.equal(state.running, true)
  assert.equal(state.armMode, 'immediate')
  assert.equal(state.status, 'listening')
  assert.equal(fetchRosterCalls, 1)
})

test('bootstrapFromEnv: fetchRoster fails (bad PIN) — does not throw, server keeps running, no session created', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cpapp-bootstrap-badpin-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const app = await buildApp({
    config: {
      dataDir: dir, mqttUrl: 'mqtt://localhost:1883', mqttTopic: 'leszyrun/checkpoint',
      goneWindowMs: 3000, uploadIntervalMs: 999999, port: 8080,
      supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'anon',
      autoconfig: autoconfigBase({ pin: 'wrong' }),
    },
    supabase: fakeSupabaseForBootstrap(),
    fetchRoster: async ({ pin }) =>
      pin === '123456' ? { ok: true, roster: [] } : { ok: false, status: 401, error: 'Invalid PIN' },
    createReader: () => { throw new Error('createReader must not be called') },
    connectMqtt: () => ({ on: () => {}, subscribe: () => {}, end: () => {} }),
    clockStatus: async () => ({ synced: true, source: 'test' }),
    detectLanIp: () => '10.0.0.99',
  })
  t.after(() => app.close())

  await assert.doesNotReject(() => app.bootstrapFromEnv())

  // server still responds
  const res = await app.inject({ method: 'GET', url: '/api/state' })
  assert.equal(res.statusCode, 200)
  const state = res.json().data
  assert.equal(state.session, null)
  assert.equal(state.running, false)
})

test('bootstrapFromEnv: reader configure throwing does not crash — server stays up, no running session', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cpapp-bootstrap-readerfail-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const app = await buildApp({
    config: {
      dataDir: dir, mqttUrl: 'mqtt://localhost:1883', mqttTopic: 'leszyrun/checkpoint',
      goneWindowMs: 3000, uploadIntervalMs: 999999, port: 8080,
      supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'anon',
      autoconfig: autoconfigBase({ noReader: false, readerIp: '10.0.0.5' }),
    },
    supabase: fakeSupabaseForBootstrap(),
    fetchRoster: async ({ pin }) => pin === '123456' ? { ok: true, roster: [] } : { ok: false, status: 401, error: 'Invalid PIN' },
    createReader: () => ({ getStatus: async () => ({ status: 'idle' }), configure: async () => { throw new Error('reader unreachable') }, start: async () => {}, stop: async () => {} }),
    connectMqtt: () => ({ on: () => {}, subscribe: () => {}, end: () => {} }),
    clockStatus: async () => ({ synced: true, source: 'test' }),
    detectLanIp: () => '10.0.0.99',
  })
  t.after(() => app.close())

  await assert.doesNotReject(() => app.bootstrapFromEnv())

  const res = await app.inject({ method: 'GET', url: '/api/state' })
  assert.equal(res.statusCode, 200)
  const state = res.json().data
  // setup succeeded (session persisted) but start() failed before flipping running
  assert.ok(state.session)
  assert.equal(state.running, false)
})

test('bootstrapFromEnv: invalid checkpointId (path traversal) fails cleanly, no session stored', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cpapp-bootstrap-badid-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const app = await buildApp({
    config: {
      dataDir: dir, mqttUrl: 'mqtt://localhost:1883', mqttTopic: 'leszyrun/checkpoint',
      goneWindowMs: 3000, uploadIntervalMs: 999999, port: 8080,
      supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'anon',
      autoconfig: autoconfigBase({ checkpointId: '../../etc/passwd' }),
    },
    supabase: fakeSupabaseForBootstrap(),
    fetchRoster: async () => { throw new Error('fetchRoster must not be called for an invalid id') },
    createReader: () => { throw new Error('createReader must not be called') },
    connectMqtt: () => ({ on: () => {}, subscribe: () => {}, end: () => {} }),
    clockStatus: async () => ({ synced: true, source: 'test' }),
    detectLanIp: () => '10.0.0.99',
  })
  t.after(() => app.close())

  await assert.doesNotReject(() => app.bootstrapFromEnv())

  const state = (await app.inject({ method: 'GET', url: '/api/state' })).json().data
  assert.equal(state.session, null)
})

test('bootstrapFromEnv: no-op when a running session already exists for the same checkpoint (resume already handled it)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cpapp-bootstrap-noop-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  let fetchRosterCalls = 0
  const app = await buildApp({
    config: {
      dataDir: dir, mqttUrl: 'mqtt://localhost:1883', mqttTopic: 'leszyrun/checkpoint',
      goneWindowMs: 3000, uploadIntervalMs: 999999, port: 8080,
      supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'anon',
      autoconfig: autoconfigBase(),
    },
    supabase: fakeSupabaseForBootstrap(),
    fetchRoster: async ({ pin }) => {
      fetchRosterCalls += 1
      return pin === '123456' ? { ok: true, roster: [{ bib_number: 101, rfid_epc: 'AABBCC01' }] } : { ok: false, status: 401, error: 'Invalid PIN' }
    },
    createReader: () => { throw new Error('createReader must not be called in noReader mode') },
    connectMqtt: () => ({ on: () => {}, subscribe: () => {}, end: () => {} }),
    clockStatus: async () => ({ synced: true, source: 'test' }),
    detectLanIp: () => '10.0.0.99',
  })
  t.after(() => app.close())

  // Simulate resume() (or a manual setup+start) already having stood up a
  // running session for the SAME checkpointId the autoconfig targets.
  await app.inject({ method: 'POST', url: '/api/setup', payload: { eventId: 'ev1', eventName: 'Race', checkpointId: 'cp1', checkpointName: 'CP 1', pin: '123456', noReader: true, armMode: 'immediate' } })
  await app.inject({ method: 'POST', url: '/api/start', payload: {} })
  assert.equal(fetchRosterCalls, 1)

  await app.bootstrapFromEnv()

  // no second fetchRoster call — bootstrap recognized the running session
  // for the same checkpoint and did nothing
  assert.equal(fetchRosterCalls, 1)
})

// Regression: bootstrapFromEnv used to only skip when the RUNNING session's
// checkpointId matched AUTOCONFIG_CHECKPOINT_ID. If they differed, it called
// doSetup() (which persists state.session pointing at the NEW checkpoint)
// before doStart() rejected with 409 — leaving the on-disk session pointing
// at the new checkpoint while the live pipeline/queue/heartbeat kept running
// under the OLD one. bootstrapFromEnv must now be checkpoint-agnostic: any
// running session at all blocks it.
test('bootstrapFromEnv: no-op when a running session exists for a DIFFERENT checkpoint — does not overwrite the persisted session', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cpapp-bootstrap-diffcp-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  let fetchRosterCalls = 0
  const app = await buildApp({
    config: {
      dataDir: dir, mqttUrl: 'mqtt://localhost:1883', mqttTopic: 'leszyrun/checkpoint',
      goneWindowMs: 3000, uploadIntervalMs: 999999, port: 8080,
      supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'anon',
      // autoconfig targets cp2, but the already-running session (below) is cp1
      autoconfig: autoconfigBase({ checkpointId: 'cp2' }),
    },
    supabase: fakeSupabaseForBootstrap(),
    fetchRoster: async ({ pin }) => {
      fetchRosterCalls += 1
      return pin === '123456' ? { ok: true, roster: [{ bib_number: 101, rfid_epc: 'AABBCC01' }] } : { ok: false, status: 401, error: 'Invalid PIN' }
    },
    createReader: () => { throw new Error('createReader must not be called in noReader mode') },
    connectMqtt: () => ({ on: () => {}, subscribe: () => {}, end: () => {} }),
    clockStatus: async () => ({ synced: true, source: 'test' }),
    detectLanIp: () => '10.0.0.99',
  })
  t.after(() => app.close())

  // A running session already exists for cp1 — e.g. resume() brought it back,
  // or the operator started it by hand — while AUTOCONFIG_CHECKPOINT_ID=cp2.
  await app.inject({ method: 'POST', url: '/api/setup', payload: { eventId: 'ev1', eventName: 'Race', checkpointId: 'cp1', checkpointName: 'CP 1', pin: '123456', noReader: true, armMode: 'immediate' } })
  await app.inject({ method: 'POST', url: '/api/start', payload: {} })
  assert.equal(fetchRosterCalls, 1)

  await app.bootstrapFromEnv()

  // fetchRoster must NOT have been called again for cp2, and the persisted
  // session must still point at the ORIGINAL running checkpoint (cp1) — not
  // overwritten mid-flight by a doSetup() call that never got to doStart().
  assert.equal(fetchRosterCalls, 1)
  const state = (await app.inject({ method: 'GET', url: '/api/state' })).json().data
  assert.equal(state.session.checkpointId, 'cp1')
  assert.equal(state.running, true)
})

test('bootstrapFromEnv: absent autoconfig is a pure no-op', async (t) => {
  const app = await makeApp(t)
  await app.bootstrapFromEnv()
  const state = (await app.inject({ method: 'GET', url: '/api/state' })).json().data
  assert.equal(state.session, null)
  assert.equal(state.running, false)
})

// --- Boot-sequence regression: AUTOCONFIG_* must win over a stale persisted
// session. index.js used to always `await app.resume()` (which restarts a
// persisted RUNNING session from the ON-DISK config) BEFORE
// `app.bootstrapFromEnv()` — so if resume() found session.running===true on
// disk it would already be running by the time bootstrapFromEnv() ran, and
// bootstrapFromEnv()'s own no-op-if-running guard would then skip
// reconfiguration entirely. An operator who changed an AUTOCONFIG_* var (e.g.
// AUTOCONFIG_READER_IP) and restarted would keep running the stale config
// until they manually deleted data/session.json.
//
// The fix: index.js now calls bootstrapFromEnv() INSTEAD of resume() when
// config.autoconfig.present is true, and only falls back to resume() when it
// isn't. index.js itself isn't unit-testable (it wires up real
// supabase-js/mqtt clients and calls process.exit), so these tests exercise
// the same startup logic directly against buildApp(): they persist a stale
// session to disk (via a first app instance, exactly like a previous boot
// would have left behind), then build a second app instance against the same
// dataDir and drive it the way the fixed index.js does — resume() only when
// autoconfig is absent, bootstrapFromEnv() only when it's present — and
// assert the env wins.

test('boot: AUTOCONFIG present overrides a stale persisted RUNNING session (env readerIp wins, reader configured with new value)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cpapp-boot-override-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const readerCalls = []
  const baseDeps = {
    supabase: fakeSupabaseForBootstrap(),
    fetchRoster: async ({ eventId, pin }) =>
      pin === '123456' ? { ok: true, roster: [{ bib_number: 101, rfid_epc: 'AABBCC01' }] } : { ok: false, status: 401, error: 'Invalid PIN' },
    createReader: ({ address, username, password }) => {
      readerCalls.push({ address, username, password })
      return { getStatus: async () => ({ status: 'idle' }), configure: async () => {}, start: async () => {}, stop: async () => {} }
    },
    connectMqtt: () => ({ on: () => {}, subscribe: () => {}, end: () => {} }),
    clockStatus: async () => ({ synced: true, source: 'test' }),
    detectLanIp: () => '10.0.0.99',
  }

  // --- Boot 1: operator runs the wizard by hand with readerIp = OLD-IP.
  // Persists a session to disk with running: true (doStart() saves it).
  const app1 = await buildApp({
    config: { dataDir: dir, mqttUrl: 'mqtt://localhost:1883', mqttTopic: 'leszyrun/checkpoint', goneWindowMs: 3000, uploadIntervalMs: 999999, port: 8080, supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'anon', autoconfig: { present: false } },
    ...baseDeps,
  })
  await app1.inject({ method: 'POST', url: '/api/setup', payload: { eventId: 'ev1', eventName: 'Race', checkpointId: 'cp1', checkpointName: 'CP 1', pin: '123456', readerIp: 'OLD-IP', armMode: 'immediate' } })
  await app1.inject({ method: 'POST', url: '/api/start', payload: {} })
  const stateAfterBoot1 = (await app1.inject({ method: 'GET', url: '/api/state' })).json().data
  assert.equal(stateAfterBoot1.session.readerIp, 'OLD-IP')
  assert.equal(stateAfterBoot1.running, true)
  await app1.close() // does NOT call /api/stop — the persisted session on disk keeps running: true, exactly like a killed process

  // --- Boot 2: operator changed AUTOCONFIG_READER_IP and restarted. Same
  // dataDir (same on-disk session), autoconfig now present with a NEW
  // readerIp. Drive it the way the fixed index.js does: skip resume(), call
  // bootstrapFromEnv() only.
  const app2 = await buildApp({
    config: {
      dataDir: dir, mqttUrl: 'mqtt://localhost:1883', mqttTopic: 'leszyrun/checkpoint', goneWindowMs: 3000, uploadIntervalMs: 999999, port: 8080,
      supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'anon',
      autoconfig: { present: true, eventId: 'ev1', checkpointId: 'cp1', pin: '123456', readerIp: 'new.reader.local', mqttHost: null, readerUsername: null, readerPassword: null, armMode: 'immediate', noReader: false, eventName: 'Race', checkpointName: 'CP 1' },
    },
    ...baseDeps,
  })
  t.after(() => app2.close())

  // Sanity: the stale session loaded from disk still has the OLD reader IP
  // before bootstrapFromEnv() runs — proves the assertions below are about
  // bootstrapFromEnv() overwriting it, not about it never having been loaded.
  assert.equal(app2.deps.session.readerIp, 'OLD-IP')

  await app2.bootstrapFromEnv() // index.js's autoconfig-present branch — resume() is never called

  const state = (await app2.inject({ method: 'GET', url: '/api/state' })).json().data
  assert.equal(state.session.readerIp, 'new.reader.local') // env won, not the stale disk value
  assert.equal(state.running, true)
  const lastReaderCall = readerCalls.at(-1)
  assert.equal(lastReaderCall.address, 'new.reader.local') // reader was actually configured with the NEW value
})

test('boot: AUTOCONFIG present, identical to the persisted session — idempotent, no crash, queue for the checkpoint is preserved', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cpapp-boot-idempotent-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  let messageHandler
  const inserted = []
  const supabaseSpy = {
    from: (table) => table === 'checkpoint_observations'
      ? { insert: async (row) => { inserted.push(row); return { error: null } } }
      : { select: () => ({ order: () => ({ limit: async () => ({ data: [], error: null }) }), eq: () => ({ order: async () => ({ data: [], error: null }) }) }) },
  }
  const baseDeps = {
    supabase: supabaseSpy,
    fetchRoster: async ({ pin }) =>
      pin === '123456' ? { ok: true, roster: [{ bib_number: 101, rfid_epc: 'AABBCC01' }] } : { ok: false, status: 401, error: 'Invalid PIN' },
    createReader: () => { throw new Error('createReader must not be called in noReader mode') },
    clockStatus: async () => ({ synced: true, source: 'test' }),
    detectLanIp: () => '10.0.0.99',
  }

  // --- Boot 1: setup + start, then record one confirmed observation into the
  // per-checkpoint queue (uploadIntervalMs is huge so it stays pending on
  // disk, never flushed).
  const app1 = await buildApp({
    config: { dataDir: dir, mqttUrl: 'mqtt://localhost:1883', mqttTopic: 'leszyrun/checkpoint', goneWindowMs: 50, uploadIntervalMs: 999999, port: 8080, supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'anon', autoconfig: { present: false } },
    ...baseDeps,
    connectMqtt: () => ({ on: (ev, fn) => { if (ev === 'message') messageHandler = fn }, subscribe: () => {}, end: () => {} }),
  })
  await app1.inject({ method: 'POST', url: '/api/setup', payload: { eventId: 'ev1', eventName: 'Race', checkpointId: 'cp1', checkpointName: 'CP 1', pin: '123456', noReader: true, armMode: 'immediate' } })
  await app1.inject({ method: 'POST', url: '/api/start', payload: {} })
  const payload = Buffer.from(JSON.stringify({ eventType: 'tagInventory', tagInventoryEvent: { epc: 'qrvMAQ==', peakRssiCdbm: -4000, antennaPort: 1 } }))
  messageHandler('leszyrun/checkpoint', payload)
  await waitFor(() => app1.deps.queue.counts.pending === 1)
  assert.equal(inserted.length, 0) // confirmed but never uploaded — still pending on disk
  await app1.close() // no /api/stop — session persists with running: true

  // --- Boot 2: autoconfig present, values IDENTICAL to the persisted
  // session (same event/checkpoint/pin/armMode/noReader). Drive the fixed
  // index.js autoconfig-present branch: bootstrapFromEnv() only, no resume().
  const app2 = await buildApp({
    config: {
      dataDir: dir, mqttUrl: 'mqtt://localhost:1883', mqttTopic: 'leszyrun/checkpoint', goneWindowMs: 50, uploadIntervalMs: 999999, port: 8080,
      supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'anon',
      autoconfig: { present: true, eventId: 'ev1', checkpointId: 'cp1', pin: '123456', readerIp: null, mqttHost: null, readerUsername: null, readerPassword: null, armMode: 'immediate', noReader: true, eventName: 'Race', checkpointName: 'CP 1' },
    },
    ...baseDeps,
    connectMqtt: () => ({ on: () => {}, subscribe: () => {}, end: () => {} }),
  })
  t.after(() => app2.close())

  await assert.doesNotReject(() => app2.bootstrapFromEnv())

  const state = (await app2.inject({ method: 'GET', url: '/api/state' })).json().data
  assert.equal(state.session.checkpointId, 'cp1')
  assert.equal(state.running, true)
  // The queue file (queue-cp1.jsonl) from boot 1 was reused, not wiped —
  // doSetup()/doStart() only ever replace the session config, never the
  // per-checkpoint queue file.
  assert.equal(state.counts.total, 1)
  assert.equal(state.counts.pending, 1)
})

test('boot: AUTOCONFIG absent — resume() path still used, persisted session unchanged, fetchRoster not called again', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cpapp-boot-resume-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const readerCalls = []
  let fetchRosterCalls = 0
  const baseDeps = {
    supabase: fakeSupabaseForBootstrap(),
    fetchRoster: async ({ pin }) => {
      fetchRosterCalls += 1
      return pin === '123456' ? { ok: true, roster: [{ bib_number: 101, rfid_epc: 'AABBCC01' }] } : { ok: false, status: 401, error: 'Invalid PIN' }
    },
    createReader: ({ address, username, password }) => {
      readerCalls.push({ address, username, password })
      return { getStatus: async () => ({ status: 'idle' }), configure: async () => {}, start: async () => {}, stop: async () => {} }
    },
    connectMqtt: () => ({ on: () => {}, subscribe: () => {}, end: () => {} }),
    clockStatus: async () => ({ synced: true, source: 'test' }),
    detectLanIp: () => '10.0.0.99',
  }

  const app1 = await buildApp({
    config: { dataDir: dir, mqttUrl: 'mqtt://localhost:1883', mqttTopic: 'leszyrun/checkpoint', goneWindowMs: 3000, uploadIntervalMs: 999999, port: 8080, supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'anon', autoconfig: { present: false } },
    ...baseDeps,
  })
  await app1.inject({ method: 'POST', url: '/api/setup', payload: { eventId: 'ev1', eventName: 'Race', checkpointId: 'cp1', checkpointName: 'CP 1', pin: '123456', readerIp: 'OLD-IP', armMode: 'immediate' } })
  await app1.inject({ method: 'POST', url: '/api/start', payload: {} })
  assert.equal(fetchRosterCalls, 1)
  await app1.close()

  // Boot 2: no AUTOCONFIG_* env vars set at all — config.autoconfig.present
  // is false. The fixed index.js's else-branch: resume() only.
  const app2 = await buildApp({
    config: { dataDir: dir, mqttUrl: 'mqtt://localhost:1883', mqttTopic: 'leszyrun/checkpoint', goneWindowMs: 3000, uploadIntervalMs: 999999, port: 8080, supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'anon', autoconfig: { present: false } },
    ...baseDeps,
  })
  t.after(() => app2.close())

  await app2.resume()

  const state = (await app2.inject({ method: 'GET', url: '/api/state' })).json().data
  assert.equal(state.session.readerIp, 'OLD-IP') // unchanged — resume() uses the on-disk config as-is
  assert.equal(state.running, true)
  assert.equal(fetchRosterCalls, 1) // resume() never calls fetchRoster — only doSetup()/bootstrapFromEnv() do
  const lastReaderCall = readerCalls.at(-1)
  assert.equal(lastReaderCall.address, 'OLD-IP')
})

test('reader auto-recovery: steady healthy status never triggers a reconfigure', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cpapp-steady-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  let configureCalls = 0
  let startCalls = 0
  const app = await buildApp({
    config: { dataDir: dir, mqttUrl: 'mqtt://localhost:1883', mqttTopic: 'leszyrun/checkpoint', goneWindowMs: 3000, uploadIntervalMs: 999999, readerPollMs: 30, supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'anon' },
    supabase: {
      from: () => ({
        select: () => ({ order: () => ({ limit: async () => ({ data: [], error: null }) }), eq: () => ({ order: async () => ({ data: [], error: null }) }) }),
        insert: async () => ({ error: null }),
      }),
    },
    fetchRoster: async ({ pin }) => pin === '123456' ? { ok: true, roster: [] } : { ok: false, status: 401, error: 'Invalid PIN' },
    createReader: () => ({
      getStatus: async () => ({ status: 'running' }),
      configure: async () => { configureCalls += 1 },
      start: async () => { startCalls += 1 },
      stop: async () => {},
    }),
    connectMqtt: () => ({ on: () => {}, subscribe: () => {}, end: () => {} }),
    clockStatus: async () => ({ synced: true, source: 'test' }),
    detectLanIp: () => '10.0.0.99',
  })
  t.after(() => app.close())

  await app.inject({ method: 'POST', url: '/api/setup', payload: { eventId: 'ev1', eventName: 'Race', checkpointId: 'cp1', checkpointName: 'CP 1', pin: '123456', readerIp: '10.0.0.5' } })
  await app.inject({ method: 'POST', url: '/api/start', payload: {} })
  assert.equal(configureCalls, 1)
  assert.equal(startCalls, 1)

  // Let several poll cycles (30ms each) pass — status is always 'running'.
  await new Promise((r) => setTimeout(r, 200))
  const state = (await app.inject({ method: 'GET', url: '/api/state' })).json().data
  assert.equal(state.readerDown, false)
  assert.equal(configureCalls, 1)
  assert.equal(startCalls, 1)
})
