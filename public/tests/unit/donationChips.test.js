import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DONATION_CHIPS, checkoutCart, donationOf, donationsOffered, extraLineLabel, orderableExtras, parseDonationInput, pickedExtras, soldOut,
} from '../../src/lib/cartModel.js'
import { cartAmounts } from '../../../supabase/functions/_shared/registration/pricing.js'

// Plan 7, task 8a: RA4's donation chips and the cart model behind RA2 and RA4.

describe('V-60 the donation „inna”', () => {
  it('12,5 → 1250 grosze, with a comma, a dot, spaces or „zł”', () => {
    assert.deepEqual(parseDonationInput('12,5'), { ok: true, grosze: 1250 })
    assert.deepEqual(parseDonationInput('12.50'), { ok: true, grosze: 1250 })
    assert.deepEqual(parseDonationInput(' 5 000 '), { ok: true, grosze: 500000 })
    assert.deepEqual(parseDonationInput('1 zł'), { ok: true, grosze: 100 })
  })

  it('0 and 5 000,01 zł are refused, and so is anything not an amount', () => {
    for (const bad of ['0', '0,00', '0,99', '5 000,01', '5000,01', '', 'abc', '-5', '12,345', '1e3']) {
      const r = parseDonationInput(bad)
      assert.equal(r.ok, false, bad)
      assert.equal(r.error, 'Popraw kwotę darowizny.')
    }
  })

  it('the chips: „0”, „+5 zł”, „+10 zł”, „inna”, nothing preselected beyond 0', () => {
    assert.deepEqual(DONATION_CHIPS.map((c) => c.label), ['0', '+5 zł', '+10 zł', 'inna'])
    assert.deepEqual(donationOf('none'), { ok: true, grosze: 0 })
    assert.deepEqual(donationOf('5'), { ok: true, grosze: 500 })
    assert.deepEqual(donationOf('10'), { ok: true, grosze: 1000 })
    assert.deepEqual(donationOf('other', '12,5'), { ok: true, grosze: 1250 })
    assert.equal(donationOf('other', '').ok, false)
  })

  it('offered only on a charity event with donations on', () => {
    assert.equal(donationsOffered({ isCharity: true, donationsEnabled: true }), true)
    assert.equal(donationsOffered({ isCharity: true, donationsEnabled: false }), false)
    assert.equal(donationsOffered({ isCharity: false, donationsEnabled: true }), false)
  })
})

const C9 = '11111111-1111-4111-8111-111111111111'
const C3 = '22222222-2222-4222-8222-222222222222'
const EXTRAS = [
  { id: 'x1', name: 'Koszulka', price: 4500, orderUntil: '2026-11-20', categoryIds: [], imageUrl: null,
    variants: [{ id: 's', label: 'S', left: 0 }, { id: 'm', label: 'M', left: 3 }] },
  { id: 'x2', name: 'Medal', price: 2000, orderUntil: null, categoryIds: [C9], variants: [{ id: 'md', label: 'Medal', left: 5 }] },
  { id: 'x3', name: 'Czapka', price: 3000, orderUntil: '2026-11-01', categoryIds: [], variants: [{ id: 'c', label: 'L', left: 0 }] },
]

describe('V-62 the extras a person may pick', () => {
  const now = new Date('2026-11-10T12:00:00Z')
  it('W-86 an extra carries the organizer\'s description to the picker', () => {
    const text = '35 zł pokrywa koszt wykonania koszulki, pozostałe 25 zł trafia na cel zbiórki.'
    const [shirt] = orderableExtras([{ ...EXTRAS[0], description: text }], C9, now)
    assert.equal(shirt.description, text)
  })
  it('offered in the competition and still orderable today (Warsaw); a sold-out variant stays as soldOut', () => {
    const nine = orderableExtras(EXTRAS, C9, now)
    assert.deepEqual(nine.map((x) => x.id), ['x1', 'x2'])
    assert.deepEqual(nine[0].variants, [{ id: 's', label: 'S', soldOut: true }, { id: 'm', label: 'M', soldOut: false }])
    assert.equal(nine[0].priceLabel, '45,00 zł')
    assert.equal(nine[0].description, null)
    assert.deepEqual(orderableExtras(EXTRAS, C3, now).map((x) => x.id), ['x1'])
    // The last day of ordering is still orderable, the next is not.
    assert.deepEqual(orderableExtras(EXTRAS, C3, new Date('2026-11-01T22:59:59Z')).map((x) => x.id), ['x1', 'x3'])
    assert.deepEqual(orderableExtras(EXTRAS, C3, new Date('2026-11-01T23:00:00Z')).map((x) => x.id), ['x1'])
  })

  it('a sold-out variant cannot be picked; an extra with every variant gone is soldOut', () => {
    const offered = orderableExtras(EXTRAS, C9, now)
    assert.deepEqual(pickedExtras({ x1: { variantId: 's', qty: 1 } }, offered), [])
    assert.deepEqual(pickedExtras({ x1: { variantId: 'm', qty: 2 }, x2: { variantId: 'md', qty: 0 } }, offered),
      [{ extraId: 'x1', variantId: 'm', name: 'Koszulka', variantLabel: 'M', price: 4500, qty: 2 }])
    assert.equal(soldOut(offered[0]), false)
    assert.equal(soldOut({ variants: [{ soldOut: true }] }), true)
  })

  it('RA4\'s line under the person', () => {
    assert.equal(extraLineLabel({ name: 'Koszulka', variantLabel: 'M', qty: 1, price: 4500 }), 'Koszulka · M · 45,00 zł')
    assert.equal(extraLineLabel({ name: 'Koszulka', variantLabel: 'M', qty: 2, price: 4500 }), 'Koszulka · M · 2 szt. · 90,00 zł')
    assert.equal(extraLineLabel({ name: 'Medal', variantLabel: 'Medal', qty: 1, price: 2000 }), 'Medal · 20,00 zł')
  })
})

describe('V-61 RA4\'s amounts are cartAmounts\'', () => {
  it('a voucher, an extra and a donation: the total and the voucher line', () => {
    const lines = [
      { priceGrosze: 6000, voucher: { code: 'BIEGACZ15', percent: 15 }, extras: [{ price: 4500, qty: 1 }] },
      { priceGrosze: 2000, voucher: null, extras: [] },
    ]
    const a = checkoutCart(lines, 2000)
    const expected = cartAmounts({
      people: [{ listPrice: 6000, voucherPercent: 15, extras: [{ price: 4500, qty: 1 }] }, { listPrice: 2000, voucherPercent: null, extras: [] }],
      donation: 2000,
    })
    assert.equal(a.total, expected.total)
    assert.equal(a.total, 5100 + 2000 + 4500 + 2000)
    assert.deepEqual([a.entryTotal, a.extrasTotal, a.donation], [7100, 4500, 2000])
    assert.deepEqual(a.voucherLabels, ['60,00 zł − 15% (BIEGACZ15) = 51,00 zł', null])
  })
})
