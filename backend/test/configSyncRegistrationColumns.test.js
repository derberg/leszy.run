import { test } from 'node:test'
import assert from 'node:assert/strict'
import { columnMeta, toLocalRow } from '../src/sync/configSync.js'
import { rowToSnake, toPushRow } from '../src/sync/supabase.js'
import { events, participants } from '../src/db/schema.js'

test('pull maps participants.registration_id and removed_at', () => {
  const row = toLocalRow(columnMeta(participants), {
    id: 'p', registration_id: 'r', removed_at: '2026-11-01T10:00:00Z',
  })
  assert.equal(row.registrationId, 'r')
  assert.ok(row.removedAt instanceof Date)
  assert.equal(row.removedAt.toISOString(), '2026-11-01T10:00:00.000Z')
})

test('pull maps events.club_id', () => {
  const row = toLocalRow(columnMeta(events), { id: 'e', club_id: 'c' })
  assert.equal(row.clubId, 'c')
})

test('rowToSnake still converts names and strips __xmin', () => {
  const s = rowToSnake({ removedAt: new Date(0), registrationId: 'r', clubId: 'c', __xmin: '1' })
  assert.deepEqual(Object.keys(s).sort(), ['club_id', 'registration_id', 'removed_at'])
})

test('push omits Supabase-owned columns', () => {
  const ev = toPushRow('events', { id: 'e', clubId: 'c', name: 'n', __xmin: '1' })
  assert.deepEqual(ev, { id: 'e', name: 'n' })
  const p = toPushRow('participants', {
    id: 'p', firstName: 'A', registrationId: 'r', removedAt: null, syncedAt: null, __xmin: '9',
  })
  assert.deepEqual(p, { id: 'p', first_name: 'A', synced_at: null })
})

test('push leaves other tables untouched', () => {
  assert.deepEqual(toPushRow('categories', { id: 'c', clubId: 'x' }), { id: 'c', club_id: 'x' })
})
