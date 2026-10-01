import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as cheerio from 'cheerio'
import { scrape, parseTournamentPage } from '../src/scrapers/sources/maratonczykpomiarczasu.js'

// Three rows on https://www.maratonczykpomiarczasu.pl/wydarzenia-biegowe carry
// the same sign-up link: Liga Centrum Nordic Walking Pabianice (2026-10-03),
// Liga Centrum Nordic Walking Bełchatów (2026-10-17) and Liga Zachodu Nordic
// Walking Kostrzyn (2026-10-24). The link is Bełchatów's. It is the only
// repeated link among the 43 distinct sign-up links on that listing.
//
// The scraper stored it on all three, and read all three regulamin PDFs off
// Bełchatów's page, so Pabianice and Kostrzyn published Bełchatów's registration
// URL, Bełchatów's website and belchatow-...-rules.pdf as their own rules. The
// same page carries the price ladder and the registration close, which the
// scraper fetched and never read, so Bełchatów published price_from and
// registration_deadline null.
//
// Markup below is copied from those pages, sampled 2026-10-01.

const ONWF = 'https://poland.nordicwalkingworldleague.com/pl/tournaments'
const BELCHATOW_URL = `${ONWF}/belchatow-nordic-walking-european-championships-poland-2026`
const PANEL_URL = 'https://panel.maratonczykpomiarczasu.pl/bieg-zmecha'

const row = ({ slug, name, date, city, regUrl }) => `<tr>
  <td class="views-field views-field-title"><a href="/content/${slug}">${name}</a></td>
  <td class="views-field views-field-field-event-date"><span content="${date}T10:00:00+02:00">x</span></td>
  <td class="views-field views-field-field-event-city">${city}</td>
  <td class="views-field views-field-field-event-province">Łódzkie</td>
  <td class="views-field views-field-field-dystans-biegu">10 km, 5 km</td>
  <td class="views-field views-field-field-link-do-zapisow"><a href="${regUrl}">Odnośnik</a></td>
  <td class="views-field views-field-field-link-do-listy-startowej"><a href="${regUrl}">Odnośnik</a></td>
  <td class="views-field views-field-field-link-do-strony-biegu"><a href="${regUrl}">Odnośnik</a></td>
</tr>`

const LISTING = `<html><body><table>
${row({ slug: 'liga-centrum-nordic-walking-pabianice', name: 'Liga Centrum Nordic Walking Pabianice', date: '2026-10-03', city: 'Pabianice', regUrl: BELCHATOW_URL })}
${row({ slug: 'liga-centrum-nordic-walking-bełchatów-1', name: 'Liga Centrum Nordic Walking Bełchatów', date: '2026-10-17', city: 'Bełchatów', regUrl: BELCHATOW_URL })}
${row({ slug: 'liga-zachodu-nordic-walking-kostrzyn-1', name: 'Liga Zachodu Nordic Walking Kostrzyn', date: '2026-10-24', city: 'Kostrzyn', regUrl: BELCHATOW_URL })}
${row({ slug: 'bieg-zmecha-2026', name: 'BIEG ZMECHA i NORDIC WALKING 2026', date: '2026-10-03', city: 'Zmysłowo', regUrl: PANEL_URL })}
</table></body></html>`

const collapseRow = (left, right) => `<div class="row collapse-data">
  <div class="col-12 col-lg-3"><p>${left}</p></div>
  <div class="col-12 col-lg-9 collapse-data-right"><p>${right}</p></div>
</div>`

const tournamentPage = ({ title, tiers, close = '16.08.2026 23:59' }) => `<html>
<head><title>${title}</title></head><body>
  ${collapseRow('Otwarcie rejestracji', '12.01.2026 10:00')}
  ${collapseRow('Zamknięcie rejestracji', close)}
  <div class="col-12 nopad"><div class="price-area" id="clock"></div></div>
  <a href="#" class="small-button-collapse">Cennik</a>
  <div class="collapse" id="collapse2">
    ${tiers.map((t, i) => collapseRow(`${100 + i}/${100 + i}`, t)).join('\n')}
  </div>
  <a href="/uploads/event/5/belchatow-nordic-walking-european-championships-poland-2026-rules.pdf">Regulamin</a>
  <a href="/uploads/information/poland_pl/regulamin-sedziowania.pdf">Regulamin Sędziowania</a>
  <a href="/uploads/information/poland_pl/polityka-prywatnosci.pdf">Polityka Prywatności</a>
</body></html>`

const BELCHATOW_TIERS = [
  'Nordic Walking 5 km - 85 PLN',
  'Nordic Walking 5 km - 165 PLN',
  'Nordic Walking 5 km - 215 PLN',
  'Nordic Walking 20km - w biurze zawodów - 270 PLN',
  'NW 5 km dzieci do 18 r.ż./ children to 18 y. - 65 PLN',
  'Przewodnik/ Guide for persons with disabilities - 130 PLN',
]

const BELCHATOW_PAGE = tournamentPage({
  title: 'Bełchatów, Nordic Walking European Championships, Poland 2026 - Rejestracja - ONWF',
  tiers: BELCHATOW_TIERS,
})

const PANEL_PAGE = '<html><head><title>BIEG ZMECHA i NORDIC WALKING 2026</title></head><body><p>80 zł</p></body></html>'

