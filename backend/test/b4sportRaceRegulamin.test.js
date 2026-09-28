import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as cheerio from 'cheerio'
import {
  collectContentPages,
  collectRegulaminLinks,
  fetchOrganizerDetails,
  pickRegulamin,
} from '../src/scrapers/sources/b4sport.js'

// TKKF Koszalin, sampled 2026-09-29. The organizer runs two races off one site.
// The menu links the Mile Biegowe regulamin and nothing else, so the index page
// and the /regulamin route between them offer one candidate, and it belongs to
// the wrong race. The Bieg Sylwestrowy regulamin is linked once, in the body of
// the race's own page, and it points at the organizer's own domain.
const MENU = `
  <ul>
    <li><a href = "/Biegi_Koszalin_2016/info">KLAUZULA INFORMACYJNA</a></li>
    <li><a href = "/Biegi_Koszalin_2016/mile">Regulamin - Mile Biegowe 2026</a></li>
    <li><a href = "/Biegi_Koszalin_2016/bieg_sylwestrowy">XVII Koszaliński Bieg Sylwestrowy</a></li>
    <li><a href = "/Biegi_Koszalin_2016/gallery">Galeria</a></li>
    <li><a href = "/Biegi_Koszalin_2016/zapisy_na_31122026__xvii_koszalinski_bieg_sylwestrowy__5km">Zapisy</a></li>
    <li><a href = "/Biegi_Koszalin_2016/lista_uczestnikow_31122026__xvii_koszalinski_bieg_sylwestrowy__5km/13098">Lista</a></li>
    <li><a href = "/Biegi_Koszalin_2016/index">Start</a></li>
  </ul>`

const INDEX_HTML = `<html><body>${MENU}
  <div class="footer"><a target="_blank" href="http://tkkf.koszalin.pl/">TKKF Koszalin</a></div>
</body></html>`

const RACE_PAGE_HTML = `<html><body>${MENU}
  <h1>XVII Koszaliński Bieg Sylwestrowy</h1>
  <p>godz. 11.00 - bieg główny 5 km</p>
  <p><a rel="nofollow" href="https://biegikoszalin.eu/Biegi_Koszalin_2016/biegsyl2025">Regulamin</a></p>
</body></html>`

const INFO_HTML = `<html><body>${MENU}<h1>Klauzula informacyjna</h1></body></html>`

const EVENT_NAME = '28.12.2024 - XV Koszaliński Bieg Sylwestrowy - 5 km'
const SYLWESTROWY_REGULAMIN = 'https://biegikoszalin.eu/Biegi_Koszalin_2016/biegsyl2025'

test('the race page is read off the index menu, the wizard and the lists are not', () => {
  const pages = collectContentPages(cheerio.load(INDEX_HTML), 'Biegi_Koszalin_2016')
  assert.deepEqual([...pages.keys()], [
    'https://b4sportonline.pl/Biegi_Koszalin_2016/info',
    'https://b4sportonline.pl/Biegi_Koszalin_2016/mile',
    'https://b4sportonline.pl/Biegi_Koszalin_2016/bieg_sylwestrowy',
  ])
  assert.equal(
    pages.get('https://b4sportonline.pl/Biegi_Koszalin_2016/bieg_sylwestrowy'),
    'XVII Koszaliński Bieg Sylwestrowy',
  )
})

test('a regulamin on the organizer own domain is a candidate', () => {
  const got = collectRegulaminLinks(cheerio.load(RACE_PAGE_HTML), 'Biegi_Koszalin_2016')
  assert.ok(got.some(c => c.url === SYLWESTROWY_REGULAMIN))
})

test('another organizer b4sport page is still not a candidate', () => {
  const $ = cheerio.load('<a href="/Inne_Biegi_2026/regulamin">Regulamin</a>')
  assert.deepEqual(collectRegulaminLinks($, 'Biegi_Koszalin_2016'), [])
})

test('the page label separates two regulamins on one organizer', async () => {
  const candidates = [
    ...collectRegulaminLinks(cheerio.load(INDEX_HTML), 'Biegi_Koszalin_2016'),
    ...collectRegulaminLinks(cheerio.load(RACE_PAGE_HTML), 'Biegi_Koszalin_2016', 'XVII Koszaliński Bieg Sylwestrowy')
      .filter(c => c.url === SYLWESTROWY_REGULAMIN),
  ]
  const url = await pickRegulamin(candidates, 'Koszalin', EVENT_NAME, { verifyPageFn: async () => true })
  // Both pages say Koszalin, so the city cannot choose. Without the label the
  // link reads only "Regulamin" and the Mile Biegowe page wins by default.
  assert.equal(url, SYLWESTROWY_REGULAMIN)
})

test('event 13098 gets its own regulamin, not the Mile Biegowe one', async () => {
  const pages = {
    'https://b4sportonline.pl/Biegi_Koszalin_2016/index': INDEX_HTML,
    'https://b4sportonline.pl/Biegi_Koszalin_2016/regulamin': null,
    'https://b4sportonline.pl/Biegi_Koszalin_2016/bieg_sylwestrowy': RACE_PAGE_HTML,
    'https://b4sportonline.pl/Biegi_Koszalin_2016/info': INFO_HTML,
  }
  const asked = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    asked.push(url)
    const body = pages[url]
    if (body == null) return { ok: false, status: 404, text: async () => '' }
    return { ok: true, status: 200, text: async () => body }
  }

  try {
    const details = await fetchOrganizerDetails(['Biegi_Koszalin_2016'])
    const { regulaminCandidates } = details.get('Biegi_Koszalin_2016')
    const url = await pickRegulamin(regulaminCandidates, 'Koszalin', EVENT_NAME, {
      verifyPageFn: async () => true,
    })
    assert.equal(url, SYLWESTROWY_REGULAMIN)
    assert.ok(asked.includes('https://b4sportonline.pl/Biegi_Koszalin_2016/bieg_sylwestrowy'))
    // The menu page that is already a candidate is not fetched a second time.
    assert.ok(!asked.includes('https://b4sportonline.pl/Biegi_Koszalin_2016/mile'))
  } finally {
    globalThis.fetch = realFetch
  }
})
