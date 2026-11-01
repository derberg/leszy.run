// Plan 6, task 3: concurrency of the organizer's refunds, cancellations and extensions (O-20…O-28 in
// docs/registration/scenario-matrix.md), and O-29, the fixes from Task 2's review (migration
// 20261102102000_organizer_panel_concurrency.sql). A double click, two organizers at once, a refund racing an
// IPN, an extension racing expiry, and the lock order against register_free, confirm_order and a
// squad edit. Every concurrent call runs on its own PostgREST connection.
//
// A refund goes through the served `organizer-refund` function (Task 4), as the owner's or the
// admin's session, against the mocked dpay. The IPN path is the real one: the mock posts its signed
// IPN to this slot's dpay-ipn. LOCAL stack only.
import { after, afterEach, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import postgres from 'postgres'
import { localEnv, resetThrottle, sessionFor } from './helpers/stack.js'
import { messagesTo, startCapture } from './helpers/emailCapture.js'
import { acceptAgreement, callFn, createPublishedPaidEvent } from './helpers/registrationFixtures.js'
import { dpayMode, dpayRefunds, dpayReset, payMock, replayIpn, startDpayMock } from './helpers/dpayControl.js'
import {
  attemptFor, competitionOf, confirm, confirmOk, db, minutesFromNow, one, orderOf, orderOk, profileFor, rows, rpc,
  runnerEmail, setSettings,
} from './helpers/orders.js'
import { adult, groupMeta, isDeadlock, registerGroup } from './helpers/groups.js'
import { assertSlotInvariant } from './helpers/slotInvariant.js'
import { captain, paidTeamEvent, squadEdit, teamOk } from './helpers/teams.js'
import { INSUFFICIENT, UNCONFIRMED, exceedsCopy, nodeDpay } from './helpers/organizerRefund.js'
import { registerTransaction, refundTransaction } from '../../supabase/functions/_shared/dpay.js'
import { COUNTRY_CODES } from '../../supabase/functions/_shared/registration/countries.js'

const BIEG = (capacity = 200) => [{ name: 'Bieg 9 km', discipline: 'run', distanceLabel: '9 km', startTime: '10:00', capacity }]
const PRICE = 6000
const JOBS_SECRET = readFileSync(new URL('./functions.env', import.meta.url), 'utf8')
  .match(/^REGISTRATION_JOBS_SECRET=(.*)$/m)?.[1]?.trim()

let owner, adminSession, ownerId, adminId, stopCapture, stopMock
const seen = new Set()
const watch = (event) => { event.categoryIds.forEach((c) => seen.add(c)); return event }

before(async () => {
  stopCapture = await startCapture()
  stopMock = await startDpayMock()
  await resetThrottle()
  await acceptAgreement('zatyrani-test')
  owner = await sessionFor('owner@zatyrani-test.local')
  adminSession = await sessionFor('admin@zatyrani-test.local')
  ownerId = await profileFor('owner@zatyrani-test.local')
  adminId = await profileFor('admin@zatyrani-test.local')
})
after(async () => {
  if (stopMock) await stopMock()
  if (stopCapture) await stopCapture()
})
beforeEach(async () => { await dpayReset() })
afterEach(async () => {
  for (const categoryId of seen) await assertSlotInvariant(categoryId)
  seen.clear()
})

const ok = (r) => { assert.equal(r.error, null, r.error?.message); return r.data }
const key = () => crypto.randomUUID()
const taken = async (cat) => (await competitionOf(cat)).taken
const reg = (id) => one('registrations', { id })
const line = (id) => one('order_lines', { id })
const noDeadlock = (r, label) => assert.ok(!isDeadlock(r), `${label}: ${r?.error?.message}`)
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })
/** Starts the calls together, in the given order on even rounds and reversed on odd ones. */
const together = async (round, ...calls) => {
  if (round % 2 === 0) return Promise.all(calls.map((c) => c()))
  return (await Promise.all([...calls].reverse().map((c) => c()))).reverse()
}

const paidEvent = async (opts = {}) =>
  watch(await createPublishedPaidEvent(owner, { prices: { 'Bieg 9 km': PRICE }, competitions: BIEG(opts.capacity), ...opts }))

const refundsAtMock = async (txn) => (await dpayRefunds()).filter((r) => r.txnId === txn)
const alerts = (orderId, kind) => rows('operator_alerts', { order_id: orderId, kind })

/**
 * A pending order with a dpay transaction registered at the mock (so the mock can refund it) →
 * { orderId, total, txn, attemptId, email, registrationId, lineId }.
 */
async function mockOrder(event, { email = runnerEmail('org') } = {}) {
  const out = await orderOk(event, { emails: [email] })
  const { transactionId } = await registerTransaction(nodeDpay(), { orderId: out.orderId, grosze: out.total })
  const att = await attemptFor(out.orderId, out.total, transactionId)
  const [l] = await rows('order_lines', { order_id: out.orderId })
  return { orderId: out.orderId, total: out.total, txn: transactionId, attemptId: att.id, email, registrationId: l.registration_id, lineId: l.id }
}

/**
 * A paid entry the mock holds as paid. `ipn: true` pays through the mock's signed IPN to dpay-ipn
 * (the confirmation e-mail goes out); otherwise the IPN is dropped and confirm_order is called here.
 */
