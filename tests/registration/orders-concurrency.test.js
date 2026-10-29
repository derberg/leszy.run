// Plan 3, task 4: concurrency of the order RPCs (P-19 a–j in
// docs/registration/scenario-matrix.md). Every pair of calls runs on its own
// PostgREST connection at the same time. The invariant checked throughout:
// competitions.taken equals the confirmed registrations, a team counted once
// (P3-R15: an entry awaiting payment holds no place). LOCAL stack only.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { sessionFor } from './helpers/stack.js'
import { acceptAgreement, createPublishedPaidEvent } from './helpers/registrationFixtures.js'
import {
  attemptFor, competitionOf, confirm, confirmOk, createOrder, db, expireNow, liveSlots, minutesFromNow,
  newTxn, orderOf, orderOk, overdue, paidOrderOk, person, registrationsOf, rows, rpc, runnerEmail, setSettings,
} from './helpers/orders.js'

let owner
before(async () => {
  await acceptAgreement('zatyrani-test')
  owner = await sessionFor('owner@zatyrani-test.local')
})

const BIEG = (capacity) => [{ name: 'Bieg 9 km', discipline: 'run', distanceLabel: '9 km', startTime: '10:00', capacity }]
const paid = (capacity = 50, opts = {}) =>
  createPublishedPaidEvent(owner, { prices: { 'Bieg 9 km': 6000 }, competitions: BIEG(capacity), ...opts })
const isDeadlock = (r) => r?.error?.code === '40P01' || /deadlock/i.test(r?.error?.message ?? '')

async function assertInvariant(categoryId, label = '') {
  const c = await competitionOf(categoryId)
  assert.equal(c.taken, await liveSlots(categoryId), `taken = live registrations ${label}`)
}

// ---------------------------------------------------------------- (a)

test('P-19a capacity 5: 20 parallel create_order are all accepted (none holds a place); all 20 pay at once → 5 confirmed, 15 refunded full, taken 5 (P3-R15)', async () => {
  const event = await paid(5)
  const cat = event.categoryIds[0]
  const results = await Promise.all(Array.from({ length: 20 }, () => createOrder(event)))
  assert.deepEqual(results.filter((r) => r.error).map((r) => r.error.message), [])
  assert.equal((await competitionOf(cat)).taken, 0)
  const orders = await Promise.all(results.map(async (r) => ({ ...r.data, att: await attemptFor(r.data.orderId, r.data.total) })))
  const rs = await Promise.all(orders.map((o) => confirm(o.orderId, o.att.txn, o.total)))
  assert.deepEqual(rs.filter((r) => r.error).map((r) => r.error.message), [])
  const outcomes = rs.map((r) => r.data.outcome)
  assert.equal(outcomes.filter((o) => o === 'confirmed').length, 5, JSON.stringify(outcomes))
  assert.equal(outcomes.filter((o) => o === 'late_refund').length, 15, JSON.stringify(outcomes))
  assert.ok(rs.filter((r) => r.data.outcome === 'late_refund').every((r) => r.data.refund.reason === 'full'))
  assert.equal((await competitionOf(cat)).taken, 5)
  await assertInvariant(cat)

  // Full: 20 more parallel creates are all refused.
  const more = await Promise.all(Array.from({ length: 20 }, () => createOrder(event)))
  assert.deepEqual([...new Set(more.map((r) => r.error?.message))], ['full'])
})

// ---------------------------------------------------------------- (b)

