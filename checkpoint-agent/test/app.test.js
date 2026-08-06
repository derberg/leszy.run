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
