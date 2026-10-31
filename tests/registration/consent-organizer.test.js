// Plan 4, task 6: what the organizer's „Zgłoszenia” reads about consents (G-53 in
// docs/registration/scenario-matrix.md). list-event-registrations rows carry `role`,
// `consentState`, `guardianName`, `guardianRemoved` and `registeredBy`, and `counts` carries
// `awaitingConsent`. `guardianRemoved` (D4-25) rests on registrations.guardian_removed_at, which
// delete-my-account stamps; the 30-day contact purge nulls the guardian fields of every past
// child entry too, so a null guardian field must never read as „removed”.
// LOCAL stack only; every event and address is random.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { sessionFor } from './helpers/stack.js'
import { acceptAgreement, callFn, createPublishedFreeEvent } from './helpers/registrationFixtures.js'
import { db, one, runnerEmail } from './helpers/orders.js'
import { BIEG, DZIECI, adult, groupMeta, minor, registerGroup } from './helpers/groups.js'

let owner, member
before(async () => {
  await acceptAgreement('zatyrani-test')
  owner = await sessionFor('owner@zatyrani-test.local')
  member = await sessionFor('member@zatyrani-test.local')
})

const warsawToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(new Date())
const isoDay = (offset) => {
  const [y, m, d] = warsawToday().split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + offset)).toISOString().slice(0, 10)
}

/** A family in `event`: the payer (self), an added adult and a child; → { payer, payerEmail, ids: { self, adult, minor } } */
async function family(event, { payerName = 'Ola Leśna', childName = 'Zosia' } = {}) {
  const [bieg, dzieci] = event.categoryIds
  const payerEmail = runnerEmail('payer')
  const payer = await sessionFor(payerEmail)
  const [first, last] = payerName.split(' ')
  const r = await registerGroup(event, [
    adult(bieg, 'self', payerEmail, { firstName: first, lastName: last }),
    adult(bieg, 'adult', runnerEmail('adult'), { firstName: 'Piotr', lastName: 'Borowy', gender: 'M', ageGroupLabel: 'M open' }),
    minor(dzieci, { firstName: childName }),
  ], { profileId: payer.profileId, meta: await groupMeta(event.eventId, { buyerName: payerName }) })
  assert.equal(r.error, null, r.error?.message)
  const byRole = Object.fromEntries(r.data.registrations.map((x) => [x.role, x.id]))
  return { payer, payerEmail, ids: byRole }
}

async function list(event, session = owner) {
  const r = await callFn('list-event-registrations', session, { eventId: event.eventId })
  return r
}

async function deleteAccount(email, session) {
  const sha = crypto.createHash('sha256').update('123456').digest('hex')
  const { error } = await db().from('auth_codes').insert({
    email, code_hash: sha, purpose: 'delete_account', expires_at: new Date(Date.now() + 600000).toISOString(),
  })
  assert.ifError(error)
  const r = await callFn('delete-my-account', session, { action: 'confirm', code: '123456' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
}

test('G-53 list-event-registrations: role, consentState, registeredBy, guardian, awaitingConsent; the office mark; guardianRemoved survives the 30-day purge', async () => {
  const event = await createPublishedFreeEvent(owner, { competitions: [BIEG(), DZIECI()] })
  const a = await family(event, { payerName: 'Ola Leśna', childName: 'Zosia' })
  const b = await family(event, { payerName: 'Ewa Polna', childName: 'Kuba' })

  const first = await list(event)
  assert.equal(first.status, 200, JSON.stringify(first.body))
  const row = (id) => first.body.data.find((x) => x.id === id)
  assert.deepEqual(
    { role: row(a.ids.self).role, consentState: row(a.ids.self).consentState, registeredBy: row(a.ids.self).registeredBy },
    { role: 'self', consentState: 'accepted', registeredBy: null })
  assert.deepEqual(
    { role: row(a.ids.adult).role, consentState: row(a.ids.adult).consentState, registeredBy: row(a.ids.adult).registeredBy },
    { role: 'adult', consentState: 'awaiting', registeredBy: 'Ola Leśna' })
  const kid = row(a.ids.minor)
  assert.deepEqual(
    { role: kid.role, consentState: kid.consentState, registeredBy: kid.registeredBy, guardianName: kid.guardianName, guardianRemoved: kid.guardianRemoved },
    { role: 'minor', consentState: 'accepted', registeredBy: 'Ola Leśna', guardianName: 'Ola Leśna', guardianRemoved: false })
  assert.equal(first.body.counts.awaitingConsent, 2, 'two added adults wait')
  // Nothing beyond what the tab shows: no address, phone or birth date at any depth.
  const text = JSON.stringify(first.body)
  for (const leak of [a.payerEmail, b.payerEmail, '+48', '1990-', '2016-']) assert.ok(!text.includes(leak), leak)

  // A member never reads it (P2-R20).
  assert.equal((await list(event, member)).status, 404)

  // „Podpisany w biurze” on family A's adult.
  const office = await callFn('mark-consent-office', owner, { registrationId: a.ids.adult })
  assert.equal(office.status, 200, JSON.stringify(office.body))
  const second = await list(event)
  assert.equal(second.body.data.find((x) => x.id === a.ids.adult).consentState, 'office')
  assert.equal(second.body.counts.awaitingConsent, 1)

  // Family A's payer deletes the account: the child's row stays, flagged, without the guardian's name.
  await deleteAccount(a.payerEmail, a.payer)
  const stamped = await one('registrations', { id: a.ids.minor })
  assert.ok(stamped.guardian_removed_at, 'delete-my-account stamps guardian_removed_at')
  const third = await list(event)
  const orphan = third.body.data.find((x) => x.id === a.ids.minor)
  assert.equal(orphan.guardianRemoved, true)
  assert.equal(orphan.guardianName, null, '„Usunięte konto” is not a name')
  assert.equal(orphan.role, 'minor')
  assert.equal(third.body.data.find((x) => x.id === b.ids.minor).guardianRemoved, false)
  // Who registered family A's adult is nobody nameable any more: not „Uczestnik anonimowy”, not „Usunięte konto”.
  assert.equal(third.body.data.find((x) => x.id === a.ids.adult).registeredBy, null)

  // 31 days after the race the purge nulls every child's guardian fields; only the stamp tells them apart.
  const moved = await db().from('registration_settings').update({ event_date: isoDay(-31) }).eq('event_id', event.eventId)
  assert.ifError(moved.error)
  const purge = await db().rpc('purge_registration_contact_data')
  assert.ifError(purge.error)
  const kidB = await one('registrations', { id: b.ids.minor })
  assert.equal(kidB.guardian_name, null, 'the purge ran on family B')
  const fourth = await list(event)
  const after = (id) => fourth.body.data.find((x) => x.id === id)
  assert.equal(after(a.ids.minor).guardianRemoved, true)
  assert.equal(after(b.ids.minor).guardianRemoved, false, 'a purged guardian is not a removed one')
  assert.equal(after(b.ids.minor).role, 'minor')
  assert.equal(after(b.ids.minor).consentState, 'accepted')
})
