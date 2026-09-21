import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  collectRegulaminDocLinks,
  resolveRegistrationPageRegulamin,
} from '../scripts/lib/registration-page-regulamin.js'

// WYSPOWY ULTRA ŚWIR (2027-06-26, biegigorskie:wyspowy-ultra-swir-2027-06-26)
// published with regulamin_url, price_from and price_to all null. Its
// registration_url was already known, and that page links the regulamin three
// times, once per distance. The search step never looked at it, paid for a web
// search instead, and the search found nothing.
//
// Markup copied from https://b4sportonline.pl/ultra_swir/ on 2026-09-21. The
// hrefs carry no "regulamin" token, only the anchor text does, and the page
// also lists another edition of the race — Jesienny ULTRA ŚWIR, a different
// event on a different date, sharing this registration_url because
// biegigorskie stores whatever the sign-up cell links.
const ULTRA_SWIR_NAV = `<html><body><ul>
  <li><a href="#">Jesienny ULTRA ŚWIR</a><ul>
    <li><a href="/ultra_swir/lista_uczestnikow_jesienny_trail__nordic_walking_15_km/12201">Lista uczestników</a></li>
  </ul></li>
  <li><a href="#">Wyspowy Ultra Świr 2027</a><ul>
    <li><a href="#">Bieg 43 km </a><ul>
      <li><a href="/ultra_swir/zapisy_na_bieg_43_km">Zapisy</a></li>
      <li><a href="https://b4sportonline.pl/users-folder/1104/files/63269af01d0da6f39fa92ec71fc6f9c2ee465.odt" target="_blank">Regulamin</a></li>
    </ul></li>
    <li><a href="#">Marsz NW 23 km</a><ul>
      <li><a href="https://b4sportonline.pl/users-folder/1104/files/783911c3dbc11711949ab57b2424dae2421a0.odt" target="_blank">Regulamin</a></li>
    </ul></li>
    <li><a href="#">Bieg 23 km</a><ul>
      <li><a href="https://b4sportonline.pl/users-folder/1104/files/73028b42ea1afb58a409f61e7ccfa5c3a1ece.odt" target="_blank">Regulamin</a></li>
    </ul></li>
  </ul></li>
</ul></body></html>`

// The same page once the autumn edition has published its own rules. This is
// the shape that decides whether a document is tied to the row it is written
// on: four Regulamin links, one of which belongs to a different event.
const ULTRA_SWIR_NAV_BOTH = ULTRA_SWIR_NAV.replace(
  '<li><a href="/ultra_swir/lista_uczestnikow_jesienny_trail__nordic_walking_15_km/12201">Lista uczestników</a></li>',
  '<li><a href="https://b4sportonline.pl/users-folder/1104/files/aaaa1111bbbb2222cccc3333dddd4444eeee5.odt" target="_blank">Regulamin</a></li>',
)

// And the shape where only the autumn edition has published. Nothing on this
// page belongs to the June row.
const ULTRA_SWIR_NAV_SIBLING_ONLY = ULTRA_SWIR_NAV_BOTH
  .replace(/<li><a href="https:\/\/b4sportonline\.pl\/users-folder\/1104\/files\/(63269af0|783911c3|73028b42)[^"]*"[^>]*>Regulamin<\/a><\/li>/g, '')

const ODT_43 = 'https://b4sportonline.pl/users-folder/1104/files/63269af01d0da6f39fa92ec71fc6f9c2ee465.odt'
const ODT_NW = 'https://b4sportonline.pl/users-folder/1104/files/783911c3dbc11711949ab57b2424dae2421a0.odt'
const ODT_23 = 'https://b4sportonline.pl/users-folder/1104/files/73028b42ea1afb58a409f61e7ccfa5c3a1ece.odt'
const ODT_JESIENNY = 'https://b4sportonline.pl/users-folder/1104/files/aaaa1111bbbb2222cccc3333dddd4444eeee5.odt'

const PAGE_URL = 'https://b4sportonline.pl/ultra_swir/'
const ROW = {
  name: 'WYSPOWY ULTRA ŚWIR',
  date: '2027-06-26',
  location: 'Łącko',
  registration_url: PAGE_URL,
}

