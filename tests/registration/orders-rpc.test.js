// Plan 3, task 4: the order RPCs (create_order, add_payment_attempt,
// confirm_order, expire_orders, cancel_order, record_refund, settle_refund,
// insert_registration_participant, registration_slot_units). Scenario ids
// P-13b…P-18 in docs/registration/scenario-matrix.md (P-13 is redactDpay).
// LOCAL stack only; every event and address is random, so reruns pass.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { sessionFor } from './helpers/stack.js'
import { acceptAgreement, createPublishedFreeEvent, createPublishedPaidEvent } from './helpers/registrationFixtures.js'
import {
  attemptFor, competitionOf, confirm, confirmOk, consentIds, createOrder, db, expireNow, minutesFromNow,
  newTxn, one, orderOf, orderOk, person, registrationsOf, rows, rpc, runnerEmail, setSettings, totalFor,
} from './helpers/orders.js'

let owner
before(async () => {
  await acceptAgreement('zatyrani-test')
  owner = await sessionFor('owner@zatyrani-test.local')
})

const paid = (opts = {}) => createPublishedPaidEvent(owner, { prices: { 'Bieg 9 km': 6000 }, ...opts })
const BIEG = (capacity) => [{ name: 'Bieg 9 km', discipline: 'run', distanceLabel: '9 km', startTime: '10:00', capacity }]

async function participantsOf(registrationId) {
  return rows('participants', { registration_id: registrationId })
}

async function alertsFor(orderId, kind) {
  const { data, error } = await db().from('operator_alerts').select('*').eq('order_id', orderId).eq('kind', kind)
  if (error) throw error
  return data
}

// ---------------------------------------------------------------- P-13b

test('P-13b happy path: amounts frozen, slot claimed, one line, pending registration; confirm inserts the participant once', async () => {
  const event = await paid({ paymentWindowHours: 24 })
  const cat = event.categoryIds[0]
  const email = runnerEmail('happy')
  const before = Date.now()
  const out = await orderOk(event, { people: [person(email, { nationality: 'DE' })], support: false })

  assert.equal(out.status, 'pending')
  assert.equal(out.total, 6055)
  assert.deepEqual(out.amounts, { entryTotal: 6000, extrasTotal: 0, donation: 0, supportFee: 0, paymentFee: 55, total: 6055 })
  const exp = Date.parse(out.expiresAt)
  assert.ok(Math.abs(exp - (before + 24 * 3600e3)) < 120e3, `expiresAt ${out.expiresAt}`)

  const order = await orderOf(out.orderId)
  assert.equal(order.status, 'pending')
  assert.equal(order.buyer_email, email)
  assert.equal(order.support_choice, false)
  assert.equal(order.entry_total, 6000)
  assert.equal(order.payment_fee, 55)
  assert.equal(order.total, 6055)
  assert.equal(order.tier_id, event.tierId)
  assert.equal((await competitionOf(cat)).taken, 1)

  const lines = await rows('order_lines', { order_id: out.orderId })
  assert.equal(lines.length, 1)
  assert.equal(lines[0].kind, 'entry')
  assert.equal(lines[0].amount, 6000)
  assert.ok(lines[0].tier_label, 'tier label snapshot')
  assert.equal(lines[0].tier_ends_on, null)

  const [reg] = await registrationsOf(out.orderId)
  assert.equal(lines[0].registration_id, reg.id)
  assert.equal(reg.status, 'pending_payment')
  assert.equal(reg.price, 6000)
  assert.equal(reg.list_price, 6000)
  assert.equal(reg.nationality, 'DE')
  assert.equal(reg.participant_id, null)
  assert.equal((await participantsOf(reg.id)).length, 0)
  const acc = await rows('consent_acceptances', { registration_id: reg.id })
  assert.equal(acc.length, (await consentIds(event.eventId)).length + 1)
  assert.ok(acc.some((a) => a.consent_kind === 'service_regulamin'))

  const att = await attemptFor(out.orderId, 6055)
  const first = await confirmOk(out.orderId, att.txn, 6055)
  assert.equal(first.outcome, 'confirmed')

  const paidOrder = await orderOf(out.orderId)
  assert.equal(paidOrder.status, 'paid')
  assert.ok(paidOrder.paid_at)
  assert.equal(paidOrder.paid_transaction_id, att.txn)
  const regAfter = await one('registrations', { id: reg.id })
  assert.equal(regAfter.status, 'confirmed')
  const parts = await participantsOf(reg.id)
  assert.equal(parts.length, 1)
  assert.equal(regAfter.participant_id, parts[0].id)
  assert.equal(parts[0].email, email)
  assert.equal(parts[0].category_id, cat)
  assert.equal((await one('payment_attempts', { id: att.id })).status, 'paid')

  const again = await confirmOk(out.orderId, att.txn, 6055)
  assert.equal(again.outcome, 'already_confirmed')
  assert.equal((await participantsOf(reg.id)).length, 1)
  assert.equal((await competitionOf(cat)).taken, 1)
})

