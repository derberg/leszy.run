import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  scrape,
  fetchDetailPage,
  needsDetail,
  distancesFromDescription,
} from '../src/scrapers/sources/elektronicznezapisy.js'

// elektronicznezapisy publishes an event page long before the organizer opens the
// price list, and the scraper read distances only from the Cennik table rows. Event
// 16096 (VII Ultras Oliwski, 2027-09-18) was scraped on 2026-09-21 with an empty
// Cennik and its three distances written out in the description instead. 5 of the
// 13 future-dated rows with no distances carry them in the description this way.
//
// Prose below is copied from the live pages, sampled 2026-09-21.

const ULTRAS_OLIWSKI = `Ultras Oliwski powraca w 2027 roku.
  Znamy już datę kolejnej edycji wydarzenia. 18 września 2027 roku ponownie
  spotkamy się w Gdańsku, w sercu Lasów Oliwskich. W programie znajdą się:
  bieg na 10 km, półmaraton na dystansie około 21 km, ParaUltras Oliwski na
  dystansie 4 km, biegi dla dzieci.
  Zapiszcie datę: 18 września 2027 roku.`

// The trap: this one states elevation in metres and surface in kilometres.
// "2 km asfaltu" and "300 m przewyższenia" are not races.
const KASZUBSKI_CROSS = `Godz. 10:30 – dystans ok. 17,5 KM (Miazga) -LIMIT Czasu 2,5 godziny
  Godz. 10:45 – dystans ok. 4 km (Sprint).+NORDIC WALKING
  TRASA 1. Dystans Sprint (~4 km): Nawierzchnia mieszana (2 km asfaltu, ok. 100
  metrów przewyższenia pozostałe – ścieżki leśne i szutrowe).
  2. Dystans Miazga (~17,5 km): Trasa wymagająca, ok. 300 m przewyższenia.
  Charakterystyczny punkt: 2 km asfaltowego podbiegu na starcie i zbiegu na metę.
  3. Trasa będzie oznakowana co 2-3 km i zabezpieczona przez służby OSP.`

// The trap: the 5 km course is two loops, and the loops are not races either.
const RUN_FOR_FIGHTERS = `Najważniejsze informacje: Termin: 15 października 2026 r.
  Miejsce: Bulwar Nadmorski im. Feliksa Nowowiejskiego w Gdyni
  Bieg główny: 5 km Trasa: dwie pętle – 2 km oraz 3 km
  Bieg integracyjny: krótszy dystans dostosowany do możliwości uczestników
  Pomiar czasu: elektroniczny`

const GDANSK_BIEGA = `Każdy uczestnik będzie mógł wybrać odpowiedni dla siebie
  dystans: 3 lub 6 km. Trasa biegu prowadzi najpierw plażą, a następnie alejkami
  Parku Nadmorskiego im. Ronalda Reagana. Obok rodziców z dziećmi można zobaczyć
  nastolatków, członków trójmiejskich klubów sportowych.`

// The trap: the kids races are in metres, and the 10 km is repeated three times.
const BIEG_NIEPODLEGLOSCI = `W ramach imprezy będzie przeprowadzony a. bieg na
  dystansie 10km, b. biegi malucha na dystansach 100, 300, 500 metrów oraz 1000 m
  - impreza towarzysząca 2. Limit czasu na dystansie 10 km wynosi 90 minut.
  4. Długość trasy biegowej 10 km`

test('distances the organizer wrote in the description are read', () => {
  const ultras = distancesFromDescription(ULTRAS_OLIWSKI)
  assert.deepEqual(ultras.distances, ['10 km', '21 km', '4 km'])
  assert.equal(ultras.isKids, true, '"biegi dla dzieci" is a kids race')

  assert.deepEqual(distancesFromDescription(GDANSK_BIEGA).distances, ['3 km', '6 km'])
})

test('course description is not a race distance', () => {
  // 2 km of asphalt and 300 m of climb belong to the 17.5 km race, they are not races.
  assert.deepEqual(
    distancesFromDescription(KASZUBSKI_CROSS).distances,
    ['17.5 km', '4 km'],
  )
  // Two loops make up the 5 km course.
  assert.deepEqual(distancesFromDescription(RUN_FOR_FIGHTERS).distances, ['5 km'])
})

test('a kids race in metres is a kids signal, not a distance', () => {
  const bieg = distancesFromDescription(BIEG_NIEPODLEGLOSCI)
  assert.deepEqual(bieg.distances, ['10 km'])
  assert.equal(bieg.isKids, true)
})

test('prose about children is not a kids race', () => {
  // "Obok rodziców z dziećmi" describes the crowd, and this event has no kids race.
  assert.equal(distancesFromDescription(GDANSK_BIEGA).isKids, false)
  assert.equal(distancesFromDescription(RUN_FOR_FIGHTERS).isKids, false)
})

