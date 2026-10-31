// User decision P3-R15 (2026-10-29): the capacity limit counts PAID entries only, plus the
// drift-check addendum for plans 4–7 (locks keyed on registration_competition_in_use, a pending
// order keeps its price, a whole order is confirmed or refunded together). Scenario P-58 in
// docs/registration/scenario-matrix.md. LOCAL stack only; every event and address is random.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { sessionFor } from './helpers/stack.js'
import { acceptAgreement, callFn, createPublishedPaidEvent } from './helpers/registrationFixtures.js'
import {
  attemptFor, competitionOf, confirm, confirmOk, createOrder, db, expireNow, liveSlots, orderOf, orderOk,
  paidOrderOk, registrationsOf, rows, rpc, runnerEmail,
} from './helpers/orders.js'

let owner
before(async () => {
  await acceptAgreement('zatyrani-test')
  owner = await sessionFor('owner@zatyrani-test.local')
})

const BIEG = (capacity) => [{ name: 'Bieg 9 km', discipline: 'run', distanceLabel: '9 km', startTime: '10:00', capacity }]
const MARSZ = (capacity) => ({ name: 'Marsz 5 km', discipline: 'nw', distanceLabel: '5 km', startTime: '10:05', capacity })
const paid = (capacity = 50) =>
  createPublishedPaidEvent(owner, { prices: { 'Bieg 9 km': 6000 }, competitions: BIEG(capacity) })

const ITEM = (categoryId, over = {}) => ({
  category_id: categoryId, name: 'Bieg 9 km', kind: 'individual', discipline: 'run', distance_label: '9 km',
  start_time: '10:00', capacity: 50, min_age: null, max_age: null, is_kids: false, timed: true,
  gpx_upload_id: null, price: 6000, ...over,
})
const stage = (event, items) => rpc('stage_registration_section', {
  p_event_id: event.eventId, p_section: 'competitions', p_actor: owner.profileId,
  p_value: { pricing_mode: 'fixed', items },
})
const publishChanges = (event) =>
  rpc('publish_registration_changes', { p_event_id: event.eventId, p_actor: owner.profileId, p_expected_updated_at: null })
const discard = (event) => db().from('registration_pending_changes').delete().eq('event_id', event.eventId)

test('P-58 capacity 2, 5 pending orders that all pay at once → exactly 2 confirmed, 3 refunded full, taken 2', async () => {
  const event = await paid(2)
  const cat = event.categoryIds[0]
  const orders = []
  for (let i = 0; i < 5; i++) {
    const o = await orderOk(event)
    orders.push({ ...o, att: await attemptFor(o.orderId, o.total) })
  }
  assert.equal((await competitionOf(cat)).taken, 0)

  const rs = await Promise.all(orders.map((o) => confirm(o.orderId, o.att.txn, o.total)))
  assert.deepEqual(rs.filter((r) => r.error).map((r) => r.error.message), [])
  const outcomes = rs.map((r) => r.data.outcome)
  assert.equal(outcomes.filter((x) => x === 'confirmed').length, 2, JSON.stringify(outcomes))
  assert.equal(outcomes.filter((x) => x === 'late_refund').length, 3, JSON.stringify(outcomes))
  assert.equal((await competitionOf(cat)).taken, 2)
  assert.equal(await liveSlots(cat), 2)

  for (const [i, r] of rs.entries()) {
    const order = await orderOf(orders[i].orderId)
    if (r.data.outcome === 'confirmed') {
      assert.equal(order.status, 'paid')
      continue
    }
    assert.equal(r.data.refund.reason, 'full')
    assert.equal(r.data.refund.grosze, orders[i].total, 'refunded in full')
    // A refunded pending order is cancelled, so it cannot be paid a second time.
    assert.equal(order.status, 'cancelled')
    assert.equal(order.cancelled_reason, 'full')
    assert.deepEqual((await registrationsOf(orders[i].orderId)).map((x) => x.status), ['cancelled'])
    const refunds = await rows('refunds', { order_id: orders[i].orderId })
    assert.deepEqual(refunds.map((f) => [f.kind, f.reason, f.amount]), [['automatic', 'full', orders[i].total]])
    assert.equal((await rows('operator_alerts', { order_id: orders[i].orderId })).filter((a) => a.kind === 'late_refund').length, 1)
    // A second payment of the same order later is refunded too (cancelled), never confirmed.
    const again = await attemptFor(orders[i].orderId, orders[i].total).catch((e) => e)
    assert.match(String(again.message ?? ''), /not_payable/)
  }
})

