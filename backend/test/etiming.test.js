import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  warsawDate, deadlineFrom, isRunningEvent, distancesFrom, pricesFrom,
  detectEventTypes, hasKidsSignal, buildRow, nextPageUrl, upcomingSlugs,
} from '../src/scrapers/sources/etiming.js'

// https://api.etiming.pl/events/ligatsa27/ on 2026-11-18, trimmed (age
// categories and four of the six stages left out).
const LIGATSA27 = {
  id: 73,
  slug: 'ligatsa27',
  name: 'Liga Biegowa TSA 2027',
  subtitle: 'Sześć etapów. Jeden komplet.',
  description: '<p>Zapraszamy do udziału w <strong>Lidze Biegowej i Nordic Walking TSA Sandomierz 2027</strong>.</p>' +
    '<p><em>Wszystkie etapy odbywają się do 50 km od Sandomierza.</em></p><p></p>' +
    '<p><strong>Dystanse na każdym etapie :</strong></p><ul><li><p>bieg 10 km</p></li><li><p>nordic walking ok. 5 km.</p></li></ul>' +
    '<p><strong>Opłata startowa:</strong></p><ul><li><p><strong>390 zł</strong> do 31.12.2026</p></li></ul>',
  event_start: '2027-02-21T12:00:00+01:00',
  event_end: '2027-12-11T16:00:00+01:00',
  registration_open: '2026-11-05T19:00:00+01:00',
  registration_close: '2027-02-20T23:59:00+01:00',
  city: 'Sandomierz',
  facebook: 'tsasandomierz',
  payment: '390',
  status: 'open',
  is_ended: false,
  details: [
    { id: 50, name: 'Rozmiar koszulki', values: 'XS, S, M, L, XL, XXL', type: 'enum' },
    { id: 51, name: 'Konkurencja', values: 'Bieg, Nordic Walking', type: 'enum' },
  ],
  distances: [
    { id: 187, name: '21.02 - Sandomierz (Etap 1)', short_name: 'Etap 1', payment: '85.00', price_tiers: [], current_price: '85.00', age_categories: [{ name: 'K20' }, { name: 'M' }] },
    { id: 189, name: '10.04 - Etap 2', short_name: 'Etap 2', payment: '85.00', price_tiers: [], current_price: '85.00', age_categories: [{ name: 'M70' }] },
  ],
  lat: '50.67827',
  lng: '21.74652',
  regulations_file: 'https://etiming.pl/media/events/ligatsa27/regulations/Regulamin_Liga_TSA_2027_v1.5.pdf',
  multi_distance: true,
  multi_distance_tiers: [{ id: 12, quantity: 1, price: '85.00' }, { id: 13, quantity: 6, price: '390.00' }],
}

// https://api.etiming.pl/events/ii-bieg-mikolajkowy/ on 2026-11-18, trimmed.
const MIKOLAJKOWY = {
  id: 77,
  slug: 'ii-bieg-mikolajkowy',
  name: 'II Bieg Mikołajkowy',
  subtitle: 'Bieg górski',
  description: '<p><strong>II Górski Bieg Mikołajkowy</strong></p><p>Trasa liczy <strong>7 kilometrów</strong> i prowadzi przez ścieżki z łącznym przewyższeniem <strong>230 metrów</strong>.</p>' +
    '<p>Dla dzieci i młodzieży (do 16 lat) przygotowaliśmy specjalną kategorię biegową OPEN.</p>',
  event_start: '2026-12-06T11:00:00+01:00',
  registration_close: '2026-12-01T00:00:00+01:00',
  city: 'Rymanów-Zdrój',
  facebook: 'https://www.facebook.com/gosirrymanow',
  payment: '50',
  status: 'open',
  is_ended: false,
  details: [],
  distances: [
    { name: 'Bieg górski', short_name: '', payment: '50.00', price_tiers: [], current_price: '50.00', age_categories: [] },
    { name: 'Nordic Walking', short_name: '', payment: '50.00', price_tiers: [], current_price: '50.00', age_categories: [] },
  ],
  lat: '49.54410',
  lng: '21.84880',
  regulations_file: 'https://etiming.pl/media/events/ii-bieg-mikolajkowy/regulations/regulamin_2026.pdf',
  multi_distance: false,
  multi_distance_tiers: [],
}