async function paidEntry(event, { ipn = false } = {}) {
  const o = await mockOrder(event)
  if (ipn) {
    await payMock(o.txn, 'paid')
  } else {
    await dpayMode({ dropIpn: true })
    await payMock(o.txn, 'paid')
    await dpayMode({ dropIpn: false })
    assert.equal((await confirmOk(o.orderId, o.txn, o.total)).outcome, 'confirmed')
  }
  assert.equal((await orderOf(o.orderId)).status, 'paid')
  return o
}

/** organizer-refund as the owner (actor ownerId) or the admin (adminId) → { status, body }. */
const refund = (e, grosze, { requestKey = key(), actor = ownerId } = {}) =>
  callFn('organizer-refund', actor === adminId ? adminSession : owner, { lineId: e.lineId, grosze, requestKey })

async function runJobs() {
  const res = await fetch(`${localEnv().functionsUrl}/registration-jobs`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-jobs-secret': JOBS_SECRET }, body: '{}',
  })
  const body = await res.json().catch(() => ({}))
  assert.equal(res.status, 200, JSON.stringify(body))
  return body
}

async function waitForMail(email, n) {
  for (let i = 0; i < 40; i++) {
    const msgs = await messagesTo(email)
    if (msgs.length >= n) return msgs
    await sleep(250)
  }
  return messagesTo(email)
}

// ---------------------------------------------------------------- O-20

test('O-20 a double click: three concurrent requests with one requestKey → one refund row, one dpay call, one refundId', async () => {
  const event = await paidEvent()
  for (let round = 0; round < 10; round++) {
    const e = await paidEntry(event)
    const k = key()
    const rs = await Promise.all([refund(e, 2000, { requestKey: k }), refund(e, 2000, { requestKey: k }), refund(e, 2000, { requestKey: k })])
    assert.equal((await rows('refunds', { request_key: k })).length, 1, `round ${round}`)
    assert.equal((await refundsAtMock(e.txn)).length, 1, `round ${round}: one dpay call`)
    const ids = new Set(rs.map((r) => r.body.data?.refundId))
    assert.equal(ids.size, 1, JSON.stringify(rs))
    assert.ok(rs.every((r) => r.status === 200 || r.status === 202), JSON.stringify(rs))
    assert.equal(rs.filter((r) => r.status === 200).length >= 1, true, 'the caller that made the call sees accepted')
    assert.equal((await line(e.lineId)).refunded, 2000)
    assert.equal((await reg(e.registrationId)).status, 'confirmed')
  }
})

test('O-20b one requestKey sent for two different lines at once → one refund, the other request_key_mismatch (never a raw unique violation)', async () => {
  const event = await paidEvent()
  for (let round = 0; round < 20; round++) {
    const a = await paidEntry(event)
    const b = await paidEntry(event)
    const k = key()
    const rs = await together(round, () => refund(a, 1000, { requestKey: k }), () => refund(b, 1000, { requestKey: k }))
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409], `round ${round}: ${JSON.stringify(rs)}`)
    assert.equal(rs.find((r) => r.status === 409).body.code, 'request_key_mismatch', JSON.stringify(rs))
    assert.equal((await rows('refunds', { request_key: k })).length, 1)
    const refunded = (await line(a.lineId)).refunded + (await line(b.lineId)).refunded
    assert.equal(refunded, 1000, `round ${round}: the losing reservation is rolled back`)
  }
})

// ---------------------------------------------------------------- O-21

test('O-21 two organizers: owner 40 zł and admin 30 zł of a 60 zł line at once → one accepted, the other exceeds with what is left', async () => {
  const event = await paidEvent()
  for (let round = 0; round < 10; round++) {
    const e = await paidEntry(event)
    const [o, a] = await together(round, () => refund(e, 4000, { actor: ownerId }), () => refund(e, 3000, { actor: adminId }))
    const statuses = [o.status, a.status].sort()
    assert.deepEqual(statuses, [200, 409], `round ${round}: ${JSON.stringify([o, a])}`)
    const lost = o.status === 409 ? o : a
    assert.equal(lost.body.code, 'exceeds')
    assert.equal(lost.body.remaining, o.status === 409 ? 3000 : 2000)
    assert.equal(lost.body.error, exceedsCopy(lost.body.remaining))
    const atMock = await refundsAtMock(e.txn)
    assert.equal(atMock.length, 1)
    assert.ok(atMock.reduce((s, r) => s + r.grosze, 0) <= PRICE)
    assert.equal((await line(e.lineId)).refunded, o.status === 200 ? 4000 : 3000)
    assert.equal((await reg(e.registrationId)).status, 'confirmed')
  }
})

test('O-21 two concurrent full refunds → one cancellation, taken − 1 once, one dpay refund', async () => {
  const event = await paidEvent()
  const cat = event.categoryIds[0]
  for (let round = 0; round < 10; round++) {
    const e = await paidEntry(event)
    const before = await taken(cat)
    const rs = await together(round, () => refund(e, PRICE, { actor: ownerId }), () => refund(e, PRICE, { actor: adminId }))
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409], JSON.stringify(rs))
    const won = rs.find((r) => r.status === 200)
    assert.deepEqual(won.body.data.cancelled, [e.registrationId])
    assert.equal(rs.find((r) => r.status === 409).body.remaining, 0)
    assert.equal(await taken(cat), before - 1)
    assert.equal((await reg(e.registrationId)).status, 'cancelled')
    assert.deepEqual((await refundsAtMock(e.txn)).map((r) => r.grosze), [PRICE])
  }
})

