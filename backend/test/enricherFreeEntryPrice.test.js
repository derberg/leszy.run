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
  const extracted = { price_from: 30, price_to: 50 }
  fillFreeEntryPrices(extracted, HERKULES_4279_REGULAMIN)
  assert.equal(extracted.price_from, 30)
  assert.equal(extracted.price_to, 50)
})

// A regulamin that charges, and waives the fee for one category. The free
// wording is identical to a free race's, and no wording test separates them:
// "opłat" gives this document fee evidence AND the free one, and the złotówka
// amounts below are matched by the prize money a free race also lists. What
// separates them is a fee already known to exist.
const PAID_WITH_KIDS_WAIVER = `
VIII. OPŁATA STARTOWA
Opłata startowa wynosi 50 zł przy zapisie do 1 listopada 2026,
70 zł w dniu zawodów.
Dzieci do lat 7 — bez opłaty startowej.
Dla osób z orzeczeniem o niepełnosprawności start wolny od opłat.

IX. NAGRODY
Za miejsca I-III nagrody pieniężne: 500 zł, 300 zł, 200 zł.
`

test('a per-category waiver in a paid regulamin does not make the race free', () => {
  // The row already charges 50 zł; price_to is the only empty column, so it is
  // the only field asked for. Filling it with 0 would say "from 50 to 0".
  const row = { id: 9001, name: 'Bieg Jesienny', price_from: 50, price_to: null }
  const extracted = { price_to: null }
  fillFreeEntryPrices(extracted, PAID_WITH_KIDS_WAIVER, row)
  assert.equal(extracted.price_to, null, 'price_to must stay empty, not become 0')
  assert.equal(extracted.price_from, undefined, 'a field that was not asked for stays absent')

  const registry = pickFillable(['price_from', 'price_to'])
  const updates = applyRegistryUpdates(row, extracted, ['price_to'], registry)
  assert.deepEqual(updates, {}, 'nothing is written')
})

test('a waiver does not zero a price the model read from the same document', () => {
  // Nothing stored yet, but the model did read the 50/70 out of the document.
  const extracted = { price_from: 50, price_to: 70 }
  fillFreeEntryPrices(extracted, PAID_WITH_KIDS_WAIVER, { price_from: null, price_to: null })
  assert.deepEqual(extracted, { price_from: 50, price_to: 70 })

  // Half read is still a charge: the blank half is not 0 zł.
  const half = { price_from: 50, price_to: null }
  fillFreeEntryPrices(half, PAID_WITH_KIDS_WAIVER, { price_from: null, price_to: null })
  assert.equal(half.price_to, null)
})

test('a lone price that would invert against the stored one is not written', () => {
  // The last line of defence, independent of how the 0 got here: only empty
  // columns are fillable, so the guard has to compare against the row.
  const registry = pickFillable(['price_from', 'price_to'])
  const row = { id: 9001, price_from: 50, price_to: null }
  assert.deepEqual(
    applyRegistryUpdates(row, { price_to: 0 }, ['price_to'], registry),
    {},
    'price_from=50 / price_to=0 is the `inverted` finding in run-data-audit.js',
  )
  // The mirror case: a high price_from landing on a stored low price_to.
  assert.deepEqual(
    applyRegistryUpdates({ id: 9002, price_from: null, price_to: 30 }, { price_from: 40 }, ['price_from'], registry),
    {},
  )
  // A pair that does not invert still goes through.
  assert.deepEqual(
    applyRegistryUpdates(row, { price_to: 70 }, ['price_to'], registry),
    { price_to: 70 },
  )
})

test('a free race still fills both halves when the row is empty or already 0', () => {
  const both = { price_from: null, price_to: null }
  fillFreeEntryPrices(both, HERKULES_4279_REGULAMIN, { price_from: null, price_to: null })
  assert.deepEqual(both, { price_from: 0, price_to: 0 })

  // price_from=0 is a value, not a fee: it must not block the other half.
  const row = { id: 4279, price_from: 0, price_to: null }
  const half = { price_to: null }
  fillFreeEntryPrices(half, HERKULES_4279_REGULAMIN, row)
  assert.equal(half.price_to, 0)
  const registry = pickFillable(['price_from', 'price_to'])
  assert.deepEqual(applyRegistryUpdates(row, half, ['price_to'], registry), { price_to: 0 })
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
