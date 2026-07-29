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

test('reentrancy guard: concurrent flush calls result in one insert per row, cursor never negative', async (t) => {
  const q = await makeQueue(t, [row(1)])
  let insertResolve, canResolve = false
  const sb = {
    inserted: [],
    from(table) {
      assert.equal(table, 'checkpoint_observations')
      return {
        insert: async (row) => {
          this.inserted.push(row)
          // Defer returning until the second flush attempt has a chance to run
          return new Promise(r => {
            if (canResolve) {
              r({ error: null })
            } else {
              insertResolve = r
            }
          })
        }
      }
    },
  }
  const up = new Uploader({ queue: q, supabase: sb, intervalMs: 999999 })
  // Start first flush (will block in the deferred insert)
  const p1 = up.flush()
  // Allow the second flush to run immediately (synchronously) before first resolves
  canResolve = true
  const p2 = up.flush() // this should early-return due to reentrancy guard
  // Verify second flush returned immediately while first was blocked
  assert.equal(p2.constructor.name, 'Promise')
  // Resolve the first flush
  insertResolve({ error: null })
  await p1
  await p2
  assert.equal(sb.inserted.length, 1) // only one insert happened
  assert.equal(q.pending().length, 0) // cursor advanced once
  assert.equal(q.counts.pending, 0) // never negative
})

test('advance() error is caught, not thrown; lastError recorded', async (t) => {
  const q = await makeQueue(t, [row(1)])
  const sb = fakeSupabase(() => ({ error: null }))
  const up = new Uploader({ queue: q, supabase: sb, intervalMs: 999999 })
  // Stub queue.advance to throw on first call
  let advanceCalls = 0
  q.advance = async () => {
    advanceCalls++
    throw new Error('disk full')
  }
  await up.flush() // must not throw
  assert.equal(advanceCalls, 1)
  assert.equal(q.counts.pending, 1) // row not advanced
  assert.match(up.status.lastError, /disk full/)
})
