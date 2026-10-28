// Task 1 of the race registration plan: the Supabase schema foundation.
// Runs against the LOCAL stack only (`supabase db reset` first). Scenario ids
// F-01…F-07 are in docs/registration/scenario-matrix.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { localEnv, admin, sessionFor } from './helpers/stack.js'

const ZT_CLUB = '00000000-0000-4000-8000-0000000000c1'
const IK_CLUB = '00000000-0000-4000-8000-0000000000c2'

const NEW_TABLES = [
  'registration_waitlist',
  'organizer_agreements',
  'club_payout_details',
  'club_payout_history',
  'registration_settings',
  'organizer_actions',
]

function anon() {
  const { url, anonKey } = localEnv()
  return createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
}

async function insert(table, row) {
  const { data, error } = await admin().from(table).insert(row).select().single()
  if (error) throw new Error(`${table}: ${error.message}`)
  return data
}

/** An event with one row in every table the delete trigger guards. */
async function seedEvent({ registration, clubId = ZT_CLUB }) {
  const tag = crypto.randomUUID().slice(0, 8)
  const event = await insert('events', { name: `Schema test ${tag}`, slug: `schema-test-${tag}` })
  const category = await insert('categories', { event_id: event.id, name: '10 km', slug: `10km-${tag}` })
  const participant = await insert('participants', {
    event_id: event.id, category_id: category.id, first_name: 'Jan', last_name: `Test${tag}`, bib_number: 1,
  })
  const checkin = await insert('checkins', { event_id: event.id, participant_id: participant.id })
  const checkpoint = await insert('checkpoints', { event_id: event.id, name: 'PK1' })
  const raceRun = await insert('race_runs', { category_id: category.id })
  const document = await insert('event_documents', { event_id: event.id, name: 'Regulamin', type: 'acknowledgement' })
  const checkinDocument = await insert('checkin_documents', { checkin_id: checkin.id, document_id: document.id })
  const checkpointCategory = await insert('checkpoint_categories', { checkpoint_id: checkpoint.id, category_id: category.id })
  if (registration) {
    await insert('registration_settings', { event_id: event.id, club_id: clubId })
  }
  return { event, category, participant, checkin, checkpoint, raceRun, document, checkinDocument, checkpointCategory }
}

test('F-01 anon cannot select any of the six new registration tables', async () => {
  for (const table of NEW_TABLES) {
    const { data, error } = await anon().from(table).select('*').limit(1)
    assert.ok(error, `anon read ${table} without an error (data: ${JSON.stringify(data)})`)
    assert.match(error.message, /permission denied/, `${table}: ${error.message}`)
  }
})

test('F-02 registration_settings.club_id cannot be changed; other columns can', async () => {
  const { event } = await seedEvent({ registration: true })
  const { error } = await admin().from('registration_settings').update({ club_id: IK_CLUB }).eq('event_id', event.id)
  assert.ok(error, 'club_id update succeeded')
  assert.match(error.message, /club_id/)

  const { error: stateErr } = await admin().from('registration_settings').update({ state: 'published' }).eq('event_id', event.id)
  assert.equal(stateErr, null)
  const { data } = await admin().from('registration_settings').select('club_id, state').eq('event_id', event.id).single()
  assert.deepEqual(data, { club_id: ZT_CLUB, state: 'published' })
})

// [table, key in seedEvent's result, column that identifies the row]
const GUARDED = [
  ['checkin_documents', 'checkinDocument'],
  ['checkpoint_categories', 'checkpointCategory', 'checkpoint_id'],
  ['participants', 'participant'],
  ['checkins', 'checkin'],
  ['checkpoints', 'checkpoint'],
  ['race_runs', 'raceRun'],
  ['event_documents', 'document'],
  ['categories', 'category'],
  ['events', 'event'],
]

test('F-03 deletes of a registration event and its rows are refused', async () => {
  const rows = await seedEvent({ registration: true })
  for (const [table, key, col = 'id'] of GUARDED) {
    const { error } = await admin().from(table).delete().eq(col, rows[key][col])
    assert.ok(error, `delete from ${table} succeeded on a registration event`)
    assert.match(error.message, /registration/i, `${table}: ${error.message}`)
    const { data } = await admin().from(table).select(col).eq(col, rows[key][col])
    assert.equal(data.length, 1, `${table} row is gone`)
  }
})

test('F-03 the same deletes on an event without registration succeed', async () => {
  const rows = await seedEvent({ registration: false })
  for (const [table, key, col = 'id'] of GUARDED) {
    const { error } = await admin().from(table).delete().eq(col, rows[key][col])
    assert.equal(error, null, `${table}: ${error?.message}`)
    const { data } = await admin().from(table).select(col).eq(col, rows[key][col])
    assert.equal(data.length, 0, `${table} row survived`)
  }
})

