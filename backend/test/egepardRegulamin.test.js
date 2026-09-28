import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDetail } from '../src/scrapers/sources/egepard.js'

// egepard published 5 rows with no regulamin_url. Two shapes caused it, and
// parseDetail only ever looked for one thing: an external link ending in .pdf.
//
// Shape A — BIEG PAŹDZIERNIKOWY 2026 - GMINA ŁUBIANKA (2026-10-11,
// egepard:1698). The Opis cell links the regulamin as an HTML page whose anchor
// text says REGULAMIN. The .pdf-only rule skipped it, so scraper_all got no
// regulamin_url, and with no URL to crawl the enricher never found the fee
// either — price_from and price_to are both null although the linked page says
// "Wysokość opłaty ... 25 zł".
//
// Shape B — Bieg Nipodległości (2026-11-15, egepard:1700). The organizer wrote
// the whole regulamin as prose inside the Opis cell. There is no link at all,
// so nothing could match, yet the rules document sits on the page the scraper
// already fetched and already stores as registration_url / source_url.
//
// Markup below is copied from https://www.e-gepard.eu/pl/show-contest/<id> on
// 2026-09-28.

const DETAIL_1698 = `<html><body><div id="basic"><table>
  <tr><th>Miejsce</th><td>Bierzgłowo</td></tr>
  <tr><th>Organizator</th><td>Biblioteka - Centrum Kultury w Łubiance</td></tr>
  <tr><th>Data zawodów</th><td>2026-10-11</td></tr>
  <tr><th>Opis</th><td>
    <h2><strong>Bieg Wrześniowy jest II biegiem z cyklu Łubianka Grand Prix Cross 2026/2027.</strong></h2>
    <h2><strong>11.10.2026 r. (NIEDZIELA)</strong></h2>
    <h2>Miejsce - Bierzgłowo START - godz. 11:00</h2>
    <h2><a href="http://gpclubianka.pl/"><strong>STRONA INTERNETOWA Łubianka Grand Prix Cross</strong></a></h2>
    <h2><a href="http://gpclubianka.pl/ogolny/"><strong>REGULAMIN Łubianka Grand Prix Cross 2026/2027</strong></a></h2>
  </td></tr>
</table></div></body></html>`

// Shape B, abbreviated: the real cell runs 9179 characters over sections I-XIII.
const DEBNO_SECTIONS = [
  'I. CELE I ZAŁOŻENIA BIEGU', 'II. ORGANIZATOR', 'III. Termin i miejsce',
  'IV. TRASA', 'V. UCZESTNICTWO', 'VI. ZGŁOSZENIA', 'VII. OPŁATA STARTOWA',
  'VIII. KLASYFIKACJE', 'IX. NAGRODY', 'X. POMIAR CZASU', 'XI. OCHRONA DANYCH',
  'XII. POSTANOWIENIA KOŃCOWE', 'XIII. FINANSOWANIE',
].map((h) => `<p><strong>${h}</strong></p><p>${'Treść regulaminu biegu. '.repeat(30)}</p>`).join('')

const DETAIL_1700 = `<html><body><div id="basic"><table>
  <tr><th>Miejsce</th><td>Dębno</td></tr>
  <tr><th>Data zawodów</th><td>2026-11-15</td></tr>
  <tr><th>Opis</th><td>
    <h2><strong>REGULAMIN BIEG NIEPODLEGŁOŚCI DĘBNO 2026</strong></h2>
    ${DEBNO_SECTIONS}
    <p>Opłata startowa wynosi 79 zł.</p>
  </td></tr>
</table></div></body></html>`

const URL_1698 = 'https://www.e-gepard.eu/pl/show-contest/1698'
const URL_1700 = 'https://www.e-gepard.eu/pl/show-contest/1700'

test('egepard: an HTML regulamin link in the Opis cell is kept', () => {
  const { regulamin } = parseDetail(DETAIL_1698, '2026-10-11', URL_1698)
  assert.equal(regulamin, 'http://gpclubianka.pl/ogolny/')
})

test('egepard: the bare organizer homepage is not the regulamin', () => {
  const html = DETAIL_1698.replace(
    '<h2><a href="http://gpclubianka.pl/ogolny/"><strong>REGULAMIN Łubianka Grand Prix Cross 2026/2027</strong></a></h2>',
    '',
  )
  const { regulamin } = parseDetail(html, '2026-10-11', URL_1698)
  assert.equal(regulamin, null)
})

test('egepard: a RODO clause is not promoted to regulamin', () => {
  const html = DETAIL_1698.replace(
    '<h2><a href="http://gpclubianka.pl/ogolny/"><strong>REGULAMIN Łubianka Grand Prix Cross 2026/2027</strong></a></h2>',
    '<h2><a href="http://gpclubianka.pl/rodo/"><strong>Klauzula RODO</strong></a></h2>',
  )
  const { regulamin } = parseDetail(html, '2026-10-11', URL_1698)
  assert.equal(regulamin, null)
})

test('egepard: a PDF regulamin still wins over an HTML one', () => {
  const html = DETAIL_1698.replace(
    '</table></div>',
    '<tr><th>x</th><td></td></tr></table></div>',
  ).replace(
    '<h2>Miejsce - Bierzgłowo START - godz. 11:00</h2>',
    '<h2><a href="http://gpclubianka.pl/regulamin_2026.pdf">Pobierz</a></h2>',
  )
  const { regulamin } = parseDetail(html, '2026-10-11', URL_1698)
  assert.equal(regulamin, 'http://gpclubianka.pl/regulamin_2026.pdf')
})

test('egepard: an e-gepard self-link is never the regulamin', () => {
  const html = DETAIL_1698.replace(
    'http://gpclubianka.pl/ogolny/',
    'https://www.e-gepard.eu/pl/regulamin',
  )
  const { regulamin } = parseDetail(html, '2026-10-11', URL_1698)
  assert.equal(regulamin, null)
})

test('egepard: an inline regulamin points at the page that carries it', () => {
  const { regulamin } = parseDetail(DETAIL_1700, '2026-11-15', URL_1700)
  assert.equal(regulamin, URL_1700)
})

test('egepard: a short Opis that merely mentions a regulamin is not one', () => {
  const html = `<html><body><div id="basic"><table>
    <tr><th>Miejsce</th><td>Dębno</td></tr>
    <tr><th>Opis</th><td><p>Regulamin biegu zostanie opublikowany wkrótce.</p></td></tr>
  </table></div></body></html>`
  const { regulamin } = parseDetail(html, '2026-11-15', URL_1700)
  assert.equal(regulamin, null)
})

test('egepard: a long Opis that is not a regulamin stays null', () => {
  const html = DETAIL_1700.replace(
    '<h2><strong>REGULAMIN BIEG NIEPODLEGŁOŚCI DĘBNO 2026</strong></h2>',
    '<h2><strong>ZAPRASZAMY NA BIEG NIEPODLEGŁOŚCI DĘBNO 2026</strong></h2>',
  )
  const { regulamin } = parseDetail(html, '2026-11-15', URL_1700)
  assert.equal(regulamin, null)
})

test('egepard: the rest of the detail parse is unchanged', () => {
  const { city } = parseDetail(DETAIL_1698, '2026-10-11', URL_1698)
  assert.equal(city, 'Bierzgłowo')
})