test('P-19b 100 rounds of expire_orders racing confirm_order on one order: confirmed or late_*, never both', async (t) => {
  const event = await paid(200)
  const cat = event.categoryIds[0]
  const outcomes = {}
  for (let round = 0; round < 100; round++) {
    const out = await orderOk(event)
    const att = await attemptFor(out.orderId, out.total)
    await overdue(out.orderId)
    const [exp, conf] = await Promise.all([rpc('expire_orders', {}), confirm(out.orderId, att.txn, out.total)])
    assert.equal(exp.error, null, exp.error?.message)
    assert.equal(conf.error, null, conf.error?.message)
    const outcome = conf.data.outcome
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1
    assert.ok(['confirmed', 'late_confirmed'].includes(outcome), outcome)
    const order = await orderOf(out.orderId)
    assert.equal(order.status, 'paid', `round ${round}: ${outcome}`)
    const [reg] = await registrationsOf(out.orderId)
    assert.equal(reg.status, 'confirmed')
    assert.equal((await rows('participants', { registration_id: reg.id })).length, 1)
  }
  t.diagnostic(`outcomes ${JSON.stringify(outcomes)}`)
  await assertInvariant(cat, JSON.stringify(outcomes))
  assert.equal((await competitionOf(cat)).taken, 100)
})

// ---------------------------------------------------------------- (c)

test('P-19c two concurrent confirms of the same txn → one confirmed, one already_confirmed, one participant', async () => {
  for (let round = 0; round < 10; round++) {
    const event = await paid()
    const out = await orderOk(event)
    const att = await attemptFor(out.orderId, out.total)
    const rs = await Promise.all([confirm(out.orderId, att.txn, out.total), confirm(out.orderId, att.txn, out.total)])
    assert.deepEqual(rs.map((r) => r.data?.outcome).sort(), ['already_confirmed', 'confirmed'], JSON.stringify(rs))
    const [reg] = await registrationsOf(out.orderId)
    assert.equal((await rows('participants', { registration_id: reg.id })).length, 1)
    await assertInvariant(event.categoryIds[0])
  }
})

// ---------------------------------------------------------------- (d)

test('P-19d two concurrent expire_orders expire an order once and leave taken alone (P3-R15)', async () => {
  const event = await paid()
  const cat = event.categoryIds[0]
  await paidOrderOk(event)
  const stays = await orderOk(event)
  const goes = await orderOk(event)
  assert.equal((await competitionOf(cat)).taken, 1)
  await overdue(goes.orderId)
  const [a, b] = await Promise.all([rpc('expire_orders', {}), rpc('expire_orders', {})])
  assert.equal(a.error, null, a.error?.message)
  assert.equal(b.error, null, b.error?.message)
  assert.equal((await competitionOf(cat)).taken, 1)
  assert.equal((await orderOf(goes.orderId)).status, 'expired')
  assert.equal((await orderOf(stays.orderId)).status, 'pending')
  await assertInvariant(cat)
})

// ---------------------------------------------------------------- (e)

test('P-19e a second attempt confirmed 5× after the order is paid → one double_payment, four already_handled, one refund', async () => {
  const event = await paid()
  const out = await orderOk(event)
  const first = await attemptFor(out.orderId, out.total)
  const second = await attemptFor(out.orderId, out.total)
  assert.equal((await confirmOk(out.orderId, first.txn, out.total)).outcome, 'confirmed')

  const rs = await Promise.all(Array.from({ length: 5 }, () => confirm(out.orderId, second.txn, out.total)))
  const outcomes = rs.map((r) => r.data?.outcome ?? r.error?.message).sort()
  assert.deepEqual(outcomes, ['already_handled', 'already_handled', 'already_handled', 'already_handled', 'double_payment'])
  const dbl = rs.find((r) => r.data.outcome === 'double_payment').data
  assert.equal(dbl.refund.attemptId, second.id)
  assert.equal(dbl.refund.grosze, out.total)
  assert.equal(dbl.refund.reason, 'double_payment')
  const refunds = await rows('refunds', { order_id: out.orderId })
  assert.equal(refunds.length, 1)
  assert.equal(refunds[0].payment_attempt_id, second.id)
  assert.equal((await orderOf(out.orderId)).paid_transaction_id, first.txn)
  assert.equal((await rows('operator_alerts', { order_id: out.orderId })).filter((a) => a.kind === 'double_payment').length, 1)
  await assertInvariant(event.categoryIds[0])
})

