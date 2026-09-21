import { test } from 'node:test'
import assert from 'node:assert/strict'
import { voivodeshipForLocatedRow } from '../scripts/lib/voivodeship.js'
import { reverseGeocode } from '../src/scrapers/geocoder.js'

// VI Bieg Szlakiem Bursztynowym "KARTOFELEK" (dostartu 17349, 2026-10-18)
// published with no voivodeship. dostartu gave the row lat 50.3888097 and lng
// 18.3476407 straight from its API and publishes no region field at all, so the
// geocode run had to derive one. Ujazd is not in the city map, and the run then
// asked Nominatim for the NAME: it answers with settlements in Łódzkie,
// Opolskie, Świętokrzyskie, Zachodniopomorskie, Kujawsko-Pomorskie and
// Wielkopolskie. The ambiguity guard refused to guess and the row published
// empty, while its own coordinates sit in Opolskie and nowhere else.
//
// Shapes below mirror the Nominatim replies sampled 2026-09-21.

const UJAZD = { lat: 50.3888097, lng: 18.3476407 }

const reverseUjazd = {
  address: {
    state: 'województwo opolskie',
    'ISO3166-2-lvl4': 'PL-16',
    country: 'Polska',
    country_code: 'pl',
  },
}

// Records every URL asked for, so a test can assert a lookup did NOT happen.
function stubFetch(reply) {
  const asked = []
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    asked.push(String(url))
    return { ok: true, json: async () => reply }
  }
  return { asked, restore: () => { globalThis.fetch = original } }
}

const noCityMap = () => null
const refuseToGeocode = () => { throw new Error('must not be asked') }

test('a row that already has coordinates gets its voivodeship from them', async () => {
  const seen = []
  const result = await voivodeshipForLocatedRow(
    { city: 'Ujazd', ...UJAZD },
    {
      fromCityMap: noCityMap,
      reverseGeocode: async (lat, lng) => {
        seen.push([lat, lng])
        return { voivodeship: 'Opolskie' }
      },
    },
  )
  assert.equal(result.voivodeship, 'Opolskie')
  assert.equal(result.via, 'coordinates')
  assert.deepEqual(seen, [[UJAZD.lat, UJAZD.lng]])
})

test('the city map still answers first and costs no lookup', async () => {
  const result = await voivodeshipForLocatedRow(
    { city: 'Opole', ...UJAZD },
    { fromCityMap: () => 'Opolskie', reverseGeocode: refuseToGeocode },
  )
  assert.equal(result.voivodeship, 'Opolskie')
  assert.equal(result.via, 'city map')
})

test('a row without coordinates is left to the caller', async () => {
  const result = await voivodeshipForLocatedRow(
    { city: 'Ujazd', lat: null, lng: null },
    { fromCityMap: noCityMap, reverseGeocode: refuseToGeocode },
  )
  assert.equal(result.voivodeship, null)
  assert.equal(result.via, null)
})

test('coordinates that name nothing leave the row alone', async () => {
  const result = await voivodeshipForLocatedRow(
    { city: 'Ujazd', ...UJAZD },
    { fromCityMap: noCityMap, reverseGeocode: async () => ({ voivodeship: null }) },
  )
  assert.equal(result.voivodeship, null)
  assert.equal(result.via, null)
})

test('reverse geocoding the KARTOFELEK coordinates answers Opolskie', async () => {
  const stub = stubFetch(reverseUjazd)
  try {
    const { voivodeship } = await reverseGeocode(UJAZD.lat, UJAZD.lng)
    assert.equal(voivodeship, 'Opolskie')
    assert.ok(stub.asked[0].includes('/reverse?'))
  } finally {
    stub.restore()
  }
})

// Běh na Filipku 2026 (dostartu 17311, 2026-09-28) is the other row with
// coordinates and no voivodeship. It starts in Návsí, which is in Czechia. The
// forward search asks for countrycodes=pl and reverse has no such switch, so a
// Czech region would otherwise be capitalized and written to the region column.
test('a point outside Poland has no voivodeship', async () => {
  const stub = stubFetch({
    address: { state: 'Moravskoslezský kraj', country: 'Česko', country_code: 'cz' },
  })
  try {
    const { voivodeship } = await reverseGeocode(49.5872, 18.759082)
    assert.equal(voivodeship, null)
  } finally {
    stub.restore()
  }
})

test('no coordinates means no request', async () => {
  const stub = stubFetch(reverseUjazd)
  try {
    assert.equal((await reverseGeocode(null, null)).voivodeship, null)
    assert.deepEqual(stub.asked, [])
  } finally {
    stub.restore()
  }
})
