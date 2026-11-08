import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseListing, parseForm, isRunningEvent, hasKidsSignal, detectEventTypes,
  distanceFromLabel, distancesFrom, pageNamesEvent, buildRow,
} from '../src/scrapers/sources/ultimasport.js'

// Rows of the https://ultimasport.pl/zapisy/ table, trimmed from 2026-11-08.
const row = (id, date, town, name) =>
  `<tr class='clickable' ><td><a href='https://formularz.ultimasport.pl/${id}' target='_blank' style='min-width:80px;'>${date}</a></td>` +
  `<td><a href='https://formularz.ultimasport.pl/${id}' target='_blank'>${town}</a></td>` +
  `<td><a href='https://formularz.ultimasport.pl/${id}' target='_blank'>${name}</a></td></tr>`

const LISTING = `<table class="table"><thead><tr><td>Data</td><td>Miejsce</td><td>Nazwa</td></tr></thead><tbody>
${row(490, '2027-03-20', 'Bardo', '3.Bardzka Rajza Górska')}
${row(519, '2026-12-06', 'Międzybórz', 'VIII BIEG MIKOŁAJÓW W MIĘDZYBORZU')}
${row(523, '2026-12-20', 'Strzelin', 'STRZELIN MIERZY WYSOKO  III BIEG NA WIEŻĘ RATUSZOWĄ ')}
${row(519, '2026-12-06', 'Międzybórz', 'VIII BIEG MIKOŁAJÓW W MIĘDZYBORZU')}
${row(999, '0001-01-01', 'Ząbkowice', 'XXII POWIATOWY RAJD ROWEROWY')}
<tr><td>brak daty</td><td>X</td><td>Y</td></tr>
</tbody></table>`

// formularz.ultimasport.pl/519, trimmed from 2026-11-08.
const FORM_519 = `<html><body><div class="container">
<h1>VIII BIEG MIKO&#x141;AJ&#xD3;W W MI&#x118;DZYBORZU, Mi&#x119;dzyb&#xF3;rz</h1>
<a href="/Competitor/Form/LoginDecision?formId=519" class="btn btn-primary">Zapisz się na zawody</a>
<div style="margin-top:10px">
  <a href="uploads/regulations/519_VIII.BM_Regulamin_za&#x142;.1 (3).pdf" class="btn btn-success" role="button" target="_blank">
    Regulamin
  </a>
</div>
<table class="table"><thead><tr><td>Zapisani zawodnicy</td><td>Wszyscy</td><td>Opłaceni</td><td>Nieopłaceni</td></tr></thead>
<tbody>
<tr><td>Wszyscy zawodnicy</td><td>120</td><td>80</td><td>40</td></tr>
<tr><td>M&#x119;&#x17C;czy&#x17A;ni</td><td>60</td><td>40</td><td>20</td></tr>
<tr><td>Kobiety</td><td>60</td><td>40</td><td>20</td></tr>
<!-- classification stats -->
<tr><td>5 km</td><td>50</td><td>30</td><td>20</td></tr>
<tr><td>10 km</td><td>40</td><td>30</td><td>10</td></tr>
<tr><td>Nordic Walking - 5 km</td><td>30</td><td>20</td><td>10</td></tr>
</tbody></table>
</div></body></html>`

const FORM_CLOSED = `<html><body><h1>BIEG BORÓWKOWA TRAIL – GÓRSKA KURACJA, Lądek Zdrój</h1>
<div class="alert"><h4 class="alert-heading">Zapisy na zawody są obecnie zamknięte!</h4></div>
<a href="uploads/regulations/501_mapa trasy.pdf">Mapa</a>
<table class="table"><tbody><tr><td>Wszyscy zawodnicy</td><td>416</td><td>306</td><td>110</td></tr>
<!-- classification stats --><tr><td>21 km</td><td>283</td><td>203</td><td>80</td></tr></tbody></table></body></html>`

test('parseListing: one row per form id, cells trimmed', () => {
  const rows = parseListing(LISTING)
  // 0001-01-01 is the site's placeholder date; scrape() drops it with every past row.
  assert.deepEqual(rows.map(r => r.id), ['490', '519', '523', '999'])
  assert.deepEqual(rows[2], { id: '523', date: '2026-12-20', location: 'Strzelin', name: 'STRZELIN MIERZY WYSOKO III BIEG NA WIEŻĘ RATUSZOWĄ' })
})

test('parseForm: title, classifications after the marker, regulamin from the button', () => {
  const f = parseForm(FORM_519, 'https://formularz.ultimasport.pl/519')
  assert.equal(f.title, 'VIII BIEG MIKOŁAJÓW W MIĘDZYBORZU, Międzybórz')
  assert.deepEqual(f.classifications, ['5 km', '10 km', 'Nordic Walking - 5 km'])
  assert.equal(f.regulaminUrl, 'https://formularz.ultimasport.pl/uploads/regulations/519_VIII.BM_Regulamin_za%C5%82.1%20(3).pdf')
  assert.equal(f.closed, false)
})

