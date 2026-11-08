import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseIcs, parseDetail, parseLocation, parseDistances, isInPoland, detectEventTypes, buildRow,
} from '../src/scrapers/sources/biegiwlkp.js'

// https://biegiwlkp.pl/events.ics as served on 2026-11-07 (CRLF, folded lines),
// three of its five events.
const ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//wp-events-plugin.com//5.95//EN',
  'BEGIN:VEVENT',
  'UID:251@biegiwlkp.pl',
  'DTSTART;TZID=Europe/Warsaw:20261108T100000',
  'URL:https://biegiwlkp.pl/events/marcelinski-bieg-jesienny-2026/',
  'SUMMARY:Marceliński Bieg Jesienny 2026',
  'DESCRIPTION:',
  'LOCATION:Lasek Marceliński\\, Ptasia\\, Poznań\\, wielkopolskie\\, Poland',
  'X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-ADDRESS=Ptasia\\, Poznań\\, wielkopo',
  ' lskie\\, Poland;X-APPLE-RADIUS=100;X-TITLE=Lasek Marceliński:geo:0,0',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:254@biegiwlkp.pl',
  'DTSTART;TZID=Europe/Warsaw:20261129T110000',
  'URL:https://biegiwlkp.pl/events/bieg-po-ciacho-2026/',
  'SUMMARY:Bieg po Ciacho 2026',
  'LOCATION:Puszczykowo\\, Kościelna 7\\, Puszczykowo\\, Puszczykowo\\, wielkopol',
  ' skie\\, 62-640\\, Poland',
  'GEO:52.2860156;16.85714669999993',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:263@biegiwlkp.pl',
  'DTSTART;TZID=Europe/Warsaw:20270124T093000',
  'URL:https://biegiwlkp.pl/events/x-zimowy-polmaraton-cwiercmaraton-lekno/',
  'SUMMARY:X Zimowy Półmaraton/Ćwierćmaraton Łękno',
  'LOCATION:Łękno wigwam\\, gajowa\\, Łękno\\, Poland',
  'GEO:52.15634371138727;17.15189077934565',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n')

// The header row and document links of /events/bieg-po-ciacho-2026/ on
// 2026-11-07. The kids' regulamin's file name (regulamin.pdf) outscores the
// main one's (Puszczykowo_cykl.pdf).
const CIACHO = `<div class="entry-content">
<div class="event-first-row">
  <div class="event-name d-flex"><p> Kościelna 7, Puszczykowo </p></div>
  <div class="event-distance d-flex"><i class="fas fa-route"></i><div>10 km</div></div>
  <div class="event-date d-flex"><div>29.11.2026</div></div>
  <div class="event-contact d-flex"><a href="/kontakt">Kontakt</a></div>
  <div class="event-signup d-flex"><a href="https://plus-timing.pl/zgloszenia/cykl-puszczykowo-2026" target="_blank">Zapisz się</a></div>
</div>
<a href="https://plus-timing.pl/zgloszenia/cykl-puszczykowo-2026/lista_startowa.php">Lista startowa</a>
<a href="https://plus-timing.pl/wyniki"> Wyniki </a>
<a href="https://plus-timing.pl/zgloszenia/cykl-puszczykowo-2026"><strong>BIEG GŁÓWNY</strong></a>
<a href="https://plus-timing.pl/zgloszenia/bieg-po-ciacho-dzieci-2026"><strong>BIEGI DZIECIĘCE </strong></a>
<a href="https://biegiwlkp.pl/wp-content/uploads/2025/12/Puszczykowo_cykl.pdf"><span><strong>REGULAMIN BIEGU GŁÓWNEGO </strong></span></a>
<a href="https://plus-timing.pl/zgloszenia/bieg-po-ciacho-dzieci-2026/doc/regulamin.pdf"><strong>REGULAMIN BIEGÓW DZIECIĘCYCH </strong></a>
</div>`

// /events/x-zimowy-polmaraton-cwiercmaraton-lekno/ on 2026-11-07: no form yet,
// so every button (Zapisz się, Lista startowa, Wyniki) points at the results page.
const LEKNO = `<div class="entry-content">
<div class="event-first-row">
  <div class="event-distance d-flex"><div>10,5 km / 21,1 km</div></div>
  <div class="event-signup d-flex"><a href="https://plus-timing.pl/wyniki" target="_blank">Zapisz się</a></div>
</div>
<a href="https://plus-timing.pl/wyniki">Lista startowa</a>
<a href="https://plus-timing.pl/wyniki">Wyniki</a>
<a href="https://biegiwlkp.pl/wp-content/uploads/2024/11/INFORMATOR-ŁĘKNO-ZIMA-2025.pdf">INFORMATOR UCZESTNIKA</a>
<a href="http://biegiwlkp.pl/wp-content/uploads/2021/11/zaniemysl_mapa_sytuacyjna-2022.pdf">MAPA SYTUACYJNA (PDF)</a>
</div>`

