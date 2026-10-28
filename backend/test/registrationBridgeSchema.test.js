import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { events, participants } from '../src/db/schema.js'

const col = (table, name) => getTableConfig(table).columns.find((c) => c.name === name)

test('registrationBridge: events.club_id is a nullable uuid', () => {
  const c = col(events, 'club_id')
  assert.ok(c, 'events.club_id missing')
  assert.equal(c.columnType, 'PgUUID')
  assert.equal(c.notNull, false)
})

test('registrationBridge: participants.registration_id is a nullable uuid', () => {
  const c = col(participants, 'registration_id')
  assert.ok(c, 'participants.registration_id missing')
  assert.equal(c.columnType, 'PgUUID')
  assert.equal(c.notNull, false)
})

test('registrationBridge: participants.removed_at is a nullable timestamptz', () => {
  const c = col(participants, 'removed_at')
  assert.ok(c, 'participants.removed_at missing')
  assert.equal(c.columnType, 'PgTimestamp')
  assert.equal(c.withTimezone, true)
  assert.equal(c.notNull, false)
})

test('registrationBridge: migration 0041 is journaled after 0040', () => {
  const journal = JSON.parse(readFileSync(new URL('../src/db/migrations/meta/_journal.json', import.meta.url), 'utf8'))
  const e = journal.entries.find((x) => x.tag === '0041_registration_bridge')
  assert.ok(e, 'journal entry missing')
  assert.equal(e.idx, 41)
  assert.ok(e.when > 1792300000000)
})
