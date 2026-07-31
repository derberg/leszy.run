import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHeartbeat } from '../src/heartbeat.js'

function fakeSupabase(respond) {
  const calls = []
  return {
    calls,
    from(table) {
      assert.equal(table, 'checkpoint_agents')
      return {
        upsert: async (row, opts) => {
          calls.push({ row, opts })
          return respond ? respond(row, opts) : { error: null }
        },
      }
    },
  }
}

test('start() immediately upserts status + counts + onConflict, then again every intervalMs', async () => {
  const supabase = fakeSupabase()
  const getStatus = () => ({ status: 'listening', readsTotal: 7, queuePending: 2, unknownCount: 1 })
  const hb = createHeartbeat({ supabase, checkpointId: 'cp1', intervalMs: 20, getStatus })
  hb.start()
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(supabase.calls.length, 1)
  const { row, opts } = supabase.calls[0]
  assert.equal(row.checkpoint_id, 'cp1')
  assert.equal(row.status, 'listening')
  assert.equal(row.reads_total, 7)
  assert.equal(row.queue_pending, 2)
  assert.equal(row.unknown_count, 1)
  assert.ok(row.last_seen_at)
  assert.ok(row.updated_at)
  assert.deepEqual(opts, { onConflict: 'checkpoint_id' })

  await new Promise((r) => setTimeout(r, 50))
  assert.ok(supabase.calls.length >= 2)
  hb.stop()
})

test('reflects whatever getStatus() returns on each tick (status can change between ticks)', async () => {
  const supabase = fakeSupabase()
  let status = 'configured'
  const hb = createHeartbeat({ supabase, checkpointId: 'cp1', intervalMs: 15, getStatus: () => ({ status, readsTotal: 0, queuePending: 0, unknownCount: 0 }) })
  hb.start()
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(supabase.calls[0].row.status, 'configured')
  status = 'armed_waiting'
  await new Promise((r) => setTimeout(r, 30))
  assert.ok(supabase.calls.some((c) => c.row.status === 'armed_waiting'))
  hb.stop()
})

test('stop() halts further upserts', async () => {
  const supabase = fakeSupabase()
  const hb = createHeartbeat({ supabase, checkpointId: 'cp1', intervalMs: 15, getStatus: () => ({ status: 'listening', readsTotal: 0, queuePending: 0, unknownCount: 0 }) })
  hb.start()
  await new Promise((r) => setTimeout(r, 5))
  hb.stop()
  const countAtStop = supabase.calls.length
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(supabase.calls.length, countAtStop)
})

test('never throws when upsert returns an error', async () => {
  const supabase = fakeSupabase(() => ({ error: { message: 'rls denied' } }))
  const hb = createHeartbeat({ supabase, checkpointId: 'cp1', intervalMs: 999999, getStatus: () => ({ status: 'listening', readsTotal: 0, queuePending: 0, unknownCount: 0 }) })
  hb.start() // must not throw
  await new Promise((r) => setTimeout(r, 5))
  hb.stop()
})

test('never throws when the client itself throws (network error)', async () => {
  const supabase = { from: () => ({ upsert: async () => { throw new Error('ECONNRESET') } }) }
  const hb = createHeartbeat({ supabase, checkpointId: 'cp1', intervalMs: 999999, getStatus: () => ({ status: 'listening', readsTotal: 0, queuePending: 0, unknownCount: 0 }) })
  hb.start() // must not throw
  await new Promise((r) => setTimeout(r, 5))
  hb.stop()
})

test('start() is idempotent — a second call does not create a second interval', async () => {
  const supabase = fakeSupabase()
  const hb = createHeartbeat({ supabase, checkpointId: 'cp1', intervalMs: 20, getStatus: () => ({ status: 'listening', readsTotal: 0, queuePending: 0, unknownCount: 0 }) })
  hb.start()
  hb.start()
  await new Promise((r) => setTimeout(r, 45))
  hb.stop()
  // one immediate tick + at most two interval ticks in 45ms/20ms — never doubled by a second interval
  assert.ok(supabase.calls.length <= 3, `expected <=3 calls, got ${supabase.calls.length}`)
})
