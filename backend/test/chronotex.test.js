import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseListing, parseDetail, parseDistances, parseFees, parseDeadline, buildRow, detectEventTypes,
} from '../src/scrapers/sources/chronotex.js'

// Rows of https://chronotex.pl/zawody/ as served on 2026-10-28.
const LISTING = `<table><tbody><tr><td>&nbsp;Data</td><td>&nbsp;Nazwa zawodów</td><td>&nbsp;Miejsce</td></tr></tbody>
<tbody><tr><td class="t-border">&nbsp;2026-11-11</td><td class="t-border"><a href="../opis-zawodow/?id_zawodow=1364"><b>&nbsp;<font color=gren>8 KNUROWSKI BIEG NIEPODLEGŁOŚCI</font></b></a></td><td>&nbsp;Knurów</td></tr></tbody>
<tbody><tr><td class="t-border">&nbsp;2026-11-11</td><td class="t-border"><a href="../opis-zawodow/?id_zawodow=1346"><b>&nbsp;<font color=gren>XXXIV BIEG NIEPODLEGŁOŚCI</font><br>SKIERNIEWICKA TRIADA BIEGOWA</b></a></td><td>&nbsp;Skierniewice</td></tr></tbody>
<tbody><tr><td class="t-border">&nbsp;2026-11-14</td><td class="t-border"><a href="../opis-zawodow/?id_zawodow=1398"><b>&nbsp;<font color=gren>BIEG OBROŃCÓW MODLINA</font></b></a></td><td>&nbsp;Modlin</td></tr></tbody>
<tbody><tr><td class="t-border">&nbsp;2026-11-14</td><td class="t-border"><a href="../opis-zawodow/?id_zawodow=1405"><b>&nbsp;<font color=gren>BIEG OBROŃCÓW MODLINA</font><br>BIEGI MŁODZIEŻOWE</b></a></td><td>&nbsp;Modlin</td></tr></tbody></table>`

// The info table of /opis-zawodow/?id_zawodow=1398, participant list left out.
const DETAIL_OPEN = `<table><tr>
<td class="b-par"><b>Nazwa zawodów: </td><td class="b-war"><h3>BIEG OBROŃCÓW MODLINA</h3></td></tr><tr>
<td class="b-par"><b>Miejsce i termin: </td><td class="b-war">Modlin, 2026-11-14</td></tr><tr>
<td class="b-par"><b>Opis zawodów: </td><td class="b-war">W ramach zawodów odbędą się biegi na 5 km i 10 km, marsz NW 5 km,<br />STAT/META i biuro zawodów Twierdza Modlin, ul. Baśki Murmańskiej 164<br />Warunkiem udziału w zawodach jest ukończone 16 lat.</td></tr><tr>
<td class="b-par"><b>Wpisowe i wpłata: </td><td class="b-war">Zapisy i płatności przez stronę do 9.11.2026, wysokość wpisowego;<br />- 65 zł pierwsze 100 osób<br />- 70 zł kolejne 100 osób<br />- 80 zł w biurze zawodów w miarę dostępności pakietów<br />- 70 zł marsz NW</td></tr><tr>
<td class="b-par"><b>Limit zawodników: </td><td class="b-war">400</td></tr><tr>
<td class="b-par"><b>Regulamin zawodów: </td><td class="b-war"><a href="../upload/1790803326.pdf" target="_blank">PDF</a></td></tr><tr>
<td class="b-par"><b>Lista opłaconych:</td><td class="b-war"><a href="https://chronotex.pl/lista-oplaconych/?id_zawodow=1398 ">Zawodnicy z potwierdzoną płatnością</a></td></tr>
</table>	<a href="https://chronotex.pl/rejestracja/?id_zawodow=1398"><input type="button" name="przycisk" value="Zarejestruj się"></a>`

// 1364 after the field filled up: no registration button, a second regulamin row.
const DETAIL_CLOSED = `<table><tr>
<td class="b-par"><b>Opis zawodów: </td><td class="b-war">Bieg na dystansie 5 km ulicami Knurowa<br />START/META przy Hali Sportowej MOSiR Knurów, Al. Lipowa 12A</td></tr><tr>
<td class="b-par"><b>Wpisowe i wpłata: </td><td class="b-war">Zapisy i płatności przez stronę zapisów do 3.11.2026 lub do wyczerpania limitu, wysokość wpisowego 50 zł</td></tr><tr>
<td class="b-par"><b>Regulamin zawodów: </td><td class="b-war"><a href="../upload/1790155084.pdf" target="_blank">PDF</a></td></tr><tr>
<td class="b-par"><b>Regulamin GRAND PRIX Knurowa: </td><td class="b-war"><a href="../upload/1790160323.pdf" target="_blank">PDF</a></td></tr><tr>
<td class="b-par"><b>Strona WWW: </td><td class="b-war"><a href="https://www.facebook.com/mosirknurow">www</a></td></tr>
</table>	<b>Rejestracja zakończona - osiągnięto limit zawodników</b>`

test('listing rows carry id, ISO date, name and town', () => {
  const [knurow] = parseListing(LISTING)
  assert.deepEqual(knurow, { id: '1364', date: '2026-11-11', name: '8 KNUROWSKI BIEG NIEPODLEGŁOŚCI', location: 'Knurów' })
})

