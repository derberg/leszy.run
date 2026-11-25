// Competition change, task 8: a surcharge whose buyer has no account is claimed by the session
// whose e-mail equals buyer_email (order-status, pay-order, cancel-my-order); never a registration
// order, never another address. The buyer rule itself (CC-30/31) is in competition-change-rpc and
// -readers. Scenario CC-47 in docs/registration/scenario-matrix.md. LOCAL stack only.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { localEnv, resetThrottle, sessionFor } from './helpers/stack.js'
import { startCapture } from './helpers/emailCapture.js'
import { acceptAgreement, callFn, createPublishedPaidEvent } from './helpers/registrationFixtures.js'
import { dpayReset, dpayTransactions, startDpayMock } from './helpers/dpayControl.js'
import { db, one, orderOk, profileFor } from './helpers/orders.js'
import { BIEG } from './helpers/groups.js'
import { paidEntry } from './helpers/transfers.js'
import { surchargeOk } from './helpers/competitionChange.js'

const BIEG_21 = () => ({ name: 'Bieg 21 km', discipline: 'run', distanceLabel: '21 km', startTime: '09:30', capacity: 50 })

let owner, stopMock, stopCapture
before(async () => {
  localEnv()
  stopCapture = await startCapture()
  stopMock = await startDpayMock()
  await resetThrottle()
  await acceptAgreement('zatyrani-test')
  owner = await sessionFor('owner@zatyrani-test.local')
  await dpayReset()
})
after(async () => {
  if (stopMock) await stopMock()
  if (stopCapture) await stopCapture()
})

async function paidEvent() {
  return createPublishedPaidEvent(owner, {
    competitions: [BIEG(), BIEG_21()],
    prices: { 'Bieg 9 km': 6000, 'Bieg 21 km': 8000 },
  })
}

/** A surcharge whose buyer has no account: the runner's profile is erased at the time of the change. */
async function accountlessSurcharge() {
  const event = await paidEvent()
  const a = await paidEntry(event)
  await db().from('orders').update({ buyer_profile_id: null }).eq('id', a.orderId)
  await db().from('profiles').update({ deleted_at: new Date().toISOString() }).eq('id', a.profileId)
  const s = await surchargeOk(a.reg.id, event.categoryIds[1], 2000)
  await db().from('profiles').update({ deleted_at: null }).eq('id', a.profileId)
  return { event, a, s }
}

test('CC-47 a runner without an account: surcharge has buyer_email only; that address claims it on order-status, anybody else gets 404', async () => {
  const { a, s } = await accountlessSurcharge()
  const order = await one('orders', { id: s.orderId })
  assert.equal(order.kind, 'surcharge')
  assert.equal(order.buyer_profile_id, null)
  assert.equal(order.buyer_email, a.email)

  const stranger = await sessionFor('stranger-cc32@test.local')
  assert.equal((await callFn('order-status', stranger, { orderId: s.orderId })).status, 404)
  assert.equal((await callFn('pay-order', stranger, { orderId: s.orderId })).status, 404)
  assert.equal((await callFn('cancel-my-order', stranger, { orderId: s.orderId })).status, 404)
  assert.equal((await one('orders', { id: s.orderId })).buyer_profile_id, null, 'a stranger claims nothing')

  const runner = await sessionFor(a.email.toUpperCase())
  const res = await callFn('order-status', runner, { orderId: s.orderId })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.data.kind, 'surcharge')
  assert.equal((await one('orders', { id: s.orderId })).buyer_profile_id, a.profileId)
  // Claimed: nobody else may read it now, and the buyer keeps reading it.
  assert.equal((await callFn('order-status', stranger, { orderId: s.orderId })).status, 404)
  assert.equal((await callFn('order-status', runner, { orderId: s.orderId })).status, 200)
})

test('CC-47 the claimed buyer can pay the surcharge (dpay mock)', async () => {
  const { a, s } = await accountlessSurcharge()
  const runner = await sessionFor(a.email)
  const res = await callFn('pay-order', runner, { orderId: s.orderId })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.ok(res.body.data.redirectUrl)
  assert.equal((await one('orders', { id: s.orderId })).buyer_profile_id, a.profileId)
  const txns = await dpayTransactions()
  assert.ok(txns.some((t) => t.request.custom === s.orderId))
})

test('CC-47 the claimed buyer can cancel it (cancel-my-order)', async () => {
  const { a, s } = await accountlessSurcharge()
  const res = await callFn('cancel-my-order', await sessionFor(a.email), { orderId: s.orderId })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal((await one('orders', { id: s.orderId })).status, 'cancelled')
})

test('CC-47 a registration order with no buyer profile is never claimable, even by its own address', async () => {
  const event = await paidEvent()
  const email = `noacct-${Date.now()}@test.local`
  const out = await orderOk(event, { buyerEmail: email })
  await db().from('orders').update({ buyer_profile_id: null }).eq('id', out.orderId)
  const session = await sessionFor(email)
  assert.equal((await callFn('order-status', session, { orderId: out.orderId })).status, 404)
  assert.equal((await callFn('pay-order', session, { orderId: out.orderId })).status, 404)
  assert.equal((await callFn('cancel-my-order', session, { orderId: out.orderId })).status, 404)
  assert.equal((await one('orders', { id: out.orderId })).buyer_profile_id, null)
  void profileFor
})
