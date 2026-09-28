import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseLocation } from '../src/scrapers/sources/lumisport.js'
import { cityFromLocation } from '../src/lib/polishLocation.js'
import { pickVenueFallback } from '../src/scrapers/geocoder.js'

// lumisport has no location field, so parseLocation mines the "Lokalizacja:"
// label out of the product description. It stopped the capture at the first
// '.', and Polish address prose writes "k." for "koło". 2 Forest Cross
// (2026-11-15, lumisport:2-forest-cross) was stored as "Las Wiączyński (k",
// the geocoder found nothing, and the row published with no voivodeship and no
// coordinates. 1 of the 5 scraper_lumisport rows carrying the label was cut
// this way.
//
// Prose below is copied from the live product descriptions, sampled 2026-09-29.
// One line each, because stripHtml collapses the whitespace before parsing.

const FOREST_CROSS = 'Lokalizacja: Las Wiączyński (k. Łodzi), okolice Leśniczówki Wiączyń'
  + ' Baza zawodów: Polana przy wiacie i miejscu na ognisko Dla kogo: Dla każdego'
  + ' – od łowców życiówek, przez amatorów rekreacji, po całe rodziny.'

const DOG_FOREST_CROSS = 'Lokalizacja: Las Wiączyński (okolice Leśniczówki Wiączyń) 🏁'
  + ' Start / Meta: Wiączyń las, wiata w okolicach leśniczówki Są psy, które na'
  + ' spacerze idą grzecznie nóżka przy nóżce.'

const HALLOWEEN_RUN = 'Lokalizacja: Łódź, Park na Zdrowiu Formuła: Bieg oraz'
  + ' Nordic Walking Dystans: 5 km – idealny dystans zarówno do walki o życiówki'

const GORKI_CROSS = 'Miejsce: Tor motocrossowy – Piątkowisko Dystans: 5 km (2x 2,5km Wpisowe 50 zł'

test('the period in "k." does not end the location', () => {
  assert.equal(
    parseLocation(FOREST_CROSS),
    'Las Wiączyński (k. Łodzi), okolice Leśniczówki Wiączyń',
  )
})

// The geocode step (scripts/run-geocode.js) asks cityFromLocation and geocodes
// nothing else, so the "(k. Łodzi)" hint is dropped before the lookup — it is
// the part after "k." that has to survive, not the hint. Below is what
// Nominatim actually answers for the resulting query, recorded 2026-09-29 from
// /search?q=Las+Wiączyński,+Polska&countrycodes=pl&addressdetails=1: one hit,
// and it names the voivodeship. The broken value "Las Wiączyński (k" was sent
// as-is (the bracket never closes, so cityFromLocation keeps it) and answered
// with an empty array.
const LAS_WIACZYNSKI = {
  name: 'Las Wiączyński',
  type: 'forest',
  addresstype: 'forest',
  lat: '51.7683',
  lon: '19.6265',
  address: {
    forest: 'Las Wiączyński',
    village: 'Wiączyń Dolny',
    municipality: 'gmina Nowosolna',
    county: 'powiat łódzki wschodni',
    state: 'województwo łódzkie',
    country_code: 'pl',
  },
}

test('the city survives into the geocode query', () => {
  assert.equal(cityFromLocation(parseLocation(FOREST_CROSS)), 'Las Wiączyński')
  assert.equal(cityFromLocation('Las Wiączyński (k'), 'Las Wiączyński (k')
})

test('the query the geocode step sends resolves to a voivodeship', () => {
  // A forest is not a settlement, so the answer comes through the venue
  // fallback: Nominatim matched the name the organizer wrote, and the hit
  // knows both its village and its state.
  const city = cityFromLocation(parseLocation(FOREST_CROSS))
  const hit = pickVenueFallback([LAS_WIACZYNSKI], city)
  assert.equal(hit?.address?.state, 'województwo łódzkie')
  // The truncated value never matched that name, which is why the row published
  // empty even though the hit existed all along.
  assert.equal(pickVenueFallback([LAS_WIACZYNSKI], 'Las Wiączyński (k'), null)
})

// Every one of these descriptions is a run of "Label: value" pairs, and a hard
// list of label words can only name the ones already seen. "Baza zawodów:",
// "Formuła:" and "Dla kogo:" are all absent from it.
test('a label the stop list never heard of still ends the location', () => {
  assert.equal(parseLocation('Miejsce: Grotniki Baza zawodów: Polana'), 'Grotniki')
  assert.equal(parseLocation('Miejsce: Grotniki Program: godzina po godzinie'), 'Grotniki')
  assert.equal(parseLocation('Miejsce: Grotniki Dla kogo: dla każdego'), 'Grotniki')
})

test('a lowercase word before a colon is not a label', () => {
  assert.equal(parseLocation('Miejsce: Grotniki, wiata przy leśniczówce'), 'Grotniki, wiata przy leśniczówce')
})

test('a sentence still ends the location', () => {
  assert.equal(
    parseLocation('Miejsce: Puszcza Bolimowska. Wybierz swój dystans.'),
    'Puszcza Bolimowska',
  )
})

// The abbreviation rule means a period no longer has to end the value, so a
// description with neither a label nor a period can run past the 70-character
// guard. It must not come out worse than it did before that rule existed: the
// naive capture is tried again, and the row keeps the truncated value it had.
test('prose with no label and no sentence end keeps its old truncated value', () => {
  const runaway = 'Miejsce: Grotniki k. Zgierza zapraszamy wszystkich chętnych do wspólnego'
    + ' biegania po lesie w naprawdę bardzo miłej atmosferze'
  assert.ok(runaway.length > 70)
  assert.equal(parseLocation(runaway), 'Grotniki k')
})

// "pl" and "k" are abbreviations at the start of a word only. A ".pl" domain
// and a "10k" distance both end in those letters and neither is one, so the
// period after them still ends the value instead of swallowing the blurb. The
// distance is the case that needs the digit in the guard: a domain's own first
// dot ends the value before its TLD is ever read.
test('a domain and a distance do not swallow the rest of the blurb', () => {
  assert.equal(parseLocation('Miejsce: Grotniki więcej na leszy.pl. Reszta blurbu'), 'Grotniki więcej na leszy')
  assert.equal(parseLocation('Miejsce: Grotniki bieg na 10k. Reszta blurbu'), 'Grotniki bieg na 10k')
})

test('the other lumisport locations are unchanged', () => {
  assert.equal(parseLocation(DOG_FOREST_CROSS), 'Las Wiączyński (okolice Leśniczówki Wiączyń) 🏁')
  assert.equal(parseLocation(GORKI_CROSS), 'Tor motocrossowy – Piątkowisko')
  assert.equal(parseLocation(''), null)
})

// This one was not a regression — the blurb carries no period, so the old rule
// swallowed "Formuła: Bieg oraz Nordic Walking" too, and the assertion used to
// pin that. The generic label stop is what cuts it back to the park.
test('the Halloween Run location stops at the organizer next label', () => {
  assert.equal(parseLocation(HALLOWEEN_RUN), 'Łódź, Park na Zdrowiu')
})
