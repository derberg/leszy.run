import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseClassifications } from '../src/scrapers/sources/dostartu.js'

// dostartu declares "this entry is free" explicitly per classification, via
// classificationSetting.isPay — NOT via an empty classificationPrices array. The two look
// identical on the wire but mean different things: an empty tier list also describes a
// paid race whose organizer simply hasn't configured fees yet. Reading the empty array as
// "free" publishes 0 zł on races that charge money, so the isPay flag is what we key on.
//
// Shapes below mirror real /competitions/:id/classifications payloads, sampled 2026-09-11.

const cls = (isPay, prices = [], { playerType = 'adults', namePl = 'Bieg 10 km' } = {}) => ({
  namePl,
  distance: 10,
  classificationPrices: prices,
  classificationSetting: { isPay, playerType },
})

test('all-free event reports 0, not unknown', () => {
  // Real shape of competition 17235 "Niedźwiedzi Bieg 2026": one adult classification,
  // isPay:false, no tiers. Genuinely free — the regulamin names no fee either.
  const got = parseClassifications([cls(false)], 'Niedźwiedzi Bieg 2026')
  assert.equal(got.priceFrom, 0)
  assert.equal(got.priceTo, 0)
})

test('paid event with no tiers configured yet stays unknown', () => {
  // The case that makes "empty prices == free" wrong. Fees are coming, they just aren't
  // published; null keeps the calendar honest until a later scrape picks the tier up.
  const got = parseClassifications([cls(true)], 'Bieg Testowy')
  assert.equal(got.priceFrom, null)
  assert.equal(got.priceTo, null)
})

test('mixed free and paid entries report the paid tier, never 0', () => {
  // A free entry alongside a paid one must not drag price_from to 0 — the race costs money.
  const got = parseClassifications(
    [cls(false), cls(true, [{ price: '50.00' }]), cls(true, [{ price: '70.00' }])],
    'Bieg Mieszany',
  )
  assert.equal(got.priceFrom, 50)
  assert.equal(got.priceTo, 70)
})

test('event with no classifications at all stays unknown', () => {
  const got = parseClassifications([], 'Bieg Bez Klasyfikacji')
  assert.equal(got.priceFrom, null)
  assert.equal(got.priceTo, null)
})

test('free kids classifications skipped in a mixed event do not make it free', () => {
  // Kids classifications are excluded from price aggregation in adult events. A free kids
  // run must not be the thing that decides the adult race is free, so it must not count
  // toward the "every classification says isPay:false" conclusion either.
  const got = parseClassifications(
    [
      cls(false, [], { playerType: 'kids', namePl: 'Bieg dzieci 200 m' }),
      cls(true, [], { namePl: 'Półmaraton' }),
    ],
    'Półmaraton z biegiem dzieci',
  )
  assert.equal(got.priceFrom, null)
  assert.equal(got.priceTo, null)
})

test('kids-only event with real tiers keeps its price', () => {
  // Competition 16843 "Dzieci - VI Lysecka Piątka": every classification is playerType
  // kids, so none are skipped, and five of them charge 10 PLN.
  const got = parseClassifications(
    [
      cls(false, [], { playerType: 'kids', namePl: 'D0 (rocznik 2021 i młodsi)' }),
      cls(true, [{ price: '10.00' }], { playerType: 'kids', namePl: 'D1 (rocznik 2019-2020)' }),
      cls(true, [{ price: '10.00' }], { playerType: 'kids', namePl: 'D2 (rocznik 2017-2018)' }),
    ],
    'Dzieci - VI Lysecka Piątka',
  )
  assert.equal(got.priceFrom, 10)
  assert.equal(got.priceTo, 10)
})

test('free event still reports its deadline and distances', () => {
  // Emitting 0 must not short-circuit the rest of the parse.
  const got = parseClassifications(
    [
      { ...cls(false), namePl: 'Bieg 5 km', distance: 5 },
      { ...cls(false), namePl: 'Bieg 10 km', distance: 10 },
    ],
    'Bieg Darmowy',
  )
  assert.equal(got.priceFrom, 0)
  assert.equal(got.distances, '5 km, 10 km')
})