test('O-21 two halves settling at the same moment → exactly one cancels the entry', async () => {
  const event = await paidEvent()
  const cat = event.categoryIds[0]
  for (let round = 0; round < 20; round++) {
    const e = await paidEntry(event)
    const a = ok(await rpc('reserve_organizer_refund', { p_line_id: e.lineId, p_grosze: 3000, p_actor: ownerId, p_request_key: key() }))
    const b = ok(await rpc('reserve_organizer_refund', { p_line_id: e.lineId, p_grosze: 3000, p_actor: adminId, p_request_key: key() }))
    const before = await taken(cat)
    const rs = await together(round,
      () => rpc('finish_organizer_refund', { p_refund_id: a.refundId, p_outcome: 'accepted' }),
      () => rpc('finish_organizer_refund', { p_refund_id: b.refundId, p_outcome: 'accepted' }))
    rs.forEach((r) => noDeadlock(r, `round ${round}`))
    const outs = rs.map(ok)
    assert.deepEqual(outs.map((x) => x.cancelled.length).sort(), [0, 1], JSON.stringify(outs))
    assert.equal(await taken(cat), before - 1)
    assert.equal((await one('payment_attempts', { id: e.attemptId })).status, 'refunded')
  }
})

test('O-21 two organizers cancel one confirmed entry at once → one cancels, the other already_cancelled, taken − 1 once', async () => {
  const event = await paidEvent()
  const cat = event.categoryIds[0]
  for (let round = 0; round < 10; round++) {
    const e = await paidEntry(event)
    const before = await taken(cat)
    const rs = await together(round,
      () => rpc('cancel_registration', { p_registration_id: e.registrationId, p_reason: 'organizer', p_actor: ownerId }),
      () => rpc('cancel_registration', { p_registration_id: e.registrationId, p_reason: 'organizer', p_actor: adminId }))
    rs.forEach((r) => noDeadlock(r, `round ${round}`))
    assert.deepEqual(rs.map((r) => r.error?.message ?? 'ok').sort(), ['already_cancelled', 'ok'], JSON.stringify(rs))
    assert.equal(await taken(cat), before - 1)
  }
})

// ---------------------------------------------------------------- O-22

test('O-22 100 rounds: reserve_organizer_refund racing confirm_order on a pending order → a reservation only on a paid order', async (t) => {
  const event = await paidEvent()
  const counts = { reserved: 0, not_paid: 0 }
  for (let round = 0; round < 100; round++) {
    const out = await orderOk(event)
    const att = await attemptFor(out.orderId, out.total)
    const [l] = await rows('order_lines', { order_id: out.orderId })
    const [res, conf] = await together(round,
      () => rpc('reserve_organizer_refund', { p_line_id: l.id, p_grosze: 1000, p_actor: ownerId, p_request_key: key() }),
      () => confirm(out.orderId, att.txn, out.total))
    noDeadlock(res, `round ${round}`)
    assert.equal(ok(conf).outcome, 'confirmed', `round ${round}`)
    const held = await rows('refunds', { order_id: out.orderId })
    if (res.error) {
      assert.equal(res.error.message, 'not_paid', `round ${round}`)
      assert.equal(held.length, 0)
      assert.equal((await line(l.id)).refunded, 0)
      counts.not_paid++
    } else {
      assert.equal(held.length, 1)
      assert.equal(held[0].payment_attempt_id, att.id, 'the reservation sits on the paid attempt')
      assert.equal((await line(l.id)).refunded, 1000)
      counts.reserved++
    }
  }
  t.diagnostic(`outcomes ${JSON.stringify(counts)}`)
})

test('O-22 after a full refund five IPN replays change nothing: still cancelled, no new participant, no e-mail, no second refund', async () => {
  const event = await paidEvent()
  const e = await paidEntry(event, { ipn: true })
  const mails = (await waitForMail(e.email, 1)).length
  assert.equal(mails, 1, 'the confirmation went out')
  const done = await refund(e, PRICE)
  assert.equal(done.status, 200, JSON.stringify(done))
  assert.deepEqual(done.body.data.cancelled, [e.registrationId])
  const afterRefund = await waitForMail(e.email, mails + 1)
  assert.equal(afterRefund.length, mails + 1, 'the club\'s refund e-mail')
  assert.match(afterRefund.at(-1).subject, /^Zwrot 60,00 zł — /)

  await replayIpn(e.txn, { times: 5 })
  assert.equal(ok(await confirm(e.orderId, e.txn, e.total)).outcome, 'already_confirmed')
  const r = await reg(e.registrationId)
  assert.equal(r.status, 'cancelled')
  assert.equal((await rows('participants', { registration_id: e.registrationId })).length, 1)
  assert.ok((await one('participants', { registration_id: e.registrationId })).removed_at)
  assert.equal((await orderOf(e.orderId)).status, 'paid')
  assert.deepEqual((await refundsAtMock(e.txn)).map((x) => x.grosze), [PRICE])
  assert.equal((await rows('refunds', { order_id: e.orderId })).length, 1, 'no double_payment refund')
  await sleep(500)
  assert.equal((await messagesTo(e.email)).length, mails + 1, 'no confirmation e-mail from the replays')
})

