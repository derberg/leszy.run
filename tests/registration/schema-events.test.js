// Plan 2, task 2: the registration event schema (settings, competitions,
// categories, form, registrations). Runs against the LOCAL stack only
// (`supabase db reset` first). Scenario ids W-05…W-08 are in
// docs/registration/scenario-matrix.md.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import postgres from 'postgres'
import { createClient } from '@supabase/supabase-js'
import { localEnv, admin } from './helpers/stack.js'

const ZT_CLUB = '00000000-0000-4000-8000-0000000000c1'

const NEW_TABLES = [
  'office_hours',
  'registration_pending_changes',
  'registration_uploads',
  'competitions',
  'price_tiers',
  'competition_prices',
  'age_groups',
  'kids_groups',
  'event_consents',
  'registrations',
  'consent_acceptances',
  'organizer_messages',
]

function anon() {
  const { url, anonKey } = localEnv()
  return createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
}

// One direct connection, for what must happen inside a single transaction
// (supabase-js calls are separate transactions, a transaction-local GUC
// would not survive between them).
let sqlClient
function sql() {
  if (!sqlClient) sqlClient = postgres(localEnv().dbUrl, { max: 1, onnotice: () => {} })
  return sqlClient
}
after(async () => { if (sqlClient) await sqlClient.end() })

async function insert(table, row) {
  const { data, error } = await admin().from(table).insert(row).select().single()
  if (error) throw new Error(`${table}: ${error.message}`)
  return data
}

/** A draft registration event with one competition (capacity as given). */
async function seedRegistrationEvent({ capacity = 10 } = {}) {
  const tag = crypto.randomUUID().slice(0, 8)
  const event = await insert('events', { name: `Schema W ${tag}`, slug: `schema-w-${tag}` })
  await insert('registration_settings', { event_id: event.id, club_id: ZT_CLUB })
  const category = await insert('categories', { event_id: event.id, name: '10 km', slug: `10km-${tag}` })
  const competition = await insert('competitions', {
    category_id: category.id, event_id: event.id, name: '10 km', capacity, sort_order: 0,
  })
  return { tag, event, category, competition }
}

function registrationRow({ event, category }, overrides = {}) {
  return {
    event_id: event.id,
    category_id: category.id,
    status: 'confirmed',
    consent_state: 'accepted',
    first_name: 'Ola',
    last_name: 'Test',
    birth_date: '1990-05-01',
    gender: 'K',
    email: 'ola@x.pl',
    ...overrides,
  }
}

test('W-05 anon cannot select any new registration table', async () => {
  for (const table of NEW_TABLES) {
    const { data, error } = await anon().from(table).select('*').limit(1)
    assert.ok(error, `anon read ${table} without an error (data: ${JSON.stringify(data)})`)
    assert.match(error.message, /permission denied/, `${table}: ${error.message}`)
  }
})

test('W-05 anon cannot call claim_competition_slots', async () => {
  const { competition } = await seedRegistrationEvent({ capacity: 5 })
  const { error } = await anon().rpc('claim_competition_slots', { p_category_id: competition.category_id, p_n: 1 })
  assert.ok(error, 'anon called claim_competition_slots')
  assert.match(error.message, /permission denied/)
  const { data } = await admin().from('competitions').select('taken').eq('category_id', competition.category_id).single()
  assert.equal(data.taken, 0)
})

test('W-05 the storage buckets exist: registration-files public, registration-pending private', async () => {
  const rows = await sql()`select id, public from storage.buckets where id in ('registration-files', 'registration-pending') order by id`
  assert.deepEqual(rows.map((r) => ({ ...r })), [
    { id: 'registration-files', public: true },
    { id: 'registration-pending', public: false },
  ])
})

test('W-06 claim_competition_slots on capacity 2: n=1,1,1 returns 1, 2, null', async () => {
  const { competition } = await seedRegistrationEvent({ capacity: 2 })
  const results = []
  for (let i = 0; i < 3; i++) {
    const { data, error } = await admin().rpc('claim_competition_slots', { p_category_id: competition.category_id, p_n: 1 })
    assert.equal(error, null, error?.message)
    results.push(data)
  }
  assert.deepEqual(results, [1, 2, null])
  const { data } = await admin().from('competitions').select('taken').eq('category_id', competition.category_id).single()
  assert.equal(data.taken, 2)
})

