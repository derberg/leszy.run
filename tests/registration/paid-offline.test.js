// „Opłacone poza systemem” (OP-1…OP-12 in docs/registration/scenario-matrix.md): the organizer marks an
// unpaid order paid outside LESZY.RUN through organizer-entry-action mark_paid_offline and edits its
// note through offline_note. Every call goes through the served functions, against the mocked dpay and
// the e-mail capture server. LOCAL stack only.
import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { resetThrottle, sessionFor } from './helpers/stack.js'
import { messagesTo, startCapture } from './helpers/emailCapture.js'
import { acceptAgreement, callFn, createPublishedPaidEvent } from './helpers/registrationFixtures.js'
import { dpayIpns, dpayRefunds, dpayReset, payMock, startDpayMock } from './helpers/dpayControl.js'
import {
  attemptFor, competitionOf, db, expireNow, minutesFromNow, one, orderOf, orderOk, paidOrderOk, profileFor, registrationsOf,
  rows, runnerEmail, setSettings,
} from './helpers/orders.js'
import { adult, orderGroupOk } from './helpers/groups.js'
import { paidTeamEvent, teamOk } from './helpers/teams.js'
import { nodeDpay } from './helpers/organizerRefund.js'
import { registerTransaction } from '../../supabase/functions/_shared/dpay.js'
import { warsawToday } from '../../supabase/functions/_shared/registration/dates.js'

const BIEG = (capacity = 50) => [{ name: 'Bieg 9 km', discipline: 'run', distanceLabel: '9 km', startTime: '10:00', capacity }]
const PRICE = 6000
const OWNER = 'owner@zatyrani-test.local'
const NOTE = 'gotówka w biurze, przyjęła Ania Notatkowa'

let owner, adminS, member, outsider, ownerId, stopCapture, stopMock

before(async () => {
  stopCapture = await startCapture()
  stopMock = await startDpayMock()
  await resetThrottle()
  await acceptAgreement('zatyrani-test')
  owner = await sessionFor(OWNER)
  adminS = await sessionFor('admin@zatyrani-test.local')
  member = await sessionFor('member@zatyrani-test.local')
  outsider = await sessionFor(runnerEmail('outsider'))
  ownerId = await profileFor(OWNER)
})
after(async () => {
  if (stopMock) await stopMock()
  if (stopCapture) await stopCapture()
})
beforeEach(async () => { await dpayReset() })

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })
const paidEvent = (capacity = 50) => createPublishedPaidEvent(owner, { prices: { 'Bieg 9 km': PRICE }, competitions: BIEG(capacity) })
const mark = (session, body) => callFn('organizer-entry-action', session, { action: 'mark_paid_offline', note: NOTE, ...body })
const actions = (eventId, action) => rows('organizer_actions', { event_id: eventId, action })

async function waitForMail(email, n = 1) {
  for (let i = 0; i < 40; i++) {
    const msgs = await messagesTo(email)
    if (msgs.length >= n) return msgs
    await sleep(250)
  }
  return messagesTo(email)
}

