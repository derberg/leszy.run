// Plan 6, task 7: the organizer panel's personal data under export-my-data and delete-my-account
// (O-38, O-39 in docs/registration/scenario-matrix.md). A refund holds no personal data: the export
// shows it on the person's order and the deletion leaves the row as it was. A message to one
// runner stores that runner's registration id in organizer_messages.filter, so it is that person's
// data: their export holds it, without the sender, and deleting the account deletes it. The
// `message_sent` row in organizer_actions stays as the club's record. A child is written to through
// the guardian, so a message on a child's entry is the guardian's. A message to everybody is
// stored per event, never per recipient, and belongs to nobody's export or deletion.
// LOCAL stack only; every event and address is random.
import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { resetThrottle, sessionFor } from './helpers/stack.js'
import { clearMessages, startCapture } from './helpers/emailCapture.js'
import { acceptAgreement, callFn, createPublishedPaidEvent } from './helpers/registrationFixtures.js'
import { dpayMode, dpayReset, payMock, startDpayMock } from './helpers/dpayControl.js'
import { attemptFor, confirmOk, db, one, orderOk, person, profileFor, rows, runnerEmail } from './helpers/orders.js'
import { BIEG, DZIECI, adult, minor, orderGroupOk } from './helpers/groups.js'
import { nodeDpay } from './helpers/organizerRefund.js'
import { registerTransaction } from '../../supabase/functions/_shared/dpay.js'

const OWNER = 'owner@zatyrani-test.local'
const PRICE = 6000
const ALL = { categoryIds: [], status: 'all', teams: 'members' }

let owner, ownerId, stopCapture, stopMock

before(async () => {
  stopCapture = await startCapture()
  stopMock = await startDpayMock()
  await acceptAgreement('zatyrani-test')
  owner = await sessionFor(OWNER)
  ownerId = await profileFor(OWNER)
})
after(async () => {
  if (stopMock) await stopMock()
  if (stopCapture) await stopCapture()
})
beforeEach(async () => {
  await dpayReset()
  await clearMessages()
  await resetThrottle()
})

const sha256 = (t) => crypto.createHash('sha256').update(t).digest('hex')
const tag = () => crypto.randomBytes(4).toString('hex')

const event = () => createPublishedPaidEvent(owner, {
  competitions: [BIEG(), DZIECI()], prices: { 'Bieg 9 km': PRICE, 'Bieg dzieci 1 km': 2000 },
})

/** A paid entry the mock holds as paid (its IPN dropped, confirm_order called here). */
async function paidEntry(e, lastName) {
  const email = runnerEmail('gdpr')
  const out = await orderOk(e, { people: [person(email, { lastName })] })
  const { transactionId } = await registerTransaction(nodeDpay(), { orderId: out.orderId, grosze: out.total })
  await attemptFor(out.orderId, out.total, transactionId)
  await dpayMode({ dropIpn: true })
  await payMock(transactionId, 'paid')
  await dpayMode({ dropIpn: false })
  assert.equal((await confirmOk(out.orderId, transactionId, out.total)).outcome, 'confirmed')
  const [line] = await rows('order_lines', { order_id: out.orderId })
  return { email, orderId: out.orderId, lineId: line.id, registrationId: line.registration_id, session: await sessionFor(email) }
}

async function refund(lineId, grosze) {
  const r = await callFn('organizer-refund', owner, { lineId, grosze, requestKey: crypto.randomUUID() })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  return r.body.data.refundId
}

