import { test } from 'node:test'
import assert from 'node:assert/strict'
import { donationAttribute, feesFromVariations, parsePrices } from '../src/scrapers/sources/lumisport.js'

// I Magnuszewski Bieg Mikołajkowy (lumisport:magnuszewski-bieg-mikolajkowy) is
// free to enter. Its WooCommerce variations are the optional donation
// ("dobrowolne uiszczenie darowizny", 0 / 50 / 100 / 200 zł), so the product's
// price_range 0–200 zł is the donation, not a fee. Store API data below is
// copied from /wp-json/wc/store/v1/products and /products/<variation id> on
// 2026-11-11.

const MAGNUSZEW = {
  id: 9567,
  slug: 'magnuszewski-bieg-mikolajkowy',
  type: 'variable',
  prices: { price: '0', price_range: { min_amount: '0', max_amount: '20000' } },
  attributes: [
    { id: 7, name: 'Darowizna', taxonomy: 'pa_darowizna', has_variations: true,
      terms: [{ name: '0 zł', slug: '0-zl' }, { name: '100 zł', slug: '100-zl' },
        { name: '200 zł', slug: '200-zl' }, { name: '50 zł', slug: '50-zl' }] },
    { id: 1, name: 'Dystans', taxonomy: 'pa_dystans', has_variations: true,
      terms: [{ name: '5 km', slug: '5-km-2' }] },
  ],
  variations: [
    { id: 9571, attributes: [{ name: 'Darowizna', value: '0-zl' }, { name: 'Dystans', value: '5-km-2' }] },
    { id: 9572, attributes: [{ name: 'Darowizna', value: '100-zl' }, { name: 'Dystans', value: '5-km-2' }] },
    { id: 9573, attributes: [{ name: 'Darowizna', value: '200-zl' }, { name: 'Dystans', value: '5-km-2' }] },
    { id: 9574, attributes: [{ name: 'Darowizna', value: '50-zl' }, { name: 'Dystans', value: '5-km-2' }] },
  ],
}
const MAGNUSZEW_PRICES = new Map([[9571, '0'], [9572, '10000'], [9573, '20000'], [9574, '5000']])

test('a donation attribute is recognised by name or taxonomy', () => {
  assert.equal(donationAttribute(MAGNUSZEW.attributes).name, 'Darowizna')
  assert.equal(donationAttribute([{ name: 'Dystans', taxonomy: 'pa_dystans', terms: [] }]), null)
  assert.equal(donationAttribute([{ name: 'aktywni członkowie ZHP', taxonomy: null, terms: [] }]), null)
})

test('the donation is taken out of each variation: a free entry is 0–0', () => {
  assert.deepEqual(feesFromVariations(MAGNUSZEW, MAGNUSZEW_PRICES), { priceFrom: 0, priceTo: 0 })
})

test('a paid entry with a donation on top keeps the fee per distance', () => {
  const product = {
    ...MAGNUSZEW,
    attributes: [
      MAGNUSZEW.attributes[0],
      { name: 'Dystans', taxonomy: 'pa_dystans', terms: [{ name: '5 km', slug: '5-km' }, { name: '10 km', slug: '10-km' }] },
    ],
    variations: [
      { id: 1, attributes: [{ name: 'Darowizna', value: '0-zl' }, { name: 'Dystans', value: '5-km' }] },
      { id: 2, attributes: [{ name: 'Darowizna', value: '50-zl' }, { name: 'Dystans', value: '5-km' }] },
      { id: 3, attributes: [{ name: 'Darowizna', value: '0-zl' }, { name: 'Dystans', value: '10-km' }] },
      { id: 4, attributes: [{ name: 'Darowizna', value: '50-zl' }, { name: 'Dystans', value: '10-km' }] },
    ],
  }
  const prices = new Map([[1, '6000'], [2, '11000'], [3, '8000'], [4, '13000']])
  assert.deepEqual(feesFromVariations(product, prices), { priceFrom: 60, priceTo: 80 })
})

test('a donation term without an amount, or a missing variation price, gives no price', () => {
  const vague = {
    ...MAGNUSZEW,
    attributes: [{ name: 'Darowizna', taxonomy: 'pa_darowizna', terms: [{ name: 'dowolna', slug: 'dowolna' }] }],
    variations: [{ id: 1, attributes: [{ name: 'Darowizna', value: 'dowolna' }] }],
  }
  assert.deepEqual(feesFromVariations(vague, new Map([[1, '5000']])), { priceFrom: null, priceTo: null })
  assert.deepEqual(feesFromVariations(MAGNUSZEW, new Map([[9571, '0']])), { priceFrom: null, priceTo: null })
})

test('a product without a donation keeps its price range', () => {
  assert.deepEqual(parsePrices({ price: '8000', price_range: { min_amount: '8000', max_amount: '9000' } }),
    { priceFrom: 80, priceTo: 90 })
})
