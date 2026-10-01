import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseDetailPage } from '../src/scrapers/sources/timekeeper.js'
import { normalizeEvent } from '../src/scrapers/normalizer.js'

// timekeeper never read a price at all. The "Koszt uczestnictwa" card was located by
// $('h5, h6, strong'), but the heading is <h4 class="m-0">, so the card was never found,
// and the handler inside it only ever read the start label — the fee sits in the
// .text-right cell next to it and nothing looked there.
//
// X Krotoszyński Bieg Niepodległości (2026-11-11, timekeeper:x-krotoszynski-bieg-niepodleglosci)
// published with no price, from a card that states 1918m / Bezpłatnie.
//
// The fixtures below are verbatim slices of live competitions.timekeeper.pl pages,
// fetched 2026-10-01 — the whole `div.card.w-100` cost card, and the date/location
// container, copied byte for byte rather than retyped.

const fixture = name => fs.readFileSync(
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8')

const FREE = fixture('timekeeper-cost-free.html')          // x-krotoszynski-bieg-niepodleglosci
const PROMO = fixture('timekeeper-cost-promo.html')        // bieg-mikolajowy
const MULTI = fixture('timekeeper-cost-multi.html')        // xix-polmaraton-elcki-i-iv-elcka-piatka
const ULTRA = fixture('timekeeper-cost-ultra.html')        // ultrapodkarpacie-3
const HEADER = fixture('timekeeper-date-location.html')    // x-krotoszynski-bieg-niepodleglosci

const page = (...parts) => `<html><body>${parts.join('\n')}</body></html>`

test('a free race reports 0, not unknown', () => {
  // The row that broke. "Bezpłatnie" is the fee, and 0 is a value.
  const got = parseDetailPage(page(FREE))
  assert.equal(got.priceFrom, 0)
  assert.equal(got.priceTo, 0)
})

test('a paid race with several starts reports the cheapest and the dearest', () => {
  // XIX Półmaraton Ełcki i IV Ełcka Piątka: 90.00 zł, 40.00 zł and 70.00 zł.
  const got = parseDetailPage(page(MULTI))
  assert.equal(got.priceFrom, 40)
  assert.equal(got.priceTo, 90)
})

test('a promotional price ignores the struck-out old fee', () => {
  // Bieg Mikołajowy prints <del>80.00 zł</del> beside the 70.00 zł actually charged.
  // Reading both would publish an 80 zł price_to nobody pays.
  const got = parseDetailPage(page(PROMO))
  assert.equal(got.priceFrom, 70)
  assert.equal(got.priceTo, 70)
})

test('a page with no cost card leaves the price unknown', () => {
  // No card means no statement about the fee. Null, never 0.
  const got = parseDetailPage(page(HEADER))
  assert.equal(got.priceFrom, null)
  assert.equal(got.priceTo, null)
})

test('a cost card with an unreadable fee leaves the price unknown', () => {
  const card = FREE.replace('Bezpłatnie', 'wg regulaminu')
  const got = parseDetailPage(page(card))
  assert.equal(got.priceFrom, null)
  assert.equal(got.priceTo, null)
})

test('a free start beside a paid one does not make the race free', () => {
  // price_from 0 says "this race costs nothing". A free kids run must not say that on
  // behalf of the half marathon beside it. Ełk's cheapest start, the 40 zł Piątka, is
  // made free here; without the guard the card would report price_from 0 for a race
  // whose every other start charges 90 zł.
  const withFreeStart = MULTI.replace(/40\.00\s*zł/, 'Bezpłatnie')
  assert.ok(withFreeStart.includes('Bezpłatnie'), 'fixture substitution missed')
  const got = parseDetailPage(page(withFreeStart))
  assert.equal(got.priceFrom, 90)
  assert.equal(got.priceTo, 90)
})

test('the cost card is read for the fee only, never for distances', () => {
  // The h6 beside each fee is a ticket name, not a distance. UltraPodkarpacie's read
  // "PRZYMIERZE [PRZemyśl - RZEszów, 130+ km] (pakiet z koszulką)" and
  // "#MINIULTRAPODKARPACIE, biegi dla dzieci" — embedded commas that the
  // scraper_all -> calendar_events step splits on, repeated once per shirt option.
  // timekeeper is priority 3 in dedup.js, so publishing these would overwrite the
  // real distances a better source already supplied.
  const got = parseDetailPage(page(ULTRA))
  assert.equal(got.priceFrom, 25)
  assert.equal(got.priceTo, 370)
  assert.equal(got.distances, undefined)
  assert.equal(parseDetailPage(page(FREE)).distances, undefined)
})

test('the date and location cards still parse', () => {
  // The cost card fix must not disturb the headings that were already working.
  const got = parseDetailPage(page(HEADER, FREE))
  assert.equal(got.date, '2026-11-11')
  assert.equal(got.location, 'Krotoszyn')
})

test('a free price survives normalizeEvent', () => {
  // `raw.price_from || null` turned the 0 back into null, so "Bezpłatnie" would have
  // been erased one step after it was parsed. lat/lng are supplied so the geocoder,
  // which would hit the network, is never reached.
  const free = { name: 'X Krotoszyński Bieg Niepodległości', date: '2026-11-11',
    location: 'Krotoszyn', lat: 51.7, lng: 17.44, price_from: 0, price_to: 0 }
  return normalizeEvent(free).then(got => {
    assert.equal(got.price_from, 0)
    assert.equal(got.price_to, 0)
  })
})

test('an absent price still normalizes to null', () => {
  const unknown = { name: 'Bieg Niepodległości', date: '2026-11-11',
    location: 'Krotoszyn', lat: 51.7, lng: 17.44 }
  return normalizeEvent(unknown).then(got => {
    assert.equal(got.price_from, null)
    assert.equal(got.price_to, null)
  })
})