test('P-13b the registration gets the buyer account only when its address is the person\'s', async () => {
  const event = await paid()
  const self = runnerEmail('self')
  const buyer = await sessionFor(self)
  const out = await orderOk(event, { people: [person(self)], profileId: buyer.profileId, buyerEmail: self })
  assert.equal((await registrationsOf(out.orderId))[0].profile_id, buyer.profileId)
  assert.equal((await orderOf(out.orderId)).buyer_profile_id, buyer.profileId)

  const other = await orderOk(event, { people: [person(runnerEmail('friend'))], profileId: buyer.profileId, buyerEmail: self })
  assert.equal((await registrationsOf(other.orderId))[0].profile_id, null)
  assert.equal((await orderOf(other.orderId)).buyer_email, self)
})

test('P-13b two people in one order: amounts for both, two lines, one claim of two slots', async () => {
  const event = await paid()
  const out = await orderOk(event, { emails: [runnerEmail('a'), runnerEmail('b')], support: true })
  // entry 12000, support 240, fee ceil(12240*9/991) = 112
  assert.equal(out.total, 12352)
  assert.equal(out.amounts.supportFee, 240)
  assert.equal((await rows('order_lines', { order_id: out.orderId })).length, 2)
  assert.equal((await competitionOf(event.categoryIds[0])).taken, 2)
})

// ---------------------------------------------------------------- P-14

test('P-14 late payment, capacity left: expire releases, confirm re-claims → late_confirmed', async () => {
  const event = await paid({ competitions: BIEG(2) })
  const cat = event.categoryIds[0]
  const out = await orderOk(event)
  const att = await attemptFor(out.orderId, out.total)
  await expireNow(out.orderId)
  assert.equal((await orderOf(out.orderId)).status, 'expired')
  assert.equal((await registrationsOf(out.orderId))[0].status, 'expired')
  assert.equal((await competitionOf(cat)).taken, 0)

  const r = await confirmOk(out.orderId, att.txn, out.total)
  assert.equal(r.outcome, 'late_confirmed')
  const order = await orderOf(out.orderId)
  assert.equal(order.status, 'paid')
  assert.equal(order.paid_transaction_id, att.txn)
  const [reg] = await registrationsOf(out.orderId)
  assert.equal(reg.status, 'confirmed')
  assert.equal((await participantsOf(reg.id)).length, 1)
  assert.equal((await competitionOf(cat)).taken, 1)
})

test('P-14 late payment into a full competition → late_refund full, taken unchanged, refund recorded and alerted', async () => {
  const event = await paid({ competitions: BIEG(2) })
  const cat = event.categoryIds[0]
  const out = await orderOk(event)
  const att = await attemptFor(out.orderId, out.total)
  await expireNow(out.orderId)
  await orderOk(event)
  await orderOk(event)
  assert.equal((await competitionOf(cat)).taken, 2)

  const r = await confirmOk(out.orderId, att.txn, out.total)
  assert.equal(r.outcome, 'late_refund')
  assert.deepEqual({ attemptId: r.refund.attemptId, grosze: r.refund.grosze, reason: r.refund.reason },
    { attemptId: att.id, grosze: out.total, reason: 'full' })
  assert.match(r.refund.messageId, /^[0-9a-f]{24}$/)
  assert.equal((await competitionOf(cat)).taken, 2)
  assert.equal((await orderOf(out.orderId)).status, 'expired')
  assert.equal((await registrationsOf(out.orderId))[0].status, 'expired')
  const refunds = await rows('refunds', { payment_attempt_id: att.id })
  assert.equal(refunds.length, 1)
  assert.equal(refunds[0].id, r.refund.refundId)
  assert.equal(refunds[0].kind, 'automatic')
  assert.equal(refunds[0].amount, out.total)
  assert.equal(refunds[0].reason, 'full')
  assert.equal(refunds[0].dpay_status, 'pending')
  assert.equal((await alertsFor(out.orderId, 'late_refund')).length, 1)
  assert.equal((await one('payment_attempts', { id: att.id })).status, 'paid')
})