test('F-04 a removed participant is hidden from participants_public and the PIN RPCs', async () => {
  const { event, category } = await seedEvent({ registration: false })
  const tag = crypto.randomUUID().slice(0, 8)
  const kept = await insert('participants', {
    event_id: event.id, category_id: category.id, first_name: 'Widoczny', last_name: `Zostaje${tag}`, bib_number: 2,
  })
  const removed = await insert('participants', {
    event_id: event.id, category_id: category.id, first_name: 'Ukryty', last_name: `Usuniety${tag}`, bib_number: 3,
    removed_at: new Date().toISOString(),
  })
  const pin = '4321'
  await insert('event_secrets', { event_id: event.id, checkin_pin: pin })

  const { data: pub, error: pubErr } = await anon().from('participants_public').select('id').in('id', [kept.id, removed.id])
  assert.equal(pubErr, null, pubErr?.message)
  assert.deepEqual(pub.map((r) => r.id), [kept.id])

  const { data: byName, error: searchErr } = await anon().rpc('search_participants_admin', { p_event_id: event.id, p_pin: pin, p_query: tag })
  assert.equal(searchErr, null, searchErr?.message)
  assert.deepEqual(byName.map((r) => r.id), [kept.id])

  const { data: byBib } = await anon().rpc('search_participants_admin', { p_event_id: event.id, p_pin: pin, p_query: '3' })
  assert.deepEqual(byBib, [])

  const { data: adminRow, error: adminErr } = await anon().rpc('get_participant_admin', { p_event_id: event.id, p_pin: pin, p_participant_id: removed.id })
  assert.equal(adminErr, null, adminErr?.message)
  assert.equal(adminRow, null)
  const { data: adminKept } = await anon().rpc('get_participant_admin', { p_event_id: event.id, p_pin: pin, p_participant_id: kept.id })
  assert.equal(adminKept.id, kept.id)

  const { data: checkinRow, error: checkinErr } = await anon().rpc('get_participant_for_checkin', { p_participant_id: removed.id })
  assert.equal(checkinErr, null, checkinErr?.message)
  assert.deepEqual(checkinRow, [])
  const { data: checkinKept } = await anon().rpc('get_participant_for_checkin', { p_participant_id: kept.id })
  assert.equal(checkinKept[0].id, kept.id)

  const { error: badPin } = await anon().rpc('search_participants_admin', { p_event_id: event.id, p_pin: 'zly', p_query: tag })
  assert.match(badPin.message, /Invalid PIN/)
})

test('F-05 delete-club: 200 for a club without events, 409 for a club owning a registration event', async () => {
  const tag = crypto.randomUUID().slice(0, 8)
  const { cookie, profileId } = await sessionFor(`delete-club-${tag}@test.local`)
  const del = (clubId) => fetch(`${localEnv().functionsUrl}/delete-club`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ club_id: clubId }),
  })

  const plain = await insert('clubs', { name: `Pusty ${tag}`, normalized_name: `pusty ${tag}`, slug: `pusty-${tag}`, owner_id: profileId })
  const ok = await del(plain.id)
  assert.equal(ok.status, 200, await ok.text())
  const { data: gone } = await admin().from('clubs').select('id').eq('id', plain.id)
  assert.equal(gone.length, 0)

  const owning = await insert('clubs', { name: `Z zapisami ${tag}`, normalized_name: `z zapisami ${tag}`, slug: `z-zapisami-${tag}`, owner_id: profileId })
  await seedEvent({ registration: true, clubId: owning.id })
  const refused = await del(owning.id)
  assert.equal(refused.status, 409)
  assert.deepEqual(await refused.json(), { error: 'Klub ma wydarzenia z zapisami — nie można go usunąć.' })
  const { data: kept } = await admin().from('clubs').select('id').eq('id', owning.id)
  assert.equal(kept.length, 1)
})

test('F-05 merge_clubs refuses a source club with registration events or payout details', async () => {
  const tag = crypto.randomUUID().slice(0, 8)
  const mk = (name) => insert('clubs', { name: `${name} ${tag}`, normalized_name: `${name.toLowerCase()} ${tag}`, slug: `${name.toLowerCase()}-${tag}` })
  const target = await mk('Cel')
  const withEvent = await mk('Wydarzenie')
  const withPayout = await mk('Wyplata')
  const plain = await mk('Zwykly')
  await seedEvent({ registration: true, clubId: withEvent.id })
  await insert('club_payout_details', {
    club_id: withPayout.id, legal_name: 'Klub Sp.', nip: '1234567890', iban: 'PL61109010140000071219812874', address: 'ul. Leśna 1',
  })

  for (const source of [withEvent, withPayout]) {
    const { error } = await admin().rpc('merge_clubs', { target: target.id, sources: [source.id] })
    assert.ok(error, `merge of ${source.name} succeeded`)
    assert.match(error.message, /registration/)
  }
  const { error } = await admin().rpc('merge_clubs', { target: target.id, sources: [plain.id] })
  assert.equal(error, null, error?.message)
})

test('F-05 merge_clubs is not callable by anon', async () => {
  const { error } = await anon().rpc('merge_clubs', { target: ZT_CLUB, sources: [IK_CLUB] })
  assert.ok(error)
  assert.match(error.message, /permission denied/)
})

test('F-06 seed: zatyrani-test has registration enabled, inny-klub does not', async () => {
  const { data, error } = await admin().from('clubs').select('slug, registration_enabled').in('slug', ['zatyrani-test', 'inny-klub']).order('slug')
  assert.equal(error, null, error?.message)
  assert.deepEqual(data, [
    { slug: 'inny-klub', registration_enabled: false },
    { slug: 'zatyrani-test', registration_enabled: true },
  ])
})

test('F-07 registration_waitlist holds one row per club', async () => {
  const tag = crypto.randomUUID().slice(0, 8)
  const club = await insert('clubs', { name: `Kolejka ${tag}`, normalized_name: `kolejka ${tag}`, slug: `kolejka-${tag}` })
  await insert('registration_waitlist', { club_id: club.id, requested_by: '00000000-0000-4000-8000-0000000000b1' })
  const { error } = await admin().from('registration_waitlist').insert({ club_id: club.id, requested_by: '00000000-0000-4000-8000-0000000000b2' })
  assert.ok(error, 'second waitlist row for one club was accepted')
  assert.equal(error.code, '23505')
})