// All three .odt files on ultra_swir are byte-identical: one regulamin,
// uploaded once per distance. Verified by md5 on 2026-09-21.
const REGULAMIN_BYTES = 'REGULAMIN BIEGÓW GÓRSKICH - Wyspowy Ultra Świr, 26.06.2027, Łącko'
const JESIENNY_BYTES = 'REGULAMIN - Jesienny Ultra Świr, 10.10.2027, Łącko'

function reply(body, { ok = true, contentType = 'application/octet-stream' } = {}) {
  // A real Response, so res.body is a real stream and the capped reader is the
  // code path under test rather than the arrayBuffer() fallback.
  return new Response(body, { status: ok ? 200 : 404, headers: { 'content-type': contentType } })
}

// url → body, or url → [body, opts], or url → a function of the fetch init
function stubFetch(routes) {
  const calls = []
  const impl = async (url, init) => {
    calls.push(String(url))
    const hit = routes[String(url)]
    if (hit === undefined) return reply('not found', { ok: false })
    if (typeof hit === 'function') return hit(init)
    return Array.isArray(hit) ? reply(hit[0], hit[1]) : reply(hit)
  }
  impl.calls = calls
  return impl
}

const html = markup => [markup, { contentType: 'text/html; charset=UTF-8' }]
const PAGE = html(ULTRA_SWIR_NAV)

// Headers arrive, the body never does — until the request is aborted, which is
// what a real fetch does with the signal we hand it.
function stalledBody(contentType) {
  return init => new Response(
    new ReadableStream({
      start(controller) {
        init.signal.addEventListener('abort', () => controller.error(new Error('aborted')))
      },
    }),
    { headers: { 'content-type': contentType } },
  )
}

test('collects a Regulamin link whose href carries no regulamin token', () => {
  assert.deepEqual(
    collectRegulaminDocLinks(ULTRA_SWIR_NAV, PAGE_URL).map(c => c.url),
    [ODT_43, ODT_NW, ODT_23],
  )
})

test('a collected link carries its own section and the ones beside it', () => {
  const [first] = collectRegulaminDocLinks(ULTRA_SWIR_NAV, PAGE_URL)
  assert.ok(first.own.includes('wyspowyultraswir2027'), first.own)
  assert.ok(!first.own.includes('jesienny'), first.own)
  assert.ok(first.rivals.some(r => r.includes('jesiennyultraswir')), first.rivals.join('|'))
  assert.deepEqual(first.years, ['2027'])
})

test('skips the documents that sit next to a regulamin', () => {
  const markup = `<a href="/o/oswiadczenie.pdf">Oświadczenie rodzica</a>
    <a href="/o/klauzula.pdf">Klauzula RODO</a>
    <a href="/o/mapa.pdf">Mapa trasy</a>
    <a href="/o/x.pdf">Regulamin</a>`
  assert.deepEqual(
    collectRegulaminDocLinks(markup, 'https://example.pl/o/').map(c => c.url),
    ['https://example.pl/o/x.pdf'],
  )
})

test('skips a link that is not a document', () => {
  const markup = '<a href="/ultra_swir/zapisy_na_bieg_43_km">Regulamin i zapisy</a>'
  assert.deepEqual(collectRegulaminDocLinks(markup, 'https://b4sportonline.pl/').length, 0)
})

test('WYSPOWY ULTRA SWIR gets its regulamin from its own registration page', async () => {
  const fetchImpl = stubFetch({
    [PAGE_URL]: PAGE,
    [ODT_43]: REGULAMIN_BYTES,
    [ODT_NW]: REGULAMIN_BYTES,
    [ODT_23]: REGULAMIN_BYTES,
  })
  assert.equal(await resolveRegistrationPageRegulamin(ROW, { fetchImpl }), ODT_43)
})

