import { test } from 'node:test'
import assert from 'node:assert/strict'
import { usableResults } from '../src/scrapers/geocoder.js'

// Every fixture below is the shape Nominatim actually returned for that query,
// trimmed to the fields geocoder.js reads.

const MUSEUM = {
  class: 'tourism',
  type: 'museum',
  addresstype: 'tourism',
  lat: '52.1236',
  lon: '20.8181',
  address: { town: 'Podkowa Leśna', state: 'województwo mazowieckie' },
}

const GUIDEPOST = {
  class: 'information',
  type: 'guidepost',
  addresstype: 'information',
  lat: '50.6',
  lon: '20.3',
  address: { state: 'województwo świętokrzyskie' },
}

const BUS_STOP = {
  class: 'highway',
  type: 'bus_stop',
  addresstype: 'highway',
  lat: '49.8',
  lon: '19.3',
  address: { state: 'województwo śląskie' },
}

const VILLAGE = {
  class: 'place',
  type: 'village',
  addresstype: 'village',
  lat: '49.6',
  lon: '20.5',
  address: { state: 'województwo małopolskie' },
}

test('a venue that states its voivodeship is an answer', () => {
  // "XII Noc STO-nogi Milanówek" gave its location as the museum, not the town.
  // Nominatim returns one exact hit, but it is tagged tourism/museum, so the
  // settlement filter dropped it and the event published with no voivodeship.
  assert.deepEqual(usableResults([MUSEUM]), [MUSEUM])
})

test('roadside furniture is still not a place', () => {
  // The two the filter was built for: a Jura trail guidepost and a bus loop.
  assert.deepEqual(usableResults([GUIDEPOST]), [])
  assert.deepEqual(usableResults([BUS_STOP]), [])
})

test('a venue without a voivodeship is not an answer', () => {
  assert.deepEqual(usableResults([{ ...MUSEUM, address: { town: 'Podkowa Leśna' } }]), [])
})

test('a settlement still wins over anything else in the same answer', () => {
  // Nothing that already resolved may change, so a venue is only read when no
  // settlement matched at all.
  assert.deepEqual(usableResults([MUSEUM, VILLAGE]), [VILLAGE])
  assert.deepEqual(usableResults([GUIDEPOST, VILLAGE]), [VILLAGE])
})

test('a non-array answer is no answer', () => {
  assert.deepEqual(usableResults(null), [])
  assert.deepEqual(usableResults({ error: 'Unable to geocode' }), [])
})
