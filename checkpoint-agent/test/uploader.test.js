import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ObservationQueue } from '../src/queue.js'
import { Uploader } from '../src/uploader.js'

function fakeSupabase(responder) {
  const inserted = []
  return {
    inserted,
    from(table) {
      assert.equal(table, 'checkpoint_observations')
      return { insert: async (row) => { inserted.push(row); return responder(row) } }
    },
  }
}

async function makeQueue(t, rows) {
  const dir = await mkdtemp(join(tmpdir(), 'cpu-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const q = new ObservationQueue(dir)
  await q.init()
  for (const r of rows) await q.append(r)
  return q
}

const row = (n) => ({ epc: `EPC${n}`, checkpoint_id: 'cp-1', bib_number: n, observed_at: new Date(n * 1000).toISOString() })

test('flush uploads pending rows without epc field and advances cursor', async (t) => {
  const q = await makeQueue(t, [row(1), row(2)])
  const sb = fakeSupabase(() => ({ error: null }))
  const up = new Uploader({ queue: q, supabase: sb, intervalMs: 999999 })
  await up.flush()
  assert.equal(q.pending().length, 0)
  assert.deepEqual(sb.inserted[0], { checkpoint_id: 'cp-1', bib_number: 1, observed_at: row(1).observed_at })
  assert.equal('epc' in sb.inserted[0], false)
  assert.ok(up.status.lastUploadAt)
  assert.equal(up.status.lastError, null)
})

test('duplicate (23505) counts as uploaded', async (t) => {
  const q = await makeQueue(t, [row(1)])
  const sb = fakeSupabase(() => ({ error: { code: '23505', message: 'duplicate' } }))
  const up = new Uploader({ queue: q, supabase: sb, intervalMs: 999999 })
  await up.flush()
  assert.equal(q.pending().length, 0)
})

test('network error stops the batch, keeps rows pending, records lastError, later retry succeeds', async (t) => {
  const q = await makeQueue(t, [row(1), row(2)])
  let fail = true
  const sb = fakeSupabase(() => fail ? { error: { message: 'fetch failed' } } : { error: null })
  const up = new Uploader({ queue: q, supabase: sb, intervalMs: 999999 })
  await up.flush()
  assert.equal(q.pending().length, 2)
  assert.match(up.status.lastError, /fetch failed/)
  fail = false
  await up.flush()
  assert.equal(q.pending().length, 0)
  assert.equal(up.status.lastError, null)
})

test('exception from client is caught, not thrown', async (t) => {
  const q = await makeQueue(t, [row(1)])
  const sb = { from: () => ({ insert: async () => { throw new Error('ECONNRESET') } }) }
  const up = new Uploader({ queue: q, supabase: sb, intervalMs: 999999 })
  await up.flush() // must not throw
  assert.equal(q.pending().length, 1)
  assert.match(up.status.lastError, /ECONNRESET/)
})