/** „Napisz do zawodnika”, or a bulk message with `audience` → the subject and body it sent. */
async function write(target) {
  const subject = `Temat ${tag()}`
  const text = `Treść ${tag()}`
  const r = await callFn('send-organizer-message', owner, { ...target, subject, body: text, mode: 'send' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  return { subject, body: text }
}

const stored = (subject) => rows('organizer_messages', { subject })

async function exportOf(session) {
  const r = await callFn('export-my-data', session, {})
  assert.equal(r.status, 200, JSON.stringify(r.body))
  return r.body
}

async function deleteAccount(email, session) {
  const { error } = await db().from('auth_codes').insert({
    email, code_hash: sha256('123456'), purpose: 'delete_account', expires_at: new Date(Date.now() + 600000).toISOString(),
  })
  assert.ifError(error)
  const r = await callFn('delete-my-account', session, { action: 'confirm', code: '123456' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
}

/** A pending family order: the payer and a child → the child's registration id. */
async function family(e, lastName) {
  const payerEmail = runnerEmail('gdpr-rodzic')
  const payer = await sessionFor(payerEmail)
  const [bieg, dzieci] = e.categoryIds
  const order = await orderGroupOk(e, [
    adult(bieg, 'self', payerEmail, { lastName }),
    minor(dzieci, { firstName: 'Zosia', lastName }),
  ], { profileId: payer.profileId })
  const regs = await rows('registrations', { order_id: order.orderId })
  return { payerEmail, payer, child: regs.find((r) => r.email === null).id, own: regs.find((r) => r.email !== null).id }
}

test('O-38 export-my-data: the refund on the person\'s order, and the message written to them with no sender; another runner\'s and a bulk message stay out', async () => {
  const e = await event()
  const anna = await paidEntry(e, `Zwrotna${tag()}`)
  const piotr = await paidEntry(e, `Obok${tag()}`)
  const refundId = await refund(anna.lineId, 2000)

  const toAnna = await write({ registrationId: anna.registrationId })
  const toPiotr = await write({ registrationId: piotr.registrationId })
  const toAll = await write({ eventId: e.eventId, audience: ALL })
  const [row] = await stored(toAnna.subject)

  const body = await exportOf(anna.session)

  const order = body.orders.find((o) => o.id === anna.orderId)
  assert.equal(order.refunds.length, 1)
  assert.equal(order.refunds[0].id, refundId)
  assert.equal(order.refunds[0].amount, 2000)
  assert.equal(order.refunds[0].kind, 'organizer')
  assert.equal(order.refunds[0].dpay_status, 'accepted')
  assert.deepEqual(Object.keys(order.refunds[0]).sort(),
    ['amount', 'created_at', 'dpay_status', 'id', 'kind', 'payment_attempt_id', 'reason'])

  const settings = await one('registration_settings', { event_id: e.eventId })
  assert.deepEqual(body.organizer_messages_received, [{
    event_name: settings.name,
    event_date: settings.event_date,
    from: 'Organizator wydarzenia',
    subject: toAnna.subject,
    body: toAnna.body,
    sent_at: row.sent_at,
  }])

  const text = JSON.stringify(body)
  assert.ok(!text.includes(ownerId), 'never the sender\'s account id')
  assert.ok(!text.includes(OWNER), 'never the sender\'s address')
  assert.ok(!text.includes('sent_by'))
  assert.ok(!text.includes(toPiotr.subject), 'another runner\'s message is theirs')
  assert.ok(!text.includes(toAll.subject), 'a bulk message is stored per event, never per recipient')
})

test('O-38 export-my-data: a message on a child\'s entry reached the guardian, so it is in the guardian\'s export; a person with no message gets an empty list', async () => {
  const e = await event()
  const f = await family(e, `Leśna${tag()}`)
  const toChild = await write({ registrationId: f.child })

  const guardian = await exportOf(f.payer)
  assert.deepEqual(guardian.organizer_messages_received.map((m) => m.subject), [toChild.subject])

  const other = await paidEntry(e, `Obok${tag()}`)
  assert.deepEqual((await exportOf(other.session)).organizer_messages_received, [])
})

test('O-39 delete-my-account: the refund row is untouched and holds nothing personal; the message written to them is gone, the audit row stays, other messages stay', async () => {
  const e = await event()
  const last = `Zwrotna${tag()}`
  const anna = await paidEntry(e, last)
  const piotr = await paidEntry(e, `Obok${tag()}`)
  const refundId = await refund(anna.lineId, 2000)

  const toAnna = await write({ registrationId: anna.registrationId })
  const toPiotr = await write({ registrationId: piotr.registrationId })
  const toAll = await write({ eventId: e.eventId, audience: ALL })
  const [row] = await stored(toAnna.subject)
  const refundBefore = await one('refunds', { id: refundId })

  await deleteAccount(anna.email, anna.session)

  assert.deepEqual(await one('refunds', { id: refundId }), refundBefore, 'accounting record: no change at all')
  const refundText = JSON.stringify(refundBefore)
  assert.ok(!refundText.includes(anna.email), 'no address in a refund')
  assert.ok(!refundText.includes(last), 'no name in a refund')
  assert.ok(!Object.keys(refundBefore).some((c) => /mail|name|phone/.test(c)), Object.keys(refundBefore).join())

  assert.equal((await stored(toAnna.subject)).length, 0, 'the free text written to them goes')
  assert.equal((await stored(toPiotr.subject)).length, 1, 'another runner\'s message stays')
  assert.equal((await stored(toAll.subject)).length, 1, 'a bulk message names nobody')

  // The club's record of the act stays: ids and a count, pointing at an anonymised entry.
  const audit = await rows('organizer_actions', { event_id: e.eventId, action: 'message_sent', target: row.id })
  assert.equal(audit.length, 1)
  assert.equal(audit[0].actor_id, ownerId)
  assert.equal(audit[0].payload.registrationId, anna.registrationId)
  assert.ok(!JSON.stringify(audit[0]).includes(toAnna.body))
  assert.ok(!JSON.stringify(audit[0]).includes(toAnna.subject))
  assert.equal((await one('registrations', { id: anna.registrationId })).first_name, 'Usunięte konto')
})

test('O-39 delete-my-account: a guardian\'s deletion takes the message on the child\'s entry too; the entry stays', async () => {
  const e = await event()
  const f = await family(e, `Leśna${tag()}`)
  const toChild = await write({ registrationId: f.child })
  const toSelf = await write({ registrationId: f.own })

  await deleteAccount(f.payerEmail, f.payer)

  assert.equal((await stored(toChild.subject)).length, 0)
  assert.equal((await stored(toSelf.subject)).length, 0)
  const child = await one('registrations', { id: f.child })
  assert.equal(child.first_name, 'Zosia', 'the child\'s entry stays')
  assert.equal(child.guardian_name, 'Usunięte konto')
})
