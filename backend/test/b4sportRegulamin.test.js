import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as cheerio from 'cheerio'
import {
  pickRegulamin,
  collectRegulaminLinks,
  verifyRegulaminPage,
  nameTokens,
} from '../src/scrapers/sources/b4sport.js'

// TKKF Koszalin publishes its regulamin as an ordinary page, and the same menu
// lists a second, unrelated race's regulamin.
const KOSZALIN_NAV = `
  <ul>
    <li><a href="/Biegi_Koszalin_2016/info">KLAUZULA INFORMACYJNA</a></li>
    <li><a href="/Biegi_Koszalin_2016/5km_stadion">Regulamin - X Otwarte Mistrzostwa Koszalina na dystansie 5 000m</a></li>
    <li><a href="/Biegi_Koszalin_2016/mile">Regulamin - Mile Biegowe 2026</a></li>
    <li><a href="/Biegi_Koszalin_2016/zapisy/13036">Zapisy</a></li>
  </ul>`

const yes = async () => true
const no = async () => false

test('collects same-organizer HTML regulamin links, not just PDFs', () => {
  const got = collectRegulaminLinks(cheerio.load(KOSZALIN_NAV), 'Biegi_Koszalin_2016')
  assert.deepEqual(got.map(c => c.url), [
    'https://b4sportonline.pl/Biegi_Koszalin_2016/5km_stadion',
    'https://b4sportonline.pl/Biegi_Koszalin_2016/mile',
  ])
  assert.deepEqual([...new Set(got.map(c => c.kind))], ['html'])
})

test('ignores a regulamin link belonging to another organizer', () => {
  const $ = cheerio.load('<a href="/Inne_Biegi_2026/regulamin">Regulamin</a>')
  assert.deepEqual(collectRegulaminLinks($, 'Biegi_Koszalin_2016'), [])
})

test('still collects PDFs, from any path', () => {
  const $ = cheerio.load('<a href="https://cdn.example.pl/regulamin_gdynia.pdf">Regulamin Gdynia</a>')
  const got = collectRegulaminLinks($, 'Formoza')
  assert.equal(got.length, 1)
  assert.equal(got[0].kind, 'pdf')
})

test('skips non-regulamin documents', () => {
  const $ = cheerio.load('<a href="/Biegi_Koszalin_2016/zgoda.pdf">Oświadczenie rodzica</a>')
  assert.deepEqual(collectRegulaminLinks($, 'Biegi_Koszalin_2016'), [])
})

test('the event name picks its own regulamin out of a same-city pair', async () => {
  const candidates = collectRegulaminLinks(cheerio.load(KOSZALIN_NAV), 'Biegi_Koszalin_2016')
  const url = await pickRegulamin(
    candidates,
    'Koszalin',
    'Letnie Mile Biegowe - biegi dorosłych od 14 roku życia',
    { verifyPageFn: yes },
  )
  // City alone cannot separate these two, because both say Koszalin.
  assert.equal(url, 'https://b4sportonline.pl/Biegi_Koszalin_2016/mile')
})

test('city still resolves a multi-city PDF series', async () => {
  const candidates = [
    { url: 'https://x.pl/regulamin_gdynia.pdf', hay: 'regulamingdyniapdf', kind: 'pdf' },
    { url: 'https://x.pl/regulamin_gdansk.pdf', hay: 'regulamingdanskpdf', kind: 'pdf' },
  ]
  const url = await pickRegulamin(candidates, 'Gdynia', 'FORMOZA CHALLENGE', { verifyPdfFn: yes })
  assert.equal(url, 'https://x.pl/regulamin_gdynia.pdf')
})

test('a lone PDF is taken, a lone HTML nav link is not', async () => {
  const pdf = [{ url: 'https://x.pl/regulamin.pdf', hay: 'regulaminpdf', kind: 'pdf' }]
  assert.equal(
    await pickRegulamin(pdf, 'Sopot', 'Bieg Zupełnie Inny', { verifyPdfFn: yes }),
    'https://x.pl/regulamin.pdf',
  )
  const html = [{ url: 'https://b4sportonline.pl/Org/rules', hay: 'orgrulesregulamin', kind: 'html' }]
  assert.equal(
    await pickRegulamin(html, 'Sopot', 'Bieg Zupełnie Inny', { verifyPageFn: yes }),
    null,
  )
})

test('refuses to guess when neither name nor city is decisive', async () => {
  const candidates = [
    { url: 'https://b4sportonline.pl/Org/a', hay: 'aregulaminkoszalin', kind: 'html' },
    { url: 'https://b4sportonline.pl/Org/b', hay: 'bregulaminkoszalin', kind: 'html' },
  ]
  assert.equal(await pickRegulamin(candidates, 'Koszalin', 'Bieg', { verifyPageFn: yes }), null)
})

test('a chosen candidate that fails verification is dropped, not written', async () => {
  const candidates = collectRegulaminLinks(cheerio.load(KOSZALIN_NAV), 'Biegi_Koszalin_2016')
  assert.equal(await pickRegulamin(candidates, 'Koszalin', 'Letnie Mile Biegowe', { verifyPageFn: no }), null)
})

test('nameTokens keeps what distinguishes a race and drops what does not', () => {
  assert.deepEqual(
    nameTokens('Letnie Mile Biegowe - biegi dorosłych od 14 roku życia'),
    ['letnie', 'mile'],
  )
})

// --- verifyRegulaminPage -----------------------------------------------------

