import { test } from 'node:test'
import assert from 'node:assert/strict'
import { looksMultisport } from '../src/lib/multisportEvent.js'

// Every name below is verbatim from scraper_all / calendar_events.
//
// The merge's SKIP_KEYWORDS already listed triathlon, duathlon and aquathlon,
// but each was wrapped in \b. A \b needs a non-word character before the word,
// and organizers write these as one compound: CROSSDUATHLON LASKI 2026 reached
// calendar_events as `trail` with distances 2.5 km and 10 km, and
// Paratriathlon Kraina Liwca got through the same way. The Polish spellings
// drop the h (duatlon, triatlon) and were never listed at all.

test('drops a multisport race written as one compound word', () => {
  // czasomierzyk 134, published as `trail` on 2026-10-17.
  assert.equal(looksMultisport({ name: 'CROSSDUATHLON LASKI 2026' }), true)
  // biegiwpolsce, reached calendar_events the same way.
  assert.equal(looksMultisport({ name: 'Paratriathlon Kraina Liwca' }), true)
})

test('still drops the spaced forms the old pattern caught', () => {
  assert.equal(looksMultisport({ name: 'Duathlon Koło' }), true)
  assert.equal(looksMultisport({ name: 'CROSS DUATHLON LASKI' }), true)
  assert.equal(looksMultisport({ name: 'Triathlon Gdańsk' }), true)
  assert.equal(looksMultisport({ name: 'Aquathlon Sopot' }), true)
})

test('drops the Polish spelling without the h', () => {
  assert.equal(looksMultisport({ name: 'Duatlon Laski' }), true)
  assert.equal(looksMultisport({ name: 'Triatlon Ustka' }), true)
  assert.equal(looksMultisport({ name: 'Akwatlon Kraków' }), true)
})

test('a run&bike hybrid survives, as it already did at the merge', () => {
  // isRunBike in mergeIntoScraperAll exempts these: the running leg is timed
  // separately and runners enter it on its own.
  assert.equal(looksMultisport({ name: 'Run & Bike Maraton Bielawa' }), false)
  assert.equal(looksMultisport({ name: 'Biegowo-rowerowy Duathlon Leśny' }), false)
})

test('a plain running race is untouched', () => {
  // The corpus check on 2026-09-17 found exactly two matching rows across
  // scraper_all and calendar_events, both genuinely multisport. These are the
  // shapes that must not start matching.
  for (const name of [
    'BIEGAM, BO LUBIĘ LASY - Lubartów',
    'XIV Pabianicki Półmaraton WSZYSTKO GRA',
    'Bieg Trzech Jezior',
    'Maraton Opolski',
    'Nocny Zew Wilka',
    'Bieg Przełajowy Cross Laski',
  ]) {
    assert.equal(looksMultisport({ name }), false, name)
  }
})

test('an empty or missing name is not a match', () => {
  assert.equal(looksMultisport({ name: null }), false)
  assert.equal(looksMultisport({}), false)
  assert.equal(looksMultisport(), false)
})