// ---------------------------------------------------------------- (f)

test('P-19f an expired order and two different late attempts confirmed together → one late_confirmed, one double_payment', async () => {
  for (let round = 0; round < 5; round++) {
    const event = await paid()
    const out = await orderOk(event)
    const a = await attemptFor(out.orderId, out.total)
    const b = await attemptFor(out.orderId, out.total)
    await expireNow(out.orderId)
    const rs = await Promise.all([confirm(out.orderId, a.txn, out.total), confirm(out.orderId, b.txn, out.total)])
    assert.deepEqual(rs.map((r) => r.data?.outcome).sort(), ['double_payment', 'late_confirmed'], JSON.stringify(rs))
    assert.equal((await orderOf(out.orderId)).status, 'paid')
    assert.equal((await rows('refunds', { order_id: out.orderId })).length, 1)
    assert.equal((await competitionOf(event.categoryIds[0])).taken, 1)
    await assertInvariant(event.categoryIds[0])
  }
})

// ---------------------------------------------------------------- (g)

test('P-19g payments at and after closes_at: created after close → refund; before close and IPN at +4 min → confirmed; at +6 min → refund', async () => {
  // An attempt created after close (the order expired at close).
  let event = await paid()
  let out = await orderOk(event)
  let att = await attemptFor(out.orderId, out.total)
  await expireNow(out.orderId)
  await setSettings(event.eventId, { closes_at: minutesFromNow(-1) })
  await db().from('payment_attempts').update({ created_at: minutesFromNow(0) }).eq('id', att.id)
  let r = await confirmOk(out.orderId, att.txn, out.total)
  assert.equal(r.outcome, 'late_refund')
  assert.equal(r.refund.reason, 'closed')
  assert.equal((await competitionOf(event.categoryIds[0])).taken, 0)
  assert.equal((await orderOf(out.orderId)).status, 'expired')

  // Created before close, IPN at close + 4 min: the order still pending → confirmed.
  event = await paid()
  out = await orderOk(event)
  att = await attemptFor(out.orderId, out.total)
  await db().from('payment_attempts').update({ created_at: minutesFromNow(-10) }).eq('id', att.id)
  await setSettings(event.eventId, { closes_at: minutesFromNow(-4) })
  r = await confirmOk(out.orderId, att.txn, out.total)
  assert.equal(r.outcome, 'confirmed')

  // The same with the order already expired at close → late_confirmed.
  event = await paid()
  out = await orderOk(event)
  att = await attemptFor(out.orderId, out.total)
  await expireNow(out.orderId)
  await db().from('payment_attempts').update({ created_at: minutesFromNow(-10) }).eq('id', att.id)
  await setSettings(event.eventId, { closes_at: minutesFromNow(-4) })
  r = await confirmOk(out.orderId, att.txn, out.total)
  assert.equal(r.outcome, 'late_confirmed')
  assert.equal((await competitionOf(event.categoryIds[0])).taken, 1)

  // Created before close, IPN at close + 6 min → refund, taken unchanged.
  for (const expired of [true, false]) {
    event = await paid()
    out = await orderOk(event)
    att = await attemptFor(out.orderId, out.total)
    if (expired) await expireNow(out.orderId)
    const taken = (await competitionOf(event.categoryIds[0])).taken
    await db().from('payment_attempts').update({ created_at: minutesFromNow(-10) }).eq('id', att.id)
    await setSettings(event.eventId, { closes_at: minutesFromNow(-6) })
    r = await confirmOk(out.orderId, att.txn, out.total)
    assert.equal(r.outcome, 'late_refund', `expired=${expired}`)
    assert.equal(r.refund.reason, 'closed')
    assert.equal((await competitionOf(event.categoryIds[0])).taken, taken)
    assert.notEqual((await orderOf(out.orderId)).status, 'paid')
    assert.equal((await rows('refunds', { payment_attempt_id: att.id })).length, 1)
  }
})