async function waitFor(check, what) {
  for (let i = 0; i < 60; i++) {
    const v = await check()
    if (v) return v
    await sleep(250)
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** A pending order of one runner → { orderId, total, registrationId, email, categoryId }. */
async function pendingEntry(event, email = runnerEmail('off')) {
  const out = await orderOk(event, { emails: [email] })
  const [reg] = await registrationsOf(out.orderId)
  return { orderId: out.orderId, total: out.total, registrationId: reg.id, email, categoryId: event.categoryIds[0] }
}

// ---------------------------------------------------------------- OP-1 the mark

test('OP-1 a pending group order marked paid outside the system: confirmed, slots claimed, participants, the added adult\'s consent request, a confirmation that claims no online payment, an audit row without the note', async () => {
  const event = await paidEvent()
  const cat = event.categoryIds[0]
  const self = adult(cat, 'self', runnerEmail('offbuyer'))
  const added = adult(cat, 'adult', runnerEmail('offadded'), { firstName: 'Piotr', lastName: 'Borowy' })
  const out = await orderGroupOk(event, [self, added])
  const takenBefore = (await competitionOf(cat)).taken

  const r = await mark(owner, { registrationId: out.registrations[0].id })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.data.outcome, 'confirmed')
  assert.equal(r.body.data.registrations.length, 2)

  const order = await orderOf(out.orderId)
  assert.equal(order.status, 'paid')
  assert.ok(order.paid_offline_at)
  assert.equal(order.offline_note, NOTE)
  assert.equal(order.offline_marked_by, ownerId)
  assert.equal(order.paid_transaction_id, null)
  assert.equal((await competitionOf(cat)).taken, takenBefore + 2)
  for (const reg of await registrationsOf(out.orderId)) {
    assert.equal(reg.status, 'confirmed')
    assert.ok(reg.participant_id, 'a participant for the timing host')
  }

  // Plan 4: the added adult is asked now, as after an online payment.
  const addedReg = (await registrationsOf(out.orderId)).find((x) => x.email === added.email)
  const [request] = await waitFor(async () => {
    const found = await rows('consent_requests', { registration_id: addedReg.id })
    return found.length && found[0].emailed_at ? found : null
  }, 'the consent request')
  assert.ok(request.emailed_at)
  assert.ok((await waitForMail(added.email)).length >= 1)

  const [confirmation] = await waitForMail(self.email)
  assert.match(confirmation.subject, /^Zapis potwierdzony — /)
  assert.match(confirmation.text, /potwierdzone przez organizatora/)
  assert.match(confirmation.text, /Płatność: u organizatora/)
  assert.doesNotMatch(confirmation.text, /dpay|przyjęta|w imieniu i na rzecz/)
  assert.ok(!confirmation.text.includes('Ania'), 'the club\'s note never reaches the buyer')

  const [audit] = await actions(event.eventId, 'order_marked_paid_offline')
  assert.equal(audit.target, out.orderId)
  assert.equal(audit.actor_id, ownerId)
  assert.ok(!JSON.stringify(audit.payload).includes('Ania'), 'the note stays out of the audit')
})

// ---------------------------------------------------------------- OP-2 refusals

test('OP-2 a full competition → 409 full, the order stays pending and nothing is claimed', async () => {
  const event = await paidEvent(1)
  const e = await pendingEntry(event)
  await paidOrderOk(event)
  const r = await mark(owner, { registrationId: e.registrationId })
  assert.equal(r.status, 409, JSON.stringify(r.body))
  assert.equal(r.body.code, 'full')
  const order = await orderOf(e.orderId)
  assert.equal(order.status, 'pending')
  assert.equal(order.paid_offline_at, null)
  assert.equal((await one('registrations', { id: e.registrationId })).status, 'pending_payment')
  assert.equal((await competitionOf(e.categoryId)).taken, 1)
  assert.equal((await actions(event.eventId, 'order_marked_paid_offline')).length, 0)
})

test('OP-3 on the race day (00:00 Warsaw on event_date) → 409 race_day', async () => {
  const event = await paidEvent()
  const e = await pendingEntry(event)
  await setSettings(event.eventId, { closes_at: minutesFromNow(-1), event_date: warsawToday(new Date()) })
  const r = await mark(owner, { orderId: e.orderId })
  assert.equal(r.status, 409, JSON.stringify(r.body))
  assert.equal(r.body.code, 'race_day')
  assert.equal((await orderOf(e.orderId)).status, 'pending')
})

test('OP-4 a paid order → 409 paid; a cancelled one → 409 cancelled; a note empty, multi-space or over 300 characters → 422 with fields.note', async () => {
  const event = await paidEvent()
  const paid = await paidOrderOk(event)
  const r = await mark(owner, { orderId: paid.orderId })
  assert.equal(r.status, 409, JSON.stringify(r.body))
  assert.equal(r.body.code, 'paid')

  const e = await pendingEntry(event)
  for (const note of ['', '   ', 'x'.repeat(301), 42]) {
    const bad = await mark(owner, { orderId: e.orderId, note })
    assert.equal(bad.status, 422, JSON.stringify(bad.body))
    assert.equal(bad.body.code, 'invalid_note')
    assert.ok(bad.body.fields.note)
  }
  assert.equal((await callFn('organizer-entry-action', owner, { action: 'cancel', registrationId: e.registrationId })).status, 200)
  const c = await mark(owner, { orderId: e.orderId })
  assert.equal(c.status, 409)
  assert.equal(c.body.code, 'cancelled')
})

test('OP-5 an expired order with room is confirmed (late_confirmed) and claims its slot; a hidden competition → 409 unavailable', async () => {
  const event = await paidEvent()
  const e = await pendingEntry(event)
  await expireNow(e.orderId)
  assert.equal((await orderOf(e.orderId)).status, 'expired')
  const r = await mark(adminS, { registrationId: e.registrationId })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.data.outcome, 'late_confirmed')
  assert.equal((await one('registrations', { id: e.registrationId })).status, 'confirmed')
  assert.equal((await competitionOf(e.categoryId)).taken, 1)

  const other = await paidEvent()
  const h = await pendingEntry(other)
  await expireNow(h.orderId)
  assert.ifError((await db().from('competitions').update({ hidden_at: new Date().toISOString() }).eq('category_id', h.categoryId)).error)
  const hidden = await mark(owner, { orderId: h.orderId })
  assert.equal(hidden.status, 409, JSON.stringify(hidden.body))
  assert.equal(hidden.body.code, 'unavailable')
  assert.equal((await orderOf(h.orderId)).status, 'expired')
})

