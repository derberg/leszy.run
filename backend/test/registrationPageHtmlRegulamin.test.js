import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveRegistrationPageRegulamin } from '../scripts/lib/registration-page-regulamin.js'

// XVIII KOSZALIŃSKI BIEG GÓRSKI (2027-04-10, herkules:4350) published with
// regulamin_url, price_from, distances and registration_deadline null. Its
// registration_url is https://biegikoszalin.eu/, a B4Sport white-label hub
// that hosts three races. The hub links each race's rules as a plain HTML
// page, never as a file, so the document-only scan found nothing to claim.
//
// Menu markup copied from https://biegikoszalin.eu/ on 2026-11-20.
const HUB_URL = 'https://biegikoszalin.eu/'
const HUB = `<html><body><ul class="menu-nav">
  <li><a title="/Biegi_Koszalin_2016/index" href="/Biegi_Koszalin_2016/index">Strona główna</a></li>
  <li><a href="#">Informacje dla uczestników</a><ul>
    <li><a title="/Biegi_Koszalin_2016/info" href="/Biegi_Koszalin_2016/info">KLAUZULA INFORMACYJNA </a></li>
    <li><a title="/Biegi_Koszalin_2016/regbg2027" href="/Biegi_Koszalin_2016/regbg2027">Regulamin - XVIII Koszaliński Bieg Górski</a></li>
    <li><a title="/Biegi_Koszalin_2016/mpm" href="/Biegi_Koszalin_2016/mpm">Regulamin - 4. MP MASTERS W BIEGU GÓRSKIM</a></li>
    <li><a title="/Biegi_Koszalin_2016/bieg_sylwestrowy" href="/Biegi_Koszalin_2016/bieg_sylwestrowy">Regulamin - XVII Koszaliński Bieg Sylwestrowy</a></li>
  </ul></li>
  <li><a href="#">Rejestracja do zawodów</a><ul>
    <li><a href="#">10.04.2027 - XVIII KOSZALIŃSKI BIEG GÓRSKI</a><ul>
      <li><a href="/Biegi_Koszalin_2016/zapisy_na_10042027__xviii_koszalinski_bieg_gorski">Zapisy</a></li>
    </ul></li>
  </ul></li>
</ul>
<table><tr><td><strong>10.04.2027 - 4.Mistrzostwa Polski Masters w Biegach Górskich 10km</strong></td>
  <td><a target="_blank" href="https://b4sportonline.pl/Biegi_Koszalin_2016/mpm">Regulamin</a></td></tr></table>
</body></html>`

const REG_BG = 'https://biegikoszalin.eu/Biegi_Koszalin_2016/regbg2027'
const REG_MPM = 'https://biegikoszalin.eu/Biegi_Koszalin_2016/mpm'
const REG_SYLW = 'https://biegikoszalin.eu/Biegi_Koszalin_2016/bieg_sylwestrowy'

// Every page of the hub repeats its menu, so a fixture without it would let
// a body check pass that the real site defeats.
const MENU = HUB.match(/<ul class="menu-nav">[\s\S]*?<\/ul>\n<table>/)[0].replace('<table>', '')
const page = (title, body) =>
  `<html><head><title>${title}</title></head><body>${MENU}<h1>${title}</h1>${body}</body></html>`
const REG_BG_PAGE = page('Regulamin - XVIII KOSZALIŃSKI BIEG GÓRSKI',
  '<p>II. TERMIN 10 kwietnia 2027 r.</p><p>IV. DYSTANSE 5 km</p><p>VI. OPŁATA STARTOWA 60 zł / 70 zł / 100 zł</p>')

const ROW = {
  name: 'XVIII KOSZALIŃSKI BIEG GÓRSKI',
  date: '2027-04-10',
  location: 'Koszalin',
  registration_url: HUB_URL,
}

function stubFetch(routes) {
  const calls = []
  const impl = async url => {
    calls.push(String(url))
    const body = routes[String(url)]
    if (body === undefined) return new Response('not found', { status: 404 })
    return new Response(body, { headers: { 'content-type': 'text/html; charset=UTF-8' } })
  }
  impl.calls = calls
  return impl
}

test('XVIII KOSZALINSKI BIEG GORSKI gets the HTML regulamin its hub names it in', async () => {
  const fetchImpl = stubFetch({
    [HUB_URL]: HUB,
    [REG_BG]: REG_BG_PAGE,
    [REG_MPM]: page('Regulamin - 4. MP MASTERS W BIEGU GÓRSKIM', '<p>Mistrzostwa</p>'),
    [REG_SYLW]: page('Regulamin - XVII Koszaliński Bieg Sylwestrowy', '<p>Sylwester</p>'),
  })
  assert.equal(await resolveRegistrationPageRegulamin(ROW, { fetchImpl }), REG_BG)
})

test('the sibling race on the hub never gets this race regulamin page', async () => {
  const fetchImpl = stubFetch({
    [HUB_URL]: HUB,
    [REG_BG]: REG_BG_PAGE,
    [REG_SYLW]: page('Regulamin - XVII Koszaliński Bieg Sylwestrowy', '<p>31 grudnia 2026</p>'),
  })
  const row = { ...ROW, name: 'XVII Koszaliński Bieg Sylwestrowy', date: '2026-12-31' }
  assert.equal(await resolveRegistrationPageRegulamin(row, { fetchImpl }), REG_SYLW)
})

test('a race the hub names no regulamin for gets none', async () => {
  const fetchImpl = stubFetch({ [HUB_URL]: HUB, [REG_BG]: REG_BG_PAGE })
  const row = { ...ROW, name: 'Koszaliński Nocny Bieg Uliczny' }
  assert.equal(await resolveRegistrationPageRegulamin(row, { fetchImpl }), null)
})

test('a linked page that does not name the event is not written, though its menu does', async () => {
  // biegikoszalin.eu answers an unknown path with 200 and the full menu.
  const fetchImpl = stubFetch({
    [HUB_URL]: HUB,
    [REG_BG]: page('Strona nie istnieje', '<p>404</p>'),
  })
  assert.equal(await resolveRegistrationPageRegulamin(ROW, { fetchImpl }), null)
})

test('a regulamin page on another host is not claimed', async () => {
  const markup = HUB.replace('href="/Biegi_Koszalin_2016/regbg2027"', 'href="https://inna.pl/regbg2027"')
  const fetchImpl = stubFetch({ [HUB_URL]: markup, 'https://inna.pl/regbg2027': REG_BG_PAGE })
  assert.equal(await resolveRegistrationPageRegulamin(ROW, { fetchImpl }), null)
})

test("last year's edition never gets this year's regulamin page", async () => {
  // 'xvii' is a prefix of 'xviii'; the edition has to match on its own.
  const fetchImpl = stubFetch({ [HUB_URL]: HUB, [REG_BG]: REG_BG_PAGE })
  const row = { ...ROW, name: 'XVII Koszaliński Bieg Górski', date: '2026-04-11' }
  assert.equal(await resolveRegistrationPageRegulamin(row, { fetchImpl }), null)
})

test('a regulamin page for another year is not written', async () => {
  const fetchImpl = stubFetch({ [HUB_URL]: HUB, [REG_BG]: REG_BG_PAGE })
  const row = { ...ROW, name: 'Koszaliński Bieg Górski', date: '2028-04-08' }
  assert.equal(await resolveRegistrationPageRegulamin(row, { fetchImpl }), null)
})
