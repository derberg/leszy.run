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

import { splitTownInput, addressQueries, addressSearchUrl, addressPin, findAddressPin } from '../../src/lib/townSearch.js'

test('„Szubin, Stadion Miejski ul. Jana Pawła II 14” in Miejscowość looks up Szubin and keeps the rest', () => {
  assert.deepEqual(splitTownInput(' Szubin, Stadion Miejski ul. Jana Pawła II 14 '), { town: 'Szubin', rest: 'Stadion Miejski ul. Jana Pawła II 14' })
  assert.deepEqual(splitTownInput('Szubin'), { town: 'Szubin', rest: '' })
})

test('the street goes first, without „ul.”, which Nominatim cannot match; then the place by name', () => {
  const one = addressQueries('Stadion Miejski\nul. Jana Pawła II 14', 'Szubin')
  assert.deepEqual(one, [
    { q: 'Jana Pawła II 14, Szubin', street: 'Jana Pawła II', name: null },
    { q: 'Stadion Miejski, Szubin', street: null, name: 'Stadion Miejski' },
  ])
  assert.deepEqual(addressQueries('Stadion Miejski ul. Jana Pawła II 14', 'Szubin'), one)
  assert.equal(addressQueries('a\nb\nc\nd\ne\nf', 'X').length, 0)
  assert.equal(addressQueries('Park 1, Las 2, Rynek 3, Hala 4', 'X').length, 3)
  assert.deepEqual(addressQueries('Stadion', ''), [])
})

test('the address query is free text in Poland, not limited to settlements', () => {
  const url = new URL(addressSearchUrl('Jana Pawła II 14, Szubin'))
  assert.equal(url.searchParams.get('q'), 'Jana Pawła II 14, Szubin')
  assert.equal(url.searchParams.get('countrycodes'), 'pl')
  assert.equal(url.searchParams.get('featureType'), null)
})

test('a pin counts only on the named street of the picked town', () => {
  const q = { street: 'Jana Pawła II', name: null }
  const hit = { lat: '53.0007949', lon: '17.7231619', name: '', address: { road: 'Jana Pawła II', town: 'Szubin' } }
  assert.deepEqual(addressPin([hit], q, 'Szubin'), { lat: 53.0007949, lng: 17.7231619 })
  // Nominatim answers a missing address with another point in the town.
  const elsewhere = { lat: '50.30', lon: '18.64', name: 'Poczta', address: { road: 'Emilii Plater', city: 'Gliwice' } }
  assert.equal(addressPin([elsewhere], { street: 'Wojska Polskiego', name: null }, 'Gliwice'), null)
  assert.equal(addressPin([hit], q, 'Nakło nad Notecią'), null)
  const stadium = { lat: '53.0', lon: '17.7', name: 'Stadion Miejski', address: { town: 'Szubin' } }
  assert.deepEqual(addressPin([stadium], { street: null, name: 'stadion miejski' }, 'Szubin'), { lat: 53, lng: 17.7 })
  assert.equal(addressPin(null, q, 'Szubin'), null)
})

test('findAddressPin stops at the first match and returns null when nothing matches', async () => {
  const asked = []
  const fetchImpl = async (url) => {
    const q = new URL(url).searchParams.get('q')
    asked.push(q)
    const body = q.startsWith('Jana') ? [{ lat: '53.0008', lon: '17.7232', address: { road: 'Jana Pawła II', town: 'Szubin' } }] : []
    return { json: async () => body }
  }
  assert.deepEqual(await findAddressPin('Stadion Miejski\nul. Jana Pawła II 14', 'Szubin', { fetchImpl, gapMs: 0 }), { lat: 53.0008, lng: 17.7232 })
  assert.deepEqual(asked, ['Jana Pawła II 14, Szubin'])
  assert.equal(await findAddressPin('Stadion Miejski', 'Szubin', { fetchImpl, gapMs: 0 }), null)
})

test('a trailing full stop does not hide the house number', () => {
  assert.deepEqual(addressQueries('Boisko LKS, ul. Szkolna 12.', 'Nieborowice')[0], { q: 'Szkolna 12, Nieborowice', street: 'Szkolna', name: null })
})
