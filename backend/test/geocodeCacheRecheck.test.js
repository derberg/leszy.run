import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nominatimAnswer, parseCacheKey } from '../src/scrapers/geocoder.js'
import { classifyCacheRow } from '../scripts/recheck-geocode-cache.js'

// "Chwałowice" was cached on 2026-03-23 as the Świętokrzyskie village, before
// the geocoder refused ambiguous names. A cache hit is returned before that
// check, so all four editions of the Chwałowicki Maraton Napoleoński (a village
// near Jelcz-Laskowice, Dolnośląskie) published as Świętokrzyskie. Hits copied
// from Nominatim's answer to "Chwałowice, Polska" on 2026-11-23.
const village = (state, lat, lon, addresstype = 'village', importance = 0.3) => ({
  addresstype, type: 'administrative', lat, lon, importance, address: { state: `województwo ${state}` },
})
const chwalowice = [
  village('świętokrzyskie', '50.5587890', '20.6155626', 'village', 0.354),
  village('mazowieckie', '51.1808700', '21.3018400', 'village', 0.346),
  village('podkarpackie', '50.7659415', '21.8871433', 'village', 0.318),
  village('dolnośląskie', '51.0446926', '17.3833423', 'village', 0.302),
  village('lubuskie', '52.6555359', '15.1319758', 'village', 0.298),
  village('śląskie', '50.0659407', '18.5578104', 'city_district', 0.160),
]

// The rest of the 2026-11-23 recheck: importance as Nominatim gave it.
test('a city also naming a village elsewhere is the city', () => {
  const szczecin = [
    village('zachodniopomorskie', '53.43', '14.55', 'city', 0.7),
    village('łódzkie', '51.2', '19.9', 'village', 0.323),
  ]
  assert.equal(nominatimAnswer(szczecin, 'Szczecin').chosen.address.state, 'województwo zachodniopomorskie')
})

test('villages ranked close together stay ambiguous, even when one is called a city', () => {
  const lacko = [
    village('małopolskie', '49.55', '20.43', 'municipality', 0.436),
    village('zachodniopomorskie', '53.1', '15.1', 'village', 0.355),
    village('warmińsko-mazurskie', '53.9', '21.1', 'city', 0.332),
  ]
  assert.equal(nominatimAnswer(lacko, 'Łącko').ambiguous, true)
  const burzyn = [
    village('podlaskie', '53.3', '22.5', 'village', 0.356),
    village('małopolskie', '49.9', '20.9', 'village', 0.286),
  ]
  assert.equal(nominatimAnswer(burzyn, 'Burzyn').ambiguous, true)
})

test('a name that is a village in several voivodeships has no answer', () => {
  const a = nominatimAnswer(chwalowice, 'Chwałowice')
  assert.equal(a.ambiguous, true)
  assert.equal(a.chosen, null)
})

test('a name Nominatim places in one voivodeship is answered', () => {
  const a = nominatimAnswer([village('dolnośląskie', '51.04', '17.38')], 'Chwałowice')
  assert.equal(a.ambiguous, false)
  assert.equal(a.chosen.address.state, 'województwo dolnośląskie')
})

test('a postcode cache key is asked again through the structured search', () => {
  assert.deepEqual(parseCacheKey('33-386 Podegrodzie'), { postcode: '33-386', city: 'Podegrodzie' })
  assert.deepEqual(parseCacheKey('Chwałowice'), { postcode: null, city: null })
})

const cached = { location_query: 'Chwałowice', voivodeship: 'Świętokrzyskie', lat: 50.558789, lng: 20.615563 }

test('the cached Chwałowice is flagged ambiguous', () => {
  assert.equal(classifyCacheRow(cached, chwalowice).status, 'ambiguous')
})

test('a cached answer Nominatim still gives is kept', () => {
  const row = { ...cached, voivodeship: 'Dolnośląskie' }
  assert.equal(classifyCacheRow(row, [village('dolnośląskie', '51.04', '17.38')]).status, 'ok')
})

test('a cached answer Nominatim now places elsewhere is flagged', () => {
  assert.equal(classifyCacheRow(cached, [village('dolnośląskie', '51.04', '17.38')]).status, 'moved')
})

test('no answer today is not evidence against the cached one', () => {
  assert.equal(classifyCacheRow(cached, []).status, 'unresolved')
})
