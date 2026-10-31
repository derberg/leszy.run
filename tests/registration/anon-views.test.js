// Client roles never write through a view (migration 20261030200000_revoke_client_view_writes.sql).
// A simple view over one table is automatically updatable, and every view in public is owned
// by postgres, which bypasses RLS: an UPDATE through participants_public as anon changed the
// participants row underneath. Runs against the LOCAL stack only (`supabase db reset` first).
// Scenario id F-23 is in docs/registration/scenario-matrix.md.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import postgres from 'postgres'
import { createClient } from '@supabase/supabase-js'
import { localEnv, admin, authenticatedClient } from './helpers/stack.js'

const WRITE_PRIVILEGES = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']

function anon() {
  const { url, anonKey } = localEnv()
  return createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
}

let sqlClient
function db() {
  if (!sqlClient) sqlClient = postgres(localEnv().dbUrl, { max: 1, onnotice: () => {} })
  return sqlClient
}
after(async () => { if (sqlClient) await sqlClient.end() })

async function insert(table, row) {
  const { data, error } = await admin().from(table).insert(row).select().single()
  if (error) throw new Error(`${table}: ${error.message}`)
  return data
}

async function seedParticipant() {
  const tag = crypto.randomUUID().slice(0, 8)
  const event = await insert('events', { name: `Anon views ${tag}`, slug: `anon-views-${tag}` })
  const category = await insert('categories', { event_id: event.id, name: '10 km', slug: `10km-${tag}` })
  return insert('participants', {
    event_id: event.id, category_id: category.id, first_name: 'Jan', last_name: `Widok${tag}`, bib_number: 1, club: 'KB Leszy',
  })
}

test('F-23 anon and authenticated hold no write privilege on any view in public', async () => {
  const views = await db()`
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('v', 'm') ORDER BY 1`
  assert.ok(views.length > 0, 'expected at least one view in public')

  const held = await db()`
    SELECT c.relname, r.rolname, p.privilege
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN (VALUES ('anon'), ('authenticated')) AS r(rolname)
      CROSS JOIN unnest(${WRITE_PRIVILEGES}::text[]) AS p(privilege)
     WHERE n.nspname = 'public' AND c.relkind IN ('v', 'm')
       AND has_table_privilege(r.rolname, c.oid, p.privilege)
     ORDER BY 1, 2, 3`
  assert.deepEqual(held.map((h) => `${h.relname} ${h.rolname} ${h.privilege}`), [])

  // The public pages still read the views they always read.
  for (const view of ['participants_public', 'profiles_public', 'event_results_summary', 'event_category_best_times']) {
    const [{ ok }] = await db()`SELECT has_table_privilege('anon', ${'public.' + view}, 'SELECT') AS ok`
    assert.equal(ok, true, `anon lost SELECT on ${view}`)
  }
})

test('F-23 a view created later gives client roles no write privilege by default', async () => {
  const name = `f23_probe_${crypto.randomUUID().slice(0, 8)}`
  await db().begin(async (tx) => {
    await tx.unsafe(`CREATE VIEW public.${name} AS SELECT id, club FROM public.participants`)
    const held = await tx`
      SELECT r.rolname, p.privilege
        FROM (VALUES ('anon'), ('authenticated')) AS r(rolname)
        CROSS JOIN unnest(${['INSERT', 'UPDATE', 'DELETE']}::text[]) AS p(privilege)
       WHERE has_table_privilege(r.rolname, ${'public.' + name}, p.privilege)`
    assert.deepEqual(held.map((h) => `${h.rolname} ${h.privilege}`), [])
    await tx.unsafe(`DROP VIEW public.${name}`)
  })
})

test('F-23 anon UPDATE through participants_public is refused and the participant is unchanged', async () => {
  const participant = await seedParticipant()

  // Over PostgREST with the publishable key, as a browser would.
  for (const [role, client] of [['anon', anon()], ['authenticated', authenticatedClient()]]) {
    const { error } = await client.from('participants_public').update({ club: 'x' }).eq('id', participant.id)
    assert.ok(error, `${role}: update through participants_public was accepted`)
    assert.equal(error.code, '42501', `${role}: ${error.message}`)
    const { error: insErr } = await client.from('participants_public').insert({ first_name: 'Obcy' })
    assert.equal(insErr?.code, '42501', `${role} insert: ${insErr?.message}`)
    const { error: delErr } = await client.from('participants_public').delete().eq('id', participant.id)
    assert.equal(delErr?.code, '42501', `${role} delete: ${delErr?.message}`)
  }

  // The reproduction itself, in SQL.
  await assert.rejects(
    db().begin(async (tx) => {
      await tx`SET LOCAL ROLE anon`
      await tx`UPDATE public.participants_public SET club = 'x' WHERE id = ${participant.id}`
    }),
    (err) => err.code === '42501',
  )

  const { data } = await admin().from('participants').select('club, deleted_at').eq('id', participant.id).single()
  assert.equal(data.club, 'KB Leszy')
  assert.equal(data.deleted_at, null)
})
