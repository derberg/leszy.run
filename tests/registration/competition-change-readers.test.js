// Competition change, task 5: every JS reader of orders tells a surcharge order (orders.kind =
// 'surcharge', it owns no registration) from a registration order: order-status, my-registrations,
// list-event-registrations (B3 rows and counts) and its CSV, export-my-data, settleConfirmOutcome.
// Scenarios CC-40…CC-45 in docs/registration/scenario-matrix.md. LOCAL stack only.
import { afterEach, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { localEnv, resetThrottle, sessionFor } from './helpers/stack.js'
import { acceptAgreement, callFn, createPublishedPaidEvent } from './helpers/registrationFixtures.js'
import { attemptFor, confirmOk, db, one, profileFor, rows, runnerEmail } from './helpers/orders.js'
import { BIEG } from './helpers/groups.js'
import { accept, enableTransfers, inviteOk, organizerTransfer, paidEntry } from './helpers/transfers.js'
import { assertSlotInvariant } from './helpers/slotInvariant.js'
import { cancelSurcharge, surchargeOk } from './helpers/competitionChange.js'
import { dpayFee } from '../../supabase/functions/_shared/registration/money.js'
import { settleConfirmOutcome } from '../../supabase/functions/_shared/registration/orderFlow.js'

const BIEG_21 = () => ({ name: 'Bieg 21 km', discipline: 'run', distanceLabel: '21 km', startTime: '09:30', capacity: 50 })

let owner, ownerId
const competitionsSeen = new Set()

before(async () => {
  localEnv()
  await resetThrottle()
  await acceptAgreement('zatyrani-test')
  owner = await sessionFor('owner@zatyrani-test.local')
  ownerId = await profileFor('owner@zatyrani-test.local')
})
afterEach(async () => {
  const competitions = [...competitionsSeen]
  competitionsSeen.clear()
  for (const id of competitions) await assertSlotInvariant(id)
})

async function paidEvent() {
  const event = await createPublishedPaidEvent(owner, {
    competitions: [BIEG(), BIEG_21()],
    prices: { 'Bieg 9 km': 6000, 'Bieg 21 km': 8000 },
  })
  event.categoryIds.forEach((c) => competitionsSeen.add(c))
  return event
}

/** A paid 9 km entry (60 zł) with a pending 20 zł surcharge to 21 km (80 zł). */
async function withSurcharge() {
  const event = await paidEvent()
  const [c9, c21] = event.categoryIds
  const a = await paidEntry(event)
  const s = await surchargeOk(a.reg.id, c21, 2000)
  const payer = await sessionFor(a.email)
  return { event, a, s, c9, c21, payer }
}

async function pay(orderId, grosze = 2000) {
  const att = await attemptFor(orderId, grosze)
  const out = await confirmOk(orderId, att.txn, grosze)
  assert.equal(out.outcome, 'surcharge_moved')
}

async function rowOf(event, registrationId) {
  const list = await callFn('list-event-registrations', owner, { eventId: event.eventId })
  assert.equal(list.status, 200, JSON.stringify(list.body))
  return { row: list.body.data.find((x) => x.id === registrationId), counts: list.body.counts }
}

test('CC-40 order-status: a surcharge reads kind surcharge, from → to, its total and no lines; a registration order reads kind registration', async () => {
  const { a, s, payer } = await withSurcharge()
  const res = await callFn('order-status', payer, { orderId: s.orderId })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  const d = res.body.data
  assert.equal(d.kind, 'surcharge')
  assert.equal(d.fromCompetition, 'Bieg 9 km')
  assert.equal(d.toCompetition, 'Bieg 21 km')
  assert.equal(d.total, 2000)
  assert.equal(d.amounts.total, 2000)
  assert.equal(d.status, 'pending')
  assert.ok(d.expiresAt)
  assert.deepEqual(d.lines, [], 'no entry line: no consent or transfer block')
  assert.equal(d.name, undefined, 'a surcharge names nobody (ruling N-1)')

  const own = await callFn('order-status', payer, { orderId: a.orderId })
  assert.equal(own.status, 200)
  assert.equal(own.body.data.kind, 'registration')
  assert.equal(own.body.data.lines.length, 1)
  assert.equal(own.body.data.fromCompetition, undefined)
})

test('CC-40 order-status: a surcharge paid after it ended says lateRefund (refunded in full); unpaid it does not', async () => {
  const { s, payer } = await withSurcharge()
  const att = await attemptFor(s.orderId, 2000)
  const { error } = await cancelSurcharge(s.orderId)
  assert.equal(error, null, error?.message)
  let d = (await callFn('order-status', payer, { orderId: s.orderId })).body.data
  assert.deepEqual([d.status, d.lateRefund], ['cancelled', false])
  const out = await confirmOk(s.orderId, att.txn, 2000)
  assert.equal(out.outcome, 'late_refund')
  assert.equal((await rows('refunds', { order_id: s.orderId })).length, 1)
  d = (await callFn('order-status', payer, { orderId: s.orderId })).body.data
  assert.deepEqual([d.status, d.lateRefund], ['cancelled', true])
})

test('CC-41 my-registrations: a pending surcharge sits on its entry; once paid it is never an order of its own, nor a cancelled one', async () => {
  const { a, s, payer } = await withSurcharge()
  let res = await callFn('my-registrations', payer, {})
  assert.equal(res.status, 200, JSON.stringify(res.body))
  let ev = res.body.data.find((e) => e.orders.some((o) => o.id === a.orderId))
  assert.deepEqual(ev.orders.map((o) => o.id), [a.orderId])
  const person = ev.people.find((p) => p.id === a.reg.id)
  assert.equal(person.surcharge.orderId, s.orderId)
  assert.equal(person.surcharge.toCompetition, 'Bieg 21 km')
  assert.equal(person.surcharge.grosze, 2000)
  assert.ok(person.surcharge.expiresAt)

  await pay(s.orderId)
  res = await callFn('my-registrations', payer, {})
  ev = res.body.data.find((e) => e.orders.some((o) => o.id === a.orderId))
  assert.deepEqual(ev.orders.map((o) => [o.id, o.cancelled]), [[a.orderId, false]])
  const moved = ev.people.find((p) => p.id === a.reg.id)
  assert.equal(moved.competition, 'Bieg 21 km')
  assert.equal(moved.surcharge, null)
})

test('CC-42 B3 rows: a pending surcharge is the row\'s surcharge and not its money; paid, its line is refundable money of the entry and dpay\'s fee counts its payment', async () => {
  const { event, a, s } = await withSurcharge()
  let { row, counts } = await rowOf(event, a.reg.id)
  assert.equal(row.surcharge.orderId, s.orderId)
  assert.equal(row.surcharge.toCompetition, 'Bieg 21 km')
  assert.equal(row.surcharge.grosze, 2000)
  assert.ok(row.surcharge.expiresAt)
  assert.deepEqual(row.lines.map((l) => l.kind), ['entry'], 'the unpaid surcharge line is no money of the entry')
  assert.equal(row.paidAmount, 6000)
  assert.equal(row.competition, 'Bieg 9 km')
  assert.equal(counts.dpayFee, dpayFee(6000))

  const csv = await callFn('export-event-registrations', owner, { eventId: event.eventId })
  assert.equal(csv.status, 200, JSON.stringify(csv.body))
  const lines = csv.body.data.csv.split('\r\n')
  assert.match(lines[0], /"Dopłata czeka \(zł\)";"Zmiana konkurencji na"$/)
  assert.ok(lines.some((l) => l.endsWith('"20,00";"Bieg 21 km"')))

  await pay(s.orderId)
  ;({ row, counts } = await rowOf(event, a.reg.id))
  assert.equal(row.surcharge, null)
  assert.equal(row.competition, 'Bieg 21 km')
  const surchargeLine = await one('order_lines', { order_id: s.orderId })
  assert.deepEqual(row.lines.map((l) => [l.kind, l.amount]), [['entry', 6000], ['surcharge', 2000]])
  assert.equal(row.lines[1].id, surchargeLine.id)
  assert.equal(row.paidAmount, 8000)
  assert.equal(row.entryRefunded, 0)
  assert.equal(row.statusKey, 'paid')
  assert.equal(counts.dpayFee, dpayFee(6000) + dpayFee(2000))
})

test('CC-43 B3 rows: an expired surcharge leaves the row as it was', async () => {
  const { event, a, s } = await withSurcharge()
  const { error } = await db().from('orders').update({ status: 'expired' }).eq('id', s.orderId)
  assert.equal(error, null)
  const { row } = await rowOf(event, a.reg.id)
  assert.equal(row.surcharge, null)
  assert.deepEqual(row.lines.map((l) => l.kind), ['entry'])
  assert.equal(row.paidAmount, 6000)
})

test('CC-44 export-my-data: the surcharge is among the payer\'s orders, with its kind and the competitions', async () => {
  const { a, s, payer } = await withSurcharge()
  const res = await callFn('export-my-data', payer, {})
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 500))
  const { orders } = res.body
  const sur = orders.find((o) => o.id === s.orderId)
  assert.equal(sur.kind, 'surcharge')
  assert.deepEqual(sur.surcharge, { registration_id: a.reg.id, from_competition: 'Bieg 9 km', to_competition: 'Bieg 21 km' })
  assert.equal(sur.amounts.total, 2000)
  const own = orders.find((o) => o.id === a.orderId)
  assert.equal(own.kind, 'registration')
  assert.equal(own.surcharge, null)
})

