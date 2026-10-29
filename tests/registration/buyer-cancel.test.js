// P3-R15 re-review I1: the buyer cancels their own unpaid order (cancel-my-order →
// buyer_cancel_order → cancel_order 'buyer_cancelled'). Since a pending order holds no place, the
// paid entries can fill its competition while it waits; the runner was then stuck behind it until
// it expired (with „do końca zapisów”, until registration closed), because its live
// pending_payment row keeps every new submit at 409 pending_order. Scenario P-61 in
// docs/registration/scenario-matrix.md. LOCAL stack plus the mocked dpay; every event and
// address is random.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { localEnv, resetThrottle, sessionFor } from './helpers/stack.js'
import { startCapture } from './helpers/emailCapture.js'
import { acceptAgreement, createPublishedPaidEvent } from './helpers/registrationFixtures.js'
import { dpayReset, dpayTransactions, payMock, startDpayMock } from './helpers/dpayControl.js'
import {
  competitionOf, confirm, consentIds, db, liveSlots, orderOf, orderOk, paidOrderOk, registrationsOf, rows, rpc,
  runnerEmail, totalFor,
} from './helpers/orders.js'

const CANCELLED = 'Zgłoszenie anulowane.'

let owner, stopCapture, stopMock
before(async () => {
  stopCapture = await startCapture()
  stopMock = await startDpayMock()
  await resetThrottle()
  await acceptAgreement('zatyrani-test')
  owner = await sessionFor('owner@zatyrani-test.local')
})
after(async () => {
  if (stopMock) await stopMock()
  if (stopCapture) await stopCapture()
})
beforeEach(async () => { await dpayReset() })

const ip = () => `198.51.100.${crypto.randomInt(1, 255)}`

