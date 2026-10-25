import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEdgeWriter } from '../src/edgeWriter.js'

function fakeFetch(status, body) {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) })
    return { ok: status >= 200 && status < 300, status, json: async () => body }
  }
  fn.calls = calls
  return fn
}

const row = { checkpoint_id: 'cp-1', bib_number: 12, observed_at: '2026-10-25T10:00:00.000Z', source: 'rfid' }

test('insert posts an observe call with the stored PIN', async () => {
  const fetchImpl = fakeFetch(200, { data: [{ id: 'x' }] })
  const w = createEdgeWriter({ supabaseUrl: 'https://x.supabase.co', anonKey: 'anon', getPin: async () => '123456', fetchImpl })
  const res = await w.from('checkpoint_observations').insert(row)
  assert.equal(res.error, null)
  const { url, body } = fetchImpl.calls[0]
  assert.equal(url, 'https://x.supabase.co/functions/v1/checkpoint-write')
  assert.deepEqual(body, { action: 'observe', checkpoint_id: 'cp-1', observation: row, pin: '123456' })
})

test('an occupied slot comes back as 23505, which the Uploader counts as uploaded', async () => {
  const w = createEdgeWriter({ supabaseUrl: 'u', anonKey: 'a', getPin: async () => '1', fetchImpl: fakeFetch(409, { error: 'Already recorded', code: '23505' }) })
  const res = await w.from('checkpoint_observations').insert(row)
  assert.equal(res.error.code, '23505')
})

test('a wrong PIN, a lockout and no network are all errors, so the row stays queued', async () => {
  for (const fetchImpl of [
    fakeFetch(401, { error: 'Invalid PIN', code: 'invalid_pin' }),
    fakeFetch(429, { error: 'Too many attempts', code: '' }),
    async () => { throw new Error('fetch failed') },
  ]) {
    const w = createEdgeWriter({ supabaseUrl: 'u', anonKey: 'a', getPin: async () => '1', fetchImpl })
    const res = await w.from('checkpoint_observations').insert(row)
    assert.ok(res.error)
    assert.notEqual(res.error.code, '23505')
  }
})

test('no stored PIN sends nothing', async () => {
  const fetchImpl = fakeFetch(200, { data: [] })
  const w = createEdgeWriter({ supabaseUrl: 'u', anonKey: 'a', getPin: async () => undefined, fetchImpl })
  const res = await w.from('checkpoint_observations').insert(row)
  assert.match(res.error.message, /PIN/)
  assert.equal(fetchImpl.calls.length, 0)
})

test('upsert on checkpoint_agents posts a heartbeat with the counters only', async () => {
  const fetchImpl = fakeFetch(200, { data: null })
  const w = createEdgeWriter({ supabaseUrl: 'u', anonKey: 'a', getPin: async () => '1', fetchImpl })
  await w.from('checkpoint_agents').upsert({
    checkpoint_id: 'cp-1', status: 'listening', reads_total: 3, queue_pending: 1, unknown_count: 0,
    last_seen_at: 'x', updated_at: 'x',
  }, { onConflict: 'checkpoint_id' })
  assert.deepEqual(fetchImpl.calls[0].body, {
    action: 'heartbeat', checkpoint_id: 'cp-1', status: 'listening', reads_total: 3, queue_pending: 1, unknown_count: 0, pin: '1',
  })
})