test('a sibling edition on the same page keeps its own regulamin', async () => {
  const fetchImpl = stubFetch({
    [PAGE_URL]: html(ULTRA_SWIR_NAV_BOTH),
    [ODT_43]: REGULAMIN_BYTES,
    [ODT_NW]: REGULAMIN_BYTES,
    [ODT_23]: REGULAMIN_BYTES,
    [ODT_JESIENNY]: JESIENNY_BYTES,
  })
  const got = await resolveRegistrationPageRegulamin(ROW, { fetchImpl })
  assert.equal(got, ODT_43)
  assert.notEqual(got, ODT_JESIENNY)
  // The autumn document is never even fetched — it was disowned in the markup.
  assert.ok(!fetchImpl.calls.includes(ODT_JESIENNY), fetchImpl.calls.join('\n'))
})

test('the sibling edition is the only one with rules, so this row gets none', async () => {
  const fetchImpl = stubFetch({
    [PAGE_URL]: html(ULTRA_SWIR_NAV_SIBLING_ONLY),
    [ODT_JESIENNY]: JESIENNY_BYTES,
  })
  // Sanity-check the fixture: the page really does link one regulamin, so this
  // is the single-candidate case and not an empty page.
  assert.equal(collectRegulaminDocLinks(ULTRA_SWIR_NAV_SIBLING_ONLY, PAGE_URL).length, 1)
  assert.equal(await resolveRegistrationPageRegulamin(ROW, { fetchImpl }), null)
  assert.ok(!fetchImpl.calls.includes(ODT_JESIENNY), fetchImpl.calls.join('\n'))
})

test('the page repeating the event name is agreement, not a rival', async () => {
  // Bieg "Wiejska 10-ka" (2026-10-04) gets its regulamin off a page whose own
  // heading and whose donation link both carry the race name. Those tie with
  // the section holding the document; held against it, the row resolves to
  // nothing and goes back to paying for a search.
  const markup = `<html><body>
    <div><h1>Bieg Wiejska 10-ka</h1></div>
    <div><a href="/d/regulamin-wiejska-10ka-2026.pdf">Regulamin</a></div>
    <div><a href="/darowizna">Darowizna Wiejska 10-tka</a></div>
  </body></html>`
  const row = { name: 'Bieg "Wiejska 10-ka"', date: '2026-10-04', location: 'Nowogródek Pomorski', registration_url: 'https://example.pl/z' }
  const fetchImpl = stubFetch({
    'https://example.pl/z': html(markup),
    'https://example.pl/d/regulamin-wiejska-10ka-2026.pdf': 'regulamin wiejska',
  })
  assert.equal(
    await resolveRegistrationPageRegulamin(row, { fetchImpl }),
    'https://example.pl/d/regulamin-wiejska-10ka-2026.pdf',
  )
})

test('last year edition still linked on the page is not this year regulamin', async () => {
  // Two editions of one race differ by nothing but the year, so the name tiers
  // tie and only the date can separate them.
  const markup = `<html><body>
    <div><a href="#">Bieg Lesny 2026</a><ul><li><a href="/d/regulamin-2026.pdf">Regulamin</a></li></ul></div>
    <div><a href="#">Bieg Lesny 2027</a><ul><li><a href="/zapisy">Zapisy</a></li></ul></div>
  </body></html>`
  const row = { name: 'Bieg Leśny', date: '2027-05-15', location: 'Mielno', registration_url: 'https://example.pl/z' }
  const fetchImpl = stubFetch({
    'https://example.pl/z': html(markup),
    'https://example.pl/d/regulamin-2026.pdf': 'regulamin 2026',
  })
  assert.equal(collectRegulaminDocLinks(markup, 'https://example.pl/z').length, 1)
  assert.equal(await resolveRegistrationPageRegulamin(row, { fetchImpl }), null)
})

test('the row is claimed by its city when the name says nothing', async () => {
  const markup = `<html><body>
    <div><h2>Etap w Gdansku</h2><a href="/d/reg-gdansk.pdf">Regulamin</a></div>
    <div><h2>Etap w Poznaniu</h2><a href="/d/reg-poznan.pdf">Regulamin</a></div>
  </body></html>`
  // Every distinctive token of the name is on both sections, so tier 1 cannot
  // choose and tier 2 has to.
  const row = { name: 'Grand Prix', date: '2026-07-01', location: 'Poznań', registration_url: 'https://example.pl/z' }
  const fetchImpl = stubFetch({
    'https://example.pl/z': html(markup),
    'https://example.pl/d/reg-poznan.pdf': 'regulamin poznan',
  })
  assert.equal(
    await resolveRegistrationPageRegulamin(row, { fetchImpl }),
    'https://example.pl/d/reg-poznan.pdf',
  )
})