// ---------------------------------------------------------------- O-23

test('O-23 the organizer cancels a pending order, then the payment lands → refunded in full automatically, never confirmed', async () => {
  const event = await paidEvent()
  const cat = event.categoryIds[0]
  const o = await mockOrder(event)
  const before = await taken(cat)
  const c = ok(await rpc('cancel_registration', { p_registration_id: o.registrationId, p_reason: 'organizer', p_actor: ownerId }))
  assert.deepEqual(c.cancelled, [o.registrationId])
  assert.equal((await orderOf(o.orderId)).cancelled_reason, 'organizer_cancelled')

  await payMock(o.txn, 'paid')
  const order = await orderOf(o.orderId)
  assert.equal(order.status, 'cancelled')
  assert.equal(order.paid_transaction_id, null)
  assert.equal((await reg(o.registrationId)).status, 'cancelled')
  assert.equal((await rows('participants', { registration_id: o.registrationId })).length, 0)
  const [f] = await rows('refunds', { order_id: o.orderId })
  assert.equal(f.kind, 'automatic')
  assert.equal(f.reason, 'cancelled')
  assert.equal(f.dpay_status, 'accepted')
  assert.deepEqual((await refundsAtMock(o.txn)).map((x) => x.grosze), [o.total])
  assert.equal(await taken(cat), before)
})

// ---------------------------------------------------------------- O-24, O-25, O-28

test('O-24 dpay answers 500 → unknown, the reservation kept, one alert; the rest can still be refunded; the job makes no dpay call', async () => {
  const event = await paidEvent()
  const e = await paidEntry(event)
  await dpayMode({ refundFails: true })
  const r = await refund(e, 2000)
  assert.equal(r.status, 202, JSON.stringify(r))
  assert.equal(r.body.message, UNCONFIRMED)
  const [f] = await rows('refunds', { order_id: e.orderId })
  assert.equal(f.dpay_status, 'unknown')
  assert.equal(f.next_retry_at, null)
  assert.equal((await line(e.lineId)).refunded, 2000, 'unknown keeps the reservation')
  assert.equal((await alerts(e.orderId, 'refund_unknown')).length, 1)

  await dpayMode({ refundFails: false })
  const rest = await refund(e, 4000)
  assert.equal(rest.status, 200, JSON.stringify(rest))
  assert.deepEqual(rest.body.data.cancelled, [], 'only accepted money cancels: 40 of 60 zł')
  assert.equal((await reg(e.registrationId)).status, 'confirmed')
  assert.equal((await refund(e, 1)).body.code, 'exceeds', 'the unknown 20 zł stays reserved')

  const calls = (await refundsAtMock(e.txn)).length
  await runJobs()
  await runJobs()
  assert.equal((await refundsAtMock(e.txn)).length, calls, 'nothing retries an organizer refund')
  assert.equal((await one('refunds', { id: f.id })).dpay_status, 'unknown')
  assert.equal((await alerts(e.orderId, 'refund_unknown')).length, 1)
})

test('O-24 dpay never answers → unknown after the function\'s 10 s timeout, the reservation kept, the job makes no dpay call', async () => {
  const event = await paidEvent()
  const e = await paidEntry(event)
  await dpayMode({ refundHang: true })
  const r = await refund(e, 2000)
  assert.equal(r.status, 202, JSON.stringify(r))
  const [f] = await rows('refunds', { order_id: e.orderId })
  assert.equal(f.dpay_status, 'unknown')
  assert.ok(f.requested_at && f.responded_at)
  assert.equal((await line(e.lineId)).refunded, 2000)
  assert.equal((await alerts(e.orderId, 'refund_unknown')).length, 1)
  await dpayMode({ refundHang: false })
  await runJobs()
  assert.equal((await refundsAtMock(e.txn)).length, 0)
  assert.equal((await one('refunds', { id: f.id })).dpay_status, 'unknown')
})

test('O-25 dpay answers 406 → 409 with the 406 copy, the reservation released, one alert, never retried', async () => {
  const event = await paidEvent()
  const e = await paidEntry(event)
  await dpayMode({ refundInsufficient: true })
  const r = await refund(e, 2000)
  assert.equal(r.status, 409, JSON.stringify(r))
  assert.equal(r.body.error, INSUFFICIENT)
  const [f] = await rows('refunds', { order_id: e.orderId })
  assert.equal(f.dpay_status, 'insufficient_balance')
  assert.equal(f.next_retry_at, null)
  assert.equal((await line(e.lineId)).refunded, 0)
  assert.equal((await reg(e.registrationId)).refunded, 0)
  assert.equal((await alerts(e.orderId, 'refund_insufficient_balance')).length, 1)
  // Even with the balance back, the job never retries it: the organizer does, by hand.
  await dpayMode({ refundInsufficient: false })
  await db().from('refunds').update({ requested_at: minutesFromNow(-120) }).eq('id', f.id)
  await runJobs()
  assert.equal((await refundsAtMock(e.txn)).length, 0)
  const after = await one('refunds', { id: f.id })
  assert.equal(after.dpay_status, 'insufficient_balance')
  assert.equal(after.attempts, f.attempts)
})

