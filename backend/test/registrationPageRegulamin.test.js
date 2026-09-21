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
// also lists two other editions of the race.
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

const ODT_43 = 'https://b4sportonline.pl/users-folder/1104/files/63269af01d0da6f39fa92ec71fc6f9c2ee465.odt'
const ODT_NW = 'https://b4sportonline.pl/users-folder/1104/files/783911c3dbc11711949ab57b2424dae2421a0.odt'
const ODT_23 = 'https://b4sportonline.pl/users-folder/1104/files/73028b42ea1afb58a409f61e7ccfa5c3a1ece.odt'

const ROW = { registration_url: 'https://b4sportonline.pl/ultra_swir/' }

// All three .odt files on ultra_swir are byte-identical: one regulamin,
// uploaded once per distance. Verified by md5 on 2026-09-21.
const REGULAMIN_BYTES = 'REGULAMIN BIEGÓW GÓRSKICH - Wyspowy Ultra Świr, 26.06.2027, Łącko'

function reply(body, { ok = true, contentType = 'application/octet-stream' } = {}) {
  return {
    ok,
    headers: { get: h => (h.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  }
}

// url → body, or url → [body, opts]
function stubFetch(routes) {
  const calls = []
  const impl = async (url) => {
    calls.push(String(url))
    const hit = routes[String(url)]
    if (hit === undefined) return reply('not found', { ok: false })
    return Array.isArray(hit) ? reply(hit[0], hit[1]) : reply(hit)
  }
  impl.calls = calls
  return impl
}

const PAGE = [ULTRA_SWIR_NAV, { contentType: 'text/html; charset=UTF-8' }]

test('collects a Regulamin link whose href carries no regulamin token', () => {
  assert.deepEqual(
    collectRegulaminDocLinks(ULTRA_SWIR_NAV, 'https://b4sportonline.pl/ultra_swir/'),
    [ODT_43, ODT_NW, ODT_23],
  )
})

test('skips the documents that sit next to a regulamin', () => {
  const html = `<a href="/o/oswiadczenie.pdf">Oświadczenie rodzica</a>
    <a href="/o/klauzula.pdf">Klauzula RODO</a>
    <a href="/o/mapa.pdf">Mapa trasy</a>
    <a href="/o/x.pdf">Regulamin</a>`
  assert.deepEqual(
    collectRegulaminDocLinks(html, 'https://example.pl/o/'),
    ['https://example.pl/o/x.pdf'],
  )
})

test('skips a link that is not a document', () => {
  const html = '<a href="/ultra_swir/zapisy_na_bieg_43_km">Regulamin i zapisy</a>'
  assert.deepEqual(collectRegulaminDocLinks(html, 'https://b4sportonline.pl/'), [])
})

test('WYSPOWY ULTRA SWIR gets its regulamin from its own registration page', async () => {
  const fetchImpl = stubFetch({
    'https://b4sportonline.pl/ultra_swir/': PAGE,
    [ODT_43]: REGULAMIN_BYTES,
    [ODT_NW]: REGULAMIN_BYTES,
    [ODT_23]: REGULAMIN_BYTES,
  })
  assert.equal(await resolveRegistrationPageRegulamin(ROW, { fetchImpl }), ODT_43)
})

test('two different documents is a choice the markup cannot make', async () => {
  const fetchImpl = stubFetch({
    'https://b4sportonline.pl/ultra_swir/': PAGE,
    [ODT_43]: 'regulamin biegu 43 km',
    [ODT_NW]: 'regulamin marszu nordic walking',
    [ODT_23]: 'regulamin biegu 23 km',
  })
  assert.equal(await resolveRegistrationPageRegulamin(ROW, { fetchImpl }), null)
})

test('a dead document link is not written', async () => {
  const fetchImpl = stubFetch({
    'https://b4sportonline.pl/ultra_swir/': PAGE,
    [ODT_43]: ['<html>404</html>', { ok: false, contentType: 'text/html' }],
    [ODT_NW]: REGULAMIN_BYTES,
    [ODT_23]: REGULAMIN_BYTES,
  })
  assert.equal(await resolveRegistrationPageRegulamin(ROW, { fetchImpl }), null)
})

test('a soft 404 that answers with HTML is not a document', async () => {
  const fetchImpl = stubFetch({
    'https://b4sportonline.pl/ultra_swir/': PAGE,
    [ODT_43]: ['<html>Strona nie istnieje</html>', { contentType: 'text/html' }],
    [ODT_NW]: ['<html>Strona nie istnieje</html>', { contentType: 'text/html' }],
    [ODT_23]: ['<html>Strona nie istnieje</html>', { contentType: 'text/html' }],
  })
  assert.equal(await resolveRegistrationPageRegulamin(ROW, { fetchImpl }), null)
})

test('a row with no registration_url costs no fetch', async () => {
  const fetchImpl = stubFetch({})
  assert.equal(await resolveRegistrationPageRegulamin({ registration_url: null }, { fetchImpl }), null)
  assert.equal(fetchImpl.calls.length, 0)
})

test('a page that links no regulamin costs no document fetch', async () => {
  const fetchImpl = stubFetch({
    'https://b4sportonline.pl/ultra_swir/': ['<html><body><a href="/zapisy">Zapisy</a></body></html>', { contentType: 'text/html' }],
  })
  assert.equal(await resolveRegistrationPageRegulamin(ROW, { fetchImpl }), null)
  assert.deepEqual(fetchImpl.calls, ['https://b4sportonline.pl/ultra_swir/'])
})

test('a registration page that will not load drops the candidate instead of throwing', async () => {
  const fetchImpl = async () => { throw new Error('ECONNRESET') }
  assert.equal(await resolveRegistrationPageRegulamin(ROW, { fetchImpl }), null)
})
