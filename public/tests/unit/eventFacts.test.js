import { test } from 'node:test'
import assert from 'node:assert/strict'
import { infoCells, priceText, formatDateWithWeekday } from '../../src/lib/eventFacts.js'

const NOW = new Date('2026-11-03T12:00:00Z')

const race = {
  name: 'Krakowski Bieg Niepodległości',
  date: '2026-11-11',
  location: 'Kraków',
  voivodeship: 'Małopolskie',
  distances: ['5 km', '10 km', '21 km'],
  event_type: ['bieg', 'uliczny'],
  price_from: 89,
  price_to: 149,
  registration_deadline: '2026-11-08',
}

test('the date carries the weekday in Polish, in Warsaw time', () => {
  assert.equal(formatDateWithWeekday('2026-11-11'), 'środa, 11 listopada 2026')
})

test('infoCells keeps the grid order and only cells with data', () => {
  assert.deepEqual(infoCells(race, NOW).map(c => c.label), ['Data', 'Lokalizacja', 'Dystanse', 'Cena', 'Termin zapisów'])
  assert.deepEqual(infoCells({ name: 'Z', date: '2026-11-11' }, NOW).map(c => c.label), ['Data'])
})

test('priceText matches the grid wording', () => {
  assert.equal(priceText({ price_from: 0, price_to: 0 }), 'Za darmo')
  assert.equal(priceText({ price_from: 0, price_to: 30 }), 'od 0 zł (za darmo) do 30 zł')
  assert.equal(priceText({ price_to: 40 }), 'do 40 zł')
  assert.equal(priceText({}), null)
})

test('atest: the certified distances are the race own strings, and get a cell', async () => {
  const { atestDistances } = await import('../../src/lib/eventFacts.js')
  const certified = { ...race, atest: [{ km: 10, certified_on: '2024-10-15', source: 'register' }, { km: 21.0975, certified_on: '2024-10-15', source: 'both' }] }
  assert.deepEqual([...atestDistances(certified)], ['10 km', '21 km'])
  assert.deepEqual(infoCells(certified, NOW).map(c => c.label), ['Data', 'Lokalizacja', 'Dystanse', 'Atest PZLA', 'Cena', 'Termin zapisów'])
  assert.equal(infoCells(certified, NOW)[3].value, '10 km / 21 km')
  // No atest, or one for a distance the race no longer lists, shows nothing.
  assert.equal(atestDistances(race).size, 0)
  assert.equal(atestDistances({ ...race, atest: [{ km: 42.195 }] }).size, 0)
})
