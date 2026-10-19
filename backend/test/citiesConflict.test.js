import { test } from 'node:test'
import assert from 'node:assert/strict'
import { citiesConflict } from '../src/scrapers/dedup.js'

// Every pair below is a real scraper_all row measured on 2026-10-19.

test('two different towns conflict', () => {
  // foxter's Baranowo race sat inside the Radom row, so the Baranowo event
  // published with no registration link.
  assert.equal(citiesConflict('Radom', 'Baranowo'), true)
  assert.equal(citiesConflict('Chełm', 'Inowroclaw'), true)
  assert.equal(citiesConflict('Poznań', 'Olsztyn'), true)
  assert.equal(citiesConflict('Cegłów, MZ', 'Czerwonak'), true)
  assert.equal(citiesConflict('Radom', 'Uroczysko Osuszek k Bielska Podlaskiego'), true)
  assert.equal(citiesConflict('Łódź, Park na Zdrowiu', 'Góra Zamkowa, Grudziądz'), true)
})

test('one town written two ways does not conflict', () => {
  assert.equal(citiesConflict('Działdowo', 'Dzialdowo'), false)
  assert.equal(citiesConflict('Łącko', 'łacko'), false)
  assert.equal(citiesConflict('Świdnica', 'Świdnia'), false)
  assert.equal(citiesConflict('Cegłów, MZ', 'Cegłów'), false)
  assert.equal(citiesConflict('Ryki, Polska', 'Ryki'), false)
  assert.equal(citiesConflict('Andrychów', 'Rzyki k/Andrychowa'), false)
  assert.equal(citiesConflict('Lądek-Zdrój', 'Przełęcz Lądecka'), false)
  assert.equal(
    citiesConflict('Las Wiączyński (k. Łodzi), okolice Leśniczówki Wiączyń', 'Las Wiączyński (okolice Leśniczówki Wiączyń)'),
    false,
  )
})

test('a missing location is not a conflict', () => {
  assert.equal(citiesConflict(null, 'Radom'), false)
  assert.equal(citiesConflict('Radom', ''), false)
})
