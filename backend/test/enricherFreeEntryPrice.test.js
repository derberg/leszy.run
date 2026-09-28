import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AI_FILLABLE, fillFreeEntryPrices, applyRegistryUpdates, pickFillable } from '../scripts/lib/ai-fillable.js'

// herkules:4279 "Bieg Niepodległości" (2026-11-15) published with no price at all.
// Section VIII of its regulamin says "BEZ OPŁATY STARTOWEJ !!!!", so the fee IS
// stated: it is 0. run-enrich-from-regulamin.js read that same document fine
// (its distances match), but the prompt only asked for a fee "or null if not
// stated", so Claude answered null and applyRegistryUpdates wrote nothing.
const HERKULES_4279_REGULAMIN = `
VII. ZGŁOSZENIA
Zgłoszenia przyjmowane są do dnia 10 listopada 2026.

VIII. OPŁATA STARTOWA
BEZ OPŁATY STARTOWEJ !!!!

IX. KLASYFIKACJE
Bieg główny na 5 km i 10 km oraz biegi dzieci na 200 m, 400 m i 800 m.
`

test('a regulamin that declares no entry fee yields a price of 0', () => {
  const extracted = { price_from: null, price_to: null }
  fillFreeEntryPrices(extracted, HERKULES_4279_REGULAMIN)
  assert.equal(extracted.price_from, 0)
  assert.equal(extracted.price_to, 0)
})

test('the 0 survives the registry and reaches the row update', () => {
  const row = { id: 4279, name: 'Bieg Niepodległości', date: '2026-11-15', price_from: null, price_to: null }
  const registry = pickFillable(['price_from', 'price_to'])
  const extracted = { price_from: null, price_to: null }
  fillFreeEntryPrices(extracted, HERKULES_4279_REGULAMIN)
  const updates = applyRegistryUpdates(row, extracted, ['price_from', 'price_to'], registry)
  assert.deepEqual(updates, { price_from: 0, price_to: 0 })
})

test('a stated fee is never overwritten with 0', () => {
  // Some regulamins waive the fee for one category and charge for another.
  // Whatever the model read stands; we only supply the value it left empty.
  const extracted = { price_from: 30, price_to: 50 }
  fillFreeEntryPrices(extracted, HERKULES_4279_REGULAMIN)
  assert.equal(extracted.price_from, 30)
  assert.equal(extracted.price_to, 50)
})

test('free parking and free water are not a free race', () => {
  const extracted = { price_from: null, price_to: null }
  fillFreeEntryPrices(extracted, 'Bezpłatny parking przy starcie. Darmowa woda na trasie.')
  assert.equal(extracted.price_from, null)
  assert.equal(extracted.price_to, null)
})

test('a document with no fee section at all is left alone', () => {
  const extracted = { price_from: null, price_to: null }
  fillFreeEntryPrices(extracted, 'Trasa prowadzi leśnymi ścieżkami wokół jeziora.')
  assert.equal(extracted.price_from, null)
  assert.equal(extracted.price_to, null)
  fillFreeEntryPrices(extracted, '')
  assert.equal(extracted.price_from, null)
})

test('the price prompt tells the model that free means 0, not null', () => {
  // The prompt template appends ", or null if not stated" to every hint. Without
  // this sentence the model reads "no number" as "not stated".
  for (const field of ['price_from', 'price_to']) {
    assert.match(AI_FILLABLE[field].promptHint, /\b0\b/)
    assert.match(AI_FILLABLE[field].promptHint, /bez opłaty startowej/i)
  }
})
