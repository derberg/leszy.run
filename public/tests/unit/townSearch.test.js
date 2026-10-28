import { test } from 'node:test'
import assert from 'node:assert/strict'
import { townSearchUrl, townCandidates } from '../../src/lib/townSearch.js'

test('the query asks Nominatim for Polish settlements with address details, five at most', () => {
  const url = new URL(townSearchUrl('  Nieborowice '))
  assert.equal(url.origin, 'https://nominatim.openstreetmap.org')
  assert.equal(url.searchParams.get('q'), 'Nieborowice')
  assert.equal(url.searchParams.get('countrycodes'), 'pl')
  assert.equal(url.searchParams.get('addressdetails'), '1')
  assert.equal(url.searchParams.get('featureType'), 'settlement')
  assert.equal(url.searchParams.get('limit'), '5')
})

test('a village becomes the town label with „GM. X · WOJEWÓDZTWO” and its pin', () => {
  const [c] = townCandidates([{
    lat: '50.2381', lon: '18.5412', name: 'Nieborowice',
    address: { village: 'Nieborowice', municipality: 'gmina Pilchowice', county: 'powiat gliwicki', state: 'województwo śląskie' },
  }])
  assert.deepEqual(c, { label: 'Nieborowice', area: 'GM. PILCHOWICE · ŚLĄSKIE', lat: 50.2381, lng: 18.5412 })
})

test('a city with no gmina shows only the voivodeship', () => {
  const [c] = townCandidates([{ lat: '50.29', lon: '18.67', name: 'Gliwice', address: { city: 'Gliwice', state: 'województwo śląskie' } }])
  assert.equal(c.area, 'ŚLĄSKIE')
  assert.equal(c.label, 'Gliwice')
})

test('duplicates collapse, at most five candidates, entries without coordinates are dropped', () => {
  const row = (n) => ({ lat: '50.1', lon: '18.1', name: `Wieś ${n}`, address: { village: `Wieś ${n}`, state: 'województwo opolskie' } })
  const list = townCandidates([row(1), row(1), { name: 'x', address: {} }, row(2), row(3), row(4), row(5), row(6)])
  assert.deepEqual(list.map((c) => c.label), ['Wieś 1', 'Wieś 2', 'Wieś 3', 'Wieś 4', 'Wieś 5'])
})

test('garbage input gives no candidates', () => {
  assert.deepEqual(townCandidates(null), [])
  assert.deepEqual(townCandidates({ error: 'x' }), [])
})
