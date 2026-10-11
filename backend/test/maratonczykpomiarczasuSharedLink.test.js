import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as cheerio from 'cheerio'
import { scrape, parseTournamentPage, titleNamesCity } from '../src/scrapers/sources/maratonczykpomiarczasu.js'

// Three rows on https://www.maratonczykpomiarczasu.pl/wydarzenia-biegowe carry
// the same sign-up link: Liga Centrum Nordic Walking Pabianice (2026-10-03),
// Liga Centrum Nordic Walking Bełchatów (2026-10-17) and Liga Zachodu Nordic
// Walking Kostrzyn (2026-10-24). The link is Bełchatów's. It is the only link
// shared by more than one row among the 41 rows on that listing.
//
// The scraper stored it on all three and read all three regulamin PDFs off
// Bełchatów's page, so Pabianice and Kostrzyn published Bełchatów's registration
// URL and belchatow-...-rules.pdf as their own rules. The same page carries the
// price ladder and the registration close, which the scraper fetched and never
// read, so all three published price_from and registration_deadline null.
//
// Pabianice and Kostrzyn do each have their own ONWF page; the listing simply
// does not link it. ONWF's event search finds them by city, and the row it
// returns carries the date, so the match can be checked rather than guessed.
//
// Markup below is copied from those pages, sampled 2026-10-01.

const ONWF = 'https://poland.nordicwalkingworldleague.com/pl/tournaments'
const ONWF_SEARCH = 'https://poland.nordicwalkingworldleague.com/pl/tournaments/list/getEvents'
const BELCHATOW_URL = `${ONWF}/belchatow-nordic-walking-european-championships-poland-2026`
const PABIANICE_URL = `${ONWF}/pabianice-2026`
const KOSTRZYN_URL = `${ONWF}/kostrzyn-poland-2026`
const PANEL_URL = 'https://panel.maratonczykpomiarczasu.pl/bieg-zmecha'
const PANEL_DUO_URL = 'https://panel.maratonczykpomiarczasu.pl/bieg-dwudniowy'
const HUB_URL = `${ONWF}/liga-centrum-2026`

const row = ({ slug, name, date, city, voivodeship = 'Łódzkie', regUrl, website = regUrl }) => `<tr>
  <td class="views-field views-field-title"><a href="/content/${slug}">${name}</a></td>
  <td class="views-field views-field-field-event-date"><span content="${date}T10:00:00+02:00">x</span></td>
  <td class="views-field views-field-field-event-city">${city}</td>
  <td class="views-field views-field-field-event-province">${voivodeship}</td>
  <td class="views-field views-field-field-dystans-biegu">10 km, 5 km</td>
  <td class="views-field views-field-field-link-do-zapisow"><a href="${regUrl}">Odnośnik</a></td>
  <td class="views-field views-field-field-link-do-listy-startowej"><a href="${regUrl}">Odnośnik</a></td>
  <td class="views-field views-field-field-link-do-strony-biegu"><a href="${website}">Odnośnik</a></td>
</tr>`

const listing = rows => `<html><body><table>${rows.join('\n')}</table></body></html>`

const collapseRow = (left, right) => `<div class="row collapse-data">
  <div class="col-12 col-lg-3"><p>${left}</p></div>
  <div class="col-12 col-lg-9 collapse-data-right"><p>${right}</p></div>
</div>`

