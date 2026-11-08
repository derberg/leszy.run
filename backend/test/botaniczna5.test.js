import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseIcs, parseDetail, parseLocation, parseDistance, cityFromName, isInPoland, buildRow,
} from '../src/scrapers/sources/botaniczna5.js'

// https://botaniczna5.pl/events.ics as served on 2026-11-07 (CRLF, folded lines),
// plus a Kaunas event shaped like the series' Lithuanian edition.
const ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//wp-events-plugin.com//5.95//EN',
  'BEGIN:VEVENT',
  'UID:341@botaniczna5.pl',
  'DTSTART;TZID=Europe/Warsaw:20261115T100000',
  'DTEND;TZID=Europe/Warsaw:20261115T133000',
  'URL:https://botaniczna5.pl/events/botaniczna-piatka-zielona-gora-edycja-je',
  ' sienna-2026/',
  'SUMMARY:Botaniczna Piątka Zielona Góra - edycja jesienna 2026',
  'DESCRIPTION:',
  'LOCATION:OB Zielona Góra\\, Botaniczna 50A\\, Zielona Góra\\, lubuskie\\, 65-',
  ' 392\\, Poland',
  'X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-ADDRESS=Botaniczna 50A\\, Zielona G',
  ' óra\\, lubuskie\\, 65-392\\, Poland;X-APPLE-RADIUS=100;X-TITLE=OB Zielona G',
  ' óra:geo:0,0',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:333@botaniczna5.pl',
  'DTSTART;TZID=Europe/Warsaw:20261121T100000',
  'URL:https://botaniczna5.pl/events/botaniczna-piatka-gdynia-edycja-jesienna',
  ' -2026/',
  'SUMMARY:Botaniczna Piątka Gdynia - edycja jesienna 2026',
  'LOCATION:Leśny Ogród Botaniczny Marszewo\\, Marszewska 5\\, Gdynia\\, pomors',
  ' kie\\, 81-081\\, Poland',
  'GEO:54.52770460000001;18.4302303',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:350@botaniczna5.pl',
  'DTSTART;TZID=Europe/Warsaw:20271017T100000',
  'URL:https://botaniczna5.pl/events/botanic-five-kaunas-2027/',
  'SUMMARY:Botanic Five Kaunas 2027',
  'LOCATION:VDU Botanikos sodas\\, Ž. E. Žilibero g. 6\\, Kaunas\\, 46324\\, Lithuania',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n')

// The header row and the document links of
// /events/botaniczna-piatka-zielona-gora-edycja-jesienna-2026/ on 2026-11-07.
// The kids' regulamin is linked before the main one.
const DETAIL = `<div class="entry-content">
<div class="event-first-row">
  <div class="event-name d-flex align-items-center"><p> Botaniczna 50A </p></div>
  <div class="event-distance d-flex"><img src="distance.png"><div>5 km</div></div>
  <div class="event-date d-flex"><img src="calendar.png"><div>15.11.2026</div></div>
  <div class="event-contact d-flex"><a href="/kontakt">Kontakt</a></div>
  <div class="event-signup d-flex"><a href="https://plus-timing.pl/zgloszenia/botaniczna5-jesien-2026" target="_blank">Zapisz się</a></div>
</div>
<a class="btn btn-event" href="https://plus-timing.pl/zgloszenia/botaniczna5-jesien-2026/lista_startowa.php">Lista startowa</a>
<h3>Biegi dziecięce w Twojej lokalizacji!</h3>
<a href="https://plus-timing.pl/zgloszenia/botaniczna5-jesien-2026-dzieci">FORMULARZ ZGŁOSZENIOWY</a>
<a href="https://botaniczna5.pl/wp-content/uploads/2026/09/DZIECI-JESIEN-2026.pdf"><span><strong>REGULAMIN BIEGÓW DZIECIĘCYCH</strong></span></a>
<a href="https://botaniczna5.pl/wp-content/uploads/2023/08/mapa-Gdynia-2.pdf"><strong>MAPA W FORMACIE PDF</strong></a>
<a href="https://plus-timing.pl/zgloszenia/botaniczna5-jesien-2026"><b>ZAPISY NA DYSTANS GŁÓWNY</b></a>
<a href="https://botaniczna5.pl/wp-content/uploads/2026/09/CYKL-JESIEN-2026.pdf"><span><strong>REGULAMIN DYSTANSU GŁÓWNEGO</strong></span></a>
<a href="https://botaniczna5.pl/wp-content/uploads/2026/09/DZIECI-JESIEN-2026.pdf"><span><strong>REGULAMIN BIEGÓW DZIECIĘCYCH</strong></span></a>
</div>`

