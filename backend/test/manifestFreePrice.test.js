import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildManifestEntry } from '../scripts/lib/manifestEntry.js'

// A free race stores price_from = 0. `publish-event-pages.js` built its manifest
// entries with `event.price_from || null`, and `||` treats 0 as falsy, so every
// free event reached the manifest as "price unknown".
//
// That manifest is not only a display source. `generate-landing-pages.js` selects
// the /listy/darmowe pages from it with `if (event.price_from !== 0) return false`,
// so the filter matched nothing: on 2026-09-17 the live page advertised
// "61 wydarzeń" in its h1, title, meta description and JSON-LD while rendering
// zero event links. /listy/maratony rendered 34 and /listy/dla-dzieci 312.
//
// `src/scrapers/index.js` uses `?? null` for the same two columns in ten places,
// and priceCoercion.test.js already asserts that a real zero survives the
// pipeline. This was the last step undoing it.

const freeEvent = {
  id: '4cd3a5c6-2cc8-410d-8309-55faeab3f1bd',
  name: 'BIEGAM, BO LUBIĘ LASY - Lubartów',
  date: '2026-10-04',
  price_from: 0,
  price_to: 0,
  lat: 51.384035,
  lng: 22.62864,
  status: 'active',
}

test('a free event keeps price 0 in the manifest', () => {
  const entry = buildManifestEntry(freeEvent)
  assert.equal(entry.price_from, 0)
  assert.equal(entry.price_to, 0)
})

test('the darmowe landing filter matches a free event entry', () => {
  // The exact predicate from public/scripts/generate-landing-pages.js.
  const entry = buildManifestEntry(freeEvent)
  assert.equal(entry.price_from !== 0, false, '/listy/darmowe would drop this event')
})

test('an unknown price stays null rather than becoming 0', () => {
  const entry = buildManifestEntry({ ...freeEvent, price_from: null, price_to: undefined })
  assert.equal(entry.price_from, null)
  assert.equal(entry.price_to, null)
})

test('a paid price passes through untouched', () => {
  const entry = buildManifestEntry({ ...freeEvent, price_from: 120, price_to: 200 })
  assert.equal(entry.price_from, 120)
  assert.equal(entry.price_to, 200)
})

test('coordinates are preserved and absent ones are null', () => {
  const entry = buildManifestEntry(freeEvent)
  assert.equal(entry.lat, 51.384035)
  assert.equal(entry.lng, 22.62864)
  const missing = buildManifestEntry({ ...freeEvent, lat: null, lng: null })
  assert.equal(missing.lat, null)
  assert.equal(missing.lng, null)
})

test('every manifest field the generators read is present', () => {
  const entry = buildManifestEntry(freeEvent)
  for (const field of [
    'id', 'name', 'date', 'registration_deadline', 'regulamin_url',
    'price_from', 'price_to', 'location', 'voivodeship', 'lat', 'lng',
    'distances', 'event_type', 'registration_url', 'website', 'is_kids', 'status',
  ]) {
    assert.ok(field in entry, `missing ${field}`)
  }
})

test('is_kids false is not coerced to null', () => {
  // Already correct via `??` — pinned so the next edit of this object keeps it.
  assert.equal(buildManifestEntry({ ...freeEvent, is_kids: false }).is_kids, false)
})
