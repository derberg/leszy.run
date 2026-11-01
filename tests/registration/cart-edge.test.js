// Plan 7, task 4b (ruling C-1): the cart through the sign-up functions. create-order and
// register-team forward each person's voucherCode and extras and the donation to the RPCs;
// create-order lets a free event through when extras or a donation make money (ruling 7) and prices
// a price_changed answer through cartAmounts (D7-21); every cart refusal is a 409 or 400 that names
// the person, never a 500; register-free answers not_free. Scenarios V-21 (edge) and V-28 in
// docs/registration/scenario-matrix.md. LOCAL stack plus the mocked dpay.
import { test, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { localEnv, resetThrottle, sessionFor } from './helpers/stack.js'
import { acceptAgreement, createPublishedFreeEvent, createPublishedPaidEvent } from './helpers/registrationFixtures.js'
import { startDpayMock } from './helpers/dpayControl.js'
import { consentIds, one, orderOf, registrationsOf, rows, runnerEmail } from './helpers/orders.js'
import { BIEG, DZIECI } from './helpers/groups.js'
import { STAFETA, teamName } from './helpers/teams.js'
import { makeExtra, makeVoucher, setCharity, vouchersMade } from './helpers/cart.js'
import { assertVoucherInvariant } from './helpers/voucherInvariant.js'

const NOT_FREE_CART = 'Do bezpłatnego zapisu nie dodasz kodu rabatowego, dodatków ani darowizny.'

let owner, stopMock
before(async () => {
  stopMock = await startDpayMock()
  await resetThrottle()
  await acceptAgreement('zatyrani-test')
  owner = await sessionFor('owner@zatyrani-test.local')
})
after(async () => { if (stopMock) await stopMock() })
afterEach(async () => {
  const vouchers = [...vouchersMade]
  vouchersMade.clear()
  for (const id of vouchers) await assertVoucherInvariant(id)
})

const ip = () => `198.51.100.${crypto.randomInt(1, 255)}`

async function call(fn, body, session, { raw } = {}) {
  const res = await fetch(`${localEnv().functionsUrl}/${fn}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip(), ...(session ? { cookie: session.cookie } : {}) },
    body: raw ?? JSON.stringify(body),
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { status: res.status, body: json }
}

const grownUp = (email, over = {}) => ({
  firstName: 'Ola', lastName: 'Leśna', birthDate: '1990-05-01', gender: 'K', email, phone: '600100200', ...over,
})
const child = () => ({ firstName: 'Zosia', lastName: 'Leśna', birthDate: '2016-05-05', gender: 'K', phone: '600100200' })

const paidFamily = () => createPublishedPaidEvent(owner, {
  prices: { 'Bieg 9 km': 6000, 'Bieg dzieci 1 km': 2000 }, competitions: [BIEG(50), DZIECI(50)],
})

/** The buyer's session and a body for `people` ([{ categoryId, person, ... }]). */
async function buyer(event, people, over = {}) {
  const me = people[0]?.person?.email ?? runnerEmail('cart')
  return {
    session: await sessionFor(me),
    body: { people, acceptedConsentIds: await consentIds(event.eventId), serviceRegulamin: true, ...over },
  }
}

// ---------------------------------------------------------------- forwarding

test('V-21 create-order forwards a family cart: a code on the adult, a shirt for the child, a donation as "2000"', async () => {
  const event = await paidFamily()
  const [c9, kids] = event.categoryIds
  await setCharity(event.eventId)
  const voucher = await makeVoucher(event.eventId, { percent: 15 })
  const { variants: { M } } = await makeExtra(event)
  const me = runnerEmail('family')
  const { session, body } = await buyer(event, [
    { categoryId: c9, person: grownUp(me), voucherCode: voucher.code.toLowerCase() },
    { categoryId: kids, person: child(), guardianConsent: true, extras: [{ variantId: M.id, qty: 1 }] },
  ], { donation: '2000', displayedTotal: 5100 + 2000 + 4500 + 2000 })
  const r = await call('create-order', body, session)
  assert.equal(r.status, 201, JSON.stringify(r.body))
  const order = await orderOf(r.body.data.orderId)
  assert.deepEqual([order.entry_total, order.extras_total, order.donation, order.total], [7100, 4500, 2000, 13600])
  const regs = await registrationsOf(order.id)
  assert.equal(regs.filter((x) => x.voucher_id === voucher.id).length, 1)
  assert.equal((await one('extra_variants', { id: M.id })).sold, 1)
})

test('V-28 the donation: "0", 0.0 and null are 0 on any event; not a whole number → 400; outside a charity → 409', async () => {
  const event = await paidFamily()
  const [c9] = event.categoryIds
  for (const donation of ['"0"', '0.0', 'null']) {
    const { session, body } = await buyer(event, [{ categoryId: c9, person: grownUp(runnerEmail('zero')) }], { displayedTotal: 6000 })
    const raw = JSON.stringify(body).replace(/}$/, `,"donation":${donation}}`)
    const r = await call('create-order', null, session, { raw })
    assert.equal(r.status, 201, `${donation}: ${JSON.stringify(r.body)}`)
    assert.equal((await orderOf(r.body.data.orderId)).donation, 0)
  }
  for (const donation of [12.5, 'abc', -100]) {
    const { session, body } = await buyer(event, [{ categoryId: c9, person: grownUp(runnerEmail('bad')) }], { displayedTotal: 6000, donation })
    const r = await call('create-order', body, session)
    assert.deepEqual([r.status, r.body.code, r.body.field], [400, 'invalid_amount:donation', 'donation'], JSON.stringify(donation))
  }
  const { session, body } = await buyer(event, [{ categoryId: c9, person: grownUp(runnerEmail('gift')) }], { displayedTotal: 8000, donation: 2000 })
  const refused = await call('create-order', body, session)
  assert.deepEqual([refused.status, refused.body.code], [409, 'donation_not_allowed'])
  // Below the 1 zł floor: the RPC's range check, still no 500.
  await setCharity(event.eventId)
  const low = await buyer(event, [{ categoryId: c9, person: grownUp(runnerEmail('low')) }], { displayedTotal: 6050, donation: 50 })
  const lowR = await call('create-order', low.body, low.session)
  assert.deepEqual([lowR.status, lowR.body.code], [400, 'invalid_amount:donation'])
})

test('V-28 an extra with no qty is invalid input (400, the person named); one past the RPC limits is too', async () => {
  const event = await paidFamily()
  const [c9] = event.categoryIds
  const { variants: { M } } = await makeExtra(event)
  const me = runnerEmail('noqty')
  const a = await buyer(event, [
    { categoryId: c9, person: grownUp(me) },
    { categoryId: c9, person: grownUp(runnerEmail('other')), extras: [{ variantId: M.id }] },
  ], { displayedTotal: 12000 })
  const r = await call('create-order', a.body, a.session)
  assert.deepEqual([r.status, r.body.code, r.body.index], [400, 'invalid_extras', 1])
  const b = await buyer(event, [{ categoryId: c9, person: grownUp(runnerEmail('many')), extras: [{ variantId: M.id, qty: 11 }] }],
    { displayedTotal: 6000 + 11 * 4500 })
  const many = await call('create-order', b.body, b.session)
  assert.deepEqual([many.status, many.body.code], [400, 'invalid_people'])
  assert.equal((await one('extra_variants', { id: M.id })).sold, 0)
})

test('V-21 a free event: create-order refuses an empty cart (free_event) and takes one with a shirt (ruling 7)', async () => {
  const event = await createPublishedFreeEvent(owner, { competitions: [BIEG(50)] })
  const [c9] = event.categoryIds
  const { variants: { M } } = await makeExtra(event, { price: 4500 })
  const empty = await buyer(event, [{ categoryId: c9, person: grownUp(runnerEmail('free')) }], { displayedTotal: 0 })
  const r = await call('create-order', empty.body, empty.session)
  assert.deepEqual([r.status, r.body.code], [409, 'free_event'])
  const zero = await buyer(event, [{ categoryId: c9, person: grownUp(runnerEmail('zeroqty')), extras: [{ variantId: M.id, qty: 0 }] }],
    { displayedTotal: 0, donation: '0' })
  assert.equal((await call('create-order', zero.body, zero.session)).body.code, 'free_event', 'all-zero cart makes no money')
  const shirt = await buyer(event, [{ categoryId: c9, person: grownUp(runnerEmail('shirt')), extras: [{ variantId: M.id, qty: 1 }] }],
    { displayedTotal: 4500 })
  const s = await call('create-order', shirt.body, shirt.session)
  assert.equal(s.status, 201, JSON.stringify(s.body))
  const order = await orderOf(s.body.data.orderId)
  assert.deepEqual([order.status, order.entry_total, order.extras_total, order.total], ['pending', 0, 4500, 4500])
})

// ---------------------------------------------------------------- the refusals

test('V-22 each cart refusal is a 409 naming the person and the field, never a 500', async () => {
  const event = await paidFamily()
  const [c9, kids] = event.categoryIds
  const single = await makeVoucher(event.eventId, { percent: 15, max_uses: 1 })
  const expired = await makeVoucher(event.eventId, { percent: 15, valid_until: new Date(Date.now() - 60_000).toISOString() })
  const adultsOnly = await makeVoucher(event.eventId, { percent: 15, categoryIds: [c9] })
  const { variants: { M } } = await makeExtra(event, { variants: [['M', 0]] })
  const past = await makeExtra(event, { name: 'Medal', orderUntil: '2020-01-01' })

  const cases = [
    ['voucher_used_up', 1, [
      { categoryId: c9, person: grownUp(runnerEmail('u1')), voucherCode: single.code },
      { categoryId: c9, person: grownUp(runnerEmail('u2')), voucherCode: single.code },
    ], 5100 * 2],
    ['voucher_invalid', 0, [{ categoryId: c9, person: grownUp(runnerEmail('inv')), voucherCode: 'NIE-MA-TAKIEGO' }], 5100],
    ['voucher_expired', 0, [{ categoryId: c9, person: grownUp(runnerEmail('exp')), voucherCode: expired.code }], 5100],
    ['voucher_category', 1, [
      { categoryId: c9, person: grownUp(runnerEmail('cat')) },
      { categoryId: kids, person: child(), guardianConsent: true, voucherCode: adultsOnly.code },
    ], 6000 + 1700],
    ['extra_sold_out', 0, [{ categoryId: c9, person: grownUp(runnerEmail('sold')), extras: [{ variantId: M.id, qty: 1 }] }], 6000 + 4500],
    ['extra_unavailable', 0, [{ categoryId: c9, person: grownUp(runnerEmail('late')), extras: [{ variantId: past.variants.M.id, qty: 1 }] }], 6000 + 4500],
  ]
  for (const [code, index, people, displayedTotal] of cases) {
    const { session, body } = await buyer(event, people, { displayedTotal })
    const r = await call('create-order', body, session)
    assert.equal(r.status, 409, `${code}: ${JSON.stringify(r.body)}`)
    assert.deepEqual([r.body.code, r.body.index, r.body.field], [code, index, code.startsWith('voucher') ? 'voucherCode' : 'extras'])
    assert.ok(r.body.error, code)
  }
})

test('V-22 voucher_not_applicable: a code on a 0 zł entry of a free event with a shirt → 409, the person named', async () => {
  const event = await createPublishedFreeEvent(owner, { competitions: [BIEG(50)] })
  const [c9] = event.categoryIds
  const voucher = await makeVoucher(event.eventId)
  const { variants: { M } } = await makeExtra(event, { price: 4500 })
  const { session, body } = await buyer(event, [
    { categoryId: c9, person: grownUp(runnerEmail('na')), voucherCode: voucher.code, extras: [{ variantId: M.id, qty: 1 }] },
  ], { displayedTotal: 4500 })
  const r = await call('create-order', body, session)
  assert.deepEqual([r.status, r.body.code, r.body.index, r.body.field], [409, 'voucher_not_applicable', 0, 'voucherCode'])
})

test('V-21 price_changed with a cart answers the amounts cartAmounts gives: discounted entries, extras, donation', async () => {
  const event = await paidFamily()
  const [c9, kids] = event.categoryIds
  await setCharity(event.eventId)
  const voucher = await makeVoucher(event.eventId, { percent: 15 })
  const { variants: { M } } = await makeExtra(event)
  const { session, body } = await buyer(event, [
    { categoryId: c9, person: grownUp(runnerEmail('pc')), voucherCode: voucher.code },
    { categoryId: kids, person: child(), guardianConsent: true, extras: [{ variantId: M.id, qty: 2 }] },
  ], { donation: 2000, displayedTotal: 1 })
  const r = await call('create-order', body, session)
  assert.equal(r.status, 409, JSON.stringify(r.body))
  assert.equal(r.body.code, 'price_changed')
  const a = r.body.amounts
  assert.deepEqual([a.entryPrices, a.entryTotal, a.extrasTotal, a.donation, a.total], [[5100, 2000], 7100, 9000, 2000, 18100])
  assert.deepEqual(Object.keys(a).sort(), ['donation', 'entryPrices', 'entryTotal', 'extrasTotal', 'total'], "Plan 3's shape")
  assert.equal((await one('vouchers', { id: voucher.id })).used, 0)
})

// ---------------------------------------------------------------- register-team, register-free

test('V-21 register-team forwards the team code, a member shirt and a donation; a bad code is 409 at index 0', async () => {
  const event = await createPublishedPaidEvent(owner, { competitions: [STAFETA(50)], prices: { Sztafeta: 24000 } })
  await setCharity(event.eventId)
  const voucher = await makeVoucher(event.eventId, { percent: 10 })
  const { variants: { M } } = await makeExtra(event)
  const me = runnerEmail('captain')
  const session = await sessionFor(me)
  const base = {
    categoryId: event.categoryIds[0], teamName: teamName(), membersConsent: true,
    acceptedConsentIds: await consentIds(event.eventId), serviceRegulamin: true,
    members: [{ person: grownUp(me) }, { person: grownUp(runnerEmail('m2'), { firstName: 'Piotr' }), extras: [{ variantId: M.id, qty: 1 }] }],
  }
  const bad = await call('register-team', { ...base, voucherCode: 'NIE-MA-TAKIEGO', displayedTotal: 21600 + 4500 }, session)
  assert.deepEqual([bad.status, bad.body.code, bad.body.index], [409, 'voucher_invalid', 0], JSON.stringify(bad.body))

  const r = await call('register-team', { ...base, voucherCode: voucher.code, donation: 1000, displayedTotal: 21600 + 4500 + 1000 }, session)
  assert.equal(r.status, 201, JSON.stringify(r.body))
  const order = await orderOf(r.body.data.orderId)
  assert.deepEqual([order.entry_total, order.extras_total, order.donation, order.total], [21600, 4500, 1000, 27100])
  const captain = (await registrationsOf(order.id)).find((x) => x.voucher_id === voucher.id)
  assert.deepEqual([captain.list_price, captain.price], [24000, 21600])
  assert.equal((await rows('order_lines', { order_id: order.id })).filter((l) => l.kind === 'extra').length, 1)
})

test('V-28 register-free with a code → 409 not_free (the cart sentence); all-zero extras and a "0" donation register', async () => {
  const event = await createPublishedFreeEvent(owner, { competitions: [BIEG(50)] })
  const [c9] = event.categoryIds
  const voucher = await makeVoucher(event.eventId)
  const { variants: { M } } = await makeExtra(event)
  const coded = await buyer(event, [{ categoryId: c9, person: grownUp(runnerEmail('fc')), voucherCode: voucher.code }])
  const r = await call('register-free', coded.body, coded.session)
  assert.deepEqual([r.status, r.body.code, r.body.error], [409, 'not_free', NOT_FREE_CART])
  const gift = await buyer(event, [{ categoryId: c9, person: grownUp(runnerEmail('fd')) }], { donation: 1000 })
  const g = await call('register-free', gift.body, gift.session)
  assert.deepEqual([g.status, g.body.code], [409, 'not_free'])
  const zero = await buyer(event, [{ categoryId: c9, person: grownUp(runnerEmail('fz')), extras: [{ variantId: M.id, qty: 0 }] }],
    { donation: '0' })
  const z = await call('register-free', zero.body, zero.session)
  assert.equal(z.status, 201, JSON.stringify(z.body))
  assert.equal((await one('vouchers', { id: voucher.id })).used, 0)
})