test('P-14 late payment after the same address registered again → late_refund duplicate, the claim released', async () => {
  const event = await paid({ competitions: BIEG(10) })
  const cat = event.categoryIds[0]
  const email = runnerEmail('dup')
  const out = await orderOk(event, { emails: [email] })
  const att = await attemptFor(out.orderId, out.total)
  await expireNow(out.orderId)
  await orderOk(event, { emails: [email] })
  assert.equal((await competitionOf(cat)).taken, 1)

  const r = await confirmOk(out.orderId, att.txn, out.total)
  assert.equal(r.outcome, 'late_refund')
  assert.equal(r.refund.reason, 'duplicate')
  assert.equal((await competitionOf(cat)).taken, 1)
  assert.equal((await orderOf(out.orderId)).status, 'expired')
  assert.equal((await registrationsOf(out.orderId))[0].status, 'expired')
})

// ---------------------------------------------------------------- P-15

test('P-15 a total-0 order is paid at once: registration confirmed, participant inserted, no attempt', async () => {
  const event = await paid({ prices: { 'Bieg 9 km': 0 } })
  const out = await orderOk(event, { support: null, displayed: 0 })
  assert.equal(out.status, 'paid')
  assert.equal(out.total, 0)
  const order = await orderOf(out.orderId)
  assert.equal(order.status, 'paid')
  assert.ok(order.paid_at)
  assert.equal(order.paid_transaction_id, null)
  const [reg] = await registrationsOf(out.orderId)
  assert.equal(reg.status, 'confirmed')
  assert.equal((await participantsOf(reg.id)).length, 1)
  assert.equal((await rows('payment_attempts', { order_id: out.orderId })).length, 0)
  assert.equal((await competitionOf(event.categoryIds[0])).taken, 1)
  const att = await rpc('add_payment_attempt', { p_order_id: out.orderId, p_txn: newTxn(), p_grosze: 100 })
  assert.equal(att.error?.message, 'not_payable')
})

// ---------------------------------------------------------------- P-16

test('P-16 price_changed carries the server total; nothing is claimed', async () => {
  const event = await paid()
  const r = await createOrder(event, { support: true, displayed: 6000 })
  assert.equal(r.error?.message, 'price_changed:6176')
  assert.equal((await competitionOf(event.categoryIds[0])).taken, 0)
  const ok = await createOrder(event, { support: true, displayed: 6176 })
  assert.equal(ok.error, null, ok.error?.message)
})

test('P-16 paid orders stop one hour before closes_at; expires_at never past closes_at', async () => {
  const event = await paid({ paymentWindowHours: 24 })
  await setSettings(event.eventId, { closes_at: minutesFromNow(59) })
  assert.equal((await createOrder(event)).error?.message, 'paying_closed')
  const closes = minutesFromNow(180)
  await setSettings(event.eventId, { closes_at: closes })
  const out = await orderOk(event)
  assert.equal(Date.parse(out.expiresAt), Date.parse(closes))
})

test('P-16 at most two pending orders per account and event (and per buyer address for a guest)', async () => {
  const event = await paid()
  const buyer = await sessionFor(runnerEmail('buyer'))
  const opts = () => ({ profileId: buyer.profileId, buyerEmail: 'kupujacy@test.local' })
  await orderOk(event, opts())
  await orderOk(event, opts())
  assert.equal((await createOrder(event, opts())).error?.message, 'too_many_pending')

  const guest = runnerEmail('guest')
  await orderOk(event, { buyerEmail: guest })
  await orderOk(event, { buyerEmail: guest })
  assert.equal((await createOrder(event, { buyerEmail: guest.toUpperCase() })).error?.message, 'too_many_pending')
  assert.equal((await competitionOf(event.categoryIds[0])).taken, 4)

  // A paid order no longer counts.
  const g2 = runnerEmail('guest2')
  const a = await orderOk(event, { buyerEmail: g2 })
  await orderOk(event, { buyerEmail: g2 })
  const att = await attemptFor(a.orderId, a.total)
  await confirmOk(a.orderId, att.txn, a.total)
  assert.equal((await createOrder(event, { buyerEmail: g2 })).error, null)
})

