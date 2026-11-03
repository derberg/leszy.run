// Security hardening: dpay-ipn asks dpay for the transaction (transactionDetails, the poll path's
// call) before confirm_order. A valid signature, type 'transfer' and the right amount are no longer
// enough: dpay must report the transaction paid ('paid' / 'captured') with the IPN's amount.
// LOCAL stack plus the mocked dpay (helpers/dpayMock.js), like ipn.test.js.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { localEnv, resetThrottle, sessionFor, EDGE_PROXY } from './helpers/stack.js'
import { startCapture } from './helpers/emailCapture.js'
import { acceptAgreement, createPublishedPaidEvent } from './helpers/registrationFixtures.js'
import {
  dpayIpns, dpayMode, dpayReset, payMock, replayIpn, startDpayMock,
} from './helpers/dpayControl.js'
import { consentIds, orderOf, rows, runnerEmail, totalFor } from './helpers/orders.js'

const BIEG = [{ name: 'Bieg 9 km', discipline: 'run', distanceLabel: '9 km', startTime: '10:00', capacity: 50 }]

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
    headers: { 'content-type': 'application/json', ...EDGE_PROXY, 'x-forwarded-for': ip(), ...(session ? { cookie: session.cookie } : {}) },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { status: res.status, body: json }
}

/** A pending order through create-order → { orderId, txn }. */
async function pendingOrder(tag) {
  const event = await createPublishedPaidEvent(owner, { prices: { 'Bieg 9 km': 6000 }, competitions: BIEG })
  const email = runnerEmail(tag)
  const runner = await sessionFor(email)
  const r = await call('create-order', {
    categoryId: event.categoryIds[0],
    person: { firstName: 'Ola', lastName: 'Leśna', birthDate: '1990-05-01', gender: 'K', email, phone: '600100200' },
    acceptedConsentIds: await consentIds(event.eventId),
    serviceRegulamin: true,
    displayedTotal: totalFor(6000, 1, false),
  }, runner)
  assert.equal(r.status, 201, JSON.stringify(r.body))
  const { orderId } = r.body.data
  const [attempt] = await rows('payment_attempts', { order_id: orderId })
  return { orderId, txn: attempt.dpay_transaction_id }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function replayOnce(txnId) {
  for (let i = 0; ; i++) {
    try {
      return await replayIpn(txnId, { times: 1 })
    } catch (err) {
      if (i > 40) throw err
      await sleep(25)
    }
  }
}
const alertKinds = async (orderId) => (await rows('operator_alerts', { order_id: orderId })).map((a) => a.kind)
const attemptStatuses = async (orderId) => (await rows('payment_attempts', { order_id: orderId })).map((a) => a.status)

test('SEC-IPN dpay says processing → ERROR on every delivery, nothing confirmed; once dpay says paid, a replay confirms', async () => {
  const { orderId, txn } = await pendingOrder('ipnproc')
  await dpayMode({ detailsStatus: 'processing' })
  await payMock(txn, 'paid')
  const ipns = (await dpayIpns()).filter((i) => i.txnId === txn)
  assert.ok(ipns.length >= 2, 'the mock retried')
  assert.ok(ipns.every((i) => i.responseText === 'ERROR'), JSON.stringify(ipns.map((i) => i.responseText)))
  assert.equal((await orderOf(orderId)).status, 'pending')
  assert.deepEqual(await attemptStatuses(orderId), ['created'])
  assert.deepEqual(await alertKinds(orderId), [])
  const checks = await rows('payment_events', { order_id: orderId, kind: 'status_check' })
  assert.ok(checks.length >= 1 && checks.every((c) => c.payload.source === 'ipn' && c.payload.status === 'processing'))

  await dpayMode({ detailsStatus: null }) // the mock's own status: paid
  await replayOnce(txn)
  const last = (await dpayIpns()).filter((i) => i.txnId === txn).at(-1)
  assert.equal(last.responseText, 'OK')
  assert.equal((await orderOf(orderId)).status, 'paid')
})

test('SEC-IPN dpay says expired → OK, nothing confirmed, one ipn_not_paid alert however often it comes', async () => {
  const { orderId, txn } = await pendingOrder('ipnexp')
  await dpayMode({ detailsStatus: 'expired' })
  await payMock(txn, 'paid')
  await Promise.all(Array.from({ length: 3 }, () => replayOnce(txn)))
  const ipns = (await dpayIpns()).filter((i) => i.txnId === txn)
  assert.ok(ipns.every((i) => i.responseText === 'OK'), JSON.stringify(ipns.map((i) => i.responseText)))
  assert.equal((await orderOf(orderId)).status, 'pending')
  assert.deepEqual(await attemptStatuses(orderId), ['created'])
  assert.deepEqual(await alertKinds(orderId), ['ipn_not_paid'])
})

test('SEC-IPN dpay reports paid at another amount → OK, nothing confirmed, one amount_mismatch alert', async () => {
  const { orderId, txn } = await pendingOrder('ipnamt')
  await dpayMode({ detailsBodyOverride: { transaction: { id: txn, status: 'paid', value: '1.00' } } })
  await payMock(txn, 'paid')
  await replayOnce(txn)
  const ipns = (await dpayIpns()).filter((i) => i.txnId === txn)
  assert.ok(ipns.every((i) => i.responseText === 'OK'), JSON.stringify(ipns.map((i) => i.responseText)))
  assert.equal((await orderOf(orderId)).status, 'pending')
  assert.deepEqual(await attemptStatuses(orderId), ['created'])
  const alerts = await rows('operator_alerts', { order_id: orderId })
  assert.deepEqual(alerts.map((a) => a.kind), ['amount_mismatch'])
  assert.equal(alerts[0].payload.reason, 'details_amount_differs')
})

test('SEC-IPN dpay\'s details answer is an error → ERROR, nothing confirmed', async () => {
  const { orderId, txn } = await pendingOrder('ipnerr')
  // A body the details parser refuses (not an object) makes transactionDetails throw.
  await dpayMode({ detailsBodyOverride: 'not json at all' })
  await payMock(txn, 'paid')
  const ipns = (await dpayIpns()).filter((i) => i.txnId === txn)
  assert.ok(ipns.every((i) => i.responseText === 'ERROR'), JSON.stringify(ipns.map((i) => i.responseText)))
  assert.equal((await orderOf(orderId)).status, 'pending')
  assert.deepEqual(await alertKinds(orderId), [])
})
