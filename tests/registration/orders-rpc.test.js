// Plan 3, task 4: the order RPCs (create_order, add_payment_attempt,
// confirm_order, expire_orders, cancel_order, record_refund, settle_refund,
// insert_registration_participant, registration_slot_units). Scenario ids
// P-13b…P-18 in docs/registration/scenario-matrix.md (P-13 is redactDpay),
// and P-53 / P-54: orders in export-my-data and delete-my-account (task 11).
// LOCAL stack only; every event and address is random, so reruns pass.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { sessionFor } from './helpers/stack.js'
import { acceptAgreement, callFn, createPublishedFreeEvent, createPublishedPaidEvent } from './helpers/registrationFixtures.js'
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

test('P-14 late payment into a competition hidden meanwhile → late_refund unavailable, nothing claimed (P3-R5)', async () => {
  const event = await paid({ competitions: BIEG(10) })
  const cat = event.categoryIds[0]
  const out = await orderOk(event)
  const att = await attemptFor(out.orderId, out.total)
  await expireNow(out.orderId)
  assert.equal((await competitionOf(cat)).taken, 0)
  await db().from('competitions').update({ hidden_at: new Date().toISOString() }).eq('category_id', cat)

  const r = await confirmOk(out.orderId, att.txn, out.total)
  assert.equal(r.outcome, 'late_refund')
  assert.equal(r.refund.reason, 'unavailable')
  assert.equal(r.refund.grosze, out.total)
  assert.equal((await competitionOf(cat)).taken, 0)
  assert.equal((await orderOf(out.orderId)).status, 'expired')
  assert.equal((await registrationsOf(out.orderId))[0].status, 'expired')
  assert.equal((await rows('refunds', { payment_attempt_id: att.id })).length, 1)
  assert.equal((await alertsFor(out.orderId, 'late_refund')).length, 1)
})

