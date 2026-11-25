// Competition change, task 7: organizer-entry-action's change_competition_preview, change_competition,
// surcharge_cancel and surcharge_remind, end to end through the served function, the mocked dpay and
// the e-mail capture server. Scenarios CC-60… in docs/registration/scenario-matrix.md. LOCAL stack only.
import { after, afterEach, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { resetThrottle, sessionFor } from './helpers/stack.js'
import { messagesTo, startCapture } from './helpers/emailCapture.js'
import { acceptAgreement, callFn, createPublishedPaidEvent } from './helpers/registrationFixtures.js'
import { dpayMode, dpayRefunds, dpayReset, payMock, startDpayMock } from './helpers/dpayControl.js'
import {
  attemptFor, competitionOf, confirmOk, db, one, orderOk, profileFor, rows, rpc, runnerEmail, setSettings,
} from './helpers/orders.js'
import { adult, orderGroupOk } from './helpers/groups.js'
import { makeExtra, makeVoucher, vouchersMade } from './helpers/cart.js'
import { organizerTransfer } from './helpers/transfers.js'
import { nodeDpay } from './helpers/organizerRefund.js'
import { assertSlotInvariant } from './helpers/slotInvariant.js'
import { assertVoucherInvariant } from './helpers/voucherInvariant.js'
import { registerTransaction } from '../../supabase/functions/_shared/dpay.js'

const OWNER = 'owner@zatyrani-test.local'
const C9 = { name: 'Bieg 9 km', discipline: 'run', distanceLabel: '9 km', startTime: '10:00', capacity: 50 }
const C5 = { name: 'Bieg 5 km', discipline: 'run', distanceLabel: '5 km', startTime: '11:00', capacity: 50 }
const C21 = { name: 'Bieg 21 km', discipline: 'run', distanceLabel: '21 km', startTime: '09:30', capacity: 50 }

let owner, member, outsider, ownerId, stopCapture, stopMock
const competitionsSeen = new Set()

before(async () => {
  stopCapture = await startCapture()
  stopMock = await startDpayMock()
  await resetThrottle()
  await acceptAgreement('zatyrani-test')
  owner = await sessionFor(OWNER)
  member = await sessionFor('member@zatyrani-test.local')
  outsider = await sessionFor(runnerEmail('outsider'))
  ownerId = await profileFor(OWNER)
})
after(async () => {
  if (stopMock) await stopMock()
  if (stopCapture) await stopCapture()
})
beforeEach(async () => { await dpayReset() })
afterEach(async () => {
  const competitions = [...competitionsSeen]
  const vouchers = [...vouchersMade]
  competitionsSeen.clear()
  vouchersMade.clear()
  for (const id of competitions) await assertSlotInvariant(id)
  for (const id of vouchers) await assertVoucherInvariant(id)
})

const key = () => crypto.randomUUID()
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })
const act = (session, body) => callFn('organizer-entry-action', session, body)
const actions = (eventId, action) => rows('organizer_actions', { event_id: eventId, action })
const reg = (id) => one('registrations', { id })

/** 9 km 60 zł, 5 km 40 zł, 21 km 80 zł. */
async function paidEvent(prices = {}) {
  const event = await createPublishedPaidEvent(owner, {
    competitions: [C9, C5, C21], prices: { 'Bieg 9 km': 6000, 'Bieg 5 km': 4000, 'Bieg 21 km': 8000, ...prices },
  })
  event.categoryIds.forEach((c) => competitionsSeen.add(c))
  return event
}

/** A paid entry the mock holds as paid (so dpay can refund it) → ids, txn and the payer's address. */
async function paidEntry(event, { email = runnerEmail('cc'), categoryId = event.categoryIds[0], voucher, variant, displayed } = {}) {
  const p = {
    ...adult(categoryId, 'self', email),
    ...(voucher ? { voucherCode: voucher.code } : {}),
    ...(variant ? { extras: [{ variantId: variant.id, qty: 1 }] } : {}),
  }
  const out = await orderGroupOk(event, [p], displayed === undefined ? undefined : { displayed })
  const { transactionId } = await registerTransaction(nodeDpay(), { orderId: out.orderId, grosze: out.total })
  await attemptFor(out.orderId, out.total, transactionId)
  await dpayMode({ dropIpn: true })
  await payMock(transactionId, 'paid')
  await dpayMode({ dropIpn: false })
  assert.equal((await confirmOk(out.orderId, transactionId, out.total)).outcome, 'confirmed')
  const [r] = await rows('registrations', { order_id: out.orderId })
  return { orderId: out.orderId, txn: transactionId, email, registrationId: r.id, total: out.total }
}