const PAGE_URL = 'https://botaniczna5.pl/events/botaniczna-piatka-zielona-gora-edycja-jesienna-2026/'

test('the iCal feed gives slug, date, name, city, voivodeship and coordinates', () => {
  const [zg, gdynia] = parseIcs(ICS)
  assert.equal(zg.slug, 'botaniczna-piatka-zielona-gora-edycja-jesienna-2026')
  assert.equal(zg.url, PAGE_URL)
  assert.equal(zg.date, '2026-11-15')
  assert.equal(zg.name, 'Botaniczna Piątka Zielona Góra - edycja jesienna 2026')
  assert.equal(zg.city, 'Zielona Góra')
  assert.equal(zg.voivodeship, 'Lubuskie')
  assert.equal(zg.lat, null)
  assert.equal(gdynia.city, 'Gdynia')
  assert.equal(gdynia.voivodeship, 'Pomorskie')
  assert.equal(gdynia.lat, 54.527705)
  assert.equal(gdynia.lng, 18.43023)
})

test('the Lithuanian edition is not in Poland', () => {
  const events = parseIcs(ICS)
  assert.deepEqual(events.map(isInPoland), [true, true, false])
})

test('the city comes from the name when the address has no voivodeship', () => {
  assert.equal(cityFromName('Botaniczna Piątka Mikołów – edycja jesienna 2026'), 'Mikołów')
  assert.deepEqual(parseLocation([], 'Botaniczna Piątka Łódź - edycja nocna 2026'),
    { city: 'Łódź', voivodeship: null, country: null })
})

test('the distance is normalised', () => {
  assert.equal(parseDistance(' 5 km '), '5 km')
  assert.equal(parseDistance('5km'), '5 km')
  assert.equal(parseDistance(''), null)
})

test('the event page gives the sign-up button, the main regulamin and the kids flag', () => {
  const d = parseDetail(DETAIL, PAGE_URL)
  assert.equal(d.registrationUrl, 'https://plus-timing.pl/zgloszenia/botaniczna5-jesien-2026')
  assert.equal(d.regulaminUrl, 'https://botaniczna5.pl/wp-content/uploads/2026/09/CYKL-JESIEN-2026.pdf')
  assert.equal(d.distances, '5 km')
  assert.equal(d.isKids, true)
})

test('a page without kids races or a regulamin', () => {
  const html = `<div class="entry-content"><div class="event-distance"><div>5 km</div></div>
    <div class="event-signup"><a href="https://plus-timing.pl/zgloszenia/botaniczna5-zima-2027">Zapisz się</a></div>
    <a href="https://botaniczna5.pl/wp-content/uploads/2023/08/mapa-Gdynia-2.pdf">MAPA W FORMACIE PDF</a></div>`
  const d = parseDetail(html, PAGE_URL)
  assert.equal(d.regulaminUrl, null)
  assert.equal(d.isKids, false)
})

test('buildRow shapes the row for scraper_botaniczna5', () => {
  const [zg] = parseIcs(ICS)
  const row = buildRow(zg, parseDetail(DETAIL, PAGE_URL))
  assert.equal(row.source, 'botaniczna5')
  assert.equal(row.source_id, 'botaniczna-piatka-zielona-gora-edycja-jesienna-2026')
  assert.equal(row.source_url, PAGE_URL)
  assert.equal(row.location, 'Zielona Góra')
  assert.equal(row.voivodeship, 'Lubuskie')
  assert.deepEqual(row.event_types, [])
  assert.equal(row.is_kids, true)
})