test('OP-15 an expired order the purge anonymised (no buyer address) → 409 erased: no slot, the entries stay anonymised', async () => {
  const event = await paidEvent()
  const e = await pendingEntry(event)
  await expireNow(e.orderId)
  const longAgo = new Date(Date.now() - 31 * 86400000).toISOString()
  assert.ifError((await db().from('orders').update({ expires_at: longAgo }).eq('id', e.orderId)).error)
  assert.ifError((await db().rpc('purge_expired_registrations')).error)
  assert.equal((await orderOf(e.orderId)).buyer_email, null)
  const r = await mark(owner, { orderId: e.orderId, note: 'gotówka' })
  assert.equal(r.status, 409, JSON.stringify(r.body))
  assert.equal(r.body.code, 'erased')
  assert.equal((await orderOf(e.orderId)).status, 'expired')
  assert.equal((await one('registrations', { id: e.registrationId })).status, 'expired')
  assert.equal((await competitionOf(e.categoryId)).taken, 0)
})

// ---------------------------------------------------------------- OP-6 online payment afterwards

test('OP-6 after the mark, online payment is refused: pay-order 409 paid, order-status paid with paidOffline and never the note', async () => {
  const event = await paidEvent()
  const e = await pendingEntry(event)
  assert.equal((await mark(owner, { orderId: e.orderId })).status, 200)
  const buyer = await sessionFor(e.email)
  const pay = await callFn('pay-order', buyer, { orderId: e.orderId })
  assert.equal(pay.status, 409, JSON.stringify(pay.body))
  assert.equal(pay.body.code, 'paid')
  const status = await callFn('order-status', buyer, { orderId: e.orderId })
  assert.equal(status.status, 200, JSON.stringify(status.body))
  assert.equal(status.body.data.status, 'paid')
  assert.equal(status.body.data.paidOffline, true)
  assert.ok(!JSON.stringify(status.body).includes('Ania'), 'the note never reaches the buyer')
  const added = await rpcAddAttempt(e.orderId, e.total)
  assert.ok(added.error, 'add_payment_attempt refuses a paid order')
})

const rpcAddAttempt = (orderId, grosze) => db().rpc('add_payment_attempt', { p_order_id: orderId, p_txn: `TXN-late-${orderId}`, p_grosze: grosze })

