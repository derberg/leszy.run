// Plan 4, task 8: a family's personal data under export-my-data and delete-my-account (G-59…G-61
// in docs/registration/scenario-matrix.md). The family is one paid order: the payer (self), an
// added adult (Piotr) and a child. The payer's export holds the child (as guardian) and never
// Piotr's entry, which is Piotr's data; Piotr's export says who provided his data and when the
// consent request went out, never the token hash. Deleting the payer keeps the child's entry and
// Piotr's, clears every pointer to the payer (guardian fields, registered_by, the order's name
// and address) and leaves the start list as it was. Deleting Piotr removes his consent request,
// which must go before any registration could be deleted (FK ON DELETE RESTRICT).
// LOCAL stack only; every event and address is random.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { localEnv, sessionFor } from './helpers/stack.js'
import { acceptAgreement, callFn, createPublishedFreeEvent, createPublishedPaidEvent } from './helpers/registrationFixtures.js'
import { attemptFor, confirmOk, consentIds, db, one, profileFor, rows, rpc, runnerEmail } from './helpers/orders.js'
import { BIEG, DZIECI, adult, groupMeta, minor, orderGroupOk, registerGroup } from './helpers/groups.js'
import { buildResultsSnapshot } from '../../public/src/lib/resultsSnapshot.js'

let owner
before(async () => {
  await acceptAgreement('zatyrani-test')
  owner = await sessionFor('owner@zatyrani-test.local')
})

const sha256 = (t) => crypto.createHash('sha256').update(t).digest('hex')

/**
 * A paid family order, confirmed, with Piotr's consent request issued (as settleConfirmOutcome
 * would). → { event, payer, payerEmail, piotr, piotrEmail, orderId, ids: { self, adult, minor }, tokenHash }
 */
async function paidFamily() {
  const event = await createPublishedPaidEvent(owner, {
    competitions: [BIEG(), DZIECI()], prices: { 'Bieg 9 km': 6000, 'Bieg dzieci 1 km': 2000 },
  })
  const [bieg, dzieci] = event.categoryIds
  const payerEmail = runnerEmail('family-payer')
  const piotrEmail = runnerEmail('family-piotr')
  const payer = await sessionFor(payerEmail)
  const order = await orderGroupOk(event, [
    adult(bieg, 'self', payerEmail, { firstName: 'Ola', lastName: 'Leśna', city: 'Leszno' }),
    adult(bieg, 'adult', piotrEmail, { firstName: 'Piotr', lastName: 'Borowy', gender: 'M', ageGroupLabel: 'M open' }),
    minor(dzieci, { firstName: 'Zosia', lastName: 'Leśna', city: 'Gierałtowice' }),
  ], { profileId: payer.profileId, meta: await groupMeta(event.eventId, { buyerName: 'Ola Leśna' }) })
  // create-order stores the typed name right after create_order (m-1); the RPC alone does not.
  const named = await db().from('orders').update({ buyer_name: 'Ola Leśna' }).eq('id', order.orderId)
  assert.ifError(named.error)
  const att = await attemptFor(order.orderId, order.total)
  const confirmed = await confirmOk(order.orderId, att.txn, order.total)
  assert.equal(confirmed.outcome, 'confirmed')

  const regs = await rows('registrations', { order_id: order.orderId })
  const ids = {
    self: regs.find((r) => r.email === payerEmail).id,
    adult: regs.find((r) => r.email === piotrEmail).id,
    minor: regs.find((r) => r.email === null).id,
  }
  const tokenHash = sha256(crypto.randomBytes(32).toString('base64url'))
  const issued = await db().rpc('issue_consent_request', { p_registration_id: ids.adult, p_token_hash: tokenHash })
  assert.equal(issued.data, true, issued.error?.message)
  return { event, payer, payerEmail, piotrEmail, orderId: order.orderId, ids, tokenHash }
}

