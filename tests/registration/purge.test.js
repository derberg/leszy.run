// Plan 2, task 11: the 30-day phone and ICE purge (W-43 in docs/registration/scenario-matrix.md).
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import postgres from 'postgres'
import { admin, localEnv, sessionFor } from './helpers/stack.js'
import { acceptAgreement, createPublishedFreeEvent } from './helpers/registrationFixtures.js'

const db = () => admin()
// The SQL cutoff is the Warsaw calendar day minus 30, so fixtures count days from the Warsaw date too.
const warsawToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(new Date())
const isoDay = (offset) => {
  const [y, m, d] = warsawToday().split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + offset)).toISOString().slice(0, 10)
}

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
  const boundary = await eventWithRunner(30)
  const recent = await eventWithRunner(29)

  const first = await db().rpc('purge_registration_contact_data')
  assert.ifError(first.error)
  assert.ok(first.data >= 4, `touched at least the registration and the participant, got ${first.data}`)

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

  const bd = await snapshot(boundary)
  assert.equal(bd.r.phone, null, 'exactly 30 days ago is purged')
  assert.equal(bd.r.ice_phone, null)
  assert.equal(bd.p.phone, null)

  const n = await snapshot(recent)
  assert.equal(n.r.phone, '600100200')
  assert.equal(n.r.ice_name, 'Jan Leśny')
  assert.equal(n.r.ice_phone, '600300400')
  assert.equal(n.p.phone, '600100200')

  const second = await db().rpc('purge_registration_contact_data')
  assert.ifError(second.error)
  assert.equal(second.data, 0)
})

test('W-43b (D4-30) the purge also clears a child\'s guardian name and address 30 days after the event; guardian_profile_id stays', async () => {
  const { registerGroup, adult, minor } = await import('./helpers/groups.js')
  const { profileFor, runnerEmail } = await import('./helpers/orders.js')
  const make = async (daysAgo) => {
    const event = await createPublishedFreeEvent(owner, {
      competitions: [{ name: 'Bieg dzieci 1 km', discipline: 'run', distanceLabel: '1 km', startTime: '09:00', capacity: 50 }],
    })
    const buyer = runnerEmail('guardian')
    const profileId = await profileFor(buyer)
    const r = await registerGroup(event, [adult(event.categoryIds[0], 'self', buyer), minor(event.categoryIds[0])], { profileId })
    assert.ifError(r.error)
    const moved = await db().from('registration_settings').update({ event_date: isoDay(-daysAgo) }).eq('event_id', event.eventId)
    assert.ifError(moved.error)
    return { childId: r.data.registrations.find((x) => x.role === 'minor').id, profileId, buyer }
  }
  const old = await make(31)
  const recent = await make(29)
  const run = await db().rpc('purge_registration_contact_data')
  assert.ifError(run.error)

  const { data: o } = await db().from('registrations').select('*').eq('id', old.childId).single()
  assert.equal(o.guardian_name, null)
  assert.equal(o.guardian_email, null)
  assert.equal(o.phone, null)
  assert.equal(o.guardian_profile_id, old.profileId, 'the link to the guardian\'s account is not contact data')
  assert.equal(o.first_name, 'Zosia')

  const { data: n } = await db().from('registrations').select('*').eq('id', recent.childId).single()
  assert.equal(n.guardian_name, 'Ola Leśna')
  assert.equal(n.guardian_email, recent.buyer)

  const again = await db().rpc('purge_registration_contact_data')
  assert.ifError(again.error)
  assert.equal(again.data, 0)
})

test('W-43 public, anon and authenticated cannot execute the purge; service_role can', async () => {
  const { url, anonKey } = localEnv()
  const anon = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const { error } = await anon.rpc('purge_registration_contact_data')
  assert.ok(error, 'anon is refused')
  assert.match(error.message, /permission denied/)

  // A real authenticated JWT: the login the other tests use is a cookie, so sign one with the stack's secret.
  const { jwtSecret } = localEnv()
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const head = b64({ alg: 'HS256', typ: 'JWT' })
  const claims = b64({ role: 'authenticated', sub: crypto.randomUUID(), aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 600 })
  const sig = crypto.createHmac('sha256', jwtSecret).update(`${head}.${claims}`).digest('base64url')
  const authed = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${head}.${claims}.${sig}` } },
  })
  const r2 = await authed.rpc('purge_registration_contact_data')
  assert.ok(r2.error, 'authenticated is refused')
  assert.match(r2.error.message, /permission denied/)
})

test('W-43 the daily schedule is 01:30 UTC where pg_cron is installed', async (t) => {
  const { dbUrl } = localEnv()
  const sql = postgres(dbUrl, { max: 1, onnotice: () => {} })
  try {
    const [has] = await sql`select to_regclass('cron.job') as t`
    if (!has.t) return t.skip('no cron.job on this stack')
    const rows = await sql`select schedule, command from cron.job where jobname = 'purge-registration-contact'`
    assert.equal(rows.length, 1)
    assert.equal(rows[0].schedule, '30 1 * * *')
    assert.match(rows[0].command, /purge_registration_contact_data\(\)/)
  } finally {
    await sql.end({ timeout: 1 })
  }
})