async function call(fn, body, session = null) {
  const res = await fetch(`${localEnv().functionsUrl}/${fn}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip(), ...(session ? { cookie: session.cookie } : {}) },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { status: res.status, body: json }
}

const TWO = [
  { name: 'Bieg 9 km', discipline: 'run', distanceLabel: '9 km', startTime: '10:00', capacity: 1 },
  { name: 'Marsz 5 km', discipline: 'nw', distanceLabel: '5 km', startTime: '10:05', capacity: 20 },
]
const paidEvent = () => createPublishedPaidEvent(owner, { prices: { 'Bieg 9 km': 6000, 'Marsz 5 km': 4000 }, competitions: TWO })

async function orderBody(event, email, categoryId = event.categoryIds[0]) {
  return {
    categoryId,
    person: { firstName: 'Ola', lastName: 'Leśna', birthDate: '1990-05-01', gender: 'K', email, phone: '600100200' },
    acceptedConsentIds: await consentIds(event.eventId),
    serviceRegulamin: true,
    supportChoice: false,
    displayedTotal: totalFor(event.prices[categoryId], 1, false),
  }
}

/** A pending order through create-order, with its dpay attempt → { event, email, runner, orderId }. */
async function pendingOrder(event, tag) {
  const email = runnerEmail(tag)
  const runner = await sessionFor(email)
  const r = await call('create-order', await orderBody(event, email), runner)
  assert.equal(r.status, 201, JSON.stringify(r.body))
  return { email, runner, orderId: r.body.data.orderId }
}

test('P-61 stuck runner: the paid entries fill the competition, the buyer cancels, then registers in another competition', async () => {
  const event = await paidEvent()
  const [bieg, marsz] = event.categoryIds
  const { email, runner, orderId } = await pendingOrder(event, 'stuck')
  assert.equal((await rows('payment_attempts', { order_id: orderId })).length, 1, 'the order went to dpay once')
  await paidOrderOk(event) // somebody else pays the only place
  assert.equal((await call('order-status', { orderId }, runner)).body.data.full, true)

  // Stuck: any new submit for this address routes back to the dead order.
  const blocked = await call('create-order', await orderBody(event, email, marsz), runner)
  assert.equal(blocked.status, 409, JSON.stringify(blocked.body))
  assert.equal(blocked.body.code, 'pending_order')
  assert.equal(blocked.body.orderId, orderId)

  const c = await call('cancel-my-order', { orderId }, runner)
  assert.equal(c.status, 200, JSON.stringify(c.body))
  assert.deepEqual(c.body.data, { status: 'cancelled' })
  const order = await orderOf(orderId)
  assert.equal(order.status, 'cancelled')
  assert.equal(order.cancelled_reason, 'buyer_cancelled')
  assert.deepEqual((await registrationsOf(orderId)).map((x) => x.status), ['cancelled'])
  assert.deepEqual(await rows('refunds', { order_id: orderId }), [], 'an unpaid order is never refunded')
  assert.equal((await competitionOf(bieg)).taken, 1, 'the paid entry keeps its place')
  assert.equal(await liveSlots(bieg), 1)

  const st = await call('order-status', { orderId }, runner)
  assert.equal(st.body.data.status, 'cancelled')
  assert.equal(st.body.data.cancelledReason, 'buyer_cancelled')

  const again = await call('create-order', await orderBody(event, email, marsz), runner)
  assert.equal(again.status, 201, JSON.stringify(again.body))
  assert.notEqual(again.body.data.orderId, orderId)
})

test('P-61 a payment that lands after the buyer cancelled is refunded in full (late_refund cancelled), never confirmed', async () => {
  const event = await paidEvent()
  const { runner, orderId } = await pendingOrder(event, 'late')
  assert.equal((await call('cancel-my-order', { orderId }, runner)).status, 200)
  const [t] = await dpayTransactions()
  await payMock(t.id, 'paid')
  let order
  for (let i = 0; i < 40; i++) {
    order = await orderOf(orderId)
    if ((await rows('refunds', { order_id: orderId })).length) break
    await new Promise((r) => setTimeout(r, 250))
  }
  assert.equal(order.status, 'cancelled')
  const refunds = await rows('refunds', { order_id: orderId })
  assert.deepEqual(refunds.map((f) => [f.kind, f.reason, f.amount]), [['automatic', 'cancelled', order.total]])
  assert.equal((await competitionOf(event.categoryIds[0])).taken, 0)
})

test('P-61 refusals: no session 401; another person, an unknown or malformed id 404; paid, cancelled or expired 409', async () => {
  const event = await paidEvent()
  const { runner, orderId } = await pendingOrder(event, 'refuse')
  assert.equal((await call('cancel-my-order', { orderId })).status, 401)
  const stranger = await sessionFor(runnerEmail('stranger'))
  for (const [body, who] of [[{ orderId }, stranger], [{ orderId: crypto.randomUUID() }, runner], [{ orderId: 'x' }, runner], [{}, runner]]) {
    const r = await call('cancel-my-order', body, who)
    assert.equal(r.status, 404, JSON.stringify(r.body))
  }
  assert.equal((await orderOf(orderId)).status, 'pending', 'a stranger cancels nothing')

  // Paid: the order is not pending any more.
  const paidEmail = runnerEmail('paid')
  const paid = await paidOrderOk(await paidEvent(), { emails: [paidEmail] })
  const p = await call('cancel-my-order', { orderId: paid.orderId }, await sessionFor(paidEmail))
  assert.equal(p.status, 409, JSON.stringify(p.body))
  assert.equal(p.body.code, 'paid')
  assert.equal((await orderOf(paid.orderId)).status, 'paid')

  // Cancelled twice: the second answers 409 cancelled.
  assert.equal((await call('cancel-my-order', { orderId }, runner)).status, 200)
  const twice = await call('cancel-my-order', { orderId }, runner)
  assert.equal(twice.status, 409)
  assert.equal(twice.body.code, 'cancelled')
  assert.equal(twice.body.error, CANCELLED)

  // Expired.
  const expEmail = runnerEmail('exp')
  const exp = await orderOk(await paidEvent(), { emails: [expEmail] })
  await db().from('orders').update({ status: 'expired' }).eq('id', exp.orderId)
  const e = await call('cancel-my-order', { orderId: exp.orderId }, await sessionFor(expEmail))
  assert.equal(e.status, 409)
  assert.equal(e.body.code, 'expired')
})

test('P-61 an attempt already paid on a pending order refuses the cancel (no refund path from here)', async () => {
  const event = await paidEvent()
  const { runner, orderId } = await pendingOrder(event, 'inflight')
  const [att] = await rows('payment_attempts', { order_id: orderId })
  // A state confirm_order never leaves behind (it flips both in one transaction); the cancel
  // still refuses it rather than cancel an order whose money arrived.
  const { error } = await db().from('payment_attempts').update({ status: 'paid', paid_at: new Date().toISOString() }).eq('id', att.id)
  assert.ifError(error)
  const r = await call('cancel-my-order', { orderId }, runner)
  assert.equal(r.status, 409, JSON.stringify(r.body))
  assert.equal(r.body.code, 'payment_received')
  assert.equal((await orderOf(orderId)).status, 'pending')
  assert.deepEqual(await rows('refunds', { order_id: orderId }), [])
  await db().from('payment_attempts').update({ status: 'created', paid_at: null }).eq('id', att.id)
})

test('P-61 buyer_cancel_order: only the buyer, only pending; service_role only', async () => {
  const event = await paidEvent()
  const email = runnerEmail('rpc')
  const o = await orderOk(event, { emails: [email] })
  const { data: buyer } = await db().from('orders').select('buyer_profile_id').eq('id', o.orderId).single()
  const other = await rpc('buyer_cancel_order', { p_order_id: o.orderId, p_profile_id: crypto.randomUUID() })
  assert.equal(other.data, 'not_found')
  const ok = await rpc('buyer_cancel_order', { p_order_id: o.orderId, p_profile_id: buyer.buyer_profile_id })
  assert.equal(ok.data, 'cancelled')
  const again = await rpc('buyer_cancel_order', { p_order_id: o.orderId, p_profile_id: buyer.buyer_profile_id })
  assert.equal(again.data, 'cancelled_already')

  const { createClient } = await import('@supabase/supabase-js')
  const env = localEnv()
  const anon = createClient(env.url, env.anonKey, { auth: { persistSession: false } })
  const r = await anon.rpc('buyer_cancel_order', { p_order_id: o.orderId, p_profile_id: buyer.buyer_profile_id })
  assert.ok(r.error, 'anon cannot execute it')
})

test('P-61 cancel-my-order is throttled per buyer', async () => {
  await resetThrottle()
  const runner = await sessionFor(runnerEmail('throttle'))
  let last
  for (let i = 0; i < 25; i++) {
    last = await call('cancel-my-order', { orderId: crypto.randomUUID() }, runner)
    if (last.status === 429) break
  }
  assert.equal(last.status, 429, JSON.stringify(last.body))
  await resetThrottle()
})

test('P-61 confirmations are unaffected: a paid order in the other competition still confirms after a cancel', async () => {
  const event = await paidEvent()
  const { runner, orderId } = await pendingOrder(event, 'other')
  assert.equal((await call('cancel-my-order', { orderId }, runner)).status, 200)
  const o = await orderOk(event, { categoryId: event.categoryIds[1] })
  const att = await rpc('add_payment_attempt', { p_order_id: o.orderId, p_txn: `TXN-${crypto.randomUUID()}`, p_grosze: o.total })
  assert.ifError(att.error)
  const [a] = await rows('payment_attempts', { order_id: o.orderId })
  assert.equal((await confirm(o.orderId, a.dpay_transaction_id, o.total)).data.outcome, 'confirmed')
})