async function waitForMail(email, n, { subject } = {}) {
  const pick = async () => (await messagesTo(email)).filter((m) => !subject || m.subject.startsWith(subject))
  for (let i = 0; i < 40; i++) {
    const msgs = await pick()
    if (msgs.length >= n) return msgs
    await sleep(250)
  }
  return pick()
}

const preview = (session, registrationId) => act(session, { action: 'change_competition_preview', registrationId })
const change = (session, registrationId, categoryId, expectedDifference, extra = {}) =>
  act(session, { action: 'change_competition', registrationId, categoryId, expectedDifference, requestKey: key(), ...extra })
const targetOf = (body, categoryId) => body.data.targets.find((t) => t.categoryId === categoryId)

// ---------------------------------------------------------------- CC-60 who

test('CC-60 a member 403 and an outsider 404 on every competition change action; owner 200', async () => {
  const event = await paidEvent()
  const [, c5, c21] = event.categoryIds
  const e = await paidEntry(event)
  const sur = await change(owner, e.registrationId, c21, 2000)
  assert.equal(sur.status, 200, JSON.stringify(sur.body))
  const bodies = [
    { action: 'change_competition_preview', registrationId: e.registrationId },
    { action: 'change_competition', registrationId: e.registrationId, categoryId: c5, expectedDifference: -2000, requestKey: key() },
    { action: 'surcharge_cancel', orderId: sur.body.data.orderId },
    { action: 'surcharge_remind', orderId: sur.body.data.orderId },
  ]
  for (const body of bodies) {
    assert.equal((await act(member, body)).status, 403, `member ${body.action}`)
    assert.equal((await act(outsider, body)).status, 404, `outsider ${body.action}`)
  }
  assert.equal((await act(owner, { action: 'change_competition_preview', registrationId: crypto.randomUUID() })).status, 404)
  assert.equal((await act(owner, { action: 'surcharge_cancel', orderId: crypto.randomUUID() })).status, 404)
  // Nothing moved, nothing cancelled.
  assert.equal((await reg(e.registrationId)).category_id, event.categoryIds[0])
  assert.equal((await one('orders', { id: sur.body.data.orderId })).status, 'pending')
})

// ---------------------------------------------------------------- CC-61 preview

test('CC-61 preview: each other visible individual competition with its price, difference, kind, voucher and extras; ineligible marked', async () => {
  const event = await paidEvent({ 'Bieg 5 km': 6000 })
  const [c9, c5, c21] = event.categoryIds
  // The voucher is offered in 9 km and 21 km only; the extra in 9 km only.
  const voucher = await makeVoucher(event.eventId, { percent: 10, categoryIds: [c9, c21] })
  const { extra, variants } = await makeExtra(event, { name: 'Koszulka', price: 3000, categoryIds: [c9] })
  assert.ok(extra)
  const e = await paidEntry(event, { voucher, variant: variants.M, displayed: 5400 + 3000 })
  const { error } = await db().from('competitions').update({ min_age: 70 }).eq('category_id', c21)
  if (error) throw error

  const r = await preview(owner, e.registrationId)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.deepEqual(r.body.data.entry, { registrationId: e.registrationId, categoryId: c9, held: 5400, offlinePaid: false })
  assert.deepEqual(r.body.data.targets.map((t) => t.categoryId).sort(), [c5, c21].sort())
  assert.deepEqual(targetOf(r.body, c5), {
    categoryId: c5, name: 'Bieg 5 km', listPrice: 6000, price: 6000, difference: 600, kind: 'surcharge',
    voucherKept: false, extrasNotOffered: ['Koszulka'], eligible: true,
  })
  const t21 = targetOf(r.body, c21)
  assert.deepEqual([t21.price, t21.difference, t21.voucherKept, t21.eligible, t21.reason], [7200, 1800, true, false, 'ineligible'])

  // A hidden competition is no target.
  const { error: hErr } = await db().from('competitions').update({ hidden_at: new Date().toISOString() }).eq('category_id', c5)
  if (hErr) throw hErr
  const again = await preview(owner, e.registrationId)
  assert.deepEqual(again.body.data.targets.map((t) => t.categoryId), [c21])
})

