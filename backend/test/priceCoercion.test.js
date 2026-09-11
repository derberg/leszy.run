import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toIntPrice } from '../src/scrapers/index.js'

// 21 of the 23 scraper tables store price as `numeric`; `scraper_all` and `calendar_events`
// are `integer`. A fractional price therefore reached Postgres unchanged and failed the whole
// row's merge with `invalid input syntax for type integer: "75.03"`, leaving the event stuck
// outside scraper_all indefinitely. Values below are the real ones found in the DB on
// 2026-09-11 — the only four fractional prices across every source.

test('rounds a fractional price to the nearest zloty', () => {
  // dostartu 16890 "II Bieg Palmiry" — a 75 zl fee plus the platform's service cut.
  assert.equal(toIntPrice('75.03'), 75)
  assert.equal(toIntPrice(75.03), 75)
  assert.equal(toIntPrice('170.00'), 170)
  assert.equal(toIntPrice(49.2), 49)
  assert.equal(toIntPrice(49.5), 50)
})

test('a positive price never rounds down to free', () => {
  // dostartu 16270 lists 0.01 and aleczas/dostartu 15352 lists 0.1 — placeholder tiers.
  // 0 is the signal for a genuinely free event, so rounding these to 0 would publish
  // "free" on a race that charges. They floor at 1 instead.
  assert.equal(toIntPrice('0.01'), 1)
  assert.equal(toIntPrice(0.1), 1)
  assert.equal(toIntPrice(0.49), 1)
})

test('a real zero stays zero', () => {
  // Free events are published as 0 and must survive the coercion untouched.
  assert.equal(toIntPrice(0), 0)
  assert.equal(toIntPrice('0'), 0)
})

test('an integer price passes through unchanged', () => {
  assert.equal(toIntPrice(50), 50)
  assert.equal(toIntPrice('120'), 120)
})

test('absent and unusable values become null', () => {
  assert.equal(toIntPrice(null), null)
  assert.equal(toIntPrice(undefined), null)
  assert.equal(toIntPrice(''), null)
  assert.equal(toIntPrice('darmowy'), null)
  assert.equal(toIntPrice(NaN), null)
  assert.equal(toIntPrice(-5), null)
})