// ---------------------------------------------------------------- (h)

test('P-19h a txn that is not an attempt of the order → unknown_attempt and one alert', async () => {
  const event = await paid()
  const out = await orderOk(event)
  const other = await orderOk(event)
  const foreign = await attemptFor(other.orderId, other.total)
  const r1 = await confirmOk(out.orderId, newTxn(), out.total)
  assert.equal(r1.outcome, 'unknown_attempt')
  const r2 = await confirmOk(out.orderId, foreign.txn, out.total)
  assert.equal(r2.outcome, 'unknown_attempt')
  assert.equal((await orderOf(out.orderId)).status, 'pending')
  assert.equal((await orderOf(other.orderId)).status, 'pending')
  const alerts = (await rows('operator_alerts', { order_id: out.orderId })).filter((a) => a.kind === 'unknown_attempt')
  assert.equal(alerts.length, 2)
})

// ---------------------------------------------------------------- (i)

test('P-19i slot units: two registrations sharing a team_id are one slot on expiry and on the late re-claim', async () => {
  const event = await paid()
  const cat = event.categoryIds[0]
  const out = await orderOk(event)
  const [reg] = await registrationsOf(out.orderId)
  const team = crypto.randomUUID()
  const { error: insErr } = await db().from('registrations').insert({
    event_id: event.eventId, category_id: cat, order_id: out.orderId, status: 'pending_payment', team_id: team,
    first_name: 'Ala', last_name: 'Leśna', email: runnerEmail('team'), consent_state: 'accepted',
    list_price: 0, price: 0,
  })
  assert.equal(insErr, null, insErr?.message)
  await db().from('registrations').update({ team_id: team }).eq('id', reg.id)
  assert.equal((await competitionOf(cat)).taken, 0)

  const units = await rpc('registration_slot_units', { p_order_id: out.orderId, p_statuses: ['pending_payment'] })
  assert.deepEqual(units.data, [{ category_id: cat, n: 1 }])

  const att = await attemptFor(out.orderId, out.total)
  await expireNow(out.orderId)
  assert.equal((await competitionOf(cat)).taken, 0)
  const r = await confirmOk(out.orderId, att.txn, out.total)
  assert.equal(r.outcome, 'late_confirmed')
  assert.equal((await competitionOf(cat)).taken, 1)
  const regs = await registrationsOf(out.orderId)
  assert.deepEqual(regs.map((x) => x.status), ['confirmed', 'confirmed'])
  for (const x of regs) assert.equal((await rows('participants', { registration_id: x.id })).length, 1)
  await assertInvariant(cat)
})

// ---------------------------------------------------------------- (j)

test('P-19j 50 rounds: expire_orders racing create_order for the same address in the same competition → no deadlock', async () => {
  const event = await paid(200)
  const cat = event.categoryIds[0]
  let created = 0
  for (let round = 0; round < 50; round++) {
    const email = runnerEmail('j1')
    const out = await orderOk(event, { emails: [email] })
    await overdue(out.orderId)
    const [exp, cre] = await Promise.all([rpc('expire_orders', {}), createOrder(event, { emails: [email] })])
    assert.ok(!isDeadlock(exp) && !isDeadlock(cre), `${exp.error?.message} / ${cre.error?.message}`)
    assert.equal(exp.error, null, exp.error?.message)
    if (cre.error) assert.equal(cre.error.message, 'duplicate')
    else created++
  }
  await assertInvariant(cat, `created ${created}`)
})

