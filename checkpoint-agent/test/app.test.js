import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp } from '../src/app.js'

async function makeApp(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cpapp-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const deps = {
    config: { dataDir: dir, mqttUrl: 'mqtt://localhost:1883', mqttTopic: 'leszyrun/checkpoint', goneWindowMs: 3000, uploadIntervalMs: 999999, supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'anon' },
    supabase: {
      from: (table) => ({
        select: () => ({
          order: () => ({ limit: async () => ({ data: [{ id: 'ev1', name: 'Race', date: '2026-08-01' }], error: null }) }),
          eq: () => ({ order: async () => ({ data: [{ id: 'cp1', name: 'CP 1', km_marker: '5.00' }], error: null }) }),
        }),
        insert: async () => ({ error: null }),
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
  await app.inject({ method: 'POST', url: '/api/setup', payload: { eventId: 'ev1', eventName: 'Race', checkpointId: 'cp1', checkpointName: 'CP 1', pin: '123456', readerIp: '10.0.0.5' } })
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
})