test('OP-7 a dpay payment of an old attempt landing after the mark goes the double-payment way: refunded in full, one alert, the order stays offline-paid', async () => {
  const event = await paidEvent()
  const e = await pendingEntry(event)
  const { transactionId } = await registerTransaction(nodeDpay(), { orderId: e.orderId, grosze: e.total })
  await attemptFor(e.orderId, e.total, transactionId)
  const r = await mark(owner, { orderId: e.orderId })
  assert.equal(r.status, 200, JSON.stringify(r.body))

  await payMock(transactionId, 'paid')
  await waitFor(async () => (await dpayIpns()).some((i) => i.responseText === 'OK'), 'the IPN answered OK')
  const [refund] = await waitFor(async () => {
    const found = await rows('refunds', { order_id: e.orderId })
    return found.length && found[0].dpay_status === 'accepted' ? found : null
  }, 'the refund')
  assert.equal(refund.reason, 'double_payment')
  assert.equal(refund.amount, e.total)
  assert.deepEqual((await dpayRefunds()).map((x) => [x.txnId, x.grosze]), [[transactionId, e.total]])
  assert.deepEqual((await rows('operator_alerts', { order_id: e.orderId })).map((a) => a.kind), ['double_payment'])
  const order = await orderOf(e.orderId)
  assert.equal(order.status, 'paid')
  assert.equal(order.paid_transaction_id, null)
  assert.ok(order.paid_offline_at)
  assert.equal((await one('registrations', { id: e.registrationId })).status, 'confirmed')
})

// ---------------------------------------------------------------- OP-8 who may

test('OP-8 a club member 403, an outsider 404, on both actions; nothing changes', async () => {
  const event = await paidEvent()
  const e = await pendingEntry(event)
  for (const action of ['mark_paid_offline', 'offline_note']) {
    const body = { action, orderId: e.orderId, note: NOTE }
    assert.equal((await callFn('organizer-entry-action', member, body)).status, 403, `member ${action}`)
    assert.equal((await callFn('organizer-entry-action', outsider, body)).status, 404, `outsider ${action}`)
  }
  assert.equal((await orderOf(e.orderId)).status, 'pending')
})

// ---------------------------------------------------------------- OP-9 the panel and the CSV

test('OP-9 list-event-registrations: the row reads paid_offline with the note, counts.offlineTotal and offlineOrders apart from the paid online; the CSV says POZA SYSTEMEM and carries the note', async () => {
  const event = await paidEvent()
  const online = await paidOrderOk(event)
  const e = await pendingEntry(event)
  assert.equal((await mark(owner, { registrationId: e.registrationId })).status, 200)

  const list = await callFn('list-event-registrations', owner, { eventId: event.eventId })
  assert.equal(list.status, 200, JSON.stringify(list.body))
  const row = list.body.data.find((x) => x.id === e.registrationId)
  assert.equal(row.statusKey, 'paid_offline')
  assert.equal(row.paymentStatus, 'paid')
  assert.equal(row.paidOffline, true)
  assert.equal(row.offlineNote, NOTE)
  assert.equal(row.orderTotal, PRICE)
  const onlineRow = list.body.data.find((x) => x.orderId === online.orderId)
  assert.equal(onlineRow.statusKey, 'paid')
  assert.equal(onlineRow.paidOffline, false)
  assert.equal(list.body.counts.offlineTotal, PRICE)
  assert.equal(list.body.counts.offlineOrders, 1)

  const csv = await callFn('export-event-registrations', owner, { eventId: event.eventId, filter: { statusKey: 'paid_offline' } })
  assert.equal(csv.status, 200, JSON.stringify(csv.body))
  const lines = csv.body.data.csv.split('\r\n')
  assert.match(lines[0], /"Notatka o wpłacie"$/)
  assert.equal(lines.length, 2, 'the filter keeps the offline row only')
  assert.match(lines[1], /"POZA SYSTEMEM"/)
  assert.ok(lines[1].endsWith(`"${NOTE}"`))
})