test('P-19j 50 rounds: publish_registration_changes racing create_order and confirm_order → no deadlock', async () => {
  const event = await paid(200)
  const cat = event.categoryIds[0]
  for (let round = 0; round < 50; round++) {
    const out = await orderOk(event)
    const att = await attemptFor(out.orderId, out.total)
    const capacity = 150 + (round % 2)
    const s = await rpc('stage_registration_section', {
      p_event_id: event.eventId, p_section: 'competitions', p_actor: owner.profileId,
      p_value: { pricing_mode: 'fixed', items: [{
        category_id: cat, name: 'Bieg 9 km', kind: 'individual', discipline: 'run', distance_label: '9 km',
        start_time: '10:00', capacity, min_age: null, max_age: null, is_kids: false, timed: true,
        gpx_upload_id: null, price: 6000,
      }] },
    })
    assert.equal(s.error, null, s.error?.message)
    const [pub, cre, conf] = await Promise.all([
      rpc('publish_registration_changes', { p_event_id: event.eventId, p_actor: owner.profileId, p_expected_updated_at: null }),
      createOrder(event),
      confirm(out.orderId, att.txn, out.total),
    ])
    for (const r of [pub, cre, conf]) assert.ok(!isDeadlock(r), r.error?.message)
    assert.equal(pub.error, null, pub.error?.message)
    assert.equal(cre.error, null, cre.error?.message)
    assert.equal(conf.data?.outcome, 'confirmed', JSON.stringify(conf))
  }
  await assertInvariant(cat)
  assert.equal((await competitionOf(cat)).taken, 50)
})

test('P-19 invariant after the paying window closes mid-flight: an expired order cannot be paid again', async () => {
  const event = await paid()
  const out = await orderOk(event)
  await expireNow(out.orderId)
  const r = await rpc('add_payment_attempt', { p_order_id: out.orderId, p_txn: newTxn(), p_grosze: out.total })
  assert.equal(r.error?.message, 'not_payable')
  await setSettings(event.eventId, { closes_at: minutesFromNow(30) })
  const fresh = await orderOk(event, { people: [person(runnerEmail('late'))] }).catch((e) => e)
  assert.match(String(fresh.message ?? fresh), /paying_closed/)
})

// ---------------------------------------------------------------- two competitions (review I4)

const MARSZ = (capacity) => ({ name: 'Marsz 5 km', discipline: 'nw', distanceLabel: '5 km', startTime: '10:05', capacity })
const paidTwo = (bieg = 200, marsz = 200) => createPublishedPaidEvent(owner, {
  prices: { 'Bieg 9 km': 6000, 'Marsz 5 km': 4000 }, competitions: [...BIEG(bieg), MARSZ(marsz)],
})

/** An order of one person in c1 plus a second registration in c2 (plan 4 shape, built with admin()). */
async function orderAcross(event) {
  const [c1, c2] = event.categoryIds
  const out = await orderOk(event, { categoryId: c1 })
  const { error } = await db().from('registrations').insert({
    event_id: event.eventId, category_id: c2, order_id: out.orderId, status: 'pending_payment',
    first_name: 'Ala', last_name: 'Leśna', email: runnerEmail('c2'), consent_state: 'accepted', list_price: 0, price: 0,
  })
  assert.equal(error, null, error?.message)
  return out
}

test('P-19k an order spanning two competitions: nothing held while unpaid, the late claim takes each', async () => {
  const event = await paidTwo()
  const [c1, c2] = event.categoryIds
  const out = await orderAcross(event)
  const units = await rpc('registration_slot_units', { p_order_id: out.orderId, p_statuses: ['pending_payment'] })
  assert.deepEqual(units.data, [c1, c2].sort().map((c) => ({ category_id: c, n: 1 })))
  assert.equal((await competitionOf(c1)).taken, 0)
  assert.equal((await competitionOf(c2)).taken, 0)

  const att = await attemptFor(out.orderId, out.total)
  await expireNow(out.orderId)
  assert.equal((await competitionOf(c1)).taken, 0)
  assert.equal((await competitionOf(c2)).taken, 0)

  const r = await confirmOk(out.orderId, att.txn, out.total)
  assert.equal(r.outcome, 'late_confirmed')
  assert.equal((await competitionOf(c1)).taken, 1)
  assert.equal((await competitionOf(c2)).taken, 1)
  const regs = await registrationsOf(out.orderId)
  assert.deepEqual(regs.map((x) => x.status), ['confirmed', 'confirmed'])
  await assertInvariant(c1)
  await assertInvariant(c2)
})