// https://api.etiming.pl/events/VI-festiwal-sandomierz/ (past), trimmed.
const FESTIWAL = {
  slug: 'VI-festiwal-sandomierz',
  name: 'VI Festiwal Biegowy Sandomierskim Szlakiem Winiarskim',
  subtitle: 'Bieg terenowy',
  description: '<h2>Trasy i dystanse</h2><ul><li><p>Traktem Sadowniczym 10KM</p></li></ul>',
  event_start: '2026-09-05T09:30:00+02:00',
  registration_close: '2026-09-02T00:00:00+02:00',
  city: 'Sandomierz',
  status: 'closed',
  details: [],
  distances: [
    { name: 'Traktem Pieprzowym 26KM', payment: '200.00', current_price: '200.00', price_tiers: [{ price: '150.00' }, { price: '170.00' }], age_categories: [] },
    { name: 'Traktem Królewskim 16KM', payment: '170.00', current_price: '170.00', price_tiers: [{ price: '120.00' }, { price: '150.00' }], age_categories: [] },
    { name: 'Nordic Walking 12KM', payment: '150.00', current_price: '150.00', price_tiers: [{ price: '100.00' }, { price: '120.00' }], age_categories: [] },
  ],
  regulations_file: 'https://etiming.pl/media/events/VI-festiwal-sandomierz/regulations/regulamin-VI-fb.pdf',
  multi_distance_tiers: [],
}

test('warsawDate: the calendar day in Warsaw, whatever the offset', () => {
  assert.equal(warsawDate('2027-02-21T12:00:00+01:00'), '2027-02-21')
  assert.equal(warsawDate('2026-09-05T23:30:00Z'), '2026-09-06')
  assert.equal(warsawDate(null), null)
  assert.equal(warsawDate('nonsense'), null)
})

test('deadlineFrom: a close at midnight means the day before is the last one', () => {
  assert.equal(deadlineFrom('2027-02-20T23:59:00+01:00'), '2027-02-20')
  assert.equal(deadlineFrom('2026-12-01T00:00:00+01:00'), '2026-11-30')
  assert.equal(deadlineFrom(null), null)
})

test('isRunningEvent: drops cycling, motor and walked rajdy, keeps runs and NW', () => {
  assert.equal(isRunningEvent({ name: 'Liga Biegowa TSA 2027', subtitle: 'Sześć etapów. Jeden komplet.' }), true)
  assert.equal(isRunningEvent({ name: 'II Bieg Mikołajkowy', subtitle: 'Bieg górski' }), true)
  assert.equal(isRunningEvent({ name: 'XIV Tropem Wilczym', subtitle: '' }), true)
  assert.equal(isRunningEvent({ name: 'I ŻUPAWA ENDURO SPRINT', subtitle: 'jesień 2026' }), false)
  assert.equal(isRunningEvent({ name: '12. Tropem Wilka i Rowerów Kilka', subtitle: 'Wyścig rowerowy' }), false)
  assert.equal(isRunningEvent({ name: 'VIII Chmielnicki Rajd Rodzinny', subtitle: null }), false)
  assert.equal(isRunningEvent({ name: 'Rajd i bieg', subtitle: null }), true)
})

test('distancesFrom: distance names first', () => {
  assert.equal(distancesFrom(FESTIWAL), '26 km, 16 km, 12 km')
})

test('distancesFrom: the description\'s Dystanse list when the names carry none, not the "50 km od" aside', () => {
  assert.equal(distancesFrom(LIGATSA27), '10 km, 5 km')
})

test('distancesFrom: "Trasa liczy 7 kilometrów" in the description', () => {
  assert.equal(distancesFrom(MIKOLAJKOWY), '7 km')
})

test('distancesFrom: nothing found is null', () => {
  assert.equal(distancesFrom({ distances: [{ name: 'Kat. 1' }], description: '<p>Zapraszamy</p>' }), null)
})

test('pricesFrom: per-start fees and tiers, never a multi-stage package', () => {
  assert.deepEqual(pricesFrom(LIGATSA27), { price_from: 85, price_to: 85 })
  assert.deepEqual(pricesFrom(MIKOLAJKOWY), { price_from: 50, price_to: 50 })
  assert.deepEqual(pricesFrom(FESTIWAL), { price_from: 100, price_to: 200 })
  assert.deepEqual(pricesFrom({ distances: [] }), { price_from: null, price_to: null })
})