test('CC-61 preview of an entry that cannot move answers its refusal: a closed event → 409 edits_closed', async () => {
  const event = await paidEvent()
  const e = await paidEntry(event)
  await setSettings(event.eventId, { closes_at: new Date(Date.now() - 60_000).toISOString() })
  const r = await preview(owner, e.registrationId)
  assert.equal(r.status, 409)
  assert.equal(r.body.code, 'edits_closed')
})

// ---------------------------------------------------------------- CC-62 preview = RPC

test('CC-62 the preview\'s difference is what change_competition applies: same, cheaper, dearer with a kept voucher', async () => {
  const event = await paidEvent({ 'Bieg 5 km': 6000 })
  const [c9, c5, c21] = event.categoryIds
  // same price
  const a = await paidEntry(event)
  const pa = targetOf((await preview(owner, a.registrationId)).body, c5)
  assert.equal(pa.kind, 'same')
  const ra = await change(owner, a.registrationId, c5, pa.difference)
  assert.deepEqual([ra.status, ra.body.data?.outcome], [200, 'moved'], JSON.stringify(ra.body))

  // cheaper: 9 km → 5 km at 40 zł in another event setup is covered below; here 21 km → 9 km
  const b = await paidEntry(event, { categoryId: c21 })
  const pb = targetOf((await preview(owner, b.registrationId)).body, c9)
  assert.equal(pb.difference, -2000)
  const rb = await change(owner, b.registrationId, c9, pb.difference)
  assert.deepEqual([rb.status, rb.body.data?.outcome], [200, 'refund'], JSON.stringify(rb.body))
  assert.equal((await reg(b.registrationId)).price - (await reg(b.registrationId)).refunded, 6000)

  // dearer with a voucher kept in the target
  const voucher = await makeVoucher(event.eventId, { percent: 15, categoryIds: [c9, c21] })
  const c = await paidEntry(event, { voucher, displayed: 5100 })
  const pc = targetOf((await preview(owner, c.registrationId)).body, c21)
  assert.deepEqual([pc.voucherKept, pc.price, pc.difference], [true, 6800, 6800 - 5100])
  const rc = await change(owner, c.registrationId, c21, pc.difference)
  assert.deepEqual([rc.status, rc.body.data?.outcome, rc.body.data?.grosze], [200, 'surcharge', 1700], JSON.stringify(rc.body))
  assert.equal((await one('orders', { id: rc.body.data.orderId })).surcharge_price, 6800)
})

// ---------------------------------------------------------------- CC-63 cheaper, refund accepted

test('CC-63 cheaper, dpay accepts: 200 accepted, the entry moved, one change notice with the refund line, no second refund e-mail, audit rows', async () => {
  const event = await paidEvent()
  const [c9, c5] = event.categoryIds
  const e = await paidEntry(event)
  const name = (await one('registration_settings', { event_id: event.eventId })).name
  const r = await change(owner, e.registrationId, c5, -2000)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.data.outcome, 'refund')
  assert.equal(r.body.data.status, 'accepted')
  assert.equal(r.body.data.grosze, 2000)
  const [refundId] = r.body.data.refundIds
  const refund = await one('refunds', { id: refundId })
  assert.deepEqual([refund.dpay_status, refund.reason, refund.amount], ['accepted', 'competition_change', 2000])
  assert.ok(refund.runner_notified_at, 'claimed, so registration-jobs sends no generic refund mail')
  const after = await reg(e.registrationId)
  assert.deepEqual([after.category_id, after.status, after.price - after.refunded], [c5, 'confirmed', 4000])
  assert.equal((await dpayRefunds()).filter((x) => x.txnId === e.txn).length, 1)

  const mails = await waitForMail(e.email, 1)
  assert.equal(mails.length, 1)
  assert.equal(mails[0].subject, `Zmieniono konkurencję — ${name}`)
  assert.match(mails[0].text, /Zwrot różnicy: 20,00 zł/)

  const changed = await actions(event.eventId, 'competition_changed')
  assert.equal(changed.length, 1)
  assert.equal(changed[0].target, e.registrationId)
  assert.deepEqual(changed[0].payload, { fromCategoryId: c9, toCategoryId: c5, outcome: 'refund', grosze: 2000, refundIds: [refundId] })
  const settled = await actions(event.eventId, 'refund_settled')
  assert.deepEqual(settled.map((a) => [a.target, a.payload.status]), [[refundId, 'accepted']])

  // A replay of the same request answers the stored state and calls dpay no more.
  const requestKey = key()
  const g = await paidEntry(event, { categoryId: c9 })
  const first = await act(owner, { action: 'change_competition', registrationId: g.registrationId, categoryId: c5, expectedDifference: -2000, requestKey })
  assert.equal(first.status, 200)
  const replay = await act(owner, { action: 'change_competition', registrationId: g.registrationId, categoryId: c5, expectedDifference: -2000, requestKey })
  assert.equal(replay.status, 200, JSON.stringify(replay.body))
  assert.equal(replay.body.data.status, 'accepted')
  assert.deepEqual(replay.body.data.refundIds, first.body.data.refundIds)
  assert.equal((await dpayRefunds()).filter((x) => x.txnId === g.txn).length, 1)
  await sleep(400)
  assert.equal((await messagesTo(g.email)).length, 1, 'the notice once')
})