test('P-16 two concurrent creates as the second and third pending order: exactly one succeeds', async () => {
  for (let round = 0; round < 5; round++) {
    const event = await paid()
    const buyer = await sessionFor(runnerEmail('conc'))
    const opts = { profileId: buyer.profileId, buyerEmail: 'kupujacy@test.local' }
    await orderOk(event, opts)
    const [a, b] = await Promise.all([createOrder(event, opts), createOrder(event, opts)])
    const errors = [a, b].map((x) => x.error?.message ?? null)
    assert.deepEqual(errors.filter(Boolean), ['too_many_pending'], JSON.stringify(errors))
    assert.equal((await competitionOf(event.categoryIds[0])).taken, 2)
  }
})

test('P-16 refusals reuse register_free\'s codes', async () => {
  const event = await paid()
  const cat = event.categoryIds[0]
  const ids = await consentIds(event.eventId)
  const { data: image } = await db().from('event_consents').select('id').eq('event_id', event.eventId).eq('kind', 'image').single()

  assert.equal((await createOrder(event, { people: [] })).error?.message, 'invalid_people')
  assert.equal((await createOrder(event, { categoryId: crypto.randomUUID() })).error?.message, 'not_found')
  assert.equal((await createOrder(event, { consents: ids.filter((x) => x !== image.id) })).error?.message, 'consents_changed')
  assert.equal((await createOrder(event, { support: null })).error?.message, 'support_choice_required')
  assert.equal((await createOrder(event, { buyerEmail: '  ' })).error?.message, 'invalid_buyer_email')

  const email = runnerEmail('twice')
  await orderOk(event, { emails: [email] })
  assert.equal((await createOrder(event, { emails: [email.toUpperCase()] })).error?.message, 'duplicate')

  await setSettings(event.eventId, { opens_at: minutesFromNow(60) })
  assert.equal((await createOrder(event)).error?.message, 'not_open')
  await setSettings(event.eventId, { opens_at: minutesFromNow(-60), closes_at: minutesFromNow(-1) })
  assert.equal((await createOrder(event)).error?.message, 'closed')
  await setSettings(event.eventId, { closes_at: minutesFromNow(600) })
  await db().from('competitions').update({ hidden_at: new Date().toISOString() }).eq('category_id', cat)
  assert.equal((await createOrder(event)).error?.message, 'closed')

  const free = await createPublishedFreeEvent(owner)
  assert.equal((await createOrder({ ...free, prices: {} })).error?.message, 'free_event')

  const full = await paid({ competitions: BIEG(1) })
  await orderOk(full)
  assert.equal((await createOrder(full)).error?.message, 'full')
})

test('P-16 create_order and the other order RPCs are callable by service_role only', async () => {
  const { localEnv } = await import('./helpers/stack.js')
  const postgres = (await import('postgres')).default
  const sql = postgres(localEnv().dbUrl, { max: 1, onnotice: () => {} })
  try {
    const fns = await sql`
      select p.oid::regprocedure::text as sig, p.prosecdef, p.proconfig,
             has_function_privilege('anon', p.oid, 'execute') as anon,
             has_function_privilege('authenticated', p.oid, 'execute') as authd,
             has_function_privilege('service_role', p.oid, 'execute') as svc
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname in ('create_order', 'add_payment_attempt', 'confirm_order',
         'expire_orders', 'cancel_order', 'record_refund', 'settle_refund', 'insert_registration_participant',
         'registration_slot_units', 'register_free')`
    assert.equal(fns.length, 10, fns.map((f) => f.sig).join())
    for (const f of fns) {
      assert.equal(f.prosecdef, true, `${f.sig} security definer`)
      assert.deepEqual(f.proconfig, ['search_path=""'], `${f.sig} search_path`)
      assert.equal(f.anon, false, `${f.sig} anon`)
      assert.equal(f.authd, false, `${f.sig} authenticated`)
      assert.equal(f.svc, true, `${f.sig} service_role`)
    }
  } finally {
    await sql.end()
  }
})