const CIACHO_URL = 'https://biegiwlkp.pl/events/bieg-po-ciacho-2026/'
const LEKNO_URL = 'https://biegiwlkp.pl/events/x-zimowy-polmaraton-cwiercmaraton-lekno/'

test('the iCal feed gives slug, date, name, city, voivodeship and coordinates', () => {
  const [marcelin, ciacho, lekno] = parseIcs(ICS)
  assert.equal(marcelin.slug, 'marcelinski-bieg-jesienny-2026')
  assert.equal(marcelin.date, '2026-11-08')
  assert.equal(marcelin.name, 'Marceliński Bieg Jesienny 2026')
  assert.equal(marcelin.city, 'Poznań')
  assert.equal(marcelin.voivodeship, 'Wielkopolskie')
  assert.equal(marcelin.lat, null)
  assert.equal(ciacho.url, CIACHO_URL)
  assert.equal(ciacho.city, 'Puszczykowo')
  assert.equal(ciacho.lat, 52.286016)
  assert.equal(ciacho.lng, 16.857147)
  assert.equal(lekno.city, 'Łękno')
  assert.equal(lekno.voivodeship, null)
  assert.equal(lekno.date, '2027-01-24')
})

test('the city without a voivodeship is the last part before the country', () => {
  assert.deepEqual(parseLocation(['Jezioro Rusałka', 'Jezioro Rusałka', 'Poznań', 'Poland']),
    { city: 'Poznań', voivodeship: null, country: 'Poland' })
  assert.deepEqual(parseLocation(['Stadion', 'Golęcin', 'Poznań']),
    { city: 'Poznań', voivodeship: null, country: null })
  assert.equal(parseLocation([]).city, null)
})

test('an address abroad is not in Poland', () => {
  assert.equal(isInPoland(parseLocation(['Park', 'Berlin', 'Germany'])), false)
  assert.equal(isInPoland(parseLocation(['Park', 'Poznań', 'Poland'])), true)
  assert.equal(isInPoland(parseLocation(['Park', 'Poznań'])), true)
})

test('distances are split and normalised', () => {
  assert.equal(parseDistances('10 km'), '10 km')
  assert.equal(parseDistances('5/10 km'), '5 km, 10 km')
  assert.equal(parseDistances('10,5 km / 21,1 km'), '10.5 km, 21.1 km')
  assert.equal(parseDistances('400 m / 5 km'), '400 m, 5 km')
  assert.equal(parseDistances(''), null)
})

test('the event page gives the sign-up button, the main regulamin and the kids flag', () => {
  const d = parseDetail(CIACHO, CIACHO_URL)
  assert.equal(d.registrationUrl, 'https://plus-timing.pl/zgloszenia/cykl-puszczykowo-2026')
  assert.equal(d.regulaminUrl, 'https://biegiwlkp.pl/wp-content/uploads/2025/12/Puszczykowo_cykl.pdf')
  assert.equal(d.distances, '10 km')
  assert.equal(d.isKids, true)
})

test('a button that points at the results page is no registration url', () => {
  const d = parseDetail(LEKNO, LEKNO_URL)
  assert.equal(d.registrationUrl, null)
  assert.equal(d.regulaminUrl, null)
  assert.equal(d.distances, '10.5 km, 21.1 km')
  assert.equal(d.isKids, false)
})

test('style comes from the name only', () => {
  assert.deepEqual(detectEventTypes('Marceliński Bieg Jesienny 2026'), [])
  assert.deepEqual(detectEventTypes('Leśny Bieg Nordic Walking'), ['trail', 'nordic walking'])
})

test('buildRow shapes the row for scraper_biegiwlkp', () => {
  const [, ciacho] = parseIcs(ICS)
  const row = buildRow(ciacho, parseDetail(CIACHO, CIACHO_URL))
  assert.equal(row.source, 'biegiwlkp')
  assert.equal(row.source_id, 'bieg-po-ciacho-2026')
  assert.equal(row.source_url, CIACHO_URL)
  assert.equal(row.website, CIACHO_URL)
  assert.equal(row.location, 'Puszczykowo')
  assert.equal(row.voivodeship, 'Wielkopolskie')
  assert.equal(row.date, '2026-11-29')
  assert.deepEqual(row.event_types, [])
  assert.equal(row.is_kids, true)
})