// ---------------------------------------------------------------- CC-64 cheaper, refund refused / unknown / blocked

test('CC-64 cheaper, dpay rejects: 409 rejected, the entry still moved, the money given back to the entry, the notice without a refund line', async () => {
  const event = await paidEvent()
  const [, c5] = event.categoryIds
  const e = await paidEntry(event)
  await dpayMode({ refundRejected: true })
  const r = await change(owner, e.registrationId, c5, -2000)
  assert.equal(r.status, 409, JSON.stringify(r.body))
  assert.equal(r.body.code, 'rejected')
  assert.equal(r.body.data.moved, true)
  const after = await reg(e.registrationId)
  assert.deepEqual([after.category_id, after.refunded], [c5, 0])
  const refund = await one('refunds', { id: r.body.data.refundIds[0] })
  assert.equal(refund.dpay_status, 'rejected')
  const [mail] = await waitForMail(e.email, 1)
  assert.ok(mail)
  assert.doesNotMatch(mail.text, /Zwrot różnicy/)
})

test('CC-64 cheaper, dpay 500: 202 „Zwrot niepotwierdzony.”, the money stays reserved, no refund claimed for the e-mail', async () => {
  const event = await paidEvent()
  const [, c5] = event.categoryIds
  const e = await paidEntry(event)
  await dpayMode({ refundFails: true })
  const r = await change(owner, e.registrationId, c5, -2000)
  assert.equal(r.status, 202, JSON.stringify(r.body))
  assert.equal(r.body.message, 'Zwrot niepotwierdzony.')
  assert.equal(r.body.data.status, 'unknown')
  const refund = await one('refunds', { id: r.body.data.refundIds[0] })
  assert.deepEqual([refund.dpay_status, refund.runner_notified_at], ['unknown', null])
  assert.equal((await reg(e.registrationId)).refunded, 2000)
  assert.equal((await rows('operator_alerts', { order_id: e.orderId, kind: 'refund_unknown' })).length, 1)
  const [mail] = await waitForMail(e.email, 1)
  assert.doesNotMatch(mail.text, /Zwrot różnicy/)
})

test('CC-64 cheaper, dpay 409: 409 refund_blocked, stored rejected, the entry moved', async () => {
  const event = await paidEvent()
  const [, c5] = event.categoryIds
  const e = await paidEntry(event)
  await dpayMode({ refundPending: true })
  const r = await change(owner, e.registrationId, c5, -2000)
  assert.equal(r.status, 409, JSON.stringify(r.body))
  assert.equal(r.body.code, 'refund_blocked')
  assert.equal(r.body.data.moved, true)
  assert.equal((await one('refunds', { id: r.body.data.refundIds[0] })).dpay_status, 'rejected')
  assert.equal((await reg(e.registrationId)).category_id, c5)
})

test('CC-64 cheaper, dpay 406: 409 insufficient_balance, the entry moved, the reservation given back, one alert', async () => {
  const event = await paidEvent()
  const [, c5] = event.categoryIds
  const e = await paidEntry(event)
  await dpayMode({ refundInsufficient: true })
  const r = await change(owner, e.registrationId, c5, -2000)
  assert.equal(r.status, 409, JSON.stringify(r.body))
  assert.equal(r.body.code, 'insufficient_balance')
  assert.equal(r.body.data.moved, true)
  const after = await reg(e.registrationId)
  assert.deepEqual([after.category_id, after.refunded], [c5, 0])
  const refund = await one('refunds', { id: r.body.data.refundIds[0] })
  assert.deepEqual([refund.dpay_status, refund.next_retry_at], ['insufficient_balance', null])
  const [line] = await rows('order_lines', { order_id: e.orderId })
  assert.equal(line.refunded, 0)
  assert.equal((await rows('operator_alerts', { order_id: e.orderId, kind: 'refund_insufficient_balance' })).length, 1)
})

