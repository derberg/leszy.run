import { test } from 'node:test'
import assert from 'node:assert/strict'
import { distinguishingTags, hasDistinguishingConflict } from '../src/scrapers/dedup.js'

// Every pair below is a real pair of rows measured in scraper_all on 2026-11-08.
const conflict = (a, b) => hasDistinguishingConflict(distinguishingTags(a), distinguishingTags(b))

test('a style the enricher added on one side no longer blocks the merge (Leśna Piątka)', () => {
  // biegnijmy {trail} against a maratonypolskie + biegiwpolsce row the LLM
  // enriched to {trail, nordic walking}: one event, a duplicate stayed.
  const biegnijmy = { name: 'Leśna Piątka 2026 ODWROTNIE', event_types: ['trail'] }
  const enriched = { name: 'Leśna Piątka Odwrotnie', event_types: ['nordic walking', 'trail'] }
  assert.equal(conflict(biegnijmy, enriched), false)
  assert.equal(conflict(enriched, biegnijmy), false)
})

test('the subset rule holds for an extra trail tag too', () => {
  assert.equal(conflict(
    { name: 'Zawzięty Kozioł vol. 5', event_types: ['ocr', 'trail'] },
    { name: 'Zawzięty Koziołek vol. 5', event_types: ['ocr'] },
  ), false)
  assert.equal(conflict(
    { name: 'V RUNda Żubra', event_types: ['nordic walking', 'trail'] },
    { name: 'V RUNda Żubra', event_types: ['uliczny', 'nordic walking'] },
  ), false)
})

test('a style both names carry does not count as a name-stated extra', () => {
  // Both names say "crossowy" (trail); only the event_types add nordic walking.
  assert.equal(conflict(
    { name: 'III BIEG CROSSOWY ŚLADAMI BOBRA - SZARLEJKA', event_types: ['nordic walking', 'trail'] },
    { name: 'III Bieg Crossowy Śladami Bobra', event_types: ['trail'] },
  ), false)
})

test('an extra style stated in the bigger side\'s NAME still blocks the merge', () => {
  // protiming24 lists the nordic walking race at Wataha as its own event. If the
  // enricher tags both forest races trail, the sets become {trail} vs
  // {trail, nw}: a subset, but the name itself says this is the NW race.
  assert.equal(conflict(
    { name: 'Wataha 7 km', event_types: ['trail'] },
    { name: 'Wataha 7 km Nordic Walking', event_types: ['trail', 'nordic walking'] },
  ), true)
  // Same rule, measured pair: kept apart (a conservative miss, one event).
  assert.equal(conflict(
    { name: 'III Bieg Górala Szlakiem Papieskim', event_types: ['trail'] },
    { name: '3. Bieg Górala Szlakiem Papieskim oraz marsz Nordic Walking', event_types: ['nordic walking', 'trail'] },
  ), true)
})

test('disjoint style sets still conflict', () => {
  assert.equal(conflict(
    { name: 'Wataha 7 km', event_types: ['trail'] },
    { name: 'Wataha 7 km Nordic Walking', event_types: ['nordic walking'] },
  ), true)
  assert.equal(conflict({ name: 'Bieg Leśny', event_types: ['trail'] }, { name: 'Bieg Leśny', event_types: ['ocr'] }), true)
})