test('P-14 late payment after the event stopped being published → late_refund unavailable, nothing claimed (P3-R5)', async () => {
  const event = await paid({ competitions: BIEG(10) })
  const cat = event.categoryIds[0]
  const out = await orderOk(event)
  const att = await attemptFor(out.orderId, out.total)
  await expireNow(out.orderId)
  const { data: st } = await db().from('registration_settings').select('state').eq('event_id', event.eventId).single()
  const { error } = await db().from('registration_settings').update({ state: 'closed' }).eq('event_id', event.eventId)
  assert.equal(error, null, error?.message)
  try {
    const r = await confirmOk(out.orderId, att.txn, out.total)
    assert.equal(r.outcome, 'late_refund')
    assert.equal(r.refund.reason, 'unavailable')
    assert.equal((await competitionOf(cat)).taken, 0)
    assert.equal((await registrationsOf(out.orderId))[0].status, 'expired')
  } finally {
    await db().from('registration_settings').update({ state: st.state }).eq('event_id', event.eventId)
  }
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

test('P-16 an order needs an account; the buyer address is the account\'s; at most two payable orders per account and event', async () => {
  const event = await paid()
  const email = runnerEmail('buyer')
  const buyer = await sessionFor(email)
  const opts = () => ({ profileId: buyer.profileId, buyerEmail: email, emails: [runnerEmail('kid')] })

  assert.equal((await createOrder(event, { profileId: null })).error?.message, 'session_required')
  assert.equal((await createOrder(event, { profileId: crypto.randomUUID() })).error?.message, 'session_required')
  assert.equal((await createOrder(event, { ...opts(), sendBuyerEmail: 'ktos-inny@test.local' })).error?.message, 'invalid_buyer_email')

  // p_buyer_email may be omitted or differ in case only; the stored address is the account's.
  const first = await orderOk(event, { ...opts(), sendBuyerEmail: null })
  assert.equal((await orderOf(first.orderId)).buyer_email, email)
  assert.equal((await orderOf(first.orderId)).buyer_profile_id, buyer.profileId)
  await orderOk(event, { ...opts(), sendBuyerEmail: email.toUpperCase() })
  assert.equal((await createOrder(event, opts())).error?.message, 'too_many_pending')
  assert.equal((await competitionOf(event.categoryIds[0])).taken, 2)

  // An overdue order the job has not swept yet no longer counts (M4).
  await db().from('orders').update({ expires_at: minutesFromNow(-1) }).eq('id', first.orderId)
  const third = await orderOk(event, opts())

  // A paid order no longer counts.
  const att = await attemptFor(third.orderId, third.total)
  await confirmOk(third.orderId, att.txn, third.total)
  assert.equal((await createOrder(event, opts())).error, null)
})

test('P-16 two concurrent creates in two competitions as the second and third pending order: exactly one succeeds', async () => {
  // Different competitions, so no competition lock orders them: only the
  // per-account advisory lock makes the count and the insert one step.
  for (let round = 0; round < 10; round++) {
    const event = await createPublishedPaidEvent(owner, {
      prices: { 'Bieg 9 km': 6000, 'Marsz 5 km': 4000 },
      competitions: [...BIEG(50), { name: 'Marsz 5 km', discipline: 'nw', distanceLabel: '5 km', startTime: '10:05', capacity: 50 }],
    })
    const [c1, c2] = event.categoryIds
    const email = runnerEmail('conc')
    const buyer = await sessionFor(email)
    const opts = (categoryId) => ({ categoryId, profileId: buyer.profileId, buyerEmail: email, emails: [runnerEmail('p')] })
    await orderOk(event, opts(c1))
    const [a, b] = await Promise.all([createOrder(event, opts(c1)), createOrder(event, opts(c2))])
    const errors = [a, b].map((x) => x.error?.message ?? null)
    assert.deepEqual(errors.filter(Boolean), ['too_many_pending'], JSON.stringify(errors))
    assert.equal((await rows('orders', { event_id: event.eventId })).length, 2)
    assert.equal((await competitionOf(c1)).taken + (await competitionOf(c2)).taken, 2)
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
  assert.equal((await createOrder(event, { sendBuyerEmail: 'ktos-inny@test.local' })).error?.message, 'invalid_buyer_email')
  assert.equal((await createOrder(event, { profileId: null })).error?.message, 'session_required')

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

test('record_refund / settle_refund (P3-R6): message id from the refund id; 406 retries in an hour; pending moves; accepted and rejected are final', async () => {
  const event = await paid()
  const out = await orderOk(event)
  const att = await attemptFor(out.orderId, out.total)
  await confirmOk(out.orderId, att.txn, out.total)

  const r = await rpc('record_refund', { p_attempt_id: att.id, p_grosze: out.total, p_kind: 'organizer', p_reason: 'rezygnacja' })
  assert.equal(r.error, null, r.error?.message)
  assert.equal(r.data.messageId, r.data.refundId.replaceAll('-', '').slice(0, 24))

  let s1 = await rpc('settle_refund', { p_refund_id: r.data.refundId, p_outcome: 'insufficient_balance' })
  assert.equal(s1.data, 'settled', s1.error?.message)
  const retry = await one('refunds', { id: r.data.refundId })
  assert.equal(retry.dpay_status, 'insufficient_balance')
  assert.ok(Math.abs(Date.parse(retry.next_retry_at) - (Date.now() + 3600e3)) < 120e3)
  assert.equal(retry.attempts, 0, 'the retry claim (task 7) owns the counter')

  s1 = await rpc('settle_refund', { p_refund_id: r.data.refundId, p_outcome: 'pending' })
  assert.equal(s1.data, 'settled', s1.error?.message)
  const pend = await one('refunds', { id: r.data.refundId })
  assert.equal(pend.dpay_status, 'pending')
  assert.equal(pend.next_retry_at, null)

  assert.equal((await rpc('settle_refund', { p_refund_id: r.data.refundId, p_outcome: 'accepted' })).data, 'settled')
  assert.equal((await one('payment_attempts', { id: att.id })).status, 'refunded')
  for (const later of ['rejected', 'unknown', 'pending', 'accepted']) {
    const again = await rpc('settle_refund', { p_refund_id: r.data.refundId, p_outcome: later })
    assert.equal(again.data, 'already_settled', later)
  }
  const done = await one('refunds', { id: r.data.refundId })
  assert.equal(done.dpay_status, 'accepted')
  assert.equal(done.attempts, 0)
  // The money left once: no second refund of it.
  const twice = await rpc('record_refund', { p_attempt_id: att.id, p_grosze: out.total, p_kind: 'organizer', p_reason: 'x' })
  assert.equal(twice.error?.message, 'invalid_amount')

  // A rejected refund is final too, and frees its amount for a new attempt.
  const out2 = await orderOk(event)
  const att2 = await attemptFor(out2.orderId, out2.total)
  await confirmOk(out2.orderId, att2.txn, out2.total)
  const r2 = await rpc('record_refund', { p_attempt_id: att2.id, p_grosze: out2.total, p_kind: 'organizer', p_reason: 'x' })
  assert.equal((await rpc('settle_refund', { p_refund_id: r2.data.refundId, p_outcome: 'rejected' })).data, 'settled')
  assert.equal((await rpc('settle_refund', { p_refund_id: r2.data.refundId, p_outcome: 'accepted' })).data, 'already_settled')
  assert.equal((await one('refunds', { id: r2.data.refundId })).dpay_status, 'rejected')
  assert.equal((await one('payment_attempts', { id: att2.id })).status, 'paid')

  const bad = await rpc('settle_refund', { p_refund_id: r.data.refundId, p_outcome: 'maybe' })
  assert.equal(bad.error?.message, 'invalid_outcome')
  const missing = await rpc('settle_refund', { p_refund_id: crypto.randomUUID(), p_outcome: 'accepted' })
  assert.equal(missing.error?.message, 'not_found')
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

// ---------------------------------------------------------------- P-53 / P-54 (task 11, GDPR)

/** A paid order of `email` (the P-48 runner: paid once) plus a double payment refunded automatically. */
async function paidRunner(event, email) {
  const session = await sessionFor(email)
  const out = await orderOk(event, { people: [person(email)], support: true })
  const att = await attemptFor(out.orderId, out.total)
  const second = await attemptFor(out.orderId, out.total)
  await confirmOk(out.orderId, att.txn, out.total)
  const dbl = await confirmOk(out.orderId, second.txn, out.total)
  assert.equal(dbl.outcome, 'double_payment', JSON.stringify(dbl))
  return { session, out, att, second }
}

test('P-53 export-my-data holds the runner\'s order with every amount, its lines, attempts and refund, and nobody else\'s', async () => {
  const event = await paid()
  const email = runnerEmail('export')
  const other = runnerEmail('other')
  const { session, out, att, second } = await paidRunner(event, email)
  const otherOrder = await orderOk(event, { people: [person(other)] })

  const res = await callFn('export-my-data', session, {})
  assert.equal(res.status, 200, JSON.stringify(res.body))
  const orders = res.body.orders
  assert.equal(orders.length, 1, JSON.stringify(orders))
  const [o] = orders
  assert.equal(o.id, out.orderId)
  assert.equal(o.status, 'paid')
  assert.equal(o.buyer_email, email)
  assert.equal(o.paid_transaction_id, att.txn)
  assert.equal(o.support_choice, true)
  assert.deepEqual(o.amounts, {
    entry_total: 6000, extras_total: 0, donation: 0, support_fee: 120, payment_fee: 56, total: 6176,
  })
  assert.equal(o.event_name, (await one('registration_settings', { event_id: event.eventId })).name)
  assert.equal(o.lines.length, 1)
  assert.equal(o.lines[0].kind, 'entry')
  assert.equal(o.lines[0].amount, 6000)
  assert.ok(o.lines[0].tier_label)
  assert.deepEqual(o.payment_attempts.map((a) => [a.dpay_transaction_id, a.status, a.grosze]).sort(),
    [[att.txn, 'paid', 6176], [second.txn, 'paid', 6176]].sort())
  assert.ok(o.payment_attempts.every((a) => a.id))
  assert.equal(o.refunds.length, 1)
  assert.equal(o.refunds[0].amount, 6176)
  assert.equal(o.refunds[0].kind, 'automatic')
  assert.equal(o.refunds[0].reason, 'double_payment')
  assert.equal(o.refunds[0].payment_attempt_id, o.payment_attempts.find((a) => a.dpay_transaction_id === second.txn).id)

  const text = JSON.stringify(res.body)
  assert.equal(text.includes(other), false, 'no other person\'s address')
  assert.equal(text.includes(otherOrder.orderId), false, 'no other person\'s order')
})

test('P-53 the club owner\'s export lists the event payout changes they made', async () => {
  const event = await paid()
  const r = await callFn('update-event-payout', owner, {
    eventId: event.eventId, mode: 'custom', recipient: 'Fundacja Leśna Pomoc', taxId: '5260250274',
    iban: 'PL61109010140000071219812874', title: 'Wpisowe',
  })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const res = await callFn('export-my-data', owner, {})
  assert.equal(res.status, 200, JSON.stringify(res.body))
  const mine = res.body.organizer.event_payout_changes.filter((c) => c.event_id === event.eventId)
  assert.equal(mine.length, 1)
  assert.equal(mine[0].old, null)
  assert.equal(mine[0].new.payout_iban, 'PL61109010140000071219812874')
  assert.ok(mine[0].changed_at)
})

test('P-54 delete-my-account: the order keeps its amounts, status and transaction ids, buyer_email is null, the person is anonymised', async () => {
  const event = await paid()
  const email = runnerEmail('erase')
  const { session, out, att, second } = await paidRunner(event, email)
  const [reg] = await registrationsOf(out.orderId)
  // An alert whose text carries the address (a mail provider's error message).
  const { error: aErr } = await db().from('operator_alerts')
    .insert({ kind: 'email_failed', order_id: out.orderId, payload: { template: 'reminder', error: `rejected ${email}` } })
  assert.ifError(aErr)
  const sha = crypto.createHash('sha256').update('123456').digest('hex')
  const { error: cErr } = await db().from('auth_codes').insert({
    email, code_hash: sha, purpose: 'delete_account', expires_at: new Date(Date.now() + 600000).toISOString(),
  })
  assert.ifError(cErr)

  const r = await callFn('delete-my-account', session, { action: 'confirm', code: '123456' })
  assert.equal(r.status, 200, JSON.stringify(r.body))

  const order = await orderOf(out.orderId)
  assert.equal(order.buyer_email, null)
  assert.equal(order.status, 'paid')
  assert.equal(order.total, 6176)
  assert.equal(order.support_fee, 120)
  assert.equal(order.payment_fee, 56)
  assert.equal(order.paid_transaction_id, att.txn)
  assert.notEqual(order.paid_at, null)
  const attempts = await rows('payment_attempts', { order_id: out.orderId })
  assert.deepEqual(attempts.map((a) => a.dpay_transaction_id).sort(), [att.txn, second.txn].sort())
  const refunds = await rows('refunds', { order_id: out.orderId })
  assert.equal(refunds.length, 1)
  assert.equal(refunds[0].amount, 6176)

  const alerts = await alertsFor(out.orderId, 'email_failed')
  assert.equal(alerts.length, 1)
  assert.equal(JSON.stringify(alerts[0].payload).includes(email), false, 'the address is masked in alert payloads')
  assert.equal(alerts[0].payload.template, 'reminder')

  const after = await one('registrations', { id: reg.id })
  assert.equal(after.first_name, 'Usunięte konto')
  assert.equal(after.email, null)
  assert.equal(after.phone, null)
  assert.equal(after.status, 'confirmed')
  const [p] = await participantsOf(reg.id)
  assert.equal(p.email, null)
  assert.equal(p.phone, null)
  assert.equal(p.first_name, 'Uczestnik')
  assert.notEqual(p.deleted_at, null)
  assert.equal((await competitionOf(event.categoryIds[0])).taken, 1, 'the slot stays taken')
})
