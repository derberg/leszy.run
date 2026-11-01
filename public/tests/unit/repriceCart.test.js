import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { listPricesFrom, repriceCart } from '../../src/lib/checkout.js'
import { checkoutCart } from '../../src/lib/cartModel.js'

// Plan 7, task 8a re-review N-1: a price_changed after a code was left unchecked (429, offline)
// must never teach the form a discounted price as the competition's list price, or the next
// accepted check discounts it twice.
const CAT = '11111111-1111-4111-8111-111111111111'

describe('N-1 a coded line is never fed back as a list price', () => {
  for (const [label, order] of [['coded card first', [0, 1]], ['coded card last', [1, 0]]]) {
    it(`a group of two in one competition, the code unchecked (${label})`, () => {
      const coded = { key: 'a', categoryId: CAT, priceGrosze: 6000, voucher: null, hasCode: true, extras: [] }
      const plain = { key: 'b', categoryId: CAT, priceGrosze: 6000, voucher: null, hasCode: false, extras: [] }
      const lines = order.map((i) => [coded, plain][i])
      const entryPrices = lines.map((l) => (l.hasCode ? 5100 : 6000))
      const repriced = repriceCart(lines, { entryPrices, entryTotal: 11100, extrasTotal: 0, donation: 0, total: 11100 })
      assert.deepEqual(repriced.map((l) => l.priceGrosze), entryPrices)
      // Only the plain card's price reaches the form: the list price stays 60 zł.
      assert.deepEqual(listPricesFrom(lines, repriced), { [CAT]: 6000 })
      // The code accepted on the next pass: the form's list price discounts once, 60 → 51.
      const next = checkoutCart([{ priceGrosze: 6000, voucher: { code: 'BIEGACZ15', percent: 15 } }], 0)
      assert.deepEqual(next.voucherLabels, ['60,00 zł − 15% (BIEGACZ15) = 51,00 zł'])
    })
  }

  it('an accepted code, and a team fee line holding a code, give nothing back (the team keeps its fee, N-2)', () => {
    const accepted = [{ categoryId: CAT, priceGrosze: 6000, voucher: { code: 'K', percent: 15 }, hasCode: true }]
    const repriced = repriceCart(accepted, { entryPrices: [5950], entryTotal: 5950, total: 5950 })
    assert.deepEqual(listPricesFrom(accepted, repriced), {})
    const unchecked = [{ categoryId: CAT, priceGrosze: 24000, voucher: null, hasCode: true }]
    assert.deepEqual(listPricesFrom(unchecked, repriceCart(unchecked, { entryPrices: [20400], entryTotal: 20400, total: 20400 })), {})
  })

  it('a plain line still teaches the form its new price', () => {
    const lines = [{ categoryId: CAT, priceGrosze: 6000, voucher: null, hasCode: false }]
    assert.deepEqual(listPricesFrom(lines, repriceCart(lines, { entryPrices: [7000], entryTotal: 7000, total: 7000 })), { [CAT]: 7000 })
  })
})