test('O-28 dpay answers 410 (an earlier refund already took the money) → unknown, the reservation kept, one alert, no cancellation', async () => {
  const event = await paidEvent()
  const e = await paidEntry(event)
  // Money that left outside this refund: the mock's own count reaches the transaction amount.
  const direct = await refundTransaction(nodeDpay(), { transactionId: e.txn, grosze: PRICE })
  assert.equal(direct.outcome, 'accepted')
  const mails = (await messagesTo(e.email)).length
  const r = await refund(e, 2000)
  assert.equal(r.status, 202, JSON.stringify(r))
  assert.equal(r.body.message, UNCONFIRMED)
  const [f] = await rows('refunds', { order_id: e.orderId })
  assert.equal(f.dpay_status, 'unknown', 'a 410 is never stored as rejected (ruling 3)')
  assert.equal((await line(e.lineId)).refunded, 2000)
  assert.equal((await reg(e.registrationId)).status, 'confirmed')
  assert.equal((await alerts(e.orderId, 'refund_unknown')).length, 1)
  assert.equal((await refundsAtMock(e.txn)).length, 1, 'only the direct refund moved money')
  await sleep(300)
  assert.equal((await messagesTo(e.email)).length, mails, 'no runner e-mail')
})

// ---------------------------------------------------------------- O-26

test('O-26 100 rounds: extend_order_window racing expire_orders → extended or expired, never both; taken untouched', async (t) => {
  const event = await paidEvent()
  const cat = event.categoryIds[0]
  await setSettings(event.eventId, { closes_at: minutesFromNow(2 * 24 * 60) })
  const before = await taken(cat)
  const counts = { extended: 0, expired: 0 }
  for (let round = 0; round < 100; round++) {
    const out = await orderOk(event)
    const due = new Date(Date.now() + 5_000)
    await db().from('orders').update({ expires_at: due.toISOString() }).eq('id', out.orderId)
    const until = minutesFromNow(24 * 60)
    // expire_orders judges the order due at p_now; extend sees it still open (expires_at > now()).
    const [ext, exp] = await together(round,
      () => rpc('extend_order_window', { p_order_id: out.orderId, p_until: until, p_actor: ownerId }),
      () => rpc('expire_orders', { p_now: new Date(due.getTime() + 1_000).toISOString() }))
    noDeadlock(ext, `round ${round}`)
    assert.equal(exp.error, null, exp.error?.message)
    const o = await orderOf(out.orderId)
    const [r] = await rows('registrations', { order_id: out.orderId })
    if (ext.error) {
      assert.equal(ext.error.message, 'expired', `round ${round}`)
      assert.equal(o.status, 'expired')
      assert.equal(o.extended_at, null)
      assert.equal(r.status, 'expired')
      counts.expired++
    } else {
      assert.equal(o.status, 'pending', `round ${round}: extended, so not expired`)
      assert.equal(new Date(o.expires_at).toISOString(), new Date(until).toISOString())
      assert.ok(o.extended_at)
      assert.equal(r.status, 'pending_payment')
      counts.extended++
    }
    assert.equal(await taken(cat), before, `round ${round}: taken`)
  }
  t.diagnostic(`outcomes ${JSON.stringify(counts)}`)
  await assertSlotInvariant(cat)
})

test('O-26 an order extended to closes_at cannot be paid from closes_at; an IPN for an attempt started before close arriving at +6 min is refunded in full', async () => {
  const event = await paidEvent()
  const cat = event.categoryIds[0]
  // Within the 14-day cap and past the order's own 7-day window, so the extension moves it.
  const closes = minutesFromNow(10 * 24 * 60)
  await setSettings(event.eventId, { closes_at: closes })
  const email = runnerEmail('ext')
  const buyer = await sessionFor(email)
  const o = await mockOrder(event, { email })
  assert.equal(new Date(ok(await rpc('extend_order_window', { p_order_id: o.orderId, p_until: closes, p_actor: ownerId }))).toISOString(),
    new Date(closes).toISOString())

  // The clock reaches closes_at = expires_at.
  const at = new Date(Date.now() - 1_000).toISOString()
  await setSettings(event.eventId, { closes_at: at })
  await db().from('orders').update({ expires_at: at }).eq('id', o.orderId)
  const attempts = (await rows('payment_attempts', { order_id: o.orderId })).length
  const pay = async () => {
    const res = await fetch(`${localEnv().functionsUrl}/pay-order`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: buyer.cookie }, body: JSON.stringify({ orderId: o.orderId }),
    })
    return { status: res.status, body: await res.json().catch(() => ({})) }
  }
  const atClose = await pay()
  assert.equal(atClose.status, 409, JSON.stringify(atClose))
  // pay-order (unchanged by Plan 6, ruling 2) reads the order's own expiry first: an order extended to
  // closes_at expires at that same instant, so its answer is the expiry copy.
  assert.equal(atClose.body.error, 'Zgłoszenie wygasło. Zapisz się ponownie.')
  // With the window still open past an earlier close, the close check answers.
  await db().from('orders').update({ expires_at: minutesFromNow(60) }).eq('id', o.orderId)
  const closed = await pay()
  assert.equal(closed.status, 409, JSON.stringify(closed))
  assert.equal(closed.body.error, 'Zapisy są zamknięte.')
  assert.equal((await rows('payment_attempts', { order_id: o.orderId })).length, attempts, 'no new payment started')

  // The attempt was started before close; its IPN lands 6 minutes after it, past the 5-minute grace.
  await setSettings(event.eventId, { closes_at: minutesFromNow(-6) })
  await db().from('orders').update({ expires_at: minutesFromNow(-6) }).eq('id', o.orderId)
  await db().from('payment_attempts').update({ created_at: minutesFromNow(-7) }).eq('id', o.attemptId)
  const before = await taken(cat)
  await payMock(o.txn, 'paid')
  const order = await orderOf(o.orderId)
  assert.notEqual(order.status, 'paid')
  assert.equal(order.paid_transaction_id, null)
  const [f] = await rows('refunds', { order_id: o.orderId })
  assert.equal(f.kind, 'automatic')
  assert.equal(f.reason, 'closed')
  assert.equal(f.dpay_status, 'accepted')
  assert.deepEqual((await refundsAtMock(o.txn)).map((x) => x.grosze), [o.total])
  assert.equal((await rows('participants', { registration_id: o.registrationId })).length, 0)
  assert.equal(await taken(cat), before)
})