test('P-19k a late re-claim across two competitions where the second is full: both claims roll back, refund', async () => {
  const event = await paidTwo(10, 1)
  const [c1, c2] = event.categoryIds
  const out = await orderAcross(event)
  const att = await attemptFor(out.orderId, out.total)
  await expireNow(out.orderId)
  await paidOrderOk(event, { categoryId: c2 })
  const before = [(await competitionOf(c1)).taken, (await competitionOf(c2)).taken]
  assert.deepEqual(before, [0, 1])

  const r = await confirmOk(out.orderId, att.txn, out.total)
  assert.equal(r.outcome, 'late_refund')
  assert.equal(r.refund.reason, 'full')
  assert.deepEqual([(await competitionOf(c1)).taken, (await competitionOf(c2)).taken], before)
  assert.deepEqual((await registrationsOf(out.orderId)).map((x) => x.status), ['expired', 'expired'])
  await assertInvariant(c1)
  await assertInvariant(c2)
})

test('P-19l 50 rounds: one expire run over orders in two competitions racing a create in the second with the first order\'s address → no deadlock', async () => {
  // The case behind the set-based expire_orders: a run that handled order A
  // (c1) completely before order B (c2) would hold A's registration while
  // waiting for c2, and the create would hold c2 while waiting on A's address.
  const event = await paidTwo()
  const [c1, c2] = event.categoryIds
  let created = 0
  for (let round = 0; round < 50; round++) {
    const email = runnerEmail('l')
    const a = await orderOk(event, { categoryId: c1, emails: [email] })
    const b = await orderOk(event, { categoryId: c2 })
    await overdue(a.orderId)
    await overdue(b.orderId)
    const [exp, cre] = await Promise.all([rpc('expire_orders', {}), createOrder(event, { categoryId: c2, emails: [email] })])
    assert.ok(!isDeadlock(exp) && !isDeadlock(cre), `${exp.error?.message} / ${cre.error?.message}`)
    assert.equal(exp.error, null, exp.error?.message)
    if (cre.error) assert.equal(cre.error.message, 'duplicate')
    else created++
  }
  await assertInvariant(c1, `created ${created}`)
  await assertInvariant(c2, `created ${created}`)
})

test('P-19l expire_orders touches no competition row (P3-R15): it finishes while another transaction holds the competition lock', async () => {
  // The per-order release that could deadlock against create_order is gone: an unpaid
  // order holds no slot, so expiry never locks a competition.
  const { localEnv } = await import('./helpers/stack.js')
  const postgres = (await import('postgres')).default
  const sql = postgres(localEnv().dbUrl, { max: 2, onnotice: () => {} })
  try {
    const event = await paidTwo()
    const [c1, c2] = event.categoryIds
    const a = await orderOk(event, { categoryId: c1 })
    const b = await orderOk(event, { categoryId: c2 })
    await overdue(a.orderId)
    await overdue(b.orderId)
    let release
    const held = new Promise((r) => { release = r })
    const locker = sql.begin(async (tx) => {
      await tx`select 1 from public.competitions where category_id in ${tx([c1, c2])} for update`
      await held
    })
    await new Promise((r) => setTimeout(r, 100))
    const exp = await Promise.race([
      rpc('expire_orders', {}),
      new Promise((r) => setTimeout(() => r({ error: { message: 'expire_orders waited on the competition lock' } }), 5000)),
    ])
    release()
    await locker
    assert.equal(exp.error, null, exp.error?.message)
    assert.equal((await orderOf(a.orderId)).status, 'expired')
    assert.equal((await orderOf(b.orderId)).status, 'expired')
    assert.equal((await competitionOf(c1)).taken, 0)
    assert.equal((await competitionOf(c2)).taken, 0)
  } finally {
    await sql.end()
  }
})
