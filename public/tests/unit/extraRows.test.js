import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addVariant, assignExtraIds, competitionOn, extraRow, extraSold, extrasSection, newExtraRow, toggleCompetition,
} from '../../src/lib/extraRows.js'

const C1 = '11111111-1111-4111-8111-111111111111'
const C2 = '22222222-2222-4222-8222-222222222222'
const X1 = '33333333-3333-4333-8333-333333333333'
const V1 = '44444444-4444-4444-8444-444444444444'
const V2 = '55555555-5555-4555-8555-555555555555'

const server = (over = {}) => ({
  id: X1, name: 'Koszulka', imageUploadId: null, price: 4500, orderUntil: '2027-11-20', categoryIds: [],
  variants: [{ id: V1, label: 'M', stock: 40, sold: 0 }, { id: V2, label: 'L', stock: 100000, sold: 0 }], ...over,
})

test('A5b a server extra becomes a card: price as text, „no limit” as an empty field', () => {
  const r = extraRow(server())
  assert.equal(r.price, '45')
  assert.deepEqual(r.variants.map((v) => [v.label, v.stock]), [['M', '40'], ['L', '']])
  assert.deepEqual(r.saved.variants, [{ id: V1, label: 'M', stock: 40 }, { id: V2, label: 'L', stock: 100000 }])
})

test('A5b a whole new card is sent; an empty limit is MAX_STOCK; an untouched new card is left out without errors', () => {
  const filled = { ...newExtraRow(), name: 'Posiłek', price: '20', orderUntil: '2027-11-20' }
  filled.variants = [{ ...filled.variants[0], label: 'Wege', stock: '' }]
  const s = extrasSection([filled, newExtraRow()], { state: 'draft', eventDate: '2027-12-05' })
  assert.equal(s.ok, true)
  assert.deepEqual(s.value.items, [{
    name: 'Posiłek', imageUploadId: null, price: '20', orderUntil: '2027-11-20', categoryIds: [], variants: [{ label: 'Wege', stock: 100000 }],
  }])
  assert.deepEqual(s.cardErrors, {})
})

test('A5b a saved card mid-edit sends its last whole value; the errors name the field and the variant', () => {
  const r = extraRow(server())
  const edited = { ...r, name: '', variants: [{ ...r.variants[0], label: '' }, r.variants[1]] }
  const s = extrasSection([edited], { state: 'draft', eventDate: '2027-12-05' })
  assert.equal(s.value.items[0].name, 'Koszulka')
  assert.equal(s.cardErrors[r.key].fields.name, 'Podaj nazwę dodatku.')
  assert.equal(s.cardErrors[r.key].variants[r.variants[0].key].label, 'Podaj nazwę wariantu.')
  assert.equal(s.cardErrors[r.key].fields.label, undefined)
})

test('A5b an order deadline after the race day is refused on its field', () => {
  const r = { ...extraRow(server()), orderUntil: '2027-12-06' }
  const s = extrasSection([r], { state: 'draft', eventDate: '2027-12-05' })
  assert.equal(s.cardErrors[r.key].fields.orderUntil, 'Zamówienia najpóźniej w dniu zawodów.')
})

test('V-71 a sold variant cannot drop below what sold; the card says so on the variant', () => {
  const r = extraRow(server({ variants: [{ id: V1, label: 'M', stock: 10, sold: 3 }] }))
  assert.equal(extraSold(r), true)
  const s = extrasSection([{ ...r, variants: [{ ...r.variants[0], stock: '2' }] }], { state: 'published', eventDate: '2027-12-05' })
  assert.equal(s.cardErrors[r.key].variants[r.variants[0].key].stock, 'Sprzedano 3: limit nie może być mniejszy.')
  assert.equal(s.value.items[0].variants[0].stock, 10)
})

test('A5b ids from a save reach the cards and variants sent without one; a variant added meanwhile stays new', () => {
  const card = { ...newExtraRow(), name: 'Czapka', price: '30', orderUntil: '2027-11-20' }
  card.variants = [{ ...card.variants[0], label: 'Uni' }]
  const s = extrasSection([card], { state: 'draft' })
  const later = s.rows.map((r) => addVariant(r))
  const next = assignExtraIds(later, s.sentKeys, s.sentVariantKeys, [X1], [[V1]])
  assert.equal(next[0].id, X1)
  assert.deepEqual(next[0].variants.map((v) => v.id), [V1, null])
  assert.equal(next[0].saved.id, X1)
  assert.deepEqual(next[0].saved.variants.map((v) => v.id), [V1])
})

test('A5b competition chips: none chosen means all; turning one off keeps the rest; the last one stays on', () => {
  const all = [C1, C2]
  assert.equal(competitionOn([], C1), true)
  assert.deepEqual(toggleCompetition([], all, C2), [C1])
  assert.deepEqual(toggleCompetition([C1], all, C2), [])
  assert.deepEqual(toggleCompetition([C1], all, C1), [C1])
})