test('parseForm: a closed form, and a map PDF is never the regulamin', () => {
  const f = parseForm(FORM_CLOSED, 'https://formularz.ultimasport.pl/501')
  assert.equal(f.closed, true)
  assert.equal(f.regulaminUrl, null)
  assert.deepEqual(f.classifications, ['21 km'])
})

test('isRunningEvent: keeps races, drops cycling, swimming, ski, motor and walked events', () => {
  for (const name of [
    'VIII BIEG MIKOŁAJÓW W MIĘDZYBORZU', 'Patrol Graniczny 7', 'MARSZOBIEG TRZECH DZIELNIC',
    'Osjakowski Marsz Nordic Walking Edycja IV', 'KORONA GÓR SOWICH PIESZYCE UPHILL', 'Wojcieszowskie Święto Niepodległości na sportowo',
  ]) assert.equal(isRunningEvent({ name }), true, name)
  for (const name of [
    '3.Bardzka Rajza Górska', 'VIII Rajd Górski „Zimowa Wyrypa Gór Suchych', 'V MARSZ GÓRSKI KŁODZKIE SZLAKI',
    'X Maraton Pieszy Wojcieszów', 'MIEROSZOWSKA NOCNA TUŁACZKA GÓRSKA', 'XII SOWIGÓRSKI MARATON MTB BIELAWA',
    'XC KUDOWA 2025', 'IX TRIATHLON SOKOŁA', 'IV NOCNY MARATON PŁYWACKI', 'Konkursowy Bieg Narciarski - Stołowogórski Klasyk',
    'Bieg na Orientację', 'Rowerem na Śnieżkę 2026', 'Wrak Race Liniewo ED3', '3 Wyprawa Quad Adventure', 'IV BIEBRZAŃSKI ROLLER CUP',
  ]) assert.equal(isRunningEvent({ name }), false, name)
})

test('detectEventTypes: umbrella style, NW from a classification only when the name has no style', () => {
  assert.deepEqual(detectEventTypes('BIEG BORÓWKOWA TRAIL – GÓRSKA KURACJA', ['21 km', 'Nordic Walking 9 km']), ['trail'])
  assert.deepEqual(detectEventTypes('VIII BIEG MIKOŁAJÓW W MIĘDZYBORZU', ['5 km', 'Nordic Walking - 5 km']), ['nordic walking'])
  assert.deepEqual(detectEventTypes('OLEŚNICKI BIEG NIEPODLEGŁOŚCI', ['10 km']), [])
  assert.deepEqual(detectEventTypes('II Leśny Bieg Gminy Brzeźnio'), ['trail'])
  assert.deepEqual(detectEventTypes('VII Charytatywny Bieg Mikołajkowy dla Wałbrzyskiego Hospicjum'), ['charytatywny'])
})

test('hasKidsSignal', () => {
  assert.equal(hasKidsSignal('Bieg dla dzieci 400 m'), true)
  assert.equal(hasKidsSignal('Bieg Młodzieżowy - Sobótka'), true)
  assert.equal(hasKidsSignal('VIII Ząbkowicki Bieg Niepodległości 5KM 10KM'), false)
})

test('distanceFromLabel / distancesFrom', () => {
  assert.equal(distanceFromLabel('5KM'), '5 km')
  assert.equal(distanceFromLabel('Nordic Walking - 5 km'), '5 km')
  assert.equal(distanceFromLabel('1918 m'), '1.918 km')
  assert.equal(distanceFromLabel('400 m'), '400 m')
  assert.equal(distanceFromLabel('Bieg na Wieżę'), null)
  assert.equal(distancesFrom(['5 km', '10 km', 'Nordic Walking - 5 km']), '5 km, 10 km')
  assert.equal(distancesFrom(['Bieg', 'Nordic Walking']), null)
})

test('pageNamesEvent', () => {
  assert.equal(pageNamesEvent('VIII BIEG MIKOŁAJÓW W MIĘDZYBORZU, Międzybórz', 'VIII BIEG MIKOŁAJÓW W MIĘDZYBORZU'), true)
  assert.equal(pageNamesEvent('Zapisy na Puchar MTB, Bieruń', 'VIII BIEG MIKOŁAJÓW W MIĘDZYBORZU'), false)
  assert.equal(pageNamesEvent('', 'Bieg Jeża'), false)
})

test('buildRow: the form page is the registration URL and the source URL', () => {
  const [event] = parseListing(LISTING).filter(r => r.id === '519')
  const r = buildRow(event, parseForm(FORM_519, 'https://formularz.ultimasport.pl/519'))
  assert.equal(r.source, 'ultimasport')
  assert.equal(r.source_id, '519')
  assert.equal(r.registration_url, 'https://formularz.ultimasport.pl/519')
  assert.equal(r.source_url, 'https://formularz.ultimasport.pl/519')
  assert.equal(r.date, '2026-12-06')
  assert.equal(r.location, 'Międzybórz')
  assert.equal(r.distances, '5 km, 10 km')
  assert.deepEqual(r.event_types, ['nordic walking'])
  assert.equal(r.is_kids, false)
  assert.equal(r.price_from, null)
})