test('detectEventTypes: style from name and subtitle; NW from competitions only when they carry none', () => {
  assert.deepEqual(detectEventTypes(LIGATSA27), ['nordic walking'])
  assert.deepEqual(detectEventTypes(MIKOLAJKOWY), ['trail'])
  assert.deepEqual(detectEventTypes(FESTIWAL), ['trail'])
  assert.deepEqual(detectEventTypes({ name: 'V Jesienna Dycha', subtitle: '', distances: [{ name: '10 km' }], details: [] }), [])
})

test('hasKidsSignal: names, subtitle, distances and categories; not the description', () => {
  assert.equal(hasKidsSignal(MIKOLAJKOWY), false)
  assert.equal(hasKidsSignal({ name: 'XII Gorzycka 5 - młodzież', subtitle: '', distances: [] }), true)
  assert.equal(hasKidsSignal({ name: 'X', subtitle: '', distances: [{ name: 'Bieg dzieci 400 m', age_categories: [] }] }), true)
  assert.equal(hasKidsSignal({ name: 'X', subtitle: '', distances: [{ name: 'Dzieci', age_categories: [] }] }), true)
})

test('buildRow: ligatsa27', () => {
  assert.deepEqual(buildRow(LIGATSA27), {
    name: 'Liga Biegowa TSA 2027',
    date: '2027-02-21',
    location: 'Sandomierz',
    distances: '10 km, 5 km',
    registration_url: 'https://etiming.pl/e/ligatsa27/register',
    registration_deadline: '2027-02-20',
    regulamin_url: 'https://etiming.pl/media/events/ligatsa27/regulations/Regulamin_Liga_TSA_2027_v1.5.pdf',
    website: null,
    is_kids: false,
    event_types: ['nordic walking'],
    price_from: 85,
    price_to: 85,
    lat: 50.67827,
    lng: 21.74652,
    source: 'etiming',
    source_id: 'ligatsa27',
    source_url: 'https://etiming.pl/e/ligatsa27',
  })
})

test('buildRow: a closed or full event gets no registration link', () => {
  assert.equal(buildRow({ ...MIKOLAJKOWY, status: 'closed' }).registration_url, null)
  assert.equal(buildRow({ ...MIKOLAJKOWY, status: 'full' }).registration_url, null)
  assert.equal(buildRow(MIKOLAJKOWY).registration_url, 'https://etiming.pl/e/ii-bieg-mikolajkowy/register')
})

test('buildRow: no regulations_file is null; a missing start date drops the row', () => {
  assert.equal(buildRow({ ...MIKOLAJKOWY, regulations_file: null }).regulamin_url, null)
  assert.equal(buildRow({ ...MIKOLAJKOWY, event_start: null }), null)
})

test('nextPageUrl: the API hands back http, it is fetched over https', () => {
  assert.equal(nextPageUrl({ next: 'http://api.etiming.pl/events/?limit=12&offset=12' }), 'https://api.etiming.pl/events/?limit=12&offset=12')
  assert.equal(nextPageUrl({ next: null }), null)
  assert.equal(nextPageUrl({ next: 'https://evil.example/events/' }), null)
})

test('upcomingSlugs: from today on, running only, each slug once', () => {
  const results = [
    { slug: 'ZMX-Enduro-Sprint', name: 'I ŻUPAWA ENDURO SPRINT', event_start: '2026-11-15T12:00:00+01:00' },
    { slug: 'ii-bieg-mikolajkowy', name: 'II Bieg Mikołajkowy', event_start: '2026-12-06T11:00:00+01:00' },
    { slug: 'ligatsa27', name: 'Liga Biegowa TSA 2027', event_start: '2027-02-21T12:00:00+01:00' },
    { slug: 'ligatsa27', name: 'Liga Biegowa TSA 2027', event_start: '2027-02-21T12:00:00+01:00' },
    { slug: 'enduro-2027', name: 'II Enduro Sprint', event_start: '2027-05-01T12:00:00+02:00' },
    { slug: 'x', name: 'Bez daty', event_start: null },
  ]
  assert.deepEqual(upcomingSlugs(results, '2026-11-18'), ['ii-bieg-mikolajkowy', 'ligatsa27'])
})