test('P-58 a pending order does not reduce the free places', async () => {
  const event = await paid(1)
  const cat = event.categoryIds[0]
  await orderOk(event)
  await orderOk(event)
  assert.equal((await competitionOf(cat)).taken, 0)
  const raw = await rpc('registration_raw', { p_event_id: event.eventId })
  assert.ifError(raw.error)
  const comp = raw.data.competitions.find((c) => c.categoryId === cat)
  assert.equal(comp.taken, 0)
  assert.equal(comp.capacity, 1)
  assert.equal((await rpc('registration_order_fits', { p_order_id: (await orderOk(event)).orderId })).data, true)
  // The organizer's „N / limit zapisanych” counts confirmed entries only.
  const ed = await callFn('get-registration-event', owner, { eventId: event.eventId })
  assert.equal(ed.status, 200, JSON.stringify(ed.body))
  assert.equal(ed.body.data.registeredCount, 0)
  await paidOrderOk(event)
  assert.equal((await callFn('get-registration-event', owner, { eventId: event.eventId })).body.data.registeredCount, 1)
})

test('P-58 a new registration is refused once the paid entries reach capacity; pay-order is refused before dpay', async () => {
  const event = await paid(1)
  const waiting = await orderOk(event)
  await paidOrderOk(event)
  assert.equal((await createOrder(event)).error?.message, 'full')
  // The order created before the place was paid for can no longer start a payment.
  assert.equal((await rpc('registration_order_fits', { p_order_id: waiting.orderId })).data, false)
  const r = await rpc('add_payment_attempt', { p_order_id: waiting.orderId, p_txn: `TXN-${Date.now()}`, p_grosze: waiting.total })
  assert.equal(r.error?.message, 'full')
})

test('P-58 expiry and cancellation of unpaid orders do not change taken', async () => {
  const event = await paid(10)
  const cat = event.categoryIds[0]
  await paidOrderOk(event)
  const a = await orderOk(event)
  const b = await orderOk(event)
  assert.equal((await competitionOf(cat)).taken, 1)
  assert.ok(await expireNow(a.orderId) >= 1)
  assert.equal((await orderOf(a.orderId)).status, 'expired')
  assert.equal((await rpc('cancel_order', { p_order_id: b.orderId, p_reason: 'test' })).data, true)
  assert.equal((await competitionOf(cat)).taken, 1)
  assert.equal(await liveSlots(cat), 1)
})

test('P-58 a pending order alone blocks hiding the competition and changing its price; the limit may go down to the paid count', async () => {
  const event = await paid(10)
  const cat = event.categoryIds[0]
  const out = await orderOk(event)
  assert.equal((await competitionOf(cat)).taken, 0)
  assert.equal((await rpc('registration_competition_in_use', { p_category_id: cat })).data, true)

  assert.equal((await stage(event, [ITEM(cat, { hidden: true })])).error?.message, 'competition_locked')
  assert.equal((await stage(event, [ITEM(cat, { price: 7000 })])).error?.message, 'price_locked')
  const mode = await rpc('stage_registration_section', {
    p_event_id: event.eventId, p_section: 'competitions', p_actor: owner.profileId,
    p_value: { pricing_mode: 'tiered', items: [ITEM(cat)] },
  })
  assert.equal(mode.error?.message, 'price_locked')

  // Staged before the order existed, published after: refused at publish too.
  await expireNow(out.orderId)
  assert.equal((await rpc('registration_competition_in_use', { p_category_id: cat })).data, false)
  assert.ifError((await stage(event, [ITEM(cat, { hidden: true })])).error)
  const again = await orderOk(event)
  assert.equal((await publishChanges(event)).error?.message, 'competition_locked')
  await discard(event)

  // Unpaid entries hold no place: the limit may go down to the paid count (0 here, 1 is the floor).
  assert.ifError((await stage(event, [ITEM(cat, { capacity: 1 })])).error)
  assert.ifError((await publishChanges(event)).error)
  assert.equal((await competitionOf(cat)).capacity, 1)
  assert.equal((await orderOf(again.orderId)).status, 'pending')
})

test('P-58 a pending order keeps the price and total it was created with, whatever the price becomes', async () => {
  const event = await paid(10)
  const cat = event.categoryIds[0]
  const out = await orderOk(event)
  assert.equal(out.amounts.entryTotal, 6000)
  // The price changes underneath (a later tier, or an edit made while nobody held an order).
  const { error } = await db().from('competition_prices').update({ amount: 9000 }).eq('category_id', cat)
  assert.ifError(error)
  const att = await attemptFor(out.orderId, out.total)
  assert.equal((await confirmOk(out.orderId, att.txn, out.total)).outcome, 'confirmed')
  const order = await orderOf(out.orderId)
  assert.equal(order.total, out.total)
  assert.equal(order.entry_total, 6000)
  assert.equal((await registrationsOf(out.orderId))[0].price, 6000)
  // A new order pays the new price.
  assert.equal((await orderOk(event, { price: 9000 })).amounts.entryTotal, 9000)
})