test('two different documents inside this row own section is a choice the markup cannot make', async () => {
  const fetchImpl = stubFetch({
    [PAGE_URL]: PAGE,
    [ODT_43]: 'regulamin biegu 43 km',
    [ODT_NW]: 'regulamin marszu nordic walking',
    [ODT_23]: 'regulamin biegu 23 km',
  })
  assert.equal(await resolveRegistrationPageRegulamin(ROW, { fetchImpl }), null)
})

test('a dead document link is not written', async () => {
  const fetchImpl = stubFetch({
    [PAGE_URL]: PAGE,
    [ODT_43]: ['<html>404</html>', { ok: false, contentType: 'text/html' }],
    [ODT_NW]: REGULAMIN_BYTES,
    [ODT_23]: REGULAMIN_BYTES,
  })
  assert.equal(await resolveRegistrationPageRegulamin(ROW, { fetchImpl }), null)
})

test('a soft 404 that answers with HTML is not a document', async () => {
  const fetchImpl = stubFetch({
    [PAGE_URL]: PAGE,
    [ODT_43]: ['<html>Strona nie istnieje</html>', { contentType: 'text/html' }],
    [ODT_NW]: ['<html>Strona nie istnieje</html>', { contentType: 'text/html' }],
    [ODT_23]: ['<html>Strona nie istnieje</html>', { contentType: 'text/html' }],
  })
  assert.equal(await resolveRegistrationPageRegulamin(ROW, { fetchImpl }), null)
})

test('a row with no registration_url costs no fetch', async () => {
  const fetchImpl = stubFetch({})
  assert.equal(await resolveRegistrationPageRegulamin({ ...ROW, registration_url: null }, { fetchImpl }), null)
  assert.equal(fetchImpl.calls.length, 0)
})

test('a page that links no regulamin costs no document fetch', async () => {
  const fetchImpl = stubFetch({
    [PAGE_URL]: html('<html><body><a href="/zapisy">Zapisy</a></body></html>'),
  })
  assert.equal(await resolveRegistrationPageRegulamin(ROW, { fetchImpl }), null)
  assert.deepEqual(fetchImpl.calls, [PAGE_URL])
})

test('a registration page that will not load drops the candidate instead of throwing', async () => {
  const fetchImpl = async () => { throw new Error('ECONNRESET') }
  assert.equal(await resolveRegistrationPageRegulamin(ROW, { fetchImpl }), null)
})

test('a page that sends headers and then stalls on the body times out', async () => {
  const fetchImpl = stubFetch({ [PAGE_URL]: stalledBody('text/html') })
  assert.equal(await resolveRegistrationPageRegulamin(ROW, { fetchImpl, timeoutMs: 100 }), null)
})

test('a document that sends headers and then stalls on the body times out', async () => {
  const fetchImpl = stubFetch({
    [PAGE_URL]: PAGE,
    [ODT_43]: stalledBody('application/octet-stream'),
    [ODT_NW]: REGULAMIN_BYTES,
    [ODT_23]: REGULAMIN_BYTES,
  })
  assert.equal(await resolveRegistrationPageRegulamin(ROW, { fetchImpl, timeoutMs: 100 }), null)
})

test('a document that never stops sending is read only up to the cap', async () => {
  // Without a ceiling this stream buffers until the process dies.
  const endless = () => new Response(
    new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024)) } }),
    { headers: { 'content-type': 'application/pdf' } },
  )
  const fetchImpl = stubFetch({
    [PAGE_URL]: PAGE,
    [ODT_43]: endless,
    [ODT_NW]: endless,
    [ODT_23]: endless,
  })
  // Same bytes from all three, so the byte check passes and we get a URL back —
  // the point is that it comes back at all.
  assert.equal(
    await resolveRegistrationPageRegulamin(ROW, { fetchImpl, maxDocBytes: 8192 }),
    ODT_43,
  )
})