test('CC-45 settleConfirmOutcome on surcharge_moved claims the change notice only: no consent request, no registrations read', async () => {
  // Task 6: the change notice is claimed on the surcharge order's confirmation_sent_at (already
  // stamped here, so nothing is sent); the consent requests of a registration order are never issued.
  const touched = []
  const chain = (table) => {
    const q = { update: () => q, eq: () => q, is: () => q, select: async () => ({ data: [], error: null }) }
    touched.push(table)
    return q
  }
  const fake = { from: chain, rpc: () => { throw new Error('rpc used') } }
  assert.deepEqual(await settleConfirmOutcome(fake, {}, { outcome: 'surcharge_moved', orderId: 'o', registrationId: 'r' }), { emailed: true })
  assert.deepEqual(touched, ['orders'])
})

// Review fix (ruling N-1): an entry that came by a transfer keeps the original order, but its
// surcharge is the holder's to pay, never the original buyer's (registration_surcharge_buyer,
// migration 20261124140000).
test('CC-46 after an organizer transfer the surcharge bills the new holder; the old buyer cannot read it', async () => {
  const event = await paidEvent()
  const [c9, c21] = event.categoryIds
  const a = await paidEntry(event)
  const holderEmail = runnerEmail('org-holder')
  const t = await organizerTransfer(event, a.reg.id, ownerId, { email: holderEmail, categoryId: c9 })
  assert.equal(t.error, null, t.error?.message)
  const fresh = t.data.registrationId
  const s = await surchargeOk(fresh, c21, 2000)
  const order = await one('orders', { id: s.orderId })
  assert.notEqual(order.buyer_profile_id, a.profileId, 'the original payer is not billed')
  assert.equal(order.buyer_email, holderEmail)
  assert.notEqual(order.buyer_name, (await one('orders', { id: a.orderId })).buyer_name)
  const holder = await one('registrations', { id: fresh })
  assert.equal(order.buyer_profile_id, holder.profile_id)
  const oldBuyer = await sessionFor(a.email)
  assert.equal((await callFn('order-status', oldBuyer, { orderId: s.orderId })).status, 404)
})

test('CC-46 after a runner transfer the surcharge bills the recipient', async () => {
  const event = await paidEvent()
  const [c9, c21] = event.categoryIds
  await enableTransfers(event)
  const a = await paidEntry(event)
  const toEmail = runnerEmail('recipient-cc46')
  const inv = await inviteOk(a.reg.id, a.profileId, toEmail)
  const acc = await accept(event, inv.hash, { email: toEmail, categoryId: c9 })
  assert.equal(acc.error, null, acc.error?.message)
  const done = await one('transfers', { id: inv.transferId })
  const s = await surchargeOk(done.new_registration_id, c21, 2000)
  const order = await one('orders', { id: s.orderId })
  assert.equal(order.buyer_profile_id, await profileFor(toEmail))
  assert.equal(order.buyer_email, toEmail)
  const recipient = await sessionFor(toEmail)
  const res = await callFn('order-status', recipient, { orderId: s.orderId })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.data.kind, 'surcharge')
  assert.equal((await callFn('order-status', await sessionFor(a.email), { orderId: s.orderId })).status, 404)
})