// ---------------------------------------------------------------- O-27

test('O-27 50 rounds: cancelling a confirmed entry (1 place left) racing register_free and confirm_order in that competition → no 40P01, never over capacity', async (t) => {
  const event = await paidEvent({ capacity: 10 })
  const cat = event.categoryIds[0]
  const counts = { confirmed: 0, full: 0, freeOk: 0, freeFull: 0 }
  for (let round = 0; round < 50; round++) {
    await setSettings(event.eventId, { pricing_mode: 'fixed' })
    const base = await taken(cat)
    await db().from('competitions').update({ capacity: base + 2 }).eq('category_id', cat)
    const x = await orderOk(event)
    const ax = await attemptFor(x.orderId, x.total)
    assert.equal((await confirmOk(x.orderId, ax.txn, x.total)).outcome, 'confirmed')
    const [xr] = await rows('registrations', { order_id: x.orderId })
    const p = await orderOk(event)
    const ap = await attemptFor(p.orderId, p.total)
    // register_free needs a free event; confirm_order does not look at the pricing mode.
    await setSettings(event.eventId, { pricing_mode: 'free' })
    const people = [adult(cat, 'self')]
    const meta = await groupMeta(event.eventId)
    const profile = await profileFor(people[0].email)

    const [c, f, conf] = await together(round,
      () => rpc('cancel_registration', { p_registration_id: xr.id, p_reason: 'organizer', p_actor: ownerId }),
      () => registerGroup(event, people, { profileId: profile, meta }),
      () => confirm(p.orderId, ap.txn, p.total))
    for (const r of [c, f, conf]) noDeadlock(r, `round ${round}`)
    ok(c)
    if (f.error) {
      assert.match(f.error.message, /^full(:|$)/, `round ${round}`)
      counts.freeFull++
    } else counts.freeOk++
    const outcome = ok(conf).outcome
    if (outcome === 'confirmed') counts.confirmed++
    else {
      assert.equal(outcome, 'late_refund', `round ${round}`)
      assert.equal(conf.data.refund.reason, 'full')
      const lost = await orderOf(p.orderId)
      assert.equal(lost.status, 'cancelled')
      assert.equal(lost.cancelled_reason, 'full')
      counts.full++
    }
    const comp = await competitionOf(cat)
    assert.ok(comp.taken <= comp.capacity, `round ${round}: taken ${comp.taken} > ${comp.capacity}`)
    await assertSlotInvariant(cat)
  }
  await setSettings(event.eventId, { pricing_mode: 'fixed' })
  t.diagnostic(`outcomes ${JSON.stringify(counts)}`)
})

test('O-27 50 rounds: a full refund of a team captain line settling while the squad is edited → no 40P01, the team goes whole, one slot', async (t) => {
  const event = watch(await paidTeamEvent(owner, { capacity: 200 }))
  const cat = event.categoryIds[0]
  const meta = await groupMeta(event.eventId)
  const counts = { addedFirst: 0, inactive: 0 }
  for (let round = 0; round < 50; round++) {
    const email = runnerEmail('captain')
    const out = await teamOk(event, { members: [captain(email), adult(cat, 'adult')] })
    const actor = await profileFor(email)
    const att = await attemptFor(out.orderId, out.total)
    assert.equal((await confirmOk(out.orderId, att.txn, out.total)).outcome, 'confirmed')
    const [l] = await rows('order_lines', { order_id: out.orderId })
    const res = ok(await rpc('reserve_organizer_refund', { p_line_id: l.id, p_grosze: out.total, p_actor: ownerId, p_request_key: key() }))
    const before = await taken(cat)

    // The edit does more work before its first lock; on every third round the settle waits for it.
    const lag = round % 3 === 2 ? 40 : 0
    const [fin, edit] = await together(round,
      async () => { await sleep(lag); return rpc('finish_organizer_refund', { p_refund_id: res.refundId, p_outcome: 'accepted' }) },
      () => squadEdit(event, out.teamId, actor, { op: 'add', person: adult(cat, 'adult', runnerEmail('new')) }, meta))
    noDeadlock(fin, `round ${round}`)
    noDeadlock(edit, `round ${round}`)
    const done = ok(fin)
    if (edit.error) {
      assert.equal(edit.error.message, 'team_inactive', `round ${round}`)
      assert.equal(done.cancelled.length, 2)
      counts.inactive++
    } else {
      assert.equal(done.cancelled.length, 3, `round ${round}: the added member goes with the team`)
      counts.addedFirst++
    }
    const live = (await rows('registrations', { team_id: out.teamId })).filter((r) => r.status !== 'cancelled')
    assert.deepEqual(live, [], `round ${round}`)
    assert.equal(await taken(cat), before - 1)
    assert.ok((await one('teams', { id: out.teamId })).released_at)
  }
  t.diagnostic(`outcomes ${JSON.stringify(counts)}`)
})