test('W-06 claim_competition_slots never overfills under concurrency', async () => {
  const { competition } = await seedRegistrationEvent({ capacity: 3 })
  const calls = Array.from({ length: 10 }, () =>
    admin().rpc('claim_competition_slots', { p_category_id: competition.category_id, p_n: 1 }))
  const results = await Promise.all(calls)
  for (const r of results) assert.equal(r.error, null, r.error?.message)
  const claimed = results.map((r) => r.data).filter((v) => v !== null).sort()
  assert.deepEqual(claimed, [1, 2, 3])
  const { data } = await admin().from('competitions').select('taken').eq('category_id', competition.category_id).single()
  assert.equal(data.taken, 3)
})

test('W-06 claim_competition_slots refuses n < 1', async () => {
  const { competition } = await seedRegistrationEvent({ capacity: 2 })
  const { error } = await admin().rpc('claim_competition_slots', { p_category_id: competition.category_id, p_n: 0 })
  assert.ok(error, 'n = 0 was accepted')
})

test('W-07 one live registration per event and email, case-insensitive', async () => {
  const seed = await seedRegistrationEvent()
  await insert('registrations', registrationRow(seed, { email: 'Ola@x.pl' }))
  const { error } = await admin().from('registrations').insert(registrationRow(seed, { email: 'ola@x.pl' }))
  assert.ok(error, 'second confirmed registration with the same email was accepted')
  assert.equal(error.code, '23505', error.message)
})

test('W-07 a cancelled registration does not block a confirmed one with the same email', async () => {
  const seed = await seedRegistrationEvent()
  await insert('registrations', registrationRow(seed, { email: 'Ola@x.pl', status: 'cancelled' }))
  const row = await insert('registrations', registrationRow(seed, { email: 'ola@x.pl' }))
  assert.equal(row.status, 'confirmed')
})

test('W-08 deleting a category of a registration event without the setting still raises', async () => {
  const { category } = await seedRegistrationEvent()
  await assert.rejects(
    sql().begin(async (tx) => {
      await tx`delete from public.competitions where category_id = ${category.id}`
      await tx`delete from public.categories where id = ${category.id}`
    }),
    /registration/i,
  )
  const { data } = await admin().from('categories').select('id').eq('id', category.id)
  assert.equal(data.length, 1)
})

test('W-08 with leszyrun.registration_draft_delete on in the same transaction the draft category delete succeeds', async () => {
  const { category } = await seedRegistrationEvent()
  await sql().begin(async (tx) => {
    await tx`select set_config('leszyrun.registration_draft_delete', 'on', true)`
    await tx`delete from public.competitions where category_id = ${category.id}`
    await tx`delete from public.categories where id = ${category.id}`
  })
  const { data } = await admin().from('categories').select('id').eq('id', category.id)
  assert.equal(data.length, 0)
  // The setting was transaction-local: the next delete is refused again.
  const other = await seedRegistrationEvent()
  await assert.rejects(
    sql().begin(async (tx) => {
      await tx`delete from public.competitions where category_id = ${other.category.id}`
      await tx`delete from public.categories where id = ${other.category.id}`
    }),
    /registration/i,
  )
})

test('W-08 the setting does not open a published event, nor the event row itself', async () => {
  const { event, category } = await seedRegistrationEvent()
  await assert.rejects(
    sql().begin(async (tx) => {
      await tx`select set_config('leszyrun.registration_draft_delete', 'on', true)`
      await tx`delete from public.events where id = ${event.id}`
    }),
    /registration/i,
  )
  await admin().from('registration_settings').update({ state: 'published' }).eq('event_id', event.id)
  await assert.rejects(
    sql().begin(async (tx) => {
      await tx`select set_config('leszyrun.registration_draft_delete', 'on', true)`
      await tx`delete from public.competitions where category_id = ${category.id}`
      await tx`delete from public.categories where id = ${category.id}`
    }),
    /registration/i,
  )
})

test('W-08 a category with a competition cannot be deleted while the competition exists (FK restrict)', async () => {
  const { category } = await seedRegistrationEvent()
  await assert.rejects(
    sql().begin(async (tx) => {
      await tx`select set_config('leszyrun.registration_draft_delete', 'on', true)`
      await tx`delete from public.categories where id = ${category.id}`
    }),
    /foreign key/i,
  )
})

test('W-08 deleting a registration a participant points at raises (FK restrict)', async () => {
  const seed = await seedRegistrationEvent()
  const registration = await insert('registrations', registrationRow(seed, { email: `p-${seed.tag}@x.pl` }))
  await insert('participants', {
    event_id: seed.event.id, category_id: seed.category.id, first_name: 'Ola', last_name: 'Test',
    registration_id: registration.id,
  })
  const { error } = await admin().from('registrations').delete().eq('id', registration.id)
  assert.ok(error, 'registration delete succeeded although a participant points at it')
  assert.equal(error.code, '23503', error.message)
})