const tournamentPage = ({ title, tiers, close = '16.08.2026 23:59', rulesPdf = 'belchatow-nordic-walking-european-championships-poland-2026-rules' }) => `<html>
<head><title>${title}</title></head><body>
  ${collapseRow('Otwarcie rejestracji', '12.01.2026 10:00')}
  ${collapseRow('Zamknięcie rejestracji', close)}
  <div class="collapse" id="collapse2">
    ${tiers.map((t, i) => collapseRow(`${100 + i}/${100 + i}`, t)).join('\n')}
  </div>
  <a href="/uploads/event/5/${rulesPdf}.pdf">Regulamin</a>
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

// Pabianice and Kostrzyn publish the same ladder: 65 at the opening rate,
// 110 on race day, with an add-on and two concession tiers alongside.
const LEAGUE_ROUND_TIERS = [
  '5 KM Nordic Walking - 65 PLN',
  '10 KM Nordic Walking - 110 PLN',
  'Nordic Walking 5 km dzieci i młodzież do 18 r.ż. - 45 PLN',
  'Nordic Walking 5 km osoby niepełnosprawne - 55 PLN',
  'posiłek dla kibica - 30 PLN',
]

const PAGES = {
  [BELCHATOW_URL]: tournamentPage({
    title: 'Bełchatów, Nordic Walking European Championships, Poland 2026 - Rejestracja - ONWF',
    tiers: BELCHATOW_TIERS,
  }),
  [PABIANICE_URL]: tournamentPage({
    title: 'Pabianice, Poland 2026 - Rejestracja - ONWF',
    tiers: LEAGUE_ROUND_TIERS,
    close: '03.10.2026 23:59',
    rulesPdf: 'pabianice-poland-2026-rules',
  }),
  [KOSTRZYN_URL]: tournamentPage({
    title: 'Kostrzyn, Poland 2026 - Rejestracja - ONWF',
    tiers: LEAGUE_ROUND_TIERS,
    close: '24.10.2026 23:59',
    rulesPdf: 'kostrzyn-poland-2026-rules',
  }),
  // panel.maratonczykpomiarczasu.pl titles the event, never the city.
  [PANEL_URL]: '<html><head><title>BIEG ZMECHA i NORDIC WALKING 2026</title></head><body><p>80 zł</p></body></html>',
  [PANEL_DUO_URL]: '<html><head><title>Bieg Dwudniowy 2026 - zapisy</title></head><body><p>80 zł</p></body></html>',
  // A league hub names every round it covers.
  [HUB_URL]: tournamentPage({
    title: 'Liga Centrum 2026 - Pabianice, Bełchatów, Kostrzyn - Rejestracja - ONWF',
    tiers: BELCHATOW_TIERS,
  }),
}

// One hit of ONWF's event search: the city, the date, and the links to the
// tournament page and its start list.
const searchHit = ({ city, date, slug }) => `<div class="row signin-data">
  <div class="col-12 col-lg-3"><p>${city}, Poland 2026</p><p>Poland</p></div>
  <div class="col-6 col-lg-1 nopad-lg"><p>${date}</p><p>(1 days)</p></div>
  <div class="col-12 col-lg-2"><a href="/pl/tournaments/${slug}/applications" class="small-button">Lista zawodników</a></div>
  <div class="col-12 col-lg-2"><a href="/pl/cities-list,2026/${slug}" class="small-button">Informacje</a></div>
  <div class="col-12 col-lg-2"><a href="/pl/tournaments/${slug}" class="small-button">Zapisz się</a></div>
