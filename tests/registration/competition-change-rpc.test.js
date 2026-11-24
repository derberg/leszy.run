// Competition change, task 3: change_competition (move now, move and reserve a difference refund,
// or create a surcharge order), registration_move_entry and cancel_surcharge. Scenarios CC-01…CC-13
// in docs/registration/scenario-matrix.md. LOCAL stack only.
import { afterEach, before, test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { localEnv, resetThrottle, sessionFor } from './helpers/stack.js'
import { acceptAgreement, createPublishedFreeEvent, createPublishedPaidEvent } from './helpers/registrationFixtures.js'
import { attemptFor, competitionOf, confirmOk, db, one, orderOf, profileFor, rows, rpc, runnerEmail, setSettings } from './helpers/orders.js'
import { BIEG, DZIECI, adult, minor, orderGroupOk } from './helpers/groups.js'
import { STAFETA, captain, teamOk } from './helpers/teams.js'
import { makeVoucher, vouchersMade } from './helpers/cart.js'
import { freeEntry, inviteOk, paidEntry, enableTransfers } from './helpers/transfers.js'
import { assertVoucherInvariant } from './helpers/voucherInvariant.js'
import { assertSlotInvariant } from './helpers/slotInvariant.js'
import { cancelSurcharge, changeCompetition, changeOk } from './helpers/competitionChange.js'

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

const refused = (r, message) => {
  assert.equal(r.data, null)
  assert.equal(r.error?.message, message)
}
const taken = async (categoryId) => (await competitionOf(categoryId)).taken
const reg = (id) => one('registrations', { id })

/** 9 km 60 zł, 5 km 40 zł, 21 km 80 zł unless `prices` say otherwise. */
async function paidEvent({ prices = {}, competitions } = {}) {
  return seen(await createPublishedPaidEvent(owner, {
    competitions: competitions ?? [BIEG(), BIEG_5(), BIEG_21()],
    prices: { 'Bieg 9 km': 6000, 'Bieg 5 km': 4000, 'Bieg 21 km': 8000, ...prices },
  }))
}

async function update(table, values, match) {
  const { error } = await db().from(table).update(values).match(match)
  if (error) throw error
}

const snapshot = async (id) => {
  const r = await reg(id)
  return { category: r.category_id, price: r.price, list: r.list_price, refunded: r.refunded, status: r.status }
}

// ---------------------------------------------------------------- CC-01 same price

test('CC-01 same price: the entry moves at once, one slot moves, the participant follows', async () => {
  const event = await paidEvent({ prices: { 'Bieg 5 km': 6000 } })
  const [c9, c5] = event.categoryIds
  const a = await paidEntry(event)
  assert.deepEqual([await taken(c9), await taken(c5)], [1, 0])

  const out = await changeOk(a.reg.id, c5, 0, { actor: ownerId })
  assert.deepEqual(out, { outcome: 'moved', grosze: 0 })
  assert.deepEqual([await taken(c9), await taken(c5)], [0, 1])
  const r = await reg(a.reg.id)
  assert.equal(r.category_id, c5)
  assert.equal(r.status, 'confirmed')
  assert.equal(r.price, 6000)
  assert.equal(r.list_price, 6000)
  assert.equal(r.refunded, 0)
  assert.equal(r.age_group_label, 'K open')
  assert.equal(r.kids_group_id, null)
  assert.equal(r.order_id, a.orderId, 'order_id is never repointed')
  const part = await one('participants', { id: r.participant_id })
  assert.equal(part.category_id, c5)
  assert.equal((await rows('refunds', { order_id: a.orderId })).length, 0)
})

test('CC-01 a free event with no order: 0 zł to 0 zł moves', async () => {
  const event = seen(await createPublishedFreeEvent(owner, { competitions: [BIEG(), BIEG_5()] }))
  const [c9, c5] = event.categoryIds
  const a = await freeEntry(event)
  const out = await changeOk(a.reg.id, c5, 0, { actor: ownerId })
  assert.equal(out.outcome, 'moved')
  assert.deepEqual([await taken(c9), await taken(c5)], [0, 1])
  const r = await reg(a.reg.id)
  assert.equal(r.category_id, c5)
  assert.equal(r.order_id, null)
})

test('CC-01 the age group is re-derived from the target competition', async () => {
  const event = await paidEvent({ prices: { 'Bieg 5 km': 6000 } })
  const [, c5] = event.categoryIds
  const { error } = await db().from('age_groups')
    .insert({ category_id: c5, gender: 'K', label: 'K30', min_age: 30, max_age: 39 })
  if (error) throw error
  const a = await paidEntry(event)
  await changeOk(a.reg.id, c5, 0)
  assert.equal((await reg(a.reg.id)).age_group_label, 'K30')
})

// ---------------------------------------------------------------- CC-02 / CC-03 cheaper

test('CC-02 cheaper: moves now and reserves an organizer refund of the difference', async () => {
  const event = await paidEvent()
  const [c9, c5] = event.categoryIds
  const a = await paidEntry(event)
  const [line] = await rows('order_lines', { order_id: a.orderId })

  const out = await changeOk(a.reg.id, c5, -2000, { actor: ownerId })
  assert.equal(out.outcome, 'refund')
  assert.equal(out.grosze, 2000)
  assert.ok(out.refundId)
  assert.equal(out.refunds.length, 1)
  assert.equal(out.refunds[0].refundId, out.refundId)
  assert.equal(out.refunds[0].transactionId, a.txn)

  const f = await one('refunds', { id: out.refundId })
  assert.equal(f.kind, 'organizer')
  assert.equal(f.reason, 'competition_change')
  assert.equal(f.amount, 2000)
  assert.equal(f.dpay_status, 'pending')
  assert.equal(f.order_line_id, line.id)
  assert.equal(f.requested_by, ownerId)
  assert.equal(f.payment_attempt_id, a.attemptId)

  const r = await reg(a.reg.id)
  assert.equal(r.category_id, c5)
  assert.equal(r.status, 'confirmed')
  assert.equal(r.price, 6000, 'price is everything paid')
  assert.equal(r.refunded, 2000)
  assert.equal(r.list_price, 4000)
  assert.equal(r.price - r.refunded, 4000)
  assert.equal((await one('order_lines', { id: line.id })).refunded, 2000)
  assert.deepEqual([await taken(c9), await taken(c5)], [0, 1])
})

test('CC-03 to a 0 zł competition: the whole held amount is refunded, the entry stays', async () => {
  const event = await paidEvent({ prices: { 'Bieg 5 km': 0 } })
  const [, c5] = event.categoryIds
  const a = await paidEntry(event)
  const out = await changeOk(a.reg.id, c5, -6000, { actor: ownerId })
  assert.equal(out.outcome, 'refund')
  assert.equal(out.grosze, 6000)
  const r = await reg(a.reg.id)
  assert.equal(r.status, 'confirmed')
  assert.equal(r.refunded, 6000)
  assert.equal(r.price, 6000)
  assert.equal(r.list_price, 0)
  assert.equal((await one('refunds', { id: out.refundId })).amount, 6000)
})

test('CC-02 a refund is refused from 00:00 Warsaw on race day (race_day), nothing changes', async () => {
  const event = await paidEvent()
  const [, c5] = event.categoryIds
  const a = await paidEntry(event)
  const before = await snapshot(a.reg.id)
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(new Date())
  await setSettings(event.eventId, { event_date: today, closes_at: new Date(Date.now() + 3_600_000).toISOString() })
  refused(await changeCompetition(a.reg.id, c5, -2000), 'race_day')
  assert.deepEqual(await snapshot(a.reg.id), before)
})

// ---------------------------------------------------------------- CC-04 offline

test('CC-04 an order paid outside LESZY.RUN: refused without the acknowledgement, moved with it, no refunds row', async () => {
  const event = await paidEvent()
  const [c9, c5] = event.categoryIds
  const email = runnerEmail('offline')
  const out = await orderGroupOk(event, [adult(c9, 'self', email)])
  const marked = await rpc('organizer_mark_paid_offline', { p_order_id: out.orderId, p_actor: ownerId, p_note: 'gotówka w biurze' })
  assert.equal(marked.error, null, marked.error?.message)
  const [r0] = await rows('registrations', { order_id: out.orderId })
  assert.equal(r0.status, 'confirmed')

  refused(await changeCompetition(r0.id, c5, -2000), 'offline_paid')
  refused(await changeCompetition(r0.id, c5, -2000, { offlineAck: false }), 'offline_paid')
  assert.equal((await reg(r0.id)).category_id, c9)

  const done = await changeOk(r0.id, c5, -2000, { offlineAck: true })
  assert.deepEqual(done, { outcome: 'moved_offline_refund', grosze: 2000 })
  const r = await reg(r0.id)
  assert.equal(r.category_id, c5)
  assert.equal(r.refunded, 2000)
  assert.equal(r.price, 6000)
  assert.equal(r.list_price, 4000)
  assert.equal((await rows('refunds', { order_id: out.orderId })).length, 0)
  assert.deepEqual([await taken(c9), await taken(c5)], [0, 1])
})

// ---------------------------------------------------------------- CC-05 / CC-06 dearer

test('CC-05 dearer: a pending surcharge order for the difference, the entry and the slots untouched', async () => {
  const event = await paidEvent()
  const [c9, , c21] = event.categoryIds
  const a = await paidEntry(event)
  const before = await snapshot(a.reg.id)
  const original = await orderOf(a.orderId)

  const out = await changeOk(a.reg.id, c21, 2000, { actor: ownerId })
  assert.equal(out.outcome, 'surcharge')
  assert.equal(out.grosze, 2000)
  const o = await orderOf(out.orderId)
  assert.equal(o.kind, 'surcharge')
  assert.equal(o.status, 'pending')
  assert.equal(o.event_id, event.eventId)
  assert.equal(o.entry_total, 2000)
  assert.equal(o.extras_total, 0)
  assert.equal(o.donation, 0)
  assert.equal(o.total, 2000)
  assert.equal(o.tier_id, original.tier_id)
  assert.equal(o.buyer_profile_id, original.buyer_profile_id)
  assert.equal(o.buyer_email, original.buyer_email)
  assert.equal(o.surcharge_registration_id, a.reg.id)
  assert.equal(o.surcharge_from_category_id, c9)
  assert.equal(o.surcharge_to_category_id, c21)
  assert.equal(o.surcharge_list_price, 8000)
  assert.equal(o.surcharge_price, 8000)
  const closes = (await one('registration_settings', { event_id: event.eventId })).closes_at
  assert.ok(new Date(o.expires_at) <= new Date(closes))
  assert.ok(new Date(o.expires_at) > new Date())
  const lines = await rows('order_lines', { order_id: out.orderId })
  assert.equal(lines.length, 1)
  assert.equal(lines[0].kind, 'surcharge')
  assert.equal(lines[0].registration_id, a.reg.id)
  assert.equal(lines[0].amount, 2000)

  assert.deepEqual(await snapshot(a.reg.id), before)
  assert.equal((await rows('registrations', { order_id: out.orderId })).length, 0, 'a surcharge owns no registration')
  assert.deepEqual([await taken(c9), await taken(c21)], [1, 0])
})

test('CC-06 a second change while a surcharge is pending is refused (surcharge_open)', async () => {
  const event = await paidEvent()
  const [, c5, c21] = event.categoryIds
  const a = await paidEntry(event)
  await changeOk(a.reg.id, c21, 2000)
  refused(await changeCompetition(a.reg.id, c21, 2000), 'surcharge_open')
  refused(await changeCompetition(a.reg.id, c5, -2000), 'surcharge_open')
})

test('CC-06 cancel_surcharge: a pending surcharge is cancelled and nothing else changes; a new one can follow', async () => {
  const event = await paidEvent()
  const [c9, , c21] = event.categoryIds
  const a = await paidEntry(event)
  const before = await snapshot(a.reg.id)
  const s = await changeOk(a.reg.id, c21, 2000)
  const r1 = await cancelSurcharge(s.orderId, 'organizer_cancelled')
  assert.equal(r1.error, null, r1.error?.message)
  assert.deepEqual(r1.data, { cancelled: true, status: 'cancelled' })
  const o = await orderOf(s.orderId)
  assert.equal(o.status, 'cancelled')
  assert.equal(o.cancelled_reason, 'organizer_cancelled')
  assert.ok(o.cancelled_at)
  assert.deepEqual(await snapshot(a.reg.id), before)
  assert.equal((await orderOf(a.orderId)).status, 'paid')
  assert.equal(await taken(c9), 1)

  const again = await cancelSurcharge(s.orderId)
  assert.deepEqual(again.data, { cancelled: false, status: 'cancelled' })
  refused(await cancelSurcharge(a.orderId), 'not_surcharge')
  refused(await cancelSurcharge(crypto.randomUUID()), 'not_found')

  const s2 = await changeOk(a.reg.id, c21, 2000)
  assert.notEqual(s2.orderId, s.orderId)
})

test('CC-05 the surcharge buyer: the original payer, else the runner, else the runner\'s e-mail alone', async () => {
  const event = await paidEvent()
  const [, , c21] = event.categoryIds
  // The original payer is somebody else than the runner.
  const payer = runnerEmail('payer')
  const runner = runnerEmail('runner')
  const g = await orderGroupOk(event, [adult(event.categoryIds[0], 'adult', runner)], { buyerEmail: payer })
  const att = await attemptFor(g.orderId, g.total)
  await confirmOk(g.orderId, att.txn, g.total)
  const [r] = await rows('registrations', { order_id: g.orderId })

  const s1 = await changeOk(r.id, c21, 2000)
  let o = await orderOf(s1.orderId)
  assert.equal(o.buyer_profile_id, await profileFor(payer))
  assert.equal(o.buyer_email, payer)
  ok(await cancelSurcharge(s1.orderId))

  // The payer's account is gone: the runner's own account pays.
  const runnerProfile = await profileFor(runner)
  await update('orders', { buyer_profile_id: null }, { id: g.orderId })
  await update('registrations', { profile_id: runnerProfile }, { id: r.id })
  const s2 = await changeOk(r.id, c21, 2000)
  o = await orderOf(s2.orderId)
  assert.equal(o.buyer_profile_id, runnerProfile)
  assert.equal(o.buyer_email, runner)
  assert.equal(o.buyer_name, 'Ola Leśna')
  ok(await cancelSurcharge(s2.orderId))

  // Nobody has an account: the order is bound to the runner's e-mail until claimed.
  await update('registrations', { profile_id: null }, { id: r.id })
  const s3 = await changeOk(r.id, c21, 2000)
  o = await orderOf(s3.orderId)
  assert.equal(o.buyer_profile_id, null)
  assert.equal(o.buyer_email, runner)
})

function ok(r) { assert.equal(r.error, null, r.error?.message); return r.data }

// ---------------------------------------------------------------- CC-07 full

test('CC-07 a full target is refused (full) and nothing changes, at the same price and for a surcharge', async () => {
  const event = await paidEvent({
    competitions: [BIEG(), BIEG_5(1), BIEG_21(1)], prices: { 'Bieg 5 km': 6000 },
  })
  const [c9, c5, c21] = event.categoryIds
  await paidEntry(event, { categoryId: c5 })
  await paidEntry(event, { categoryId: c21 })
  const a = await paidEntry(event)
  const before = await snapshot(a.reg.id)
  refused(await changeCompetition(a.reg.id, c5, 0), 'full')
  refused(await changeCompetition(a.reg.id, c21, 2000), 'full')
  assert.deepEqual(await snapshot(a.reg.id), before)
  assert.deepEqual([await taken(c9), await taken(c5), await taken(c21)], [1, 1, 1])
  assert.equal((await rows('orders', { surcharge_registration_id: a.reg.id })).length, 0)
})

// ---------------------------------------------------------------- CC-08…CC-11 refusals

test('CC-08 after closes_at: edits_closed', async () => {
  const event = await paidEvent()
  const [, c5] = event.categoryIds
  const a = await paidEntry(event)
  await setSettings(event.eventId, { closes_at: new Date(Date.now() - 60_000).toISOString() })
  refused(await changeCompetition(a.reg.id, c5, -2000), 'edits_closed')
})

test('CC-09 a team entry: team_competition; an individual entry into a team competition: unavailable', async () => {
  const event = seen(await createPublishedFreeEvent(owner, { competitions: [BIEG(), STAFETA()] }))
  const [c9, cTeam] = event.categoryIds
  await teamOk(event, { categoryId: cTeam, members: [captain(), adult(cTeam, 'adult')] })
  const member = (await rows('registrations', { event_id: event.eventId })).find((x) => x.team_id)
  refused(await changeCompetition(member.id, c9, 0), 'team_competition')
  const a = await freeEntry(event, { categoryId: c9 })
  refused(await changeCompetition(a.reg.id, cTeam, 0), 'unavailable')
})

test('CC-10 a runner too young for the target: ineligible, nothing changes', async () => {
  const event = await paidEvent({ prices: { 'Bieg 5 km': 6000 } })
  const [c9, c5] = event.categoryIds
  await update('competitions', { min_age: 50 }, { category_id: c5 })
  const a = await paidEntry(event)
  refused(await changeCompetition(a.reg.id, c5, 0), 'ineligible')
  assert.equal((await reg(a.reg.id)).category_id, c9)
})

test('CC-11 a stale expected difference: price_changed with the real one', async () => {
  const event = await paidEvent()
  const [, c5, c21] = event.categoryIds
  const a = await paidEntry(event)
  refused(await changeCompetition(a.reg.id, c5, -1000), 'price_changed:-2000')
  refused(await changeCompetition(a.reg.id, c21, 0), 'price_changed:2000')
  refused(await changeCompetition(a.reg.id, c21, null), 'price_changed:2000')
  assert.equal((await rows('refunds', { order_id: a.orderId })).length, 0)
})

test('CC-11 other refusals: same_competition, unavailable, not_live, refund_pending, transfer_open, invalid_kind, not_found', async () => {
  const event = await paidEvent()
  const [c9, c5, c21] = event.categoryIds
  const a = await paidEntry(event)
  refused(await changeCompetition(a.reg.id, c9, 0), 'same_competition')
  refused(await changeCompetition(a.reg.id, c5, -2000, { kind: 'club' }), 'invalid_kind')
  refused(await changeCompetition(crypto.randomUUID(), c5, -2000), 'not_found')
  refused(await changeCompetition(a.reg.id, crypto.randomUUID(), -2000), 'not_found')
  const other = await paidEvent()
  refused(await changeCompetition(a.reg.id, other.categoryIds[1], -2000), 'not_found')

  await update('competitions', { hidden_at: new Date().toISOString() }, { category_id: c21 })
  refused(await changeCompetition(a.reg.id, c21, 2000), 'unavailable')

  // A refund of the entry waiting for dpay.
  const [line] = await rows('order_lines', { order_id: a.orderId })
  const res = ok(await rpc('reserve_organizer_refund', {
    p_line_id: line.id, p_grosze: 500, p_actor: ownerId, p_request_key: crypto.randomUUID(),
  }))
  refused(await changeCompetition(a.reg.id, c5, -1500), 'refund_pending')
  ok(await rpc('finish_organizer_refund', { p_refund_id: res.refundId, p_outcome: 'rejected' }))

  // An open transfer invite.
  await enableTransfers(event)
  await inviteOk(a.reg.id, a.profileId)
  refused(await changeCompetition(a.reg.id, c5, -2000), 'transfer_open')

  // An entry still waiting for its payment.
  const b = await orderGroupOk(event, [adult(c9, 'self')])
  const [rb] = await rows('registrations', { order_id: b.orderId })
  refused(await changeCompetition(rb.id, c5, -2000), 'not_live')
})

// ---------------------------------------------------------------- CC-12 vouchers

test('CC-12 a voucher not offered in the target: the target is priced in full, the voucher stays on the entry', async () => {
  const event = await paidEvent({ prices: { 'Bieg 5 km': 6000 } })
  const [c9, c5] = event.categoryIds
  const voucher = await makeVoucher(event.eventId, { percent: 15, max_uses: 3, categoryIds: [c9] })
  const a = await paidEntry(event, { voucher, displayed: 5100 })
  assert.equal(a.reg.price, 5100)
  refused(await changeCompetition(a.reg.id, c5, 0), 'price_changed:900')
  const out = await changeOk(a.reg.id, c5, 900)
  assert.equal(out.outcome, 'surcharge')
  const o = await orderOf(out.orderId)
  assert.equal(o.surcharge_list_price, 6000)
  assert.equal(o.surcharge_price, 6000)
  const r = await reg(a.reg.id)
  assert.equal(r.voucher_id, voucher.id)
  assert.equal((await one('vouchers', { id: voucher.id })).used, 1)
})

test('CC-12 a voucher offered everywhere keeps its discount in the target; a move to 0 zł keeps the voucher', async () => {
  const event = await paidEvent({ prices: { 'Bieg 5 km': 6000, 'Bieg 21 km': 0 } })
  const [, c5, c21] = event.categoryIds
  const voucher = await makeVoucher(event.eventId, { percent: 15, max_uses: 3 })
  const a = await paidEntry(event, { voucher, displayed: 5100 })
  assert.deepEqual(await changeOk(a.reg.id, c5, 0), { outcome: 'moved', grosze: 0 })
  let r = await reg(a.reg.id)
  assert.equal(r.list_price, 6000)
  assert.equal(r.price, 5100)
  assert.equal(r.voucher_id, voucher.id)

  const out = await changeOk(a.reg.id, c21, -5100)
  assert.equal(out.outcome, 'refund')
  r = await reg(a.reg.id)
  assert.equal(r.voucher_id, voucher.id, 'the use is neither claimed nor released')
  assert.equal(r.refunded, 5100)
  assert.equal((await one('vouchers', { id: voucher.id })).used, 1)
})

// ---------------------------------------------------------------- CC-13 replay

test('CC-13 a replayed request key returns the first refund, nothing is reserved twice', async () => {
  const event = await paidEvent()
  const [, c5] = event.categoryIds
  const a = await paidEntry(event)
  const key = crypto.randomUUID()
  const first = await changeOk(a.reg.id, c5, -2000, { key, actor: ownerId })
  const again = await changeOk(a.reg.id, c5, -2000, { key, actor: ownerId })
  assert.equal(again.outcome, 'refund')
  assert.equal(again.refundId, first.refundId)
  assert.equal(again.grosze, 2000)
  assert.equal(again.replay, true)
  assert.equal((await rows('refunds', { order_id: a.orderId })).length, 1)
  const r = await reg(a.reg.id)
  assert.equal(r.refunded, 2000)

  // The same key for another target is a mismatch, not the first answer.
  const [, , c21] = event.categoryIds
  refused(await changeCompetition(a.reg.id, c21, 0, { key }), 'request_key_mismatch')
  assert.equal((await one('refunds', { id: first.refundId })).change_to_category_id, c5)

  // The same key for another entry is a mismatch.
  const b = await paidEntry(event)
  refused(await changeCompetition(b.reg.id, c5, -2000, { key }), 'request_key_mismatch')
})

// ---------------------------------------------------------------- the money model across moves

test('CC-02 moves add up: 9 km → 5 km → 9 km → 5 km keeps price − refunded equal to the current price', async () => {
  const event = await paidEvent()
  const [c9, c5] = event.categoryIds
  const a = await paidEntry(event)
  const first = await changeOk(a.reg.id, c5, -2000)
  ok(await rpc('finish_organizer_refund', { p_refund_id: first.refundId, p_outcome: 'accepted' }))
  // Back to 9 km: a surcharge of 20 zł (the refunded 20 zł are not credited again).
  const s = await changeOk(a.reg.id, c9, 2000)
  assert.equal(s.outcome, 'surcharge')
  ok(await cancelSurcharge(s.orderId))
  const r = await reg(a.reg.id)
  assert.equal(r.category_id, c5)
  assert.equal(r.price - r.refunded, 4000)
})

test('registration_move_entry and registration_surcharge_buyer are not callable by service_role', async () => {
  const event = await paidEvent()
  const a = await paidEntry(event)
  const m = await rpc('registration_move_entry', { p_registration_id: a.reg.id, p_to: event.categoryIds[1] })
  assert.ok(m.error)
  const b = await rpc('registration_surcharge_buyer', { p_registration_id: a.reg.id })
  assert.ok(b.error)
  assert.equal((await reg(a.reg.id)).category_id, event.categoryIds[0])
})

test('a free entry in a free event cannot be moved into a competition with a price (no_payer)', async () => {
  const event = seen(await createPublishedFreeEvent(owner, { competitions: [BIEG(), BIEG_5()] }))
  const [, c5] = event.categoryIds
  const a = await freeEntry(event)
  // A price appears in the current tier after the entry registered free with no order.
  const { data: tier, error } = await db().from('price_tiers')
    .insert({ event_id: event.eventId, ends_on: null, sort_order: 0 }).select('id').single()
  if (error) throw error
  const { error: pErr } = await db().from('competition_prices')
    .insert({ category_id: c5, tier_id: tier.id, amount: 3000 })
  if (pErr) throw pErr
  refused(await changeCompetition(a.reg.id, c5, 3000), 'no_payer')
})

test('CC-02 a cheaper move after a paid surcharge refunds the surcharge first and splits over both orders', async () => {
  const event = await paidEvent()
  const [c9, c5, c21] = event.categoryIds
  const a = await paidEntry(event)
  const s = await changeOk(a.reg.id, c21, 2000)
  // What task 4's confirm_order does for a paid surcharge, by hand: the order is paid, the entry moves.
  const att = await attemptFor(s.orderId, 2000)
  await update('payment_attempts', { status: 'paid' }, { id: att.id })
  await update('orders', { status: 'paid', paid_at: new Date(Date.now() + 1000).toISOString(), paid_transaction_id: att.txn }, { id: s.orderId })
  await update('registrations', { category_id: c21, list_price: 8000, price: 8000 }, { id: a.reg.id })
  await update('competitions', { taken: 0 }, { category_id: c9 })
  await update('competitions', { taken: 1 }, { category_id: c21 })

  const key = crypto.randomUUID()
  const out = await changeOk(a.reg.id, c5, -4000, { key })
  assert.equal(out.outcome, 'refund')
  assert.equal(out.grosze, 4000)
  assert.deepEqual(out.refunds.map((x) => x.grosze), [2000, 2000])
  assert.deepEqual(out.refunds.map((x) => x.transactionId), [att.txn, a.txn])
  const [surchargeLine] = await rows('order_lines', { order_id: s.orderId })
  const [entryLine] = await rows('order_lines', { order_id: a.orderId })
  assert.equal((await one('order_lines', { id: surchargeLine.id })).refunded, 2000)
  assert.equal((await one('order_lines', { id: entryLine.id })).refunded, 2000)
  const keys = (await rows('refunds', { reason: 'competition_change' }))
    .filter((f) => f.request_key?.startsWith(key)).map((f) => f.request_key).sort()
  assert.deepEqual(keys, [key, `${key}:2`])
  const r = await reg(a.reg.id)
  assert.equal(r.refunded, 4000)
  assert.equal(r.price - r.refunded, 4000)
  assert.deepEqual([await taken(c9), await taken(c5), await taken(c21)], [0, 1, 0])

  const again = await changeOk(a.reg.id, c5, -4000, { key })
  assert.equal(again.refundId, out.refundId)
  assert.equal(again.grosze, 4000)
  assert.equal(again.refunds.length, 2)
})

// ---------------------------------------------------------------- children

const DZIECI_2 = (capacity = 50) =>
  ({ name: 'Bieg dzieci 2 km', discipline: 'run', distanceLabel: '2 km', startTime: '09:30', capacity })

/** A paid group order: the buyer runs 9 km, their child the kids' 1 km. → { orderId, child, buyerEmail } */
async function childEntry(event) {
  const [c9, cKids] = event.categoryIds
  const buyerEmail = runnerEmail('parent')
  const out = await orderGroupOk(event, [adult(c9, 'self', buyerEmail), minor(cKids)])
  const att = await attemptFor(out.orderId, out.total)
  await confirmOk(out.orderId, att.txn, out.total)
  const child = (await rows('registrations', { order_id: out.orderId })).find((x) => x.email === null)
  assert.ok(child)
  return { orderId: out.orderId, child, buyerEmail }
}

async function kidsEvent() {
  return paidEvent({
    competitions: [BIEG(), DZIECI(), DZIECI_2()],
    prices: { 'Bieg dzieci 1 km': 2000, 'Bieg dzieci 2 km': 3000 },
  })
}

test('CC-10 a child entry into an adults-only competition: ineligible (an age rule; the role never changes, the birth date does not)', async () => {
  const event = await paidEvent({
    competitions: [BIEG(), DZIECI(), BIEG_5()],
    prices: { 'Bieg dzieci 1 km': 2000, 'Bieg 5 km': 2000 },
  })
  const [, cKids, c5] = event.categoryIds
  await update('competitions', { min_age: 18 }, { category_id: c5 })
  const { child } = await childEntry(event)
  refused(await changeCompetition(child.id, c5, 0), 'ineligible')
  assert.equal((await reg(child.id)).category_id, cKids)
})

test('CC-01 into a kids competition: the kids group is re-derived from the target', async () => {
  const event = await kidsEvent()
  const [, cKids, cKids2] = event.categoryIds
  await update('competitions', { is_kids: true }, { category_id: cKids2 })
  const { data: group, error } = await db().from('kids_groups')
    .insert({ category_id: cKids2, label: 'Dzieci 2014-2017', birth_year_from: 2014, birth_year_to: 2017 }).select().single()
  if (error) throw error
  await update('competition_prices', { amount: 2000 }, { category_id: cKids2 })
  const { child } = await childEntry(event)
  assert.equal(child.kids_group_id, null)
  assert.deepEqual(await changeOk(child.id, cKids2, 0), { outcome: 'moved', grosze: 0 })
  const r = await reg(child.id)
  assert.equal(r.category_id, cKids2)
  assert.equal(r.kids_group_id, group.id)
  assert.equal(r.age_group_label, 'K open')
  assert.deepEqual([await taken(cKids), await taken(cKids2)], [0, 1])
})

test('CC-05 a child entry\'s surcharge with the payer gone is paid by the guardian\'s account', async () => {
  const event = await kidsEvent()
  const [, , cKids2] = event.categoryIds
  const { orderId, child } = await childEntry(event)
  const guardianEmail = runnerEmail('guardian')
  const guardian = await profileFor(guardianEmail)
  await update('orders', { buyer_profile_id: null }, { id: orderId })
  await update('registrations', { guardian_profile_id: guardian, guardian_name: 'Anna Opiekun' }, { id: child.id })
  const out = await changeOk(child.id, cKids2, 1000)
  assert.equal(out.outcome, 'surcharge')
  const o = await orderOf(out.orderId)
  assert.equal(o.buyer_profile_id, guardian)
  assert.equal(o.buyer_email, guardianEmail)
  assert.equal(o.buyer_name, 'Anna Opiekun')
})