// ---------------------------------------------------------------- CC-65 offline

test('CC-65 an entry paid outside LESZY.RUN: cheaper without the acknowledgement 409 offline_paid; with it 200 moved_offline_refund, no dpay call', async () => {
  const event = await paidEvent()
  const [, c5] = event.categoryIds
  const out = await orderOk(event, { emails: [runnerEmail('off')] })
  const marked = await rpc('organizer_mark_paid_offline', { p_order_id: out.orderId, p_actor: ownerId, p_note: 'gotówka' })
  assert.equal(marked.error, null, marked.error?.message)
  const [r0] = await rows('registrations', { order_id: out.orderId })
  const p = await preview(owner, r0.id)
  assert.equal(p.body.data.entry.offlinePaid, true)
  assert.equal(targetOf(p.body, c5).offlineAck, true)
  const no = await change(owner, r0.id, c5, -2000)
  assert.deepEqual([no.status, no.body.code], [409, 'offline_paid'])
  const yes = await change(owner, r0.id, c5, -2000, { offlineAck: true })
  assert.equal(yes.status, 200, JSON.stringify(yes.body))
  assert.deepEqual([yes.body.data.outcome, yes.body.data.grosze], ['moved_offline_refund', 2000])
  assert.equal((await rows('refunds', { order_id: out.orderId })).length, 0)
  assert.equal((await dpayRefunds()).length, 0)
  // „Opłacone poza systemem” on a surcharge order is refused with its own code.
  const e = await paidEntry(event)
  const sur = await change(owner, e.registrationId, event.categoryIds[2], 2000)
  const mark = await act(owner, { action: 'mark_paid_offline', orderId: sur.body.data.orderId, note: 'gotówka' })
  assert.deepEqual([mark.status, mark.body.code], [409, 'surcharge'])
})

// ---------------------------------------------------------------- CC-66 surcharge

test('CC-66 dearer: a surcharge order, its e-mail to the payer; remind once a day; cancel; audit rows', async () => {
  const event = await paidEvent()
  const [c9, , c21] = event.categoryIds
  const e = await paidEntry(event)
  const name = (await one('registration_settings', { event_id: event.eventId })).name
  const r = await change(owner, e.registrationId, c21, 2000)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.data.outcome, 'surcharge')
  assert.equal(r.body.data.grosze, 2000)
  const { orderId } = r.body.data
  assert.ok(r.body.data.expiresAt)
  assert.equal((await reg(e.registrationId)).category_id, c9, 'the entry moves only when the surcharge is paid')
  const [ask] = await waitForMail(e.email, 1, { subject: 'Dopłata za zmianę konkurencji' })
  assert.equal(ask.subject, `Dopłata za zmianę konkurencji — ${name}`)
  assert.match(ask.text, new RegExp(`/zamowienie/${orderId}`))
  assert.deepEqual((await actions(event.eventId, 'surcharge_created')).map((a) => [a.target, a.payload]),
    [[orderId, { registrationId: e.registrationId, grosze: 2000 }]])
  assert.equal((await actions(event.eventId, 'competition_changed'))[0].payload.outcome, 'surcharge')

  // A second change while the surcharge waits: 409 surcharge_open.
  const twice = await change(owner, e.registrationId, event.categoryIds[1], -2000)
  assert.deepEqual([twice.status, twice.body.code], [409, 'surcharge_open'])

  const remind = await act(owner, { action: 'surcharge_remind', orderId })
  assert.equal(remind.status, 200, JSON.stringify(remind.body))
  const reminders = await waitForMail(e.email, 1, { subject: 'Przypomnienie: dopłata' })
  assert.equal(reminders.length, 1)
  const again = await act(owner, { action: 'surcharge_remind', orderId })
  assert.equal(again.status, 429)
  assert.equal((await actions(event.eventId, 'surcharge_reminded')).length, 1)

  const cancel = await act(owner, { action: 'surcharge_cancel', orderId })
  assert.equal(cancel.status, 200, JSON.stringify(cancel.body))
  assert.equal((await one('orders', { id: orderId })).status, 'cancelled')
  assert.deepEqual((await actions(event.eventId, 'surcharge_cancelled')).map((a) => a.target), [orderId])
  const twiceCancel = await act(owner, { action: 'surcharge_cancel', orderId })
  assert.deepEqual([twiceCancel.status, twiceCancel.body.code], [409, 'cancelled'])
  const remindCancelled = await act(owner, { action: 'surcharge_remind', orderId })
  assert.deepEqual([remindCancelled.status, remindCancelled.body.code], [409, 'cancelled'])

  // surcharge actions only for a surcharge order
  const notSur = await act(owner, { action: 'surcharge_cancel', orderId: e.orderId })
  assert.deepEqual([notSur.status, notSur.body.code], [409, 'not_surcharge'])
})