test('P-16 the total is capped at the dpay limit and support_fee follows support_choice', async () => {
  const event = await paid()
  const base = {
    event_id: event.eventId, buyer_email: 'x@test.local', entry_total: 6000, extras_total: 0, donation: 0,
    expires_at: minutesFromNow(60),
  }
  const cap = await db().from('orders').insert({ ...base, entry_total: 99999990, support_choice: false, support_fee: 0, payment_fee: 20, total: 100000010 })
  assert.equal(cap.error?.code, '23514', JSON.stringify(cap.error))
  assert.match(cap.error.message, /orders_total_cap_check/)
  const tie = await db().from('orders').insert({ ...base, support_choice: false, support_fee: 120, payment_fee: 56, total: 6176 })
  assert.equal(tie.error?.code, '23514')
  assert.match(tie.error.message, /orders_support_fee_choice_check/)
})

// ---------------------------------------------------------------- P-17

test('P-17 an amount mismatch confirms nothing and raises one alert', async () => {
  const event = await paid()
  const out = await orderOk(event)
  const att = await attemptFor(out.orderId, out.total)
  const r = await confirmOk(out.orderId, att.txn, out.total - 1)
  assert.equal(r.outcome, 'amount_mismatch')
  assert.equal((await orderOf(out.orderId)).status, 'pending')
  assert.equal((await one('payment_attempts', { id: att.id })).status, 'created')
  const [reg] = await registrationsOf(out.orderId)
  assert.equal(reg.status, 'pending_payment')
  assert.equal((await participantsOf(reg.id)).length, 0)
  const alerts = await alertsFor(out.orderId, 'amount_mismatch')
  assert.equal(alerts.length, 1)
  assert.equal(alerts[0].payload.grosze, out.total - 1)
  assert.equal((await rows('refunds', { order_id: out.orderId })).length, 0)

  // A mismatched attempt cannot be registered either.
  const bad = await rpc('add_payment_attempt', { p_order_id: out.orderId, p_txn: newTxn(), p_grosze: out.total + 1 })
  assert.equal(bad.error?.message, 'amount_mismatch')
})

// ---------------------------------------------------------------- P-18

test('P-18 a confirm after closes_at (inside the grace) still inserts the participant; the bridge never updates one', async () => {
  const event = await paid()
  const out = await orderOk(event)
  const att = await attemptFor(out.orderId, out.total)
  await db().from('payment_attempts').update({ created_at: minutesFromNow(-10) }).eq('id', att.id)
  await setSettings(event.eventId, { closes_at: minutesFromNow(-2) })

  const r = await confirmOk(out.orderId, att.txn, out.total)
  assert.equal(r.outcome, 'confirmed')
  const [reg] = await registrationsOf(out.orderId)
  const [part] = await participantsOf(reg.id)
  assert.ok(part)

  await db().from('registrations').update({ first_name: 'Zmieniona' }).eq('id', reg.id)
  const again = await rpc('insert_registration_participant', { p_registration_id: reg.id })
  assert.equal(again.error, null, again.error?.message)
  assert.equal(again.data, part.id)
  const after = await one('participants', { id: part.id })
  assert.equal(after.first_name, part.first_name)
  assert.equal(after.updated_at, part.updated_at)
  assert.equal((await participantsOf(reg.id)).length, 1)
})

test('P-18 the bridge refuses a registration that is not confirmed', async () => {
  const event = await paid()
  const out = await orderOk(event)
  const [reg] = await registrationsOf(out.orderId)
  const r = await rpc('insert_registration_participant', { p_registration_id: reg.id })
  assert.equal(r.error?.message, 'not_confirmed')
})

test('P-18 register_free goes through the bridge: one participant per registration, nationality never copied', async () => {
  const free = await createPublishedFreeEvent(owner)
  const email = runnerEmail('free')
  const r = await rpc('register_free', {
    p_category_id: free.categoryIds[0], p_people: [person(email, { nationality: 'CZ' })], p_profile_id: null,
    p_meta: { consentIds: await consentIds(free.eventId), ip: null, userAgent: 'test' },
  })
  assert.equal(r.error, null, r.error?.message)
  const reg = await one('registrations', { id: r.data.registrations[0].id })
  assert.equal(reg.nationality, 'CZ')
  const parts = await participantsOf(reg.id)
  assert.equal(parts.length, 1)
  assert.equal(parts[0].id, reg.participant_id)
  assert.equal(parts[0].id, r.data.registrations[0].participantId)
  assert.ok(!('nationality' in parts[0]) || parts[0].nationality == null)
})

