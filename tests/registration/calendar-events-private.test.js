// calendar_events is service-role only (migration 20261114200000_calendar_events_service_role_only.sql):
// the publishable key used to page through the whole race calendar, pending and rejected rows
// included. Scenario F-24 in docs/registration/scenario-matrix.md. Runs against the LOCAL stack only (`supabase db reset` first).
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import postgres from 'postgres'
import { createClient } from '@supabase/supabase-js'
import { localEnv, admin } from './helpers/stack.js'

let sqlClient
function db() {
  if (!sqlClient) sqlClient = postgres(localEnv().dbUrl, { max: 1, onnotice: () => {} })
  return sqlClient
}
after(async () => { if (sqlClient) await sqlClient.end() })

test('F-24 anon and authenticated hold no privilege on calendar_events', async () => {
  const held = await db()`
    SELECT r.rolname, p.privilege
      FROM (VALUES ('anon'), ('authenticated')) AS r(rolname)
      CROSS JOIN unnest(${['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']}::text[]) AS p(privilege)
     WHERE has_table_privilege(r.rolname, 'public.calendar_events', p.privilege)`
  assert.deepEqual(held.map((h) => `${h.rolname} ${h.privilege}`), [])
})

test('F-24 the publishable key cannot read calendar_events; the service role still can', async () => {
  const { url, anonKey } = localEnv()
  const anon = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const { data, error } = await anon.from('calendar_events').select('id').limit(1)
  assert.ok(error, `expected a permission error, got ${JSON.stringify(data)}`)
  assert.equal(error.code, '42501')

  const { error: adminError } = await admin().from('calendar_events').select('id').limit(1)
  assert.equal(adminError, null)
})