// ---------------------------------------------------------------- O-29: Task 2 review fixes

let sqlClient
const sql = () => (sqlClient ??= postgres(localEnv().dbUrl, { max: 1, onnotice: () => {} }))
after(async () => { if (sqlClient) await sqlClient.end() })
const reserveRpc = (lineId, grosze, requestKey = key()) =>
  rpc('reserve_organizer_refund', { p_line_id: lineId, p_grosze: grosze, p_actor: ownerId, p_request_key: requestKey })
const finishRpc = (refundId, outcome) => rpc('finish_organizer_refund', { p_refund_id: refundId, p_outcome: outcome })

/** A paid, confirmed entry with no dpay transaction at the mock (the RPC tests need none). */
async function rpcPaidEntry(event) {
  const out = await orderOk(event)
  const att = await attemptFor(out.orderId, out.total)
  assert.equal((await confirmOk(out.orderId, att.txn, out.total)).outcome, 'confirmed')
  const [l] = await rows('order_lines', { order_id: out.orderId })
  return { orderId: out.orderId, lineId: l.id, registrationId: l.registration_id, attemptId: att.id }
}

test('O-29a settle_refund refuses an organizer refund: finish_organizer_refund is its only settle step', async () => {
  const event = await paidEvent()
  const e = await rpcPaidEntry(event)
  const r = ok(await reserveRpc(e.lineId, 2000))
  ok(await finishRpc(r.refundId, 'insufficient_balance'))
  for (const outcome of ['accepted', 'rejected', 'unknown']) {
    const s = await rpc('settle_refund', { p_refund_id: r.refundId, p_outcome: outcome })
    assert.equal(s.error?.message, 'organizer_refund', outcome)
  }
  const f = await one('refunds', { id: r.refundId })
  assert.equal(f.dpay_status, 'insufficient_balance')
  assert.equal((await line(e.lineId)).refunded, 0)
  // An automatic refund still settles through it.
  const auto = ok(await rpc('record_refund', { p_attempt_id: e.attemptId, p_grosze: 1000, p_kind: 'automatic', p_reason: 'x' }))
  assert.equal(ok(await rpc('settle_refund', { p_refund_id: auto.refundId, p_outcome: 'accepted' })), 'settled')
})

test('O-29b an accepted refund is stored even when the cancellation it triggers fails: one alert, the entry left for the operator', async () => {
  const event = watch(await paidTeamEvent(owner))
  const cat = event.categoryIds[0]
  const out = await teamOk(event, { members: [captain(), adult(cat, 'adult')] })
  const att = await attemptFor(out.orderId, out.total)
  assert.equal((await confirmOk(out.orderId, att.txn, out.total)).outcome, 'confirmed')
  const [l] = await rows('order_lines', { order_id: out.orderId })
  const r = ok(await reserveRpc(l.id, out.total))
  // A line pointing at a member the squad minimum keeps: cancel_registration refuses it.
  const member = out.registrations.find((x) => x.id !== l.registration_id).id
  await db().from('order_lines').update({ registration_id: member }).eq('id', l.id)
  const before = await taken(cat)
  const done = ok(await finishRpc(r.refundId, 'accepted'))
  assert.equal(done.status, 'accepted')
  assert.equal(done.settled, 'settled')
  assert.deepEqual(done.cancelled, [])
  assert.equal((await one('refunds', { id: r.refundId })).dpay_status, 'accepted')
  assert.equal((await one('payment_attempts', { id: att.id })).status, 'refunded')
  assert.equal((await reg(member)).status, 'confirmed')
  assert.equal(await taken(cat), before)
  const al = await alerts(out.orderId, 'refund_cancel_failed')
  assert.equal(al.length, 1)
  assert.equal(al[0].payload.refundId, r.refundId)
  assert.equal(al[0].payload.error, 'below_team_min')
})

