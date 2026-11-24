// Competition change, task 4: settling a surcharge (confirm_order's surcharge branch), the organizer
// refund finish rule (cancel only when all of the entry's money is back, never for a
// competition_change refund), expiry / orphan release / purge / job claims for a surcharge order,
// transfers and external refunds of an entry with a surcharge, and create_order's too_many_pending.
// Scenarios CC-20…CC-31 in docs/registration/scenario-matrix.md. LOCAL stack only.
import { afterEach, before, test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { authenticatedClient, localEnv, resetThrottle, sessionFor } from './helpers/stack.js'
import { acceptAgreement, createPublishedPaidEvent } from './helpers/registrationFixtures.js'
import {
  ageRefund, attemptFor, competitionOf, confirmOk, db, minutesFromNow, one, orderOf, overdue, profileFor, rows, rpc,
  setSettings,
} from './helpers/orders.js'
import { BIEG, adult, orderGroupOk } from './helpers/groups.js'
import { enableTransfers, invite, paidEntry, organizerTransfer } from './helpers/transfers.js'
import { assertVoucherInvariant } from './helpers/voucherInvariant.js'
import { assertSlotInvariant } from './helpers/slotInvariant.js'
import { makeExtra, vouchersMade } from './helpers/cart.js'
import { changeCompetition, changeOk, surchargeOk } from './helpers/competitionChange.js'

const BIEG_5 = (capacity = 50) =>
  ({ name: 'Bieg 5 km', discipline: 'run', distanceLabel: '5 km', startTime: '11:00', capacity })
const BIEG_21 = (capacity = 50) =>
  ({ name: 'Bieg 21 km', discipline: 'run', distanceLabel: '21 km', startTime: '09:30', capacity })

let owner, ownerId
const competitionsSeen = new Set()
const seen = (event) => { event.categoryIds.forEach((c) => competitionsSeen.add(c)); return event }

before(async () => {
  localEnv()
  await resetThrottle()
  await acceptAgreement('zatyrani-test')
  owner = await sessionFor('owner@zatyrani-test.local')
  ownerId = await profileFor('owner@zatyrani-test.local')
})
afterEach(async () => {
  const competitions = [...competitionsSeen]
  const vouchers = [...vouchersMade]
  competitionsSeen.clear()
  vouchersMade.clear()
  for (const id of competitions) await assertSlotInvariant(id)
  for (const id of vouchers) await assertVoucherInvariant(id)
})

function ok(r) { assert.equal(r.error, null, r.error?.message); return r.data }
const refused = (r, message) => {
  assert.equal(r.data, null)
  assert.equal(r.error?.message, message)
}
const taken = async (categoryId) => (await competitionOf(categoryId)).taken
const reg = (id) => one('registrations', { id })
async function update(table, values, match) {
  const { error } = await db().from(table).update(values).match(match)
  if (error) throw error
}

/** 9 km 60 zł, 5 km 40 zł, 21 km 80 zł. */
async function paidEvent({ capacity21 = 50 } = {}) {
  return seen(await createPublishedPaidEvent(owner, {
    competitions: [BIEG(), BIEG_5(), BIEG_21(capacity21)],
    prices: { 'Bieg 9 km': 6000, 'Bieg 5 km': 4000, 'Bieg 21 km': 8000 },
  }))
}

/** A paid 9 km entry with a pending 20 zł surcharge to 21 km → { a, s, c9, c5, c21, event }. */
async function withSurcharge() {
  const event = await paidEvent()
  const [c9, c5, c21] = event.categoryIds
  const a = await paidEntry(event)
  const s = await surchargeOk(a.reg.id, c21, 2000)
  return { event, a, s, c9, c5, c21 }
}

/** The target's last place taken by somebody else: capacity 1 and one paid entry. */
async function fill(event, categoryId) {
  await update('competitions', { capacity: 1 }, { category_id: categoryId })
  await paidEntry(event, { categoryId })
}

const lateRefundOf = (out, reason) => {
  assert.equal(out.outcome, 'late_refund')
  assert.equal(out.refund.reason, reason)
  assert.equal(out.refund.grosze, 2000)
}

// ---------------------------------------------------------------- CC-20 paid

test('CC-20 a paid surcharge moves the entry: price += D, list_price = L2, one slot moves, the order is paid', async () => {
  const { a, s, c9, c21 } = await withSurcharge()
  assert.deepEqual([await taken(c9), await taken(c21)], [1, 0])
  const att = await attemptFor(s.orderId, 2000)
  const out = await confirmOk(s.orderId, att.txn, 2000)
  assert.deepEqual(out, { outcome: 'surcharge_moved', orderId: s.orderId, registrationId: a.reg.id })

  const r = await reg(a.reg.id)
  assert.equal(r.category_id, c21)
  assert.equal(r.status, 'confirmed')
  assert.equal(r.price, 8000)
  assert.equal(r.list_price, 8000)
  assert.equal(r.refunded, 0)
  assert.equal(r.order_id, a.orderId, 'order_id is never repointed')
  assert.equal((await one('participants', { id: r.participant_id })).category_id, c21)
  assert.deepEqual([await taken(c9), await taken(c21)], [0, 1])

  const o = await orderOf(s.orderId)
  assert.equal(o.status, 'paid')
  assert.equal(o.paid_transaction_id, att.txn)
  assert.ok(o.paid_at)
  assert.equal((await orderOf(a.orderId)).status, 'paid')
  assert.equal((await rows('refunds', { order_id: s.orderId })).length, 0)
  // A replay of the same payment changes nothing.
  assert.equal((await confirmOk(s.orderId, att.txn, 2000)).outcome, 'already_confirmed')
  assert.equal((await reg(a.reg.id)).price, 8000)
})

test('CC-20 an expired surcharge paid later still moves the entry when every check passes', async () => {
  const { a, s, c21 } = await withSurcharge()
  const att = await attemptFor(s.orderId, 2000)
  await overdue(s.orderId)
  ok(await rpc('expire_orders', {}))
  assert.equal((await orderOf(s.orderId)).status, 'expired')
  const out = await confirmOk(s.orderId, att.txn, 2000)
  assert.equal(out.outcome, 'surcharge_moved')
  assert.equal((await reg(a.reg.id)).category_id, c21)
  assert.equal((await orderOf(s.orderId)).status, 'paid')
})

test('CC-20 an expired surcharge paid after the entry moved elsewhere is refunded (entry_changed)', async () => {
  const { a, s, c9, c5 } = await withSurcharge()
  const att = await attemptFor(s.orderId, 2000)
  await overdue(s.orderId)
  // A pending surcharge past its window no longer blocks: change_competition expires it inline.
  const s2 = await changeOk(a.reg.id, c5, -2000)
  assert.equal(s2.outcome, 'refund')
  assert.equal((await orderOf(s.orderId)).status, 'expired')
  ok(await rpc('finish_organizer_refund', { p_refund_id: s2.refundId, p_outcome: 'accepted' }))
  // The entry is in 5 km now, not in 9 km where the old surcharge started.
  lateRefundOf(await confirmOk(s.orderId, att.txn, 2000), 'entry_changed')
  const r = await reg(a.reg.id)
  assert.equal(r.category_id, c5)
  assert.equal(r.status, 'confirmed')
  assert.equal((await orderOf(s.orderId)).status, 'expired')
  assert.equal(await taken(c9), 0)
})

test('CC-20 an expired surcharge paid while a newer surcharge is pending is refunded (entry_changed)', async () => {
  const { a, s, c9, c21 } = await withSurcharge()
  const att = await attemptFor(s.orderId, 2000)
  await overdue(s.orderId)
  const s2 = await surchargeOk(a.reg.id, c21, 2000)
  lateRefundOf(await confirmOk(s.orderId, att.txn, 2000), 'entry_changed')
  assert.equal((await reg(a.reg.id)).category_id, c9)
  assert.equal((await orderOf(s2.orderId)).status, 'pending')
  // The newer one still moves it.
  const att2 = await attemptFor(s2.orderId, 2000)
  assert.equal((await confirmOk(s2.orderId, att2.txn, 2000)).outcome, 'surcharge_moved')
  assert.equal((await reg(a.reg.id)).category_id, c21)
})

test('CC-20 a pending surcharge past its window does not block a new change (expired inline)', async () => {
  const { a, s, c21 } = await withSurcharge()
  refused(await changeCompetition(a.reg.id, c21, 2000), 'surcharge_open')
  await overdue(s.orderId)
  const s2 = await surchargeOk(a.reg.id, c21, 2000)
  assert.notEqual(s2.orderId, s.orderId)
  assert.equal((await orderOf(s.orderId)).status, 'expired')
  assert.equal((await orderOf(s2.orderId)).status, 'pending')
})

test('CC-20 a replayed IPN of a paid surcharge: already_confirmed, the entry moved once, taken unchanged', async () => {
  const { a, s, c9, c21 } = await withSurcharge()
  const att = await attemptFor(s.orderId, 2000)
  assert.equal((await confirmOk(s.orderId, att.txn, 2000)).outcome, 'surcharge_moved')
  const after = await reg(a.reg.id)
  const counts = [await taken(c9), await taken(c21)]
  assert.deepEqual(counts, [0, 1])
  assert.equal((await confirmOk(s.orderId, att.txn, 2000)).outcome, 'already_confirmed')
  assert.deepEqual(await reg(a.reg.id), after)
  assert.deepEqual([await taken(c9), await taken(c21)], counts)
  assert.equal((await rows('refunds', { order_id: s.orderId })).length, 0)
})

// ---------------------------------------------------------------- CC-21 full

test('CC-21 paid into a full target: late_refund full in full, the entry stays, the surcharge is cancelled', async () => {
  const { event, a, s, c9, c21 } = await withSurcharge()
  const att = await attemptFor(s.orderId, 2000)
  await fill(event, c21)
  const out = await confirmOk(s.orderId, att.txn, 2000)
  lateRefundOf(out, 'full')
  const r = await reg(a.reg.id)
  assert.equal(r.category_id, c9)
  assert.equal(r.price, 6000)
  assert.equal(r.list_price, 6000)
  assert.deepEqual([await taken(c9), await taken(c21)], [1, 1])
  const o = await orderOf(s.orderId)
  assert.equal(o.status, 'cancelled')
  assert.equal(o.cancelled_reason, 'full')
  const [f] = await rows('refunds', { order_id: s.orderId })
  assert.equal(f.kind, 'automatic')
  assert.equal(f.amount, 2000)
  assert.ok((await rows('operator_alerts', { order_id: s.orderId })).some((x) => x.kind === 'late_refund'))
})

test('CC-21 registration_order_fits says no for a surcharge into a full target', async () => {
  const { event, s, c21 } = await withSurcharge()
  assert.equal(ok(await rpc('registration_order_fits', { p_order_id: s.orderId })), true)
  await fill(event, c21)
  assert.equal(ok(await rpc('registration_order_fits', { p_order_id: s.orderId })), false)
})

test('CC-21 a hidden target or an unpublished event: late_refund unavailable', async () => {
  const { a, s, c9, c21 } = await withSurcharge()
  const att = await attemptFor(s.orderId, 2000)
  await update('competitions', { hidden_at: new Date().toISOString() }, { category_id: c21 })
  lateRefundOf(await confirmOk(s.orderId, att.txn, 2000), 'unavailable')
  assert.equal((await reg(a.reg.id)).category_id, c9)
  assert.equal((await orderOf(s.orderId)).status, 'cancelled')
})

// ---------------------------------------------------------------- CC-22 entry gone

test('CC-22 an expired surcharge paid after the entry was cancelled: late_refund entry_changed, nothing moves', async () => {
  const { a, s, c9, c21 } = await withSurcharge()
  const att = await attemptFor(s.orderId, 2000)
  await overdue(s.orderId)
  ok(await rpc('expire_orders', {}))
  ok(await rpc('cancel_registration', { p_registration_id: a.reg.id, p_reason: 'organizer', p_actor: ownerId }))
  assert.equal((await orderOf(s.orderId)).status, 'expired', 'an expired surcharge is not cancelled with the entry')
  lateRefundOf(await confirmOk(s.orderId, att.txn, 2000), 'entry_changed')
  const r = await reg(a.reg.id)
  assert.equal(r.status, 'cancelled')
  assert.equal(r.category_id, c9)
  assert.deepEqual([await taken(c9), await taken(c21)], [0, 0])
  assert.equal((await orderOf(s.orderId)).status, 'expired')
})

test('CC-22 a cancelled surcharge paid late: late_refund cancelled', async () => {
  const { a, s, c9 } = await withSurcharge()
  const att = await attemptFor(s.orderId, 2000)
  ok(await rpc('cancel_surcharge', { p_order_id: s.orderId, p_reason: 'organizer_cancelled' }))
  lateRefundOf(await confirmOk(s.orderId, att.txn, 2000), 'cancelled')
  assert.equal((await reg(a.reg.id)).category_id, c9)
})

// ---------------------------------------------------------------- CC-23 closed

test('CC-23 paid more than 5 minutes after closes_at: late_refund closed; inside the grace it moves', async () => {
  const { event, a, s, c9 } = await withSurcharge()
  const att = await attemptFor(s.orderId, 2000)
  await update('payment_attempts', { created_at: minutesFromNow(-20) }, { id: att.id })
  await setSettings(event.eventId, { opens_at: minutesFromNow(-60 * 24), closes_at: minutesFromNow(-10) })
  lateRefundOf(await confirmOk(s.orderId, att.txn, 2000), 'closed')
  assert.equal((await reg(a.reg.id)).category_id, c9)
  assert.equal((await orderOf(s.orderId)).status, 'cancelled')
})

test('CC-23 an attempt made before closes_at and paid within the 5-minute grace moves the entry', async () => {
  const { event, a, s, c21 } = await withSurcharge()
  const att = await attemptFor(s.orderId, 2000)
  await update('payment_attempts', { created_at: minutesFromNow(-10) }, { id: att.id })
  await setSettings(event.eventId, { opens_at: minutesFromNow(-60 * 24), closes_at: minutesFromNow(-2) })
  assert.equal((await confirmOk(s.orderId, att.txn, 2000)).outcome, 'surcharge_moved')
  assert.equal((await reg(a.reg.id)).category_id, c21)
})

// ---------------------------------------------------------------- CC-24 double payment

test('CC-24 a second payment of a paid surcharge is a double payment, refunded in full', async () => {
  const { a, s } = await withSurcharge()
  const one1 = await attemptFor(s.orderId, 2000)
  const two = await attemptFor(s.orderId, 2000)
  assert.equal((await confirmOk(s.orderId, one1.txn, 2000)).outcome, 'surcharge_moved')
  const out = await confirmOk(s.orderId, two.txn, 2000)
  assert.equal(out.outcome, 'double_payment')
  assert.equal(out.refund.grosze, 2000)
  assert.equal((await reg(a.reg.id)).price, 8000)
})

// ---------------------------------------------------------------- CC-25 expiry, orphans, purge, jobs

test('CC-25 a surcharge expires: nothing else changes; the purge 31 days later anonymises no entry', async () => {
  const { a, s, c9, c21 } = await withSurcharge()
  const before = await reg(a.reg.id)
  await overdue(s.orderId)
  ok(await rpc('expire_orders', {}))
  assert.equal((await orderOf(s.orderId)).status, 'expired')
  assert.deepEqual(await reg(a.reg.id), before)
  assert.deepEqual([await taken(c9), await taken(c21)], [1, 0])

  await update('orders', { expires_at: new Date(Date.now() - 31 * 86_400_000).toISOString() }, { id: s.orderId })
  ok(await rpc('purge_expired_registrations', {}))
  assert.deepEqual(await reg(a.reg.id), before, 'the live entry is untouched')
  assert.ok((await orderOf(a.orderId)).buyer_email, 'the paid order keeps its buyer')
  // The unpaid surcharge's own buyer address goes like any order that moved no money.
  assert.equal((await orderOf(s.orderId)).buyer_email, null)
})

test('CC-25 release_orphan_orders never cancels a surcharge waiting for its first payment', async () => {
  const { s } = await withSurcharge()
  await update('orders', { created_at: minutesFromNow(-60) }, { id: s.orderId })
  ok(await rpc('release_orphan_orders', {}))
  assert.equal((await orderOf(s.orderId)).status, 'pending')
})

test('CC-25 job claims: the order claims never stamp a surcharge; the surcharge claims hand it out once', async () => {
  const { s } = await withSurcharge()
  // Reminder: a window of 48 h, created 47 h ago.
  await update('orders', { created_at: minutesFromNow(-47 * 60), expires_at: minutesFromNow(60) }, { id: s.orderId })
  assert.ok(!ok(await rpc('claim_payment_reminders', { p_limit: 1000 })).includes(s.orderId))
  assert.equal((await orderOf(s.orderId)).reminder_sent_at, null)
  assert.deepEqual(ok(await rpc('claim_surcharge_reminders', { p_limit: 1000 })).filter((x) => x === s.orderId), [s.orderId])
  assert.ok(!ok(await rpc('claim_surcharge_reminders', { p_limit: 1000 })).includes(s.orderId))

  // Expired notice.
  await overdue(s.orderId)
  ok(await rpc('expire_orders', {}))
  await update('orders', { expires_at: minutesFromNow(-180) }, { id: s.orderId })
  assert.ok(!ok(await rpc('claim_expired_notices', { p_limit: 1000 })).includes(s.orderId))
  assert.equal((await orderOf(s.orderId)).expired_notified_at, null)
  assert.ok(ok(await rpc('claim_surcharge_expired_notices', { p_limit: 1000 })).includes(s.orderId))
  assert.ok((await orderOf(s.orderId)).expired_notified_at)
  assert.ok(!ok(await rpc('claim_surcharge_expired_notices', { p_limit: 1000 })).includes(s.orderId))
})

test('CC-25 lost confirmations: a paid surcharge is never stamped by the order claim; the surcharge claim returns a moved one', async () => {
  const { a, s } = await withSurcharge()
  const att = await attemptFor(s.orderId, 2000)
  await confirmOk(s.orderId, att.txn, 2000)
  await update('orders', { paid_at: minutesFromNow(-20) }, { id: s.orderId })
  assert.ok(!ok(await rpc('claim_confirmation_resends', { p_limit: 1000 })).includes(s.orderId))
  assert.equal((await orderOf(s.orderId)).confirmation_sent_at, null)
  assert.ok(ok(await rpc('claim_surcharge_confirmations', { p_limit: 1000 })).includes(s.orderId))
  assert.ok((await orderOf(s.orderId)).confirmation_sent_at)

  // A paid surcharge whose entry was cancelled since: stamped, never handed out.
  const t = await withSurcharge()
  const att2 = await attemptFor(t.s.orderId, 2000)
  await confirmOk(t.s.orderId, att2.txn, 2000)
  ok(await rpc('cancel_registration', { p_registration_id: t.a.reg.id, p_reason: 'organizer', p_actor: ownerId }))
  await update('orders', { paid_at: minutesFromNow(-20) }, { id: t.s.orderId })
  assert.ok(!ok(await rpc('claim_surcharge_confirmations', { p_limit: 1000 })).includes(t.s.orderId))
  assert.ok((await orderOf(t.s.orderId)).confirmation_sent_at)
  void a
})

test('CC-25 the new claims are service_role only', async () => {
  const anon = createClient(localEnv().url, localEnv().anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  for (const client of [anon, authenticatedClient()]) {
    for (const fn of ['claim_surcharge_reminders', 'claim_surcharge_expired_notices', 'claim_surcharge_confirmations']) {
      const { error } = await client.rpc(fn, { p_limit: 1 })
      assert.match(error?.message ?? '', /permission denied/, fn)
    }
  }
})

// ---------------------------------------------------------------- CC-26 / CC-27 refund finish

test('CC-26 refunding the original line in full leaves an entry with a paid surcharge confirmed; the rest cancels it', async () => {
  const { a, s, c21 } = await withSurcharge()
  const att = await attemptFor(s.orderId, 2000)
  await confirmOk(s.orderId, att.txn, 2000)
  const [entryLine] = await rows('order_lines', { order_id: a.orderId })
  const [surLine] = await rows('order_lines', { order_id: s.orderId })

  const first = ok(await rpc('reserve_organizer_refund', {
    p_line_id: entryLine.id, p_grosze: 6000, p_actor: ownerId, p_request_key: crypto.randomUUID(), p_registration_id: a.reg.id,
  }))
  const f1 = ok(await rpc('finish_organizer_refund', { p_refund_id: first.refundId, p_outcome: 'accepted' }))
  assert.deepEqual(f1.cancelled, [])
  let r = await reg(a.reg.id)
  assert.equal(r.status, 'confirmed')
  assert.equal(r.refunded, 6000)
  assert.equal(await taken(c21), 1)

  const second = ok(await rpc('reserve_organizer_refund', {
    p_line_id: surLine.id, p_grosze: 2000, p_actor: ownerId, p_request_key: crypto.randomUUID(), p_registration_id: a.reg.id,
  }))
  const f2 = ok(await rpc('finish_organizer_refund', { p_refund_id: second.refundId, p_outcome: 'accepted' }))
  assert.equal(f2.cancelled.length, 1)
  r = await reg(a.reg.id)
  assert.equal(r.status, 'cancelled')
  assert.equal(r.refunded, 8000)
  assert.equal(await taken(c21), 0)
})

test('CC-26 a rejected refund of a surcharge line gives back the line and the entry', async () => {
  const { a, s } = await withSurcharge()
  const att = await attemptFor(s.orderId, 2000)
  await confirmOk(s.orderId, att.txn, 2000)
  const [surLine] = await rows('order_lines', { order_id: s.orderId })
  for (const outcome of ['rejected', 'insufficient_balance']) {
    const res = ok(await rpc('reserve_organizer_refund', {
      p_line_id: surLine.id, p_grosze: 1500, p_actor: ownerId, p_request_key: crypto.randomUUID(),
    }))
    assert.equal((await reg(a.reg.id)).refunded, 1500)
    ok(await rpc('finish_organizer_refund', { p_refund_id: res.refundId, p_outcome: outcome }))
    assert.equal((await reg(a.reg.id)).refunded, 0)
    assert.equal((await one('order_lines', { id: surLine.id })).refunded, 0)
  }
})

test('CC-26 an entry that never moved: a full refund of its line still cancels it (unchanged)', async () => {
  const event = await paidEvent()
  const a = await paidEntry(event)
  const [line] = await rows('order_lines', { order_id: a.orderId })
  const part = ok(await rpc('reserve_organizer_refund', {
    p_line_id: line.id, p_grosze: 1000, p_actor: ownerId, p_request_key: crypto.randomUUID(),
  }))
  assert.deepEqual(ok(await rpc('finish_organizer_refund', { p_refund_id: part.refundId, p_outcome: 'accepted' })).cancelled, [])
  const rest = ok(await rpc('reserve_organizer_refund', {
    p_line_id: line.id, p_grosze: 5000, p_actor: ownerId, p_request_key: crypto.randomUUID(),
  }))
  assert.equal(ok(await rpc('finish_organizer_refund', { p_refund_id: rest.refundId, p_outcome: 'accepted' })).cancelled.length, 1)
  assert.equal((await reg(a.reg.id)).status, 'cancelled')
})

test('CC-26 an extra line\'s refund still in flight does not stop a full entry refund from cancelling the entry', async () => {
  const event = await paidEvent()
  const { variants: { M } } = await makeExtra(event, { variants: [['M', 10]] })
  const a = await paidEntry(event, { variant: M, displayed: 6000 + 4500 })
  const lines = await rows('order_lines', { order_id: a.orderId })
  const entryLine = lines.find((l) => l.kind === 'entry')
  const extraLine = lines.find((l) => l.kind === 'extra')
  const extra = ok(await rpc('reserve_organizer_refund', {
    p_line_id: extraLine.id, p_grosze: 4500, p_actor: ownerId, p_request_key: crypto.randomUUID(),
  }))
  await ageRefund(extra.refundId)
  const full = ok(await rpc('reserve_organizer_refund', {
    p_line_id: entryLine.id, p_grosze: 6000, p_actor: ownerId, p_request_key: crypto.randomUUID(),
  }))
  const fin = ok(await rpc('finish_organizer_refund', { p_refund_id: full.refundId, p_outcome: 'accepted' }))
  assert.equal(fin.cancelled.length, 1)
  assert.equal((await reg(a.reg.id)).status, 'cancelled')
  assert.equal((await one('refunds', { id: extra.refundId })).dpay_status, 'unknown')
})

test('CC-32 cancelling an entry cancels its pending surcharge (cancel_registration)', async () => {
  const { a, s, c9 } = await withSurcharge()
  const att = await attemptFor(s.orderId, 2000)
  ok(await rpc('cancel_registration', { p_registration_id: a.reg.id, p_reason: 'organizer', p_actor: ownerId }))
  const o = await orderOf(s.orderId)
  assert.equal(o.status, 'cancelled')
  assert.equal(o.cancelled_reason, 'entry_cancelled')
  assert.equal(await taken(c9), 0)
  // A payment in flight lands on the cancelled surcharge and is refunded in full.
  lateRefundOf(await confirmOk(s.orderId, att.txn, 2000), 'cancelled')
})

test('CC-32 a refund that cancels the entry cancels its pending surcharge (finish_organizer_refund, record_external_refund)', async () => {
  for (const via of ['dpay', 'external']) {
    const { a, s } = await withSurcharge()
    const [line] = await rows('order_lines', { order_id: a.orderId })
    let out
    if (via === 'dpay') {
      const res = ok(await rpc('reserve_organizer_refund', {
        p_line_id: line.id, p_grosze: 6000, p_actor: ownerId, p_request_key: crypto.randomUUID(),
      }))
      out = ok(await rpc('finish_organizer_refund', { p_refund_id: res.refundId, p_outcome: 'accepted' }))
    } else {
      out = ok(await rpc('record_external_refund', { p_line_id: line.id, p_grosze: 6000, p_note: 'LG test: panel dpay 60 zł' }))
    }
    assert.equal(out.cancelled.length, 1, via)
    assert.equal((await reg(a.reg.id)).status, 'cancelled', via)
    const o = await orderOf(s.orderId)
    assert.equal(o.status, 'cancelled', via)
    assert.equal(o.cancelled_reason, 'entry_cancelled', via)
  }
})

test('CC-33 create_transfer refuses surcharge_open while a surcharge in its window is pending; past it, the invite goes', async () => {
  const { event, a, s } = await withSurcharge()
  await enableTransfers(event)
  refused((await invite(a.reg.id, a.profileId)).result, 'surcharge_open')
  await overdue(s.orderId)
  const { result } = await invite(a.reg.id, a.profileId)
  assert.equal(result.error, null, result.error?.message)
})

test('CC-27 an accepted competition_change refund down to 0 zł leaves the entry confirmed', async () => {
  const event = seen(await createPublishedPaidEvent(owner, {
    competitions: [BIEG(), BIEG_5()], prices: { 'Bieg 9 km': 6000, 'Bieg 5 km': 0 },
  }))
  const [, c5] = event.categoryIds
  const a = await paidEntry(event)
  const out = await changeOk(a.reg.id, c5, -6000)
  const fin = ok(await rpc('finish_organizer_refund', { p_refund_id: out.refundId, p_outcome: 'accepted' }))
  assert.deepEqual(fin.cancelled, [])
  const r = await reg(a.reg.id)
  assert.equal(r.status, 'confirmed')
  assert.equal(r.category_id, c5)
  assert.equal(r.refunded, 6000)
  assert.equal(r.price, 6000)
})

// ---------------------------------------------------------------- CC-28 too_many_pending

test('CC-28 a buyer with an open surcharge can still place two unpaid orders', async () => {
  const { event, a, s, c5 } = await withSurcharge()
  assert.equal((await orderOf(s.orderId)).buyer_profile_id, a.profileId)
  const opts = { buyerEmail: a.email, profileId: a.profileId }
  await orderGroupOk(event, [adult(c5, 'adult')], opts)
  await orderGroupOk(event, [adult(c5, 'adult')], opts)
})

// ---------------------------------------------------------------- CC-29 transfers

test('CC-29 a transfer is refused while a surcharge is pending; a pending one past its window is expired instead', async () => {
  const { event, a, s, c9 } = await withSurcharge()
  refused(await organizerTransfer(event, a.reg.id, ownerId, { categoryId: c9 }), 'surcharge_open')
  await overdue(s.orderId)
  const t = ok(await organizerTransfer(event, a.reg.id, ownerId, { categoryId: c9 }))
  assert.ok(t.registrationId)
  assert.equal((await orderOf(s.orderId)).status, 'expired')
})

test('CC-29 a paid surcharge line moves to the new holder with the entry', async () => {
  const { event, a, s, c21 } = await withSurcharge()
  const att = await attemptFor(s.orderId, 2000)
  await confirmOk(s.orderId, att.txn, 2000)
  const t = ok(await organizerTransfer(event, a.reg.id, ownerId, { categoryId: c21 }))
  const [surLine] = await rows('order_lines', { order_id: s.orderId })
  assert.equal(surLine.registration_id, t.registrationId)
  const n = await reg(t.registrationId)
  assert.equal(n.price, 8000)
  assert.equal(n.list_price, 8000)
  assert.equal(n.category_id, c21)
  assert.equal((await reg(a.reg.id)).status, 'transferred_out')
})

// ---------------------------------------------------------------- CC-30 external refunds

test('CC-30 an external refund of a surcharge line adds to the entry and never cancels a partial', async () => {
  const { a, s } = await withSurcharge()
  const att = await attemptFor(s.orderId, 2000)
  await confirmOk(s.orderId, att.txn, 2000)
  const [surLine] = await rows('order_lines', { order_id: s.orderId })
  const out = ok(await rpc('record_external_refund', { p_line_id: surLine.id, p_grosze: 2000, p_note: 'LG test: panel dpay 20 zł' }))
  assert.deepEqual(out.cancelled, [])
  const r = await reg(a.reg.id)
  assert.equal(r.refunded, 2000)
  assert.equal(r.status, 'confirmed')
})

// ---------------------------------------------------------------- CC-31 paid offline

test('CC-31 a surcharge cannot be marked paid outside the system (it would not move the entry)', async () => {
  const { s } = await withSurcharge()
  refused(await rpc('organizer_mark_paid_offline', { p_order_id: s.orderId, p_actor: ownerId, p_note: 'gotówka' }), 'surcharge')
  assert.equal((await orderOf(s.orderId)).status, 'pending')
})

