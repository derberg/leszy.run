// Plan 7, task 4a: concurrency of voucher uses and extra stock in create_order (V-27 a–c in
// docs/registration/scenario-matrix.md). Every call runs on its own PostgREST connection at the
// same time. Invariants: a voucher's used = the live registrations holding it and never passes
// max_uses; a variant's sold never passes its stock and equals the qty on live orders' lines; no
// call ends in a deadlock (40P01). LOCAL stack only.
import { test, before, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { sessionFor } from './helpers/stack.js'
import { acceptAgreement, createPublishedPaidEvent } from './helpers/registrationFixtures.js'
import { one, rows } from './helpers/orders.js'
import { BIEG, adult, isDeadlock, orderGroup } from './helpers/groups.js'
import { makeExtra, makeVoucher, vouchersMade } from './helpers/cart.js'
import { assertVoucherInvariant } from './helpers/voucherInvariant.js'
import { assertSlotInvariant } from './helpers/slotInvariant.js'

let owner
const competitionsSeen = new Set()
before(async () => {
  await acceptAgreement('zatyrani-test')
  owner = await sessionFor('owner@zatyrani-test.local')
})
afterEach(async () => {
  for (const id of competitionsSeen) await assertSlotInvariant(id)
  for (const id of vouchersMade) await assertVoucherInvariant(id)
  competitionsSeen.clear()
  vouchersMade.clear()
})

async function paidEvent() {
  const event = await createPublishedPaidEvent(owner, { prices: { 'Bieg 9 km': 6000 }, competitions: [BIEG(100)] })
  competitionsSeen.add(event.categoryIds[0])
  return event
}

function outcomes(rs) {
  assert.deepEqual(rs.filter(isDeadlock).map((r) => r.error.message), [], 'no deadlock')
  return { ok: rs.filter((r) => !r.error), errors: rs.filter((r) => r.error).map((r) => r.error.message) }
}

async function soldMatchesLines(variantId) {
  const v = await one('extra_variants', { id: variantId })
  const lines = await rows('order_lines', { extra_variant_id: variantId })
  assert.ok(v.sold <= v.stock, `sold ${v.sold} <= stock ${v.stock}`)
  assert.equal(v.sold, lines.reduce((s, l) => s + l.qty, 0), 'sold = the qty on the order lines')
  return v.sold
}

// ---------------------------------------------------------------- (a), (b)

for (const [label, maxUses] of [['a', 1], ['b', 5]]) {
  test(`V-27${label} max_uses ${maxUses}: 20 parallel create_order with the code → exactly ${maxUses} hold it`, async () => {
    const event = await paidEvent()
    const cat = event.categoryIds[0]
    const voucher = await makeVoucher(event.eventId, { percent: 15, max_uses: maxUses })
    const rs = await Promise.all(Array.from({ length: 20 }, () =>
      orderGroup(event, [{ ...adult(cat, 'self'), voucherCode: voucher.code }], { displayed: 5100 })))
    const { ok, errors } = outcomes(rs)
    assert.equal(ok.length, maxUses, JSON.stringify(errors))
    assert.deepEqual([...new Set(errors)], ['voucher_used_up:0'])
    assert.equal(errors.length, 20 - maxUses)
    const v = await one('vouchers', { id: voucher.id })
    assert.equal(v.used, maxUses)
    const holders = (await rows('registrations', { event_id: event.eventId })).filter((r) => r.voucher_id === voucher.id)
    assert.equal(holders.length, maxUses)
    assert.ok(holders.every((r) => r.price === 5100 && r.list_price === 6000))
  })
}

// ---------------------------------------------------------------- (c)

test('V-27c stock 3 of variant M: 10 parallel create_order → 3 sold, 7 extra_sold_out:0', async () => {
  const event = await paidEvent()
  const cat = event.categoryIds[0]
  const { variants: { M, L } } = await makeExtra(event, { variants: [['M', 3], ['L', 100]] })
  const rs = await Promise.all(Array.from({ length: 10 }, () =>
    orderGroup(event, [{ ...adult(cat, 'self'), extras: [{ variantId: L.id, qty: 1 }, { variantId: M.id, qty: 1 }] }],
      { displayed: 6000 + 4500 + 4500 })))
  const { ok, errors } = outcomes(rs)
  assert.equal(ok.length, 3, JSON.stringify(errors))
  assert.deepEqual([...new Set(errors)], ['extra_sold_out:0'])
  assert.equal(await soldMatchesLines(M.id), 3)
  assert.equal(await soldMatchesLines(L.id), 3, 'a refused order keeps no other variant either')
  assert.equal((await rows('orders', { event_id: event.eventId })).length, 3)
})