test('O-29c cancelling a pending team stamps cancelled_at / cancelled_by only on the rows it cancelled, never an earlier swap-out', async () => {
  const event = watch(await paidTeamEvent(owner))
  const cat = event.categoryIds[0]
  const email = runnerEmail('captain')
  const out = await teamOk(event, { members: [captain(email), adult(cat, 'adult'), adult(cat, 'adult')] })
  const actor = await profileFor(email)
  const old = out.registrations[1].id
  ok(await squadEdit(event, out.teamId, actor, { op: 'swap', registrationId: old, person: adult(cat, 'adult', runnerEmail('swap')) }))
  assert.equal((await reg(old)).status, 'cancelled')
  const live = (await rows('registrations', { team_id: out.teamId })).filter((x) => x.status === 'pending_payment').map((x) => x.id)
  const done = ok(await rpc('cancel_registration', { p_registration_id: out.registrations[0].id, p_reason: 'organizer', p_actor: ownerId }))
  assert.deepEqual([...done.cancelled].sort(), [...live].sort())
  const swapped = await reg(old)
  assert.equal(swapped.cancelled_at, null)
  assert.equal(swapped.cancelled_by, null)
  for (const id of live) assert.equal((await reg(id)).cancelled_by, ownerId)
})

test('O-29d extend_order_window with no closes_at is capped by the end of race day as well as 14 days', async () => {
  const event = await paidEvent()
  const out = await orderOk(event)
  const raceDay = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10)
  await db().from('orders').update({ expires_at: minutesFromNow(60) }).eq('id', out.orderId)
  await setSettings(event.eventId, { event_date: raceDay, closes_at: null })
  const r = await rpc('extend_order_window', { p_order_id: out.orderId, p_until: minutesFromNow(5 * 24 * 60), p_actor: ownerId })
  assert.equal(r.error?.message, 'invalid_until', JSON.stringify(r))
  ok(await rpc('extend_order_window', { p_order_id: out.orderId, p_until: minutesFromNow(24 * 60), p_actor: ownerId }))
  await setSettings(event.eventId, { closes_at: minutesFromNow(2 * 24 * 60) })
})

test('O-29e a reservation replay returns the refund\'s status', async () => {
  const event = await paidEvent()
  const e = await rpcPaidEntry(event)
  const k = key()
  const first = ok(await reserveRpc(e.lineId, 1500, k))
  assert.equal(first.status, 'pending')
  assert.equal(ok(await reserveRpc(e.lineId, 1500, k)).status, 'pending')
  ok(await finishRpc(first.refundId, 'accepted'))
  const again = ok(await reserveRpc(e.lineId, 1500, k))
  assert.equal(again.replay, true)
  assert.equal(again.status, 'accepted')
})

test('O-29f the host_withdraw alert carries a reason code, never the text it was given', async () => {
  const event = await paidEvent()
  const a = await rpcPaidEntry(event)
  const b = await rpcPaidEntry(event)
  await setSettings(event.eventId, { closes_at: minutesFromNow(-1) })
  ok(await rpc('cancel_registration', { p_registration_id: a.registrationId, p_reason: 'Jan Kowalski prosi o wycofanie', p_actor: ownerId }))
  const r = ok(await reserveRpc(b.lineId, PRICE))
  ok(await finishRpc(r.refundId, 'accepted'))
  const [ax] = await alerts(a.orderId, 'host_withdraw')
  const [bx] = await alerts(b.orderId, 'host_withdraw')
  assert.equal(ax.payload.reason, 'other')
  assert.equal(JSON.stringify(ax.payload).includes('Kowalski'), false)
  assert.equal(bx.payload.reason, 'refund')
})

test('O-29g rename_team holds no invisible character in its source and still collapses U+205F and U+3000', async () => {
  const [{ def }] = await sql()`SELECT pg_get_functiondef('public.rename_team(uuid, text, uuid)'::regprocedure) AS def`
  assert.deepEqual(def.match(/[^\x09\x0a\x0d\x20-\x7e]/gu) ?? [], [])
  const event = watch(await paidTeamEvent(owner))
  const t = await teamOk(event, { members: [captain(), adult(event.categoryIds[0], 'adult')] })
  const tag = crypto.randomBytes(3).toString('hex')
  assert.equal(ok(await rpc('rename_team', { p_team_id: t.teamId, p_name: `Szybkie Łosie　${tag}`, p_actor: ownerId })), `Szybkie Łosie ${tag}`)
})

test('O-29h „Edytuj dane” accepts only a nationality from the form\'s country list', async () => {
  const event = await paidEvent()
  const e = await rpcPaidEntry(event)
  const { data: rs } = await db().from('registration_settings').select('form_fields').eq('event_id', event.eventId).single()
  await setSettings(event.eventId, { form_fields: { ...(rs.form_fields ?? {}), nationality: 'optional' } })
  const edit = (nationality) => rpc('organizer_edit_registration', { p_registration_id: e.registrationId, p_fields: { nationality }, p_actor: ownerId })
  for (const bad of ['XX', 'EU', 'UK', 'QQ']) assert.equal((await edit(bad)).error?.message, 'edit_invalid', bad)
  assert.equal(ok(await edit('de')).changed, true)
  assert.equal((await reg(e.registrationId)).nationality, 'DE')
  const [{ n }] = await sql()`SELECT count(*)::int AS n FROM unnest(${COUNTRY_CODES}::text[]) c WHERE NOT public.registration_country_ok(c)`
  assert.equal(n, 0, 'every code of countries.js is accepted')
})