test('a series subtitle is dropped from the name', () => {
  const rows = parseListing(LISTING)
  assert.equal(rows.find(r => r.id === '1346').name, 'XXXIV BIEG NIEPODLEGŁOŚCI')
})

test('a kids subtitle keeps the youth races apart from the main race', () => {
  // Same first line, date and town as 1398: without the subtitle the merge folds them together.
  const rows = parseListing(LISTING)
  assert.equal(rows.find(r => r.id === '1398').name, 'BIEG OBROŃCÓW MODLINA')
  assert.equal(rows.find(r => r.id === '1405').name, 'BIEG OBROŃCÓW MODLINA - BIEGI MŁODZIEŻOWE')
})

test('the header row is not an event', () => {
  assert.equal(parseListing(LISTING).length, 4)
})

test('the "Zarejestruj się" button is the registration url', () => {
  assert.equal(parseDetail(DETAIL_OPEN, '1398').registrationUrl, 'https://chronotex.pl/rejestracja/?id_zawodow=1398')
})

test('with registration closed the detail page is the registration url', () => {
  assert.equal(parseDetail(DETAIL_CLOSED, '1364').registrationUrl, 'https://chronotex.pl/opis-zawodow/?id_zawodow=1364')
})

test('the regulamin comes from the "Regulamin zawodów" row, resolved to an absolute url', () => {
  assert.equal(parseDetail(DETAIL_OPEN, '1398').regulaminUrl, 'https://chronotex.pl/upload/1790803326.pdf')
})

test('a series regulamin row is never taken for the race regulamin', () => {
  assert.equal(parseDetail(DETAIL_CLOSED, '1364').regulaminUrl, 'https://chronotex.pl/upload/1790155084.pdf')
})

test('the declared "Strona WWW" is the website, Facebook included', () => {
  assert.equal(parseDetail(DETAIL_CLOSED, '1364').website, 'https://www.facebook.com/mosirknurow')
  assert.equal(parseDetail(DETAIL_OPEN, '1398').website, null)
})

test('fees and the online deadline come from the fee cell', () => {
  const d = parseDetail(DETAIL_OPEN, '1398')
  assert.equal(d.priceFrom, 65)
  assert.equal(d.priceTo, 80)
  assert.equal(d.deadline, '2026-11-09')
})

test('distances come from the description, street numbers ignored', () => {
  assert.equal(parseDetail(DETAIL_OPEN, '1398').distances, '5 km, 10 km')
  assert.equal(parseDetail(DETAIL_CLOSED, '1364').distances, '5 km')
})

test('decimal comma and metres are normalised', () => {
  assert.equal(parseDistances('Bieg na dystansie 21,0975km, trasa: drogi leśne'), '21.0975 km')
  assert.equal(parseDistances('Bieg OPEN na dystansie 5000 m / Marsz Nordic Walking 2200 m'), '5 km, 2.2 km')
  assert.equal(parseDistances('Rocznik 2010 i młodsze.'), null)
})

test('a fee cell with no amount gives no price', () => {
  assert.deepEqual(parseFees('Zgłoszenia przez system STARTER PZLA'), { priceFrom: null, priceTo: null })
  assert.equal(parseDeadline('Zgłoszenia przez system STARTER PZLA'), null)
})

test('the first "do D.M.YYYY" is the deadline, a later price tier is not', () => {
  assert.equal(parseDeadline('Zapisy przez stronę do 30.11.2026, wysokość wpisowego; - 50 zł do 30.09.2026'), '2026-11-30')
})

test('style comes from the race name only', () => {
  assert.deepEqual(detectEventTypes('VIII PORANKOWY PÓŁMARATON LEŚNY'), ['trail'])
  assert.deepEqual(detectEventTypes('IV OTWARTE MISTRZOSTWA NOWEGO WIŚNICZA W BIEGACH PRZEŁAJOWYCH'), ['trail'])
  assert.deepEqual(detectEventTypes('XII CHARYTATYWNY BIEG NIEPODLEGŁOŚCI'), ['charytatywny'])
  assert.deepEqual(detectEventTypes('8 KNUROWSKI BIEG NIEPODLEGŁOŚCI'), [])
})

test('a row is built from the listing entry and its detail page', () => {
  const [knurow] = parseListing(LISTING)
  const row = buildRow(knurow, parseDetail(DETAIL_CLOSED, '1364'))
  assert.equal(row.source, 'chronotex')
  assert.equal(row.source_id, '1364')
  assert.equal(row.source_url, 'https://chronotex.pl/opis-zawodow/?id_zawodow=1364')
  assert.equal(row.is_kids, false)
  assert.equal(row.price_from, 50)
  assert.equal(row.registration_deadline, '2026-11-03')
})

test('kids races named in the description set is_kids', () => {
  const html = DETAIL_CLOSED.replace('Bieg na dystansie 5 km', 'Bieg na dystansie 5 km. Dodatkowo odbędą się biegi dzieci wg kategorii wiekowych')
  const [knurow] = parseListing(LISTING)
  assert.equal(buildRow(knurow, parseDetail(html, '1364')).is_kids, true)
})
