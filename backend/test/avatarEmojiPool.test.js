import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { POOL } from '../src/lib/emoji.js'

// Account avatars (profiles.avatar_emoji) are drawn in Postgres from a copy of
// the participant pool. A migration that already ran is never edited, so a
// change to POOL needs a new migration replacing random_avatar_emoji().
test('random_avatar_emoji() draws from the same pool as participants', () => {
  const sql = readFileSync(
    new URL('../../supabase/migrations/20261028120000_profiles_avatar_emoji.sql', import.meta.url),
    'utf8',
  )
  const body = sql.match(/array\[([\s\S]*?)\] as pool/)[1]
  const sqlPool = [...body.matchAll(/'([^']+)'/g)].map(m => m[1])
  assert.deepEqual(sqlPool, POOL)
})
