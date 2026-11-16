import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as cheerio from 'cheerio'
import { scrape, parseTournamentPage, parsePanelDistances } from '../src/scrapers/sources/maratonczykpomiarczasu.js'

// 8. Mikołajkowy Bieg Rodzinny – Słubice 2026 (2026-12-05). The listing row on
// https://www.maratonczykpomiarczasu.pl/wydarzenia-biegowe has an empty distance
// cell. The panel page https://panel.maratonczykpomiarczasu.pl/rodzinny-bieg-mikolajkowy
// is a custom 'mk26' layout with no .row.collapse-data pairs. It states distance,
// price and registration close only in tiles. The scraper published all three
// as null. Markup below is copied from that page, sampled 2026-11-16.

const PANEL_URL = 'https://panel.maratonczykpomiarczasu.pl/rodzinny-bieg-mikolajkowy'

const PANEL_HTML = `<html><head><title>8. Mikołajkowy Bieg Rodzinny – Słubice 2026 | Panel Maratończyk Pomiar Czasu</title></head><body>
<div class="mk26">
<section class="hero">
<div class="eyebrow">5 GRUDNIA 2026 · SŁUBICE · START 15:00</div>
<h2>8. MIKOŁAJKOWY<br />BIEG RODZINNY</h2>
<div class="grid">
<div class="tile"><span class="big">2026 M</span>3 okrążenia wokół Placu Bohaterów</div>
<div class="tile"><span class="big">100 RODZIN</span>Limit zgłoszeń (do 200 osób)</div>
<div class="tile"><span class="big">BEZPŁATNIE</span>Udział w biegu jest bezpłatny</div>
</div>
</section>
<div class="grid">
<div class="tile info t-cal"><span class="big">DO 1 GRUDNIA</span>Zapisy online do 1.12.2026 (wtorek), godz. 23:59. Później tylko w biurze zawodów – maks. 20 rodzin, do limitu 100.</div>
<div class="tile info t-bag"><span class="big">W PAKIECIE</span>Numer startowy dla rodziny, gadżet niespodzianka od Mikołaja z logo „wspólnej marki” i woda na trasę.</div>
<div class="tile info t-clock"><span class="big">BIURO 13:00–14:30</span>Plac Bohaterów: weryfikacja zgłoszeń, dodatkowe zapisy i pakiety.<br />Start biegu: 15:00.</div>
</div>
<div class="grid actions"><a href="/rodzinny-bieg-mikolajkowy/lista"><strong>≡ LISTA STARTOWA</strong></a><a href="/sites/default/files/regulamin/Regulamin_8_Mikolajkowy_Bieg_Rodzinny_Slubice_2026.pdf"><strong>↓ REGULAMIN PDF</strong>Zasady udziału w biegu</a></div>
</div></body></html>`

const LISTING = `<html><body><table><tr>
  <td class="views-field views-field-title"><a href="/content/8-miko%C5%82ajkowy-bieg-rodzinny-%E2%80%93-s%C5%82ubice-2026">8. Mikołajkowy Bieg Rodzinny – Słubice 2026</a></td>
  <td class="views-field views-field-field-event-date"><span content="2026-12-05T15:00:00+01:00">5 gru 2026 - 15:00</span></td>
  <td class="views-field views-field-field-event-city">Słubice</td>
  <td class="views-field views-field-field-event-province">Lubuskie</td>
  <td class="views-field views-field-field-dystans-biegu"></td>
  <td class="views-field views-field-field-link-do-zapisow"><a href="${PANEL_URL}">Odnośnik</a></td>
  <td class="views-field views-field-field-link-do-strony-biegu"></td>
</tr></table></body></html>`

function stubFetch() {
  const original = globalThis.fetch
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url)
    if (opts.method === 'HEAD') {
      return { ok: true, status: 200, headers: { get: () => (u.endsWith('.pdf') ? 'application/pdf' : 'text/html') } }
    }
    if (u === PANEL_URL) return { ok: true, status: 200, text: async () => PANEL_HTML }
    if (u.includes('wydarzenia-biegowe')) return { ok: true, status: 200, text: async () => LISTING }
    return { ok: false, status: 404, text: async () => '' }
  }
  return () => { globalThis.fetch = original }
}

test('a panel page that states distance, price and close only in tiles fills all three', async () => {
  const restore = stubFetch()
  try {
    const [ev] = await scrape()
    assert.equal(ev.source_id, '8-mikołajkowy-bieg-rodzinny-–-słubice-2026')
    assert.equal(ev.distances, '2026 m')
    assert.equal(ev.price_from, 0)
    assert.equal(ev.price_to, 0)
    assert.equal(ev.registration_deadline, '2026-12-01')
  } finally {
    restore()
  }
})

const parse = (html, opts) => parseTournamentPage(cheerio.load(html), opts)
const tile = (big, text) => `<div class="tile"><span class="big">${big}</span>${text}</div>`

test('free parking or a free kids run does not make the race free', () => {
  assert.equal(parse(`<html><body>${tile('PARKING', 'Bezpłatny parking przy starcie')}</body></html>`).price_from, null)
  assert.equal(parse(`<html><body>${tile('PAKIET', 'Pakiet startowy bezpłatny dla każdego')}</body></html>`).price_from, null)
  assert.equal(parse(`<html><body>${tile('PARKING', 'Bezpłatny parking. Start biegu: 15:00')}</body></html>`).price_from, null)
  assert.equal(parse(`<html><body>${tile('DZIECI', 'Udział dla dzieci bezpłatnie')}</body></html>`).price_from, null)
  assert.equal(parse(`<html><body><p>Zapewniamy bezpłatną wodę.</p></body></html>`).price_from, null)
})

test('a single-digit day in the close date is read and zero-padded', () => {
  assert.equal(parse(`<html><body><p>Zapisy online do 1.2.2027, godz. 23:59</p></body></html>`).registration_deadline, '2027-02-01')
})

test('a tile number that is not a distance is not read as one', () => {
  const $ = cheerio.load(`<html><body>${tile('100 RODZIN', 'Limit')}${tile('BIURO 13:00–14:30', 'x')}</body></html>`)
  assert.equal(parsePanelDistances($), null)
  assert.equal(parsePanelDistances(cheerio.load(`<html><body>${tile('5,5 KM', 'trasa')}</body></html>`)), '5.5 km')
})
