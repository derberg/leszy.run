import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseLocation } from '../src/scrapers/sources/lumisport.js'
import { cityFromLocation } from '../src/lib/polishLocation.js'

// lumisport has no location field, so parseLocation mines the "Lokalizacja:"
// label out of the product description. It stopped the capture at the first
// '.', and Polish address prose writes "k." for "koło". 2 Forest Cross
// (2026-11-15, lumisport:2-forest-cross) was stored as "Las Wiączyński (k",
// the geocoder found nothing, and the row published with no voivodeship and no
// coordinates. 1 of the 7 scraper_lumisport rows was cut this way.
//
// Prose below is copied from the live product descriptions, sampled 2026-09-29.
// One line each, because stripHtml collapses the whitespace before parsing.

const FOREST_CROSS = 'Lokalizacja: Las Wiączyński (k. Łodzi), okolice Leśniczówki Wiączyń'
  + ' Baza zawodów: Polana przy wiacie i miejscu na ognisko Dla kogo: Dla każdego'
  + ' – od łowców życiówek, przez amatorów rekreacji, po całe rodziny.'

const DOG_FOREST_CROSS = 'Lokalizacja: Las Wiączyński (okolice Leśniczówki Wiączyń)'
  + ' Start / Meta: Wiączyń las, wiata w okolicach leśniczówki'

const HALLOWEEN_RUN = 'Lokalizacja: Łódź, Park na Zdrowiu Formuła: Bieg oraz'
  + ' Nordic Walking Dystans: 5 km'

const GORKI_CROSS = `Miejsce: Tor motocrossowy – Piątkowisko Dystans: 5 km`

test('the period in "k." does not end the location', () => {
  assert.equal(
    parseLocation(FOREST_CROSS),
    'Las Wiączyński (k. Łodzi), okolice Leśniczówki Wiączyń',
  )
})

test('the city survives into the geocode query', () => {
  // The geocode step asks cityFromLocation first. "Las Wiączyński" resolves to
  // the forest in województwo łódzkie; "Las Wiączyński (k" resolves to nothing.
  assert.equal(cityFromLocation(parseLocation(FOREST_CROSS)), 'Las Wiączyński')
})

test('"Baza zawodów" ends the location like the other labels', () => {
  // Without this stop the capture runs to the end of the paragraph, 194
  // characters, and the length guard throws the whole value away.
  assert.equal(parseLocation('Miejsce: Grotniki Baza zawodów: Polana'), 'Grotniki')
})

test('a sentence still ends the location', () => {
  assert.equal(
    parseLocation('Miejsce: Puszcza Bolimowska. Wybierz swój dystans.'),
    'Puszcza Bolimowska',
  )
})

test('the other lumisport locations are unchanged', () => {
  assert.equal(parseLocation(DOG_FOREST_CROSS), 'Las Wiączyński (okolice Leśniczówki Wiączyń)')
  assert.equal(parseLocation(HALLOWEEN_RUN), 'Łódź, Park na Zdrowiu Formuła: Bieg oraz Nordic Walking')
  assert.equal(parseLocation(GORKI_CROSS), 'Tor motocrossowy – Piątkowisko')
  assert.equal(parseLocation(''), null)
})