function stubFetch() {
  const original = globalThis.fetch
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url)
    if (opts.method === 'HEAD') {
      return { ok: true, status: 200, headers: { get: () => 'application/pdf' } }
    }
    if (u.startsWith(BELCHATOW_URL)) return { ok: true, status: 200, text: async () => BELCHATOW_PAGE }
    if (u.startsWith(PANEL_URL)) return { ok: true, status: 200, text: async () => PANEL_PAGE }
    if (u.includes('wydarzenia-biegowe')) return { ok: true, status: 200, text: async () => LISTING }
    return { ok: false, status: 404, text: async () => '' }
  }
  return { restore: () => { globalThis.fetch = original } }
}

const byId = (rows, id) => rows.find(r => r.source_id === id)

test('a sign-up link repeated across rows is kept only by the event its page names', async () => {
  const stub = stubFetch()
  try {
    const rows = await scrape()

    const belchatow = byId(rows, 'liga-centrum-nordic-walking-bełchatów-1')
    assert.equal(belchatow.registration_url, BELCHATOW_URL)
    assert.match(belchatow.regulamin_url, /belchatow-nordic-walking-european-championships-poland-2026-rules\.pdf$/)

    // The page sells Bełchatów entries. It is not these two events' page.
    for (const id of ['liga-centrum-nordic-walking-pabianice', 'liga-zachodu-nordic-walking-kostrzyn-1']) {
      const ev = byId(rows, id)
      assert.equal(ev.registration_url, null, `${id} must not keep another event's sign-up link`)
      assert.equal(ev.website, null, `${id} must not keep another event's website`)
      assert.equal(ev.regulamin_url, undefined, `${id} must not keep another event's regulamin`)
      assert.equal(ev.price_from, undefined, `${id} must not keep another event's price`)
    }
  } finally {
    stub.restore()
  }
})

test('price and registration close are read off the page already fetched for the regulamin', async () => {
  const stub = stubFetch()
  try {
    const rows = await scrape()
    const belchatow = byId(rows, 'liga-centrum-nordic-walking-bełchatów-1')
    assert.equal(belchatow.price_from, 85)
    assert.equal(belchatow.price_to, 270)
    assert.equal(belchatow.registration_deadline, '2026-08-16')
  } finally {
    stub.restore()
  }
})

test('a link used by one row only is never questioned', async () => {
  // panel.maratonczykpomiarczasu.pl pages do not name the city in their title.
  // Only a repeated link has to prove ownership, so this row keeps its link.
  const stub = stubFetch()
  try {
    const rows = await scrape()
    const zmecha = byId(rows, 'bieg-zmecha-2026')
    assert.equal(zmecha.registration_url, PANEL_URL)
  } finally {
    stub.restore()
  }
})

const parse = (html, opts) => parseTournamentPage(cheerio.load(html), opts)

test('an add-on on the price ladder is not an entry fee', () => {
  // Kostrzyn sells "posiłek dla kibica - 30 PLN" next to its entries. Its real
  // entry fees run 65 to 110.
  const got = parse(tournamentPage({
    title: 'Kostrzyn, Poland 2026 - Rejestracja - ONWF',
    tiers: [
      '5 KM Nordic Walking - 65 PLN',
      '10 KM Nordic Walking - 110 PLN',
      'posiłek dla kibica - 30 PLN',
    ],
  }))
  assert.equal(got.price_from, 65)
  assert.equal(got.price_to, 110)
})

test('a kids tier does not set price_from for an adults event', () => {
  const got = parse(tournamentPage({ title: 'Bełchatów - ONWF', tiers: BELCHATOW_TIERS }), { isKids: false })
  assert.equal(got.price_from, 85)
})

test('a disabled-entrant tier does not set price_from', () => {
  // Pabianice sells 5 km at 65 PLN and the same 5 km at 55 PLN to disabled
  // entrants. 55 is not a fee a reader of the calendar can pay.
  const got = parse(tournamentPage({
    title: 'Pabianice, Poland 2026 - Rejestracja - ONWF',
    tiers: [
      '5 KM Nordic Walking - 65 PLN',
      '5 KM Nordic Walking - 110 PLN',
      'Nordic Walking 5 km osoby niepełnosprawne - 55 PLN',
    ],
  }))
  assert.equal(got.price_from, 65)
  assert.equal(got.price_to, 110)
})

test('a kids event keeps its kids tiers', () => {
  const got = parse(tournamentPage({
    title: 'Pabianice, Poland 2026 - Rejestracja - ONWF',
    tiers: ['Nordic Walking 5 km dzieci i młodzież do 18 r.ż. - 45 PLN', 'Nordic Walking 5 km dzieci i młodzież do 18 r.ż. - 100 PLN'],
  }), { isKids: true })
  assert.equal(got.price_from, 45)
  assert.equal(got.price_to, 100)
})

test('a page with no price ladder reports no price, not zero', () => {
  const got = parse(tournamentPage({ title: 'Pabianice - ONWF', tiers: [] }))
  assert.equal(got.price_from, null)
  assert.equal(got.price_to, null)
  assert.equal(got.registration_deadline, '2026-08-16')
})

test('an unreadable close date is dropped', () => {
  const got = parse(tournamentPage({ title: 'Pabianice - ONWF', tiers: [], close: '32.08.2026 23:59' }))
  assert.equal(got.registration_deadline, null)
})