const detailPage = ({ cennik = '', description = '' }) => `<html><body>
  <h1>VII Ultras Oliwski - Bieg Wokół Radości!</h1>
  <div style="padding:10px 0;">${description}</div>
  <ul class="list-group">
    <li class="list-group-item list-group-item-info">Informacje ogólne</li>
    <li class="list-group-item"><a href="/m/gdansk">Gdańsk</a></li>
    <li class="list-group-item">Początek imprezy: 2027.09.18 08:00</li>
    <li class="list-group-item">Zamknięcie rejestracji: 2027.09.16 08:00</li>
  </ul>
  <ul class="list-group">
    <li class="list-group-item list-group-item-info">Cennik</li>
    ${cennik}
  </ul>
</body></html>`

const CENNIK_ROWS = `<li class="list-group-item"><table>
  <tr><td>Bieg na 10 km</td><td>90,00 PLN</td></tr>
  <tr><td>Półmaraton</td><td>120,00 PLN</td></tr>
</table></li>`

function stubFetch(pages) {
  const asked = []
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    asked.push(String(url))
    const body = pages(String(url))
    return { ok: body !== null, text: async () => body ?? '' }
  }
  return { asked, restore: () => { globalThis.fetch = original } }
}

test('an empty Cennik falls back to the description', async () => {
  const stub = stubFetch(() => detailPage({ description: ULTRAS_OLIWSKI }))
  try {
    const detail = await fetchDetailPage('16096')
    assert.equal(detail.distances, '10 km, 21 km, 4 km')
    assert.equal(detail.is_kids, true)
    // Nothing was published about the fee, and the fallback must not invent one.
    assert.equal(detail.price_from, null)
  } finally {
    stub.restore()
  }
})

test('a Cennik that names distances wins over the description', async () => {
  // The price table is structured and authoritative. The description of the same
  // event calls the półmaraton "około 21 km"; the Cennik answer is 21.1.
  const stub = stubFetch(() => detailPage({ cennik: CENNIK_ROWS, description: ULTRAS_OLIWSKI }))
  try {
    const detail = await fetchDetailPage('16096')
    assert.equal(detail.distances, '10 km, 21.1 km')
    assert.equal(detail.price_from, 90)
  } finally {
    stub.restore()
  }
})

test('needsDetail re-reads a future row that still has no distances', () => {
  const known = new Set(['16096', '13847'])
  const rows = new Map([
    ['16096', { source_id: '16096', date: '2027-09-18', distances: null }],
    ['13847', { source_id: '13847', date: '2026-09-19', distances: '10 km, 21 km' }],
  ])
  assert.equal(needsDetail({ eventId: '16096' }, known, rows, '2026-09-21'), true)
  // A row that already has its distances costs no request.
  assert.equal(needsDetail({ eventId: '13847' }, known, rows, '2026-09-21'), false)
  // A new id is always fetched.
  assert.equal(needsDetail({ eventId: '99999' }, known, rows, '2026-09-21'), true)
})

test('needsDetail leaves a past race and an unreadable row alone', () => {
  const known = new Set(['16096'])
  const past = new Map([['16096', { source_id: '16096', date: '2026-09-20', distances: null }]])
  assert.equal(needsDetail({ eventId: '16096' }, known, past, '2026-09-21'), false)
  // Race day itself still counts — the page can be completed that morning.
  const today = new Map([['16096', { source_id: '16096', date: '2026-09-21', distances: null }]])
  assert.equal(needsDetail({ eventId: '16096' }, known, today, '2026-09-21'), true)
  // Without knownColumns there are no stored values to compare, so keep the skip.
  assert.equal(needsDetail({ eventId: '16096' }, known, new Map(), '2026-09-21'), false)
})

const listing = `<html><body><table>
  <tr>
    <td>1</td>
    <td><a href="event/16096/strona.html">VII Ultras Oliwski</a></td>
    <td>2027-09-18</td>
    <td><a href="event/16096/signup.html">Zapisz się</a></td>
  </tr>
  <tr>
    <td>1</td>
    <td><a href="event/13847/strona.html">VI Ultras Oliwski</a></td>
    <td>2026-09-19</td>
    <td><a href="event/13847/signup.html">Zapisz się</a></td>
  </tr>
</table></body></html>`

test('a known row with no distances is scraped again', async () => {
  const stub = stubFetch((url) => {
    if (url.includes('/1/bieg.html') || url.includes('/2/nordic-walking.html')) return listing
    if (url.includes('/16096/strona')) return detailPage({ description: ULTRAS_OLIWSKI })
    if (url.includes('/13847/strona')) return detailPage({ cennik: CENNIK_ROWS })
    return null
  })
  try {
    const events = await scrape({
      knownIds: new Set(['16096', '13847']),
      knownRows: new Map([
        ['16096', { source_id: '16096', date: '2027-09-18', distances: null }],
        ['13847', { source_id: '13847', date: '2026-09-19', distances: '10 km, 21.1 km' }],
      ]),
      today: '2026-09-21',
    })

    const found = events.find(e => e.source_id === '16096')
    assert.ok(found, '16096 must be emitted again while its distances are empty')
    assert.equal(found.distances, '10 km, 21 km, 4 km')

    // The complete row was neither re-fetched nor re-emitted.
    assert.equal(events.some(e => e.source_id === '13847'), false)
    assert.equal(stub.asked.some(u => u.includes('/13847/strona')), false)
  } finally {
    stub.restore()
  }
})