const REGULAMIN_HTML = `<html><body>
  <h1>Regulamin - Mile Biegowe 2026</h1>
  <h2>I. CEL IMPREZY</h2><p>Popularyzacja biegania jako najbardziej naturalnej formy aktywności oraz zdrowego stylu życia.</p>
  <h2>II. TERMINY I MIEJSCE</h2><p>Zawsze o godz. 18.30 na stadionie Bałtyk w Koszalinie w terminach 16.09.2026 r. oraz 23.09.2026 r.</p>
  <h2>III. ORGANIZATOR</h2><p>Koszalińskie Towarzystwo Krzewienia Kultury Fizycznej, kontakt ktkkf@wp.pl.</p>
  <h2>IV. ZAPISY I OPŁATA</h2><p>On-line przez formularz zgłoszeniowy. Opłata za udział osób dorosłych wynosi 10 zł za 1 edycję. Udział dzieci jest bezpłatny.</p>
  <h2>V. ZASADY UCZESTNICTWA</h2><p>Podczas imprezy obowiązują przepisy Polskiego Związku Lekkiej Atletyki. Pomiar czasu za pomocą zwrotnych chipów. W biegach dorosłych uczestniczą zawodnicy 14 lat i więcej.</p>
  <h2>VI. TRASA</h2><p>Po bieżni stadionu, dystans mila 1609 m rozgrywany w trzech seriach.</p>
  <h2>VII. NAGRODY</h2><p>Klasyfikacja generalna kobiet i mężczyzn za miejsca 1-3 puchary oraz wyróżnienia.</p>
  <h2>VIII. UBEZPIECZENIE</h2><p>Organizator posiada ubezpieczenie OC. Organizator nie zapewnia uczestnikom ubezpieczenia od następstw nieszczęśliwych wypadków. W przypadku kontuzji uczestnik powiadamia obsługę trasy, która przekazuje informacje do punktu pomocy medycznej.</p>
  <h2>IX. OCHRONA DANYCH OSOBOWYCH</h2><p>Dane osobowe uczestników biegów będą przetwarzane w celach przeprowadzenia imprezy, wyłonienia zwycięzcy i przyznania, wydania, odbioru i rozliczenia nagrody. Uczestnik wyraża zgodę na wykorzystywanie i przetwarzanie danych osobowych zawartych w formularzu zgłoszeniowym w zakresie związanym z organizacją imprezy, zgodnie z Rozporządzeniem Parlamentu Europejskiego i Rady (UE) 2016/679 z dnia 27 kwietnia 2016 r. w sprawie ochrony osób fizycznych w związku z przetwarzaniem danych osobowych i w sprawie swobodnego przepływu takich danych oraz uchylenia dyrektywy 95/46/WE. Przetwarzanie danych obejmuje także publikację imienia i nazwiska uczestnika wraz z rokiem urodzenia i z nazwą miejscowości, w której zamieszkuje. Uczestnik ma prawo wglądu do swoich danych osobowych oraz ich poprawiania. Podanie danych osobowych oraz wyrażenie zgody na ich przetwarzanie jest dobrowolne, lecz ich niepodanie lub brak zgody na ich przetwarzanie uniemożliwia udział w biegu. Zdjęcia, nagrania filmowe oraz wywiady z uczestnikami, a także wyniki z danymi osobowymi mogą być wykorzystane przez prasę, radio, telewizję i w innych mediach.</p>
  <h2>X. POSTANOWIENIA KOŃCOWE</h2><p>Organizator zapewnia opiekę medyczną na terenie zawodów oraz zastrzega sobie prawo do wprowadzania zmian w niniejszym regulaminie. Ostateczna interpretacja regulaminu należy do organizatora. W sprawach nieujętych w regulaminie rozstrzyga organizator.</p>
</body></html>`

// The b4sport event page: its only "regulamin" is a menu item.
const NAV_SHELL_HTML = `<html><body><nav>${KOSZALIN_NAV}</nav><p>Zapisy na zawody</p></body></html>`

function stubFetch(body, { ok = true, contentType = 'text/html; charset=utf-8' } = {}) {
  return async () => ({
    ok,
    headers: { get: h => (h.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => body,
  })
}

test('verifies a real regulamin page', async () => {
  const ok = await verifyRegulaminPage('https://x.pl/mile', 'Letnie Mile Biegowe 2026', {
    fetchImpl: stubFetch(REGULAMIN_HTML),
  })
  assert.equal(ok, true)
})

test('rejects a nav shell that merely links the word Regulamin', async () => {
  const ok = await verifyRegulaminPage('https://x.pl/13036', 'Letnie Mile Biegowe 2026', {
    fetchImpl: stubFetch(NAV_SHELL_HTML),
  })
  assert.equal(ok, false)
})

test('rejects a regulamin for a different race, because 200 is not proof', async () => {
  const ok = await verifyRegulaminPage('https://x.pl/mile', 'Bieg Rzeźnika Bieszczady', {
    fetchImpl: stubFetch(REGULAMIN_HTML),
  })
  assert.equal(ok, false)
})

test('rejects a non-HTML response', async () => {
  const ok = await verifyRegulaminPage('https://x.pl/mile', 'Letnie Mile Biegowe 2026', {
    fetchImpl: stubFetch(REGULAMIN_HTML, { contentType: 'application/json' }),
  })
  assert.equal(ok, false)
})

test('rejects a non-200 response', async () => {
  const ok = await verifyRegulaminPage('https://x.pl/mile', 'Letnie Mile Biegowe 2026', {
    fetchImpl: stubFetch(REGULAMIN_HTML, { ok: false }),
  })
  assert.equal(ok, false)
})

test('a network failure drops the candidate instead of throwing', async () => {
  const ok = await verifyRegulaminPage('https://x.pl/mile', 'Letnie Mile Biegowe 2026', {
    fetchImpl: async () => { throw new Error('ECONNRESET') },
  })
  assert.equal(ok, false)
})