// ---------------------------------------------------------------- cancel, refunds

test('cancel_order releases a pending order once; a later payment is refunded', async () => {
  const event = await paid()
  const cat = event.categoryIds[0]
  const out = await orderOk(event)
  const att = await attemptFor(out.orderId, out.total)
  const c1 = await rpc('cancel_order', { p_order_id: out.orderId, p_reason: 'runner' })
  assert.equal(c1.data, true)
  const c2 = await rpc('cancel_order', { p_order_id: out.orderId, p_reason: 'runner' })
  assert.equal(c2.data, false)
  assert.equal((await competitionOf(cat)).taken, 0)
  assert.equal((await orderOf(out.orderId)).status, 'cancelled')
  assert.equal((await orderOf(out.orderId)).cancelled_reason, 'runner')
  assert.equal((await registrationsOf(out.orderId))[0].status, 'cancelled')

  const r = await confirmOk(out.orderId, att.txn, out.total)
  assert.equal(r.outcome, 'late_refund')
  assert.equal(r.refund.reason, 'cancelled')
  assert.equal((await competitionOf(cat)).taken, 0)
})

test('record_refund / settle_refund: message id from the refund id; accepted marks the attempt refunded; 406 retries in an hour', async () => {
  const event = await paid()
  const out = await orderOk(event)
  const att = await attemptFor(out.orderId, out.total)
  await confirmOk(out.orderId, att.txn, out.total)

  const r = await rpc('record_refund', { p_attempt_id: att.id, p_grosze: 1000, p_kind: 'organizer', p_reason: 'rezygnacja' })
  assert.equal(r.error, null, r.error?.message)
  assert.equal(r.data.messageId, r.data.refundId.replaceAll('-', '').slice(0, 24))
  const s1 = await rpc('settle_refund', { p_refund_id: r.data.refundId, p_outcome: 'insufficient_balance' })
  assert.equal(s1.error, null, s1.error?.message)
  const pendingRetry = await one('refunds', { id: r.data.refundId })
  assert.equal(pendingRetry.dpay_status, 'insufficient_balance')
  assert.ok(Math.abs(Date.parse(pendingRetry.next_retry_at) - (Date.now() + 3600e3)) < 120e3)
  assert.equal(pendingRetry.attempts, 1)

  await rpc('settle_refund', { p_refund_id: r.data.refundId, p_outcome: 'accepted' })
  const done = await one('refunds', { id: r.data.refundId })
  assert.equal(done.dpay_status, 'accepted')
  assert.equal(done.next_retry_at, null)
  assert.equal((await one('payment_attempts', { id: att.id })).status, 'refunded')

  const bad = await rpc('settle_refund', { p_refund_id: r.data.refundId, p_outcome: 'maybe' })
  assert.equal(bad.error?.message, 'invalid_outcome')
  const zero = await rpc('record_refund', { p_attempt_id: att.id, p_grosze: 0, p_kind: 'organizer', p_reason: 'x' })
  assert.equal(zero.error?.message, 'invalid_amount')
})

test('add_payment_attempt only for a pending order before expires_at', async () => {
  const event = await paid()
  const out = await orderOk(event)
  await db().from('orders').update({ expires_at: minutesFromNow(-1) }).eq('id', out.orderId)
  const r = await rpc('add_payment_attempt', { p_order_id: out.orderId, p_txn: newTxn(), p_grosze: out.total })
  assert.equal(r.error?.message, 'not_payable')
  const missing = await rpc('add_payment_attempt', { p_order_id: crypto.randomUUID(), p_txn: newTxn(), p_grosze: 100 })
  assert.equal(missing.error?.message, 'not_payable')
  assert.equal(totalFor(6000), 6055)
})

test('confirm on an unknown order id → unknown_attempt and an alert without an order', async () => {
  const txn = newTxn()
  const r = await confirm(crypto.randomUUID(), txn, 6055)
  assert.equal(r.error, null, r.error?.message)
  assert.equal(r.data.outcome, 'unknown_attempt')
  const { data } = await db().from('operator_alerts').select('*').eq('kind', 'unknown_attempt').is('order_id', null)
  assert.ok(data.some((a) => a.payload?.txn === txn))
})
