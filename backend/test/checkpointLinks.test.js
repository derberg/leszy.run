import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupLinks, sameLinks, linksToPull, pushCheckpointLinks } from '../src/sync/checkpointLinks.js'
import { checkpointUpdates } from '../src/lib/checkpointUpdates.js'

// Regression: checkpoint_categories was never synced. On 2026-10-14 "Premia lotna" of
// Wilczy Półmaraton was narrowed to the 21 km and canicross categories on the Mac, and
// Supabase (public results, volunteer phones, the Pi) still had it open to every category.

test('groupLinks accepts both Supabase and Drizzle row shapes', () => {
  const m = groupLinks([
    { checkpoint_id: 'cp1', category_id: 'b' },
    { checkpointId: 'cp1', categoryId: 'a' },
    { checkpoint_id: 'cp2', category_id: 'c' },
  ])
  assert.deepEqual(m.get('cp1'), ['a', 'b'])
  assert.deepEqual(m.get('cp2'), ['c'])
})

test('sameLinks ignores order', () => {
  assert.ok(sameLinks(['a', 'b'], ['b', 'a']))
  assert.ok(sameLinks([], undefined))
  assert.ok(!sameLinks(['a'], ['a', 'b']))
})

test('linksToPull replaces a clean checkpoint whose remote set differs', () => {
  const out = linksToPull({
    cleanLocalIds: ['cp1', 'cp2'],
    remoteCheckpointIds: ['cp1', 'cp2'],
    localLinks: new Map([['cp2', ['x']]]),
    remoteLinks: new Map([['cp1', ['hm', 'cc']], ['cp2', ['x']]]),
  })
  assert.deepEqual(out, [{ checkpointId: 'cp1', categoryIds: ['hm', 'cc'] }])
})

test('linksToPull clears links that were removed remotely (back to all categories)', () => {
  const out = linksToPull({
    cleanLocalIds: ['cp1'],
    remoteCheckpointIds: ['cp1'],
    localLinks: new Map([['cp1', ['hm']]]),
    remoteLinks: new Map(),
  })
  assert.deepEqual(out, [{ checkpointId: 'cp1', categoryIds: [] }])
})

test('linksToPull never touches a dirty checkpoint or one missing remotely', () => {
  const out = linksToPull({
    cleanLocalIds: ['gone'], // cp-dirty is absent: its synced_at is NULL
    remoteCheckpointIds: ['cp-dirty'],
    localLinks: new Map([['gone', ['hm']], ['cp-dirty', ['hm']]]),
    remoteLinks: new Map(),
  })
  assert.deepEqual(out, [])
})

function fakeSupabase({ deleteError = null, insertError = null } = {}) {
  const calls = []
  return {
    calls,
    from(table) {
      return {
        delete: () => ({ in: async (col, ids) => { calls.push(['delete', table, col, ids]); return { error: deleteError } } }),
        insert: async (rows) => { calls.push(['insert', table, rows]); return { error: insertError } },
      }
    },
  }
}

const fakeDb = (links) => ({
  select: () => ({ from: () => ({ where: async () => links }) }),
})

test('pushCheckpointLinks replaces the remote link set of the pushed checkpoints', async () => {
  const sb = fakeSupabase()
  const err = await pushCheckpointLinks(sb, fakeDb([{ checkpointId: 'cp1', categoryId: 'hm' }]), ['cp1', 'cp2'])
  assert.equal(err, null)
  assert.deepEqual(sb.calls, [
    ['delete', 'checkpoint_categories', 'checkpoint_id', ['cp1', 'cp2']],
    ['insert', 'checkpoint_categories', [{ checkpoint_id: 'cp1', category_id: 'hm' }]],
  ])
})

test('pushCheckpointLinks reports an insert failure so the checkpoint stays dirty', async () => {
  const sb = fakeSupabase({ insertError: { message: 'fk violation' } })
  const err = await pushCheckpointLinks(sb, fakeDb([{ checkpointId: 'cp1', categoryId: 'hm' }]), ['cp1'])
  assert.equal(err, 'fk violation')
})

test('a PATCH that changes only categoryIds still writes the checkpoint row', () => {
  assert.deepEqual(checkpointUpdates({ categoryIds: ['hm'] }), { syncedAt: null })
  assert.deepEqual(checkpointUpdates({ name: 'Premia lotna', categoryIds: [] }), { name: 'Premia lotna' })
  assert.deepEqual(checkpointUpdates({ kmMarker: '13' }), { kmMarker: '13' })
})