async function deleteAccount(email, session) {
  const { error } = await db().from('auth_codes').insert({
    email, code_hash: sha256('123456'), purpose: 'delete_account', expires_at: new Date(Date.now() + 600000).toISOString(),
  })
  assert.ifError(error)
  const r = await callFn('delete-my-account', session, { action: 'confirm', code: '123456' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
}

const startList = async (eventId) => {
  const { data, error } = await db().rpc('start_list', { p_event_id: eventId })
  assert.ifError(error)
  return data
}

test('G-59 export-my-data: the payer gets the child as guardian and the order with the typed name, never Piotr; Piotr gets who provided his data and the consent request, never the token hash', async () => {
  const f = await paidFamily()

  const mine = await callFn('export-my-data', f.payer, {})
  assert.equal(mine.status, 200, JSON.stringify(mine.body))
  assert.deepEqual(mine.body.registrations.map((r) => r.id), [f.ids.self])
  assert.equal(mine.body.registrations[0].registered_by, null, 'the payer registered themself')
  assert.equal(mine.body.registrations[0].consent_request, null)
  assert.deepEqual(mine.body.registrations_as_guardian.map((r) => r.id), [f.ids.minor])
  assert.equal(mine.body.registrations_as_guardian[0].first_name, 'Zosia')
  assert.equal(mine.body.registrations_as_guardian[0].guardian_removed_at, null)
  const order = mine.body.orders.find((o) => o.id === f.orderId)
  assert.equal(order.buyer_name, 'Ola Leśna')
  // The order's lines name Piotr's entry by id only (the payer paid for it); nothing of his data.
  assert.ok(order.lines.some((l) => l.registration_id === f.ids.adult))
  const text = JSON.stringify({ ...mine.body, orders: mine.body.orders.map(({ lines: _l, ...o }) => o) })
  assert.ok(!text.includes(f.ids.adult), 'Piotr\'s entry is his data, not the payer\'s')
  const whole = JSON.stringify(mine.body)
  assert.ok(!whole.includes(f.piotrEmail))
  assert.ok(!whole.includes('Borowy'))
  assert.ok(!whole.includes('Piotr'))

  const piotr = await sessionFor(f.piotrEmail)
  const his = await callFn('export-my-data', piotr, {})
  assert.equal(his.status, 200, JSON.stringify(his.body))
  assert.equal(his.body.registrations.length, 1)
  const [reg] = his.body.registrations
  assert.equal(reg.id, f.ids.adult)
  assert.equal(reg.consent_state, 'awaiting')
  assert.deepEqual(reg.registered_by, { name: 'Ola Leśna' })
  assert.ok(reg.consent_request, 'the consent request is exported')
  assert.deepEqual(Object.keys(reg.consent_request).sort(),
    ['auto_reminded_at', 'emailed_at', 'expires_at', 'last_reminded_at', 'sent_at', 'used_at'])
  assert.ok(reg.consent_request.sent_at)
  assert.equal(reg.consent_request.used_at, null)
  const hisText = JSON.stringify(his.body)
  assert.ok(!hisText.includes(f.tokenHash), 'never the token hash')
  assert.ok(!hisText.includes('token_hash'))
  assert.ok(!hisText.includes(f.payer.profileId), 'never the payer\'s account id')
  assert.ok(!hisText.includes(f.payerEmail), 'never the payer\'s address')
  assert.deepEqual(his.body.registrations_as_guardian, [])
})

test('G-60 the payer deletes the account: the child and Piotr stay, every pointer to the payer goes, the start list is unchanged, the organizer sees „kontakt opiekuna usunięty” and „Usunięte konto” once', async () => {
  const f = await paidFamily()
  // Piotr accepts in the office, so the start list names him before and after.
  const office = await callFn('mark-consent-office', owner, { registrationId: f.ids.adult })
  assert.equal(office.status, 200, JSON.stringify(office.body))
  const before = await startList(f.event.eventId)
  const namesBefore = before.entries.map((e) => e.name).sort()
  assert.deepEqual(namesBefore, ['Ola Leśna', 'Piotr Borowy', 'Zosia Leśna'])

  await deleteAccount(f.payerEmail, f.payer)

  const kid = await one('registrations', { id: f.ids.minor })
  assert.equal(kid.first_name, 'Zosia')
  assert.equal(kid.last_name, 'Leśna')
  assert.equal(kid.guardian_email, null)
  assert.equal(kid.guardian_profile_id, null)
  assert.equal(kid.guardian_name, 'Usunięte konto')
  assert.ok(kid.guardian_removed_at, 'guardian_removed_at is stamped')
  assert.equal(kid.registered_by_profile_id, null)
  assert.equal(kid.status, 'confirmed')

  const piotr = await one('registrations', { id: f.ids.adult })
  assert.equal(piotr.registered_by_profile_id, null, 'nothing points at the deleted payer')
  assert.equal(piotr.first_name, 'Piotr')
  assert.equal(piotr.email, f.piotrEmail)
  assert.equal(piotr.consent_state, 'office')
  assert.equal((await rows('consent_requests', { registration_id: f.ids.adult })).length, 1, 'Piotr\'s request is his, it stays')

  const self = await one('registrations', { id: f.ids.self })
  assert.equal(self.first_name, 'Usunięte konto')
  assert.equal(self.registered_by_profile_id, null)

  const order = await one('orders', { id: f.orderId })
  assert.equal(order.buyer_name, null)
  assert.equal(order.buyer_email, null)
  assert.equal(order.status, 'paid')

  // The start list: the deleted payer was never listed by the pair; the child and Piotr stay.
  const after = await startList(f.event.eventId)
  assert.deepEqual(after.entries.map((e) => e.name).sort(), ['Piotr Borowy', 'Zosia Leśna'])
  assert.deepEqual(after.competitions, before.competitions, 'the counts are unchanged: the slot stays')
  const zosia = after.entries.find((e) => e.name === 'Zosia Leśna')
  assert.equal(zosia.town ?? null, null, 'no town under 18')

  const list = await callFn('list-event-registrations', owner, { eventId: f.event.eventId })
  assert.equal(list.status, 200, JSON.stringify(list.body))
  const row = (id) => list.body.data.find((x) => x.id === id)
  assert.equal(row(f.ids.minor).guardianRemoved, true)
  assert.equal(row(f.ids.minor).role, 'minor')
  assert.equal(row(f.ids.minor).guardianName, null)
  assert.equal(row(f.ids.adult).role, 'adult', 'still an added adult without registered_by')
  assert.equal(row(f.ids.adult).registeredBy, null)
  assert.equal(row(f.ids.self).name, 'Usunięte konto', 'the deleted payer reads once, not twice')
  assert.ok(!JSON.stringify(list.body).includes('Usunięte konto Usunięte konto'))
})

test('G-61 the added adult deletes the account: the consent request goes, the entry is anonymised and keeps its slot', async () => {
  const f = await paidFamily()
  const taken = (await one('competitions', { category_id: f.event.categoryIds[0] })).taken
  const piotr = await sessionFor(f.piotrEmail)
  await deleteAccount(f.piotrEmail, piotr)

  assert.deepEqual(await rows('consent_requests', { registration_id: f.ids.adult }), [], 'the consent request is deleted')
  const reg = await one('registrations', { id: f.ids.adult })
  assert.equal(reg.first_name, 'Usunięte konto')
  assert.equal(reg.email, null)
  assert.equal(reg.status, 'confirmed')
  assert.equal((await one('competitions', { category_id: f.event.categoryIds[0] })).taken, taken)
  // The payer's own rows are untouched.
  assert.equal((await one('registrations', { id: f.ids.minor })).guardian_profile_id, f.payer.profileId)
  assert.equal((await one('registrations', { id: f.ids.self })).first_name, 'Ola')
  // A reminder now finds nothing to send.
  const remind = await callFn('remind-consent', f.payer, { registrationId: f.ids.adult })
  assert.notEqual(remind.status, 200, JSON.stringify(remind.body))
})

// ---------------------------------------------------------------- final review I-1, I-2, M-3

const anon = () => {
  const { url, anonKey } = localEnv()
  return createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
}

/** A free group: the payer (self) and the given added adults and children. → { event, payer, payerEmail, regs } */
async function freeGroup(extra, { self = true, buyerName = 'Ola Leśna' } = {}) {
  const event = await createPublishedFreeEvent(owner, { competitions: [BIEG(), DZIECI()] })
  const [bieg, dzieci] = event.categoryIds
  const payerEmail = runnerEmail('free-payer')
  const payer = await sessionFor(payerEmail)
  const people = [
    ...(self ? [adult(bieg, 'self', payerEmail, { firstName: 'Ola', lastName: 'Leśna' })] : []),
    ...extra({ bieg, dzieci }),
  ]
  const r = await registerGroup(event, people, { profileId: payer.profileId, meta: await groupMeta(event.eventId, { buyerName }) })
  assert.equal(r.error, null, r.error?.message)
  return { event, payer, payerEmail, regs: r.data.registrations }
}

test('G-64 an added adult awaiting consent is not in participants_public (read as anon) nor in the results snapshot; accepted or signed in the office, they are (final review I-1)', async () => {
  const anna = runnerEmail('anna')
  const piotr = runnerEmail('piotr')
  const f = await freeGroup(({ bieg }) => [
    adult(bieg, 'adult', anna, { firstName: 'Anna', lastName: 'Wrzosowa' }),
    adult(bieg, 'adult', piotr, { firstName: 'Piotr', lastName: 'Borowy', gender: 'M', ageGroupLabel: 'M open' }),
  ])
  const byEmail = async (email) => one('registrations', { email })
  const annaReg = await byEmail(anna)
  const piotrReg = await byEmail(piotr)
  const selfReg = await byEmail(f.payerEmail)
  assert.ok(annaReg.participant_id && piotrReg.participant_id, 'the participant rows exist (the timing host needs them)')
  assert.equal((await one('participants', { id: piotrReg.participant_id })).first_name, 'Piotr')
  // The registration categories are timed, so the results page would show them.
  await db().from('categories').update({ untimed: false }).in('id', f.event.categoryIds)

  const publicIds = async () => {
    const { data, error } = await anon().from('participants_public').select('id, first_name')
      .in('category_id', f.event.categoryIds)
    assert.equal(error, null, error?.message)
    return data.map((p) => p.id).sort()
  }
  const snapshotNames = async () => {
    const snap = await buildResultsSnapshot(anon(), f.event.eventId)
    return snap.participants.map((p) => p.first_name).sort()
  }

  assert.deepEqual(await publicIds(), [selfReg.participant_id].sort(), 'before acceptance: only the payer')
  assert.deepEqual(await snapshotNames(), ['Ola'])

  // Anna accepts through her link.
  const { newToken } = await import('../../supabase/functions/_shared/registration/tokens.js')
  const t = await newToken()
  assert.equal((await rpc('issue_consent_request', { p_registration_id: annaReg.id, p_token_hash: t.hash })).data, true)
  const accepted = await rpc('accept_consent_request', {
    p_token_hash: t.hash, p_profile_id: await profileFor(anna), p_edits: null,
    p_meta: { consentIds: await consentIds(f.event.eventId), ip: '198.51.100.7', userAgent: 'g64' },
  })
  assert.equal(accepted.error, null, accepted.error?.message)
  assert.deepEqual(await publicIds(), [selfReg.participant_id, annaReg.participant_id].sort())
  assert.deepEqual(await snapshotNames(), ['Anna', 'Ola'])

  // Piotr signs in the office.
  const office = await callFn('mark-consent-office', owner, { registrationId: piotrReg.id })
  assert.equal(office.status, 200, JSON.stringify(office.body))
  assert.deepEqual(await publicIds(), [selfReg.participant_id, annaReg.participant_id, piotrReg.participant_id].sort())
  assert.deepEqual(await snapshotNames(), ['Anna', 'Ola', 'Piotr'])
})

test('G-65 export-my-data on a free group: an added adult\'s registered_by names the payer by their own entry, or by the guardian name the children carry (final review I-2)', async () => {
  const piotr = runnerEmail('free-piotr')
  await freeGroup(({ bieg }) => [adult(bieg, 'adult', piotr, { firstName: 'Piotr', lastName: 'Borowy', gender: 'M', ageGroupLabel: 'M open' })])
  const his = await callFn('export-my-data', await sessionFor(piotr), {})
  assert.equal(his.status, 200, JSON.stringify(his.body))
  assert.deepEqual(his.body.registrations.map((r) => r.registered_by), [{ name: 'Ola Leśna' }])

  // „Nie startuję”: the payer has no entry; the name they typed is on the child's guardian fields.
  const marta = runnerEmail('free-marta')
  await freeGroup(({ bieg, dzieci }) => [
    adult(bieg, 'adult', marta, { firstName: 'Marta', lastName: 'Borowa' }),
    minor(dzieci, { firstName: 'Zosia', lastName: 'Kowalska' }),
  ], { self: false, buyerName: 'Jan Kowalski' })
  const hers = await callFn('export-my-data', await sessionFor(marta), {})
  assert.equal(hers.status, 200, JSON.stringify(hers.body))
  assert.deepEqual(hers.body.registrations.map((r) => r.registered_by), [{ name: 'Jan Kowalski' }])
})

test('G-66 a guardian deletes the account: the child\'s phone goes when it is the guardian\'s own, a phone typed for the child stays (final review M-3)', async () => {
  const f = await freeGroup(({ dzieci }) => [
    minor(dzieci, { firstName: 'Zosia', lastName: 'Leśna', phone: '+48500100200' }),
    minor(dzieci, { firstName: 'Kuba', lastName: 'Leśny', birthDate: '2015-02-02', gender: 'M', ageGroupLabel: 'M dzieci', phone: '+48511222333' }),
  ])
  const kids = (await rows('registrations', { event_id: f.event.eventId })).filter((r) => r.guardian_profile_id)
  const zosia = kids.find((r) => r.first_name === 'Zosia')
  const kuba = kids.find((r) => r.first_name === 'Kuba')
  assert.equal(zosia.phone, '+48500100200', 'prefilled from the payer (D4-26)')
  assert.equal((await one('participants', { id: zosia.participant_id })).phone, '+48500100200')

  await deleteAccount(f.payerEmail, f.payer)

  const z = await one('registrations', { id: zosia.id })
  assert.equal(z.phone, null, 'the deleted guardian\'s number is gone from the child')
  assert.equal(z.first_name, 'Zosia', 'the entry stays')
  assert.equal((await one('participants', { id: zosia.participant_id })).phone, null)
  const k = await one('registrations', { id: kuba.id })
  assert.equal(k.phone, '+48511222333', 'a number typed for the child is the child\'s')
  assert.equal((await one('participants', { id: kuba.participant_id })).phone, '+48511222333')
})
