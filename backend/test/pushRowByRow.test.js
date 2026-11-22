// The push worker's per-row fallback: one team_batons row refused by a unique index (a tag moved
// between two teams within one cycle) must not keep the other rows from being pushed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { teamBatons } from '../src/db/schema.js'
import { pushRowsOneByOne, PER_ROW_FALLBACK } from '../src/sync/supabase.js'

function client(refusedIds) {
  const upserts = []
  return {
    upserts,
    from: (name) => ({
      upsert: (row) => {
        upserts.push([name, row.id])
        return Promise.resolve({ error: refusedIds.includes(row.id) ? { code: '23505', message: 'duplicate key' } : null })
      },
    }),
  }
}
function db() {
  const stamped = []
  return {
    stamped,
    update: () => ({
      set: () => ({
        where: (cond) => ({
          returning: () => {
            const id = cond.queryChunks.find(c => typeof c === 'string' && /^[ab]\d$/.test(c))
            stamped.push(id)
            return Promise.resolve([{ id }])
          },
        }),
      }),
    }),
  }
}

test('team_batons falls back to per-row pushes on a 23505', () => {
  assert.ok(PER_ROW_FALLBACK.has('team_batons'))
  assert.ok(PER_ROW_FALLBACK.has('checkpoint_observations'))
})

test('a refused team_batons row stays dirty, the others are pushed and stamped', async () => {
  const rows = [{ id: 'a1', __xmin: '1' }, { id: 'a2', __xmin: '1' }, { id: 'a3', __xmin: '1' }]
  const c = client(['a2'])
  const d = db()
  const failed = await pushRowsOneByOne(c, d, teamBatons, 'team_batons', rows, rows.map(r => ({ id: r.id })))
  assert.deepEqual(c.upserts.map(u => u[1]), ['a1', 'a2', 'a3'])
  assert.deepEqual(failed.map(f => f.id), ['a2'])
  assert.deepEqual(d.stamped, ['a1', 'a3'], 'the refused row is not stamped: it is pushed again next cycle')
})
