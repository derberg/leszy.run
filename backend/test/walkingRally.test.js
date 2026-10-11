import { test } from 'node:test'
import assert from 'node:assert/strict'
import { looksWalkingRally } from '../src/lib/walkingRally.js'

// Every name below is verbatim from scraper_all, calendar_events or a raw
// scraper table on 2026-09-29. Between them they are every row in the corpus
// whose name contains "piesz".

test('drops a rally that is walked', () => {
  // b4sport 13090, reached calendar_events as `uliczny` with no distances.
  assert.equal(looksWalkingRally({ name: 'I PIESZY RAJD - KIERUNEK CHEŁMY' }), true)
  assert.equal(looksWalkingRally({ name: 'Rajd Pieszy Niepodległa Polska' }), true)
  assert.equal(looksWalkingRally({ name: 'RAJD PIESZY „Tam i z Powrotem"' }), true)
  assert.equal(looksWalkingRally({ name: 'IX Bieszczadzki Rajd Pieszy Edycja Natchnieni Bieszczadem 2026' }), true)
})

test('a walked marathon is still walked', () => {
  // The word maraton states a distance. It does not make the event a race.
  assert.equal(looksWalkingRally({ name: 'MARATON PIESZY „SUDECKI SOWIZDRZAŁ”' }), true)
  assert.equal(looksWalkingRally({ name: 'XXI Ekstremalny Maraton Pieszy KIERAT' }), true)
})

test('a town called Pieszyce is not a walking rally', () => {
  // The reason the match is anchored at both ends. KORONA GÓR SOWICH PIESZYCE
  // UPHILL is an uphill running race, datasport 12718, 5 / 9 / 12.3 km.
  assert.equal(looksWalkingRally({ name: 'KORONA GÓR SOWICH PIESZYCE UPHILL' }), false)
})

test('a run that happens to share its name with a ramble survives', () => {
  // bgtimesport 870 is a mountain RACE with a hike alongside it. Dropping the
  // row would lose the race, and the race is what this calendar lists.
  assert.equal(looksWalkingRally({ name: 'Bieg Górski Na Błatnią oraz Beskidzki Rajd Pieszy' }), false)
  assert.equal(looksWalkingRally({ name: 'Festiwal Pieszo - Biegowy PRZEDWIOŚNIE 2027' }), false)
  assert.equal(looksWalkingRally({ name: 'VIII Festiwal Pieszo-Biegowy Przedwiośnie' }), false)
})

test('nordic walking survives, because this calendar lists it', () => {
  assert.equal(looksWalkingRally({ name: 'Wędrówka Piesza i Nordic Walking z Energią Wiatru' }), false)
  assert.equal(looksWalkingRally({ name: 'Marsz Pieszy z kijami' }), false)
})

test('rajd on its own is never evidence', () => {
  // A rajd is a route, not a discipline. These are the rows a bare `rajd`
  // keyword would have destroyed.
  for (const name of [
    'Rajd Górski Boguszowska 50',
    'Rajd 12. SKOCKA 100',
    'IV Rajd Izersko – Karkonoski im. Roberta Kapczyńskiego',
    'Rajd Beskidy Short',
    'XIV Rajd Nordic Walking',
    'X Rajd z Kijami przez Jaskinie',
    'Jesienny Rajd Wokół Zalewu Koronowskiego',
    'X Sosnowicki Rajd na 6 Łapach',
  ]) {
    assert.equal(looksWalkingRally({ name }), false, name)
  }
})

test('an empty or missing name is not a match', () => {
  assert.equal(looksWalkingRally({ name: null }), false)
  assert.equal(looksWalkingRally({}), false)
  assert.equal(looksWalkingRally(), false)
})