</div>`

const SEARCH = {
  Pabianice: searchHit({ city: 'Pabianice', date: '2026-10-03', slug: 'pabianice-2026' }),
  Kostrzyn: searchHit({ city: 'Kostrzyn', date: '2026-10-24', slug: 'kostrzyn-poland-2026' }),
}

function stubFetch(listingHtml, { search = SEARCH, pages = PAGES } = {}) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url)
    calls.push(`${opts.method || 'GET'} ${u}`)
    if (opts.method === 'HEAD') {
      return { ok: true, status: 200, headers: { get: () => (u.endsWith('.pdf') ? 'application/pdf' : 'text/html') } }
    }
    if (u === ONWF_SEARCH) {
      const name = new URLSearchParams(opts.body || '').get('name')
      return { ok: true, status: 200, text: async () => search[name] || '' }
    }
    if (pages[u]) return { ok: true, status: 200, text: async () => pages[u] }
    if (u.includes('wydarzenia-biegowe')) return { ok: true, status: 200, text: async () => listingHtml }
    return { ok: false, status: 404, text: async () => '' }
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

const byId = (rows, id) => rows.find(r => r.source_id === id)

const PABIANICE_SITE = 'https://ligacentrum.pl/pabianice'

const SHARED_LISTING = listing([
  row({ slug: 'pabianice', name: 'Liga Centrum Nordic Walking Pabianice', date: '2026-10-03', city: 'Pabianice', regUrl: BELCHATOW_URL, website: PABIANICE_SITE }),
  row({ slug: 'belchatow', name: 'Liga Centrum Nordic Walking Bełchatów', date: '2026-10-17', city: 'Bełchatów', regUrl: BELCHATOW_URL }),
  row({ slug: 'kostrzyn', name: 'Liga Zachodu Nordic Walking Kostrzyn', date: '2026-10-24', city: 'Kostrzyn', voivodeship: 'Lubuskie', regUrl: BELCHATOW_URL }),
])

test('the event a shared page names keeps the link, and reads price and close off it', async () => {
  const stub = stubFetch(SHARED_LISTING)
  try {
    const ev = byId(await scrape(), 'belchatow')
    assert.equal(ev.registration_url, BELCHATOW_URL)
    assert.match(ev.regulamin_url, /belchatow-nordic-walking-european-championships-poland-2026-rules\.pdf$/)
    assert.equal(ev.price_from, 85)
    assert.equal(ev.price_to, 270)
    assert.equal(ev.registration_deadline, '2026-08-16')
  } finally {
    stub.restore()
  }
})

// Concern raised on the first cut of this fix: the other two rows lost their
// registration_url and gained nothing, so the PR deleted a field to fill a
// blank. They are repointed at their own page instead.
test('an event handed a neighbour\'s link is repointed at its own page, price and all', async () => {
  const stub = stubFetch(SHARED_LISTING)
  try {
    const rows = await scrape()

    const pabianice = byId(rows, 'pabianice')
    assert.equal(pabianice.registration_url, PABIANICE_URL)
    assert.match(pabianice.regulamin_url, /pabianice-poland-2026-rules\.pdf$/)
    assert.equal(pabianice.price_from, 65)
    assert.equal(pabianice.price_to, 110)
    assert.equal(pabianice.registration_deadline, '2026-10-03')

    const kostrzyn = byId(rows, 'kostrzyn')
    assert.equal(kostrzyn.registration_url, KOSTRZYN_URL)
    assert.match(kostrzyn.regulamin_url, /kostrzyn-poland-2026-rules\.pdf$/)
    assert.equal(kostrzyn.price_from, 65)
    assert.equal(kostrzyn.registration_deadline, '2026-10-24')
  } finally {
    stub.restore()
  }
})

// The 'link do strony biegu' column is a separate claim. When it is not the
// sign-up link it carries no evidence of being wrong, so it stays.
test('a website of its own survives having the sign-up link repointed', async () => {
  const stub = stubFetch(SHARED_LISTING)
  try {
    assert.equal(byId(await scrape(), 'pabianice').website, PABIANICE_SITE)
  } finally {
    stub.restore()
  }
})

test('a link we cannot repoint is dropped rather than published on the wrong event', async () => {
  // ONWF's search knows nothing about this city, so there is no page to move
  // to — and Bełchatów's is not this event's.
  const stub = stubFetch(SHARED_LISTING, { search: {} })
  try {
    const rows = await scrape()
    assert.equal(byId(rows, 'pabianice').registration_url, null)
    assert.equal(byId(rows, 'pabianice').regulamin_url, undefined)
    assert.equal(byId(rows, 'pabianice').price_from, undefined)
    assert.equal(byId(rows, 'belchatow').registration_url, BELCHATOW_URL)
  } finally {
    stub.restore()
  }
})

// Concern raised on review: ONWF titles 'Kostrzyn nad Odrą' as 'Kostrzyn,
// Poland 2026'. Requiring the whole city string would make the event that owns
// the page look like a stranger on it and cost it a correct link.
test('a multi-word city is recognised in a title that shortens it', async () => {
  const MULTIWORD_LISTING = listing([
    row({ slug: 'kostrzyn-nad-odra', name: 'Liga Zachodu Nordic Walking', date: '2026-10-24', city: 'Kostrzyn nad Odrą', voivodeship: 'Lubuskie', regUrl: KOSTRZYN_URL }),
    row({ slug: 'slubice', name: 'Liga Zachodu Nordic Walking Słubice', date: '2026-11-07', city: 'Słubice', voivodeship: 'Lubuskie', regUrl: KOSTRZYN_URL }),
  ])
  const stub = stubFetch(MULTIWORD_LISTING, { search: {} })
  try {
    const rows = await scrape()
    const kostrzyn = byId(rows, 'kostrzyn-nad-odra')
    assert.equal(kostrzyn.registration_url, KOSTRZYN_URL, 'the event the page names must keep its link')
    assert.equal(kostrzyn.price_from, 65)
    assert.equal(byId(rows, 'slubice').registration_url, null)
  } finally {
    stub.restore()
  }
})

test('titleNamesCity reads a city as words, not as one string', () => {
  assert.equal(titleNamesCity('Kostrzyn, Poland 2026 - Rejestracja - ONWF', 'Kostrzyn nad Odrą'), true)
  assert.equal(titleNamesCity('Nowy Dwór, Poland 2026', 'Nowy Dwór Mazowiecki'), true)
  assert.equal(titleNamesCity('Ostrowiec, Poland 2026', 'Ostrowiec Świętokrzyski'), true)
  assert.equal(titleNamesCity('Bełchatów, Poland 2026', 'Belchatow'), true)
  assert.equal(titleNamesCity('Bełchatów, Poland 2026', 'Pabianice'), false)
  assert.equal(titleNamesCity('Bełchatów, Poland 2026', null), false)
})

// Concern raised on review: a main run and its kids run, or a two-day event
// split over two rows, legitimately share one panel link. Panel titles name the
// event, never the city, so an ownership test that demands the city would strip
// the link from both.
test('a link two rows legitimately share is left alone when nothing says it is anyone else\'s', async () => {
  const DUO_LISTING = listing([
    row({ slug: 'dwudniowy-d1', name: 'Bieg Dwudniowy - dzień 1', date: '2026-07-04', city: 'Kalisz', voivodeship: 'Wielkopolskie', regUrl: PANEL_DUO_URL }),
    row({ slug: 'dwudniowy-d2', name: 'Bieg Dwudniowy - dzień 2', date: '2026-07-05', city: 'Kalisz', voivodeship: 'Wielkopolskie', regUrl: PANEL_DUO_URL }),
  ])
  const stub = stubFetch(DUO_LISTING)
  try {
    const rows = await scrape()
    for (const id of ['dwudniowy-d1', 'dwudniowy-d2']) {
      assert.equal(byId(rows, id).registration_url, PANEL_DUO_URL, `${id} must keep the link it shares`)
    }
  } finally {
    stub.restore()
  }
})

// Concern raised on review: a hub page whose title names several rounds would
// pass a 'does it name my city' test for every one of them, and hand them all
// the same price.
test('a hub page that names several rounds gives none of them a price', async () => {
  const HUB_LISTING = listing([
    row({ slug: 'hub-pabianice', name: 'Liga Centrum Pabianice', date: '2026-10-03', city: 'Pabianice', regUrl: HUB_URL }),
    row({ slug: 'hub-belchatow', name: 'Liga Centrum Bełchatów', date: '2026-10-17', city: 'Bełchatów', regUrl: HUB_URL }),
    row({ slug: 'hub-kostrzyn', name: 'Liga Zachodu Kostrzyn', date: '2026-10-24', city: 'Kostrzyn', voivodeship: 'Lubuskie', regUrl: HUB_URL }),
  ])
  const stub = stubFetch(HUB_LISTING)
  try {
    const rows = await scrape()
    for (const id of ['hub-pabianice', 'hub-belchatow', 'hub-kostrzyn']) {
      const ev = byId(rows, id)
      assert.equal(ev.registration_url, HUB_URL, `${id} keeps the link the listing gave it`)
      assert.equal(ev.price_from, undefined, `${id} must not take a price off a page shared by three events`)
      assert.equal(ev.registration_deadline, undefined, `${id} must not take a close off a page shared by three events`)
      assert.equal(ev.regulamin_url, undefined, `${id} must not take a regulamin off a page shared by three events`)
    }
  } finally {
    stub.restore()
  }
})

test('a link used by one row only is never questioned', async () => {
  // panel.maratonczykpomiarczasu.pl pages do not name the city in their title.
  // Only a shared link has to be attributed, so this row keeps its link.
  const stub = stubFetch(listing([
    row({ slug: 'bieg-zmecha-2026', name: 'BIEG ZMECHA i NORDIC WALKING 2026', date: '2026-10-03', city: 'Zmysłowo', regUrl: PANEL_URL }),
  ]))
  try {
    assert.equal(byId(await scrape(), 'bieg-zmecha-2026').registration_url, PANEL_URL)
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
    tiers: LEAGUE_ROUND_TIERS,
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
  const got = parse(tournamentPage({ title: 'Pabianice, Poland 2026 - ONWF', tiers: LEAGUE_ROUND_TIERS }))
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

// Concern raised on review: a fee written with grosze was silently discarded,
// so a page that does publish a price reported none.
test('a fee written with grosze is still a fee', () => {
  const got = parse(tournamentPage({
    title: 'Pabianice, Poland 2026 - ONWF',
    tiers: ['5 km Nordic Walking - 85,00 PLN', '10 km Nordic Walking - 110,50 PLN'],
  }))
  assert.equal(got.price_from, 85)
  assert.equal(got.price_to, 110.5)
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
