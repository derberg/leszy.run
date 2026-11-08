import { test } from 'node:test'
import assert from 'node:assert/strict'
import { distinguishingTags, hasDistinguishingConflict, hasHardConflict } from '../src/scrapers/dedup.js'

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

test('Polish NW forms in a name count as a name-stated style', () => {
  // A separate march named this way, enriched to {trail, nw}, must not fold into
  // the run {trail} of the same day. Forms measured in scraper_all 2026-11-08.
  for (const name of ['Marsz z kijkami Wilczyński', 'NADMORSKI MARSZ Z KIJAMI', 'X Rajd z Kijami przez Jaskinie', 'Dobromiejski Festiwal Nordic Wa...', 'Kaszubski Rajd Nordic Waking']) {
    assert.ok(distinguishingTags({ name }).has('named:nw'), name)
    assert.equal(conflict({ name: 'Bieg Wilczyński', event_types: ['trail'] }, { name, event_types: ['trail', 'nordic walking'] }), true, name)
  }
  // named: only qualifies the subset check: it adds no style tag of its own.
  assert.equal(distinguishingTags({ name: 'Marsz z kijkami' }).has('style:nw'), false)
})

test('Cross and przełaj as nouns count as a name-stated trail', () => {
  for (const name of ['Leśny Cross Wieluń Biega 2026', '34. Żukowski Przełaj', 'XIII Otuski Bieg Przełajowy']) {
    assert.ok(distinguishingTags({ name }).has('named:trail'), name)
    assert.equal(distinguishingTags({ name }).has('style:trail'), false, name)
  }
  assert.equal(conflict(
    { name: 'Wieluń Biega 2026', event_types: ['nordic walking'] },
    { name: 'Leśny Cross Wieluń Biega 2026', event_types: ['nordic walking', 'trail'] },
  ), true)
  // Words that only contain "cross" are not a cross race.
  for (const name of ['PROTOUR CYCLOCROSS CUP', 'LIGA MŁODEGO CROSSFITERA', 'Wieliszewski Crossing']) {
    assert.equal(distinguishingTags({ name }).has('named:trail'), false, name)
  }
})

test('a calendar_events row (event_type, array or string) follows the same rule', () => {
  // publish's fuzzyMatch compares a scraper_all row with calendar_events rows,
  // which carry event_type instead of event_types.
  const ce = { name: 'Leśna Piątka Odwrotnie', event_type: ['nordic walking', 'trail'] }
  assert.equal(conflict({ name: 'Leśna Piątka 2026 ODWROTNIE', event_types: ['trail'] }, ce), false)
  assert.equal(conflict({ name: 'Wataha 7 km', event_type: 'trail' }, { name: 'Wataha 7 km Nordic Walking', event_type: ['trail', 'nordic walking'] }), true)
  assert.equal(conflict({ name: 'Bieg Leśny', event_type: 'trail' }, { name: 'Bieg Leśny', event_type: ['ocr'] }), true)
})

test('hasHardConflict (review list) ignores named: tags', () => {
  // Same style set, but one name states nw and the other trail: named: must not
  // be compared as its own category, or the pair would vanish from review.
  const a = distinguishingTags({ name: 'Bieg Nordic Walking Kłodawa', event_types: ['trail'] })
  const b = distinguishingTags({ name: 'Cross Kłodawa', event_types: ['nordic walking'] })
  assert.deepEqual([...a].filter(t => t.startsWith('named:')), ['named:nw'])
  assert.deepEqual([...b].filter(t => t.startsWith('named:')), ['named:trail'])
  assert.equal(hasHardConflict(a, b), false)
  // A disjoint style set still excludes a pair from review.
  assert.equal(hasHardConflict(distinguishingTags({ name: 'X', event_types: ['trail'] }), distinguishingTags({ name: 'X', event_types: ['ocr'] })), true)
})
