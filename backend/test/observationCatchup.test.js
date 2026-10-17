import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchRemoteObservations } from '../src/sync/observationCatchup.js'

// A PostgREST stand-in that, like the real one, never returns more than 1000 rows.
function fakeSupabase(total) {
  const rows = Array.from({ length: total }, (_, i) => ({ id: `id-${String(i).padStart(5, '0')}` }))
  const ranges = []
  const q = {
    from: () => q, select: () => q, in: () => q, order: () => q,
    range: (from, to) => {
      ranges.push([from, to])
      return Promise.resolve({ data: rows.slice(from, Math.min(to + 1, from + 1000)), error: null })
    },
  }
  return { client: q, ranges }
}

test('reads every observation past the 1000-row cap', async () => {
  const { client, ranges } = fakeSupabase(2345)
  const rows = await fetchRemoteObservations(client, ['cp'])
  assert.equal(rows.length, 2345)
  assert.equal(new Set(rows.map(r => r.id)).size, 2345)
  assert.deepEqual(ranges, [[0, 999], [1000, 1999], [2000, 2999]])
})

test('stops after one page when the checkpoint has fewer rows', async () => {
  const { client, ranges } = fakeSupabase(188)
  assert.equal((await fetchRemoteObservations(client, ['cp'])).length, 188)
  assert.equal(ranges.length, 1)
})

test('fails loudly on a Supabase error rather than reporting nothing missing', async () => {
  const q = { from: () => q, select: () => q, in: () => q, order: () => q,
    range: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }
  await assert.rejects(fetchRemoteObservations(q, ['cp']), /boom/)
})