test('P-58 a whole order is confirmed or refunded together: two people with one place left → refunded in full, nothing claimed', async () => {
  const event = await paid(2)
  const cat = event.categoryIds[0]
  const pair = await orderOk(event, { emails: [runnerEmail('p1'), runnerEmail('p2')] })
  const att = await attemptFor(pair.orderId, pair.total)
  await paidOrderOk(event)
  assert.equal((await competitionOf(cat)).taken, 1)

  const r = await confirmOk(pair.orderId, att.txn, pair.total)
  assert.equal(r.outcome, 'late_refund')
  assert.equal(r.refund.reason, 'full')
  assert.equal(r.refund.grosze, pair.total)
  assert.equal((await competitionOf(cat)).taken, 1)
  assert.deepEqual((await registrationsOf(pair.orderId)).map((x) => x.status), ['cancelled', 'cancelled'])
  assert.equal((await orderOf(pair.orderId)).status, 'cancelled')
})

test('P-58 a pending order spanning two competitions, the second full at payment → neither claimed, refunded in full', async () => {
  const event = await createPublishedPaidEvent(owner, {
    prices: { 'Bieg 9 km': 6000, 'Marsz 5 km': 4000 }, competitions: [...BIEG(10), MARSZ(1)],
  })
  const [c1, c2] = event.categoryIds
  const out = await orderOk(event, { categoryId: c1 })
  // A plan 4 shape: a second registration of the same order in c2 (built with admin()).
  const { error } = await db().from('registrations').insert({
    event_id: event.eventId, category_id: c2, order_id: out.orderId, status: 'pending_payment',
    first_name: 'Ala', last_name: 'Leśna', email: runnerEmail('c2'), consent_state: 'accepted', list_price: 0, price: 0,
  })
  assert.ifError(error)
  const att = await attemptFor(out.orderId, out.total)
  await paidOrderOk(event, { categoryId: c2 })

  const r = await confirmOk(out.orderId, att.txn, out.total)
  assert.equal(r.outcome, 'late_refund')
  assert.equal(r.refund.reason, 'full')
  assert.deepEqual([(await competitionOf(c1)).taken, (await competitionOf(c2)).taken], [0, 1])
  assert.deepEqual((await registrationsOf(out.orderId)).map((x) => x.status), ['cancelled', 'cancelled'])
  assert.equal((await rows('participants', { registration_id: (await registrationsOf(out.orderId))[0].id })).length, 0)
})

test('P-58 a 0 zł order is confirmed at once and claims its place at creation', async () => {
  const event = await createPublishedPaidEvent(owner, { prices: { 'Bieg 9 km': 0 }, competitions: BIEG(1) })
  const cat = event.categoryIds[0]
  const out = await orderOk(event, { price: 0 })
  assert.equal(out.status, 'paid')
  assert.equal((await competitionOf(cat)).taken, 1)
  assert.equal((await createOrder(event, { price: 0 })).error?.message, 'full')
})

// P3-R15 re-review I3: the wizard locks kind, price and hiding on registration_competition_in_use,
// so get-registration-event hands it to owner and admin per competition.
test('P-58 get-registration-event: inUse per competition for owner and admin (a live unpaid order counts, taken stays 0); none for a member', async () => {
  const event = await createPublishedPaidEvent(owner, {
    prices: { 'Bieg 9 km': 6000, 'Marsz 5 km': 4000 }, competitions: [...BIEG(50), MARSZ(20)],
  })
  const [bieg, marsz] = event.categoryIds
  const inUse = async (session) => {
    const r = await callFn('get-registration-event', session, { eventId: event.eventId })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    return Object.fromEntries(r.body.data.competitions.map((c) => [c.categoryId, [c.inUse, c.taken]]))
  }
  assert.deepEqual(await inUse(owner), { [bieg]: [false, 0], [marsz]: [false, 0] })
  const o = await orderOk(event)
  assert.deepEqual(await inUse(owner), { [bieg]: [true, 0], [marsz]: [false, 0] })
  assert.deepEqual(await inUse(await sessionFor('admin@zatyrani-test.local')), { [bieg]: [true, 0], [marsz]: [false, 0] })
  const member = await inUse(await sessionFor('member@zatyrani-test.local'))
  assert.deepEqual(member, { [bieg]: [undefined, 0], [marsz]: [undefined, 0] })
  // Cancelled, the order no longer holds the lock.
  assert.equal((await rpc('cancel_order', { p_order_id: o.orderId, p_reason: 'test' })).data, true)
  assert.deepEqual(await inUse(owner), { [bieg]: [false, 0], [marsz]: [false, 0] })
  await paidOrderOk(event, { categoryId: marsz })
  assert.deepEqual(await inUse(owner), { [bieg]: [false, 0], [marsz]: [true, 1] })
})
