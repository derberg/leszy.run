import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  pickRegulaminUrl,
  pickRegulaminFromDom,
  scoreRegulaminCandidate,
} from '../src/lib/pickRegulaminUrl.js'
import * as cheerio from 'cheerio'

const ZMC = 'https://www.zmierzymyczas.pl'

// Every URL below is a REAL value observed in scraper_all on 2026-09-11.
// The "bad" list is what the old pickers actually wrote as regulamin_url.
const CONSENT_FORMS = [
  '/images/regulaminy/20260920_Olawa_-_oswiadczenie_rodzica_opiekuna.pdf',
  '/images/regulaminy/20260920_Olawa_-_oswiadczenie_uczestnika.pdf',
  '/images/regulaminy/20260501_Jelcz-Laskowice_-_Memorial_Barbary_Szlachetki_2026_oswiadczenie_dla_osoby_niepelnoletniej.pdf',
  '/images/regulaminy/20260517_Wrocław_-_zgoda_rodzica.pdf',
  '/images/regulaminy/20260523_MTS_-_oświadczenie_dla_zawodnika_niepelnoletniego_WYŚCIG_2026.pdf',
  '/images/regulaminy/20260523_MTS_-_zgoda_wizerunek_dla_osoby_małoletniej_RAJD_2026.pdf',
  '/images/regulaminy/20260501_Krapkowice_-_KNW_Karta_zgłoszenia_-_oświadczenia_puste.pdf',
  '/images/regulaminy/3_Oświadczenie_rodzica-opiekuna_prawnego_1.pdf',
  '/images/regulaminy/XI_BS_JL_-_zgoda_na_pobranie_pakietu_startowego.pdf',
  '/images/regulaminy/Mapa_Lewin_Biega-skonwertowany.pdf',
]

// Real regulamins whose NAME also contains a deny-list word. These are the
// false positives a naive deny-list throws away.
const REAL_BUT_LOOKS_SUSPECT = [
  'https://kepasport.pl/wp-content/uploads/2026/04/Regulamin_Rynek_Mocy_RODO.pdf',
  'https://panel.maratonczykpomiarczasu.pl/sites/default/files/regulamin/Bieg%20prze%C5%82ajowy%20Pami%C4%99ci%20Batalionu%20Obrony%20Narodowej%20%E2%80%9CNak%C5%82o%E2%80%9D%20-%20REGULAMIN.pdf',
  'https://panel.maratonczykpomiarczasu.pl/sites/default/files/u22/REGULAMIN%20-%20XX%20Mi%C4%99dzynarodowy%20Ko%C5%9Bcia%C5%84ski%20P%C3%B3%C5%82maraton.pdf',
]

test('rejects every consent form / map that was written as a regulamin', () => {
  for (const href of CONSENT_FORMS) {
    assert.equal(scoreRegulaminCandidate({ href }), null, href)
    assert.equal(pickRegulaminUrl([{ href }], { baseUrl: ZMC }), null, href)
  }
})

test('keeps real regulamins whose name also contains a deny word', () => {
  for (const href of REAL_BUT_LOOKS_SUSPECT) {
    assert.ok(scoreRegulaminCandidate({ href }) >= 3, href)
    assert.equal(pickRegulaminUrl([{ href }]), href)
  }
})

test('Oława: picks the regulamin regardless of DOM order', () => {
  // The regression: zmierzymyczas linked the regulamin first and the consent
  // form second, and the old picker kept the LAST match.
  const regulamin = '/images/regulaminy/20260614_Oława_-_regulamin_CPR_2026_DLA_DZIECI.pdf'
  const consent = '/images/regulaminy/20260920_Olawa_-_oswiadczenie_rodzica_opiekuna.pdf'
  // Polish characters come back percent-encoded — verified live: that form
  // fetches 200 application/pdf from zmierzymyczas.
  const expected =
    `${ZMC}/images/regulaminy/20260614_O%C5%82awa_-_regulamin_CPR_2026_DLA_DZIECI.pdf`

  assert.equal(
    pickRegulaminUrl([{ href: regulamin }, { href: consent }], { baseUrl: ZMC }),
    expected,
  )
  assert.equal(
    pickRegulaminUrl([{ href: consent }, { href: regulamin }], { baseUrl: ZMC }),
    expected,
  )
})

test('a path segment that merely contains a deny word does not disqualify', () => {
  // datasport regulamins live under /zapisy/portal/regulaminy/.
  const href = 'https://online.datasport.pl/zapisy/portal/regulaminy/regulamin_12496.pdf'
  assert.equal(pickRegulaminUrl([{ href }]), href)
})

test('anchor text carries the evidence when the filename does not', () => {
  const href = 'https://example.pl/files/doc-9931.pdf'
  assert.equal(pickRegulaminUrl([{ href }]), null)
  assert.equal(pickRegulaminUrl([{ href, text: 'Regulamin biegu' }]), href)
})

test('a deny-list anchor label rejects an otherwise neutral filename', () => {
  const href = 'https://example.pl/files/doc-9931.pdf'
  assert.equal(pickRegulaminUrl([{ href, text: 'Oświadczenie rodzica' }]), null)
})

test('requireToken:false accepts an opaque download URL from a labelled section', () => {
  // elektronicznezapisy.pl download links carry no token anywhere.
  const href = 'https://elektronicznezapisy.pl/download/a7h048e8R0m041P7D8c4s849q8u7C092/open'
  assert.equal(pickRegulaminUrl([{ href }]), null)
  assert.equal(pickRegulaminUrl([{ href }], { requireToken: false }), href)
})

test('requireToken:false still rejects a known non-regulamin document', () => {
  const href = 'https://example.pl/download/oswiadczenie_rodzica.pdf'
  assert.equal(pickRegulaminUrl([{ href }], { requireToken: false }), null)
})

test('prefers a PDF over a landing page at equal textual evidence', () => {
  const page = 'https://example.pl/regulamin'
  const pdf = 'https://example.pl/regulamin.pdf'
  assert.equal(pickRegulaminUrl([{ href: page }, { href: pdf }]), pdf)
})

test('pickRegulaminFromDom reads hrefs and labels out of a page', () => {
  const $ = cheerio.load(`
    <div id="docs">
      <a href="/images/regulaminy/20260920_Olawa_-_oswiadczenie_rodzica_opiekuna.pdf">Oświadczenie</a>
      <a href="/images/regulaminy/20260614_Olawa_-_regulamin_CPR_2026.pdf">Regulamin</a>
    </div>
    <a href="/elsewhere/regulamin_innego_biegu.pdf">Regulamin</a>
  `)
  assert.equal(
    pickRegulaminFromDom($, { root: '#docs', baseUrl: ZMC }),
    `${ZMC}/images/regulaminy/20260614_Olawa_-_regulamin_CPR_2026.pdf`,
  )
})

test('returns null on an empty candidate list', () => {
  assert.equal(pickRegulaminUrl([], { baseUrl: ZMC }), null)
  assert.equal(pickRegulaminUrl(undefined), null)
})
