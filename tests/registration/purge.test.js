// Plan 2, task 11: the 30-day phone and ICE purge (W-43 in docs/registration/scenario-matrix.md).
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { admin, localEnv, sessionFor } from './helpers/stack.js'
import { acceptAgreement, createPublishedFreeEvent } from './helpers/registrationFixtures.js'

const db = () => admin()
const isoDay = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10)

let owner
before(async () => {
  await acceptAgreement('zatyrani-test')
  owner = await sessionFor('owner@zatyrani-test.local')
})

/** A published event with one registration holding phone and ICE data, then the event moved to `daysAgo`. */
async function eventWithRunner(daysAgo) {
  const event = await createPublishedFreeEvent(owner)
  const { data: consents } = await db().from('event_consents').select('id').eq('event_id', event.eventId)
  const email = `purge-${crypto.randomBytes(4).toString('hex')}@test.local`
  const { data, error } = await db().rpc('register_free', {
    p_category_id: event.categoryIds[0],
    p_people: [{
      firstName: 'Ola', lastName: 'Leśna', birthDate: '1990-05-01', gender: 'K', email, phone: '600100200',
      club: 'Klub', iceName: 'Jan Leśny', icePhone: '600300400',
    }],
    p_profile_id: null,
    p_meta: { consentIds: consents.map((c) => c.id), ip: '203.0.113.9', userAgent: 'UA' },
  })
  assert.ifError(error)
  const regId = data.registrations[0].id
  const moved = await db().from('registration_settings').update({ event_date: isoDay(-daysAgo) }).eq('event_id', event.eventId)
  assert.ifError(moved.error)
  return { regId, email, participantId: data.registrations[0].participantId }
}

const snapshot = async ({ regId, participantId }) => {
  const { data: r } = await db().from('registrations').select('*').eq('id', regId).single()
  const { data: p } = await db().from('participants').select('*').eq('id', participantId).single()
  return { r, p }
}

test('W-43 an event 31 days ago loses phone and ICE; an event 29 days ago is untouched; a second run returns 0', async () => {
  const old = await eventWithRunner(31)
  const recent = await eventWithRunner(29)

  const first = await db().rpc('purge_registration_contact_data')
  assert.ifError(first.error)
  assert.ok(first.data >= 2, `touched at least the registration and the participant, got ${first.data}`)

  const o = await snapshot(old)
  assert.equal(o.r.phone, null)
  assert.equal(o.r.ice_name, null)
  assert.equal(o.r.ice_phone, null)
  assert.equal(o.p.phone, null)
  assert.equal(o.r.email, old.email)
  assert.equal(o.r.first_name, 'Ola')
  assert.equal(o.r.birth_date, '1990-05-01')
  assert.equal(o.r.club, 'Klub')
  assert.equal(o.r.status, 'confirmed')
  assert.equal(o.p.email, old.email)

  const n = await snapshot(recent)
  assert.equal(n.r.phone, '600100200')
  assert.equal(n.r.ice_name, 'Jan Leśny')
  assert.equal(n.r.ice_phone, '600300400')
  assert.equal(n.p.phone, '600100200')

  const second = await db().rpc('purge_registration_contact_data')
  assert.ifError(second.error)
  assert.equal(second.data, 0)
})

test('W-43 anon and authenticated cannot execute the purge', async () => {
  const { url, anonKey } = localEnv()
  const anon = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const { error } = await anon.rpc('purge_registration_contact_data')
  assert.ok(error, 'anon is refused')
  assert.match(error.message, /permission denied/)
})