test('CC-66 surcharge_remind with no payer address left → 409 no_address', async () => {
  const event = await paidEvent()
  const e = await paidEntry(event)
  const r = await change(owner, e.registrationId, event.categoryIds[2], 2000)
  const { orderId } = r.body.data
  // No address to write to: the payer's address is gone.
  const { error } = await db().from('orders').update({ buyer_email: null }).eq('id', orderId)
  if (error) throw error
  const no = await act(owner, { action: 'surcharge_remind', orderId })
  assert.deepEqual([no.status, no.body.code], [409, 'no_address'])
})

// ---------------------------------------------------------------- CC-67 refusals

test('CC-67 refusal mapping: price_changed carries the real difference, 422s carry fields.categoryId, unknown target 404', async () => {
  const event = await paidEvent()
  const [c9, c5] = event.categoryIds
  const e = await paidEntry(event)
  const stale = await change(owner, e.registrationId, c5, -1000)
  assert.deepEqual([stale.status, stale.body.code, stale.body.difference], [409, 'price_changed', -2000])
  const same = await change(owner, e.registrationId, c9, 0)
  assert.equal(same.status, 422)
  assert.equal(same.body.code, 'same_competition')
  assert.ok(same.body.fields.categoryId)
  const { error } = await db().from('competitions').update({ min_age: 70 }).eq('category_id', c5)
  if (error) throw error
  const old = await change(owner, e.registrationId, c5, -2000)
  assert.deepEqual([old.status, old.body.code, Boolean(old.body.fields?.categoryId)], [422, 'ineligible', true])
  const nowhere = await change(owner, e.registrationId, crypto.randomUUID(), 0)
  assert.equal(nowhere.status, 404)
  const bad = await act(owner, { action: 'change_competition', registrationId: e.registrationId, categoryId: c5, expectedDifference: 'x', requestKey: key() })
  assert.equal(bad.status, 400)
  assert.equal((await competitionOf(c9)).taken, 1)
})

// ---------------------------------------------------------------- CC-68 after a transfer

test('CC-68 after an organizer transfer, a cheaper move refunds the original payer: the payer\'s notice names nobody, the holder\'s carries no payer address', async () => {
  const event = await paidEvent()
  const [c9, c5] = event.categoryIds
  const e = await paidEntry(event, { email: runnerEmail('payer') })
  const holderEmail = runnerEmail('holder')
  const t = await organizerTransfer(event, e.registrationId, ownerId, { email: holderEmail, categoryId: c9, over: { firstName: 'Zenon', lastName: 'Przejmujący' } })
  assert.equal(t.error, null, t.error?.message)
  const newReg = t.data.registrationId
  const { error } = await db().from('registrations').update({ consent_state: 'accepted' }).eq('id', newReg)
  if (error) throw error
  const r = await change(owner, newReg, c5, -2000)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.data.status, 'accepted')
  const toPayer = (await waitForMail(e.email, 1, { subject: 'Zmieniono konkurencję' }))
  const toHolder = (await waitForMail(holderEmail, 1, { subject: 'Zmieniono konkurencję' }))
  assert.equal(toPayer.length, 1)
  assert.equal(toHolder.length, 1)
  const payerMail = JSON.stringify(toPayer[0])
  assert.ok(!payerMail.includes(holderEmail) && !payerMail.includes('Zenon') && !payerMail.includes('Przejmujący'), payerMail)
  const holderMail = JSON.stringify(toHolder[0])
  assert.ok(!holderMail.includes(e.email), holderMail)
  assert.match(toPayer[0].text, /Zwrot różnicy: 20,00 zł/)
})