test('OP-10 offline_note: the owner changes the note (audit without it), an order not marked → 409 not_offline', async () => {
  const event = await paidEvent()
  const e = await pendingEntry(event)
  const unmarked = await callFn('organizer-entry-action', owner, { action: 'offline_note', orderId: e.orderId, note: 'x' })
  assert.equal(unmarked.status, 409, JSON.stringify(unmarked.body))
  assert.equal(unmarked.body.code, 'not_offline')
  assert.equal((await mark(owner, { orderId: e.orderId })).status, 200)
  const r = await callFn('organizer-entry-action', owner, { action: 'offline_note', registrationId: e.registrationId, note: '  zapłacone 12.11, Bartek  ' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.data.note, 'zapłacone 12.11, Bartek')
  assert.equal((await orderOf(e.orderId)).offline_note, 'zapłacone 12.11, Bartek')
  const [audit] = await actions(event.eventId, 'offline_note_edited')
  assert.equal(audit.target, e.orderId)
  assert.equal(audit.payload, null)
})

test('OP-11 a no-show: „Anuluj” cancels the offline-paid entry without a refund and releases its slot', async () => {
  const event = await paidEvent()
  const e = await pendingEntry(event)
  assert.equal((await mark(owner, { orderId: e.orderId })).status, 200)
  assert.equal((await competitionOf(e.categoryId)).taken, 1)
  const r = await callFn('organizer-entry-action', owner, { action: 'cancel', registrationId: e.registrationId })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal((await one('registrations', { id: e.registrationId })).status, 'cancelled')
  assert.equal((await competitionOf(e.categoryId)).taken, 0)
  assert.equal((await rows('refunds', { order_id: e.orderId })).length, 0)
  // An organizer refund is no way out: no dpay transaction holds the money.
  const [line] = await rows('order_lines', { order_id: e.orderId })
  const refund = await callFn('organizer-refund', owner, { lineId: line.id, grosze: 100, requestKey: crypto.randomUUID() })
  assert.equal(refund.status, 409, JSON.stringify(refund.body))
})

test('OP-12 a team\'s order marked from the captain\'s row confirms the whole team; export-my-data says paid_offline and never the note', async () => {
  const event = await paidTeamEvent(owner)
  const team = await teamOk(event)
  const captainId = team.registrations?.[0]?.id ?? (await one('teams', { id: team.teamId })).captain_registration_id
  const r = await mark(owner, { registrationId: captainId })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const regs = await registrationsOf(team.orderId)
  assert.ok(regs.length >= 2)
  assert.ok(regs.every((x) => x.status === 'confirmed'), JSON.stringify(regs.map((x) => x.status)))
  assert.equal((await competitionOf(event.categoryIds[0])).taken, 1, 'a team holds one slot')

  const list = await callFn('list-event-registrations', owner, { eventId: event.eventId })
  const t = list.body.teams.find((x) => x.id === team.teamId)
  assert.equal(t.paidOffline, true)

  const captainEmail = regs.find((x) => x.id === captainId).email
  const mine = await callFn('export-my-data', await sessionFor(captainEmail), {})
  assert.equal(mine.status, 200, JSON.stringify(mine.body))
  const order = mine.body.orders.find((o) => o.id === team.orderId)
  assert.equal(order.paid_offline, true)
  assert.ok(!JSON.stringify(mine.body).includes('Ania'), 'the club\'s note is not exported')
})

test('OP-13 delete-my-account: the buyer\'s offline-paid order keeps its amounts and its mark, and loses the club\'s note (it may name them)', async () => {
  const event = await paidEvent()
  const e = await pendingEntry(event)
  assert.equal((await mark(owner, { orderId: e.orderId })).status, 200)
  const session = await sessionFor(e.email)
  const sha = crypto.createHash('sha256').update('123456').digest('hex')
  assert.ifError((await db().from('auth_codes').insert({
    email: e.email, code_hash: sha, purpose: 'delete_account', expires_at: new Date(Date.now() + 600000).toISOString(),
  })).error)
  const r = await callFn('delete-my-account', session, { action: 'confirm', code: '123456' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const order = await orderOf(e.orderId)
  assert.equal(order.status, 'paid')
  assert.ok(order.paid_offline_at)
  assert.equal(order.total, PRICE)
  assert.equal(order.offline_note, null)
  assert.equal(order.buyer_email, null)
})
