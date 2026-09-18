import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { looksLikeRegulamin } from '../src/lib/looksLikeRegulamin.js'

const fixture = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf-8')

test('accepts a real race regulamin', () => {
  // The document the Oława kids race SHOULD have been enriched from — it carries
  // "Obowiązuje opłata startowa 25zł" and a 4-days-before entry deadline.
  const r = looksLikeRegulamin(fixture('olawa-regulamin.txt'))
  assert.equal(r.verdict, 'regulamin')
  assert.ok(r.sections >= 8)
})

test('rejects the parental consent form that was enriched instead', () => {
  // The regression: this is what regulamin_url actually pointed at, and the LLM
  // invented a 0–500 zł price range from it. Note it DOES contain the word
  // "regulaminu" ("zapoznałem się z treścią regulaminu"), so a keyword test
  // passes it — only the structural test rejects it.
  const text = fixture('olawa-consent-form.txt')
  assert.match(text, /regulamin/i)
  const r = looksLikeRegulamin(text)
  assert.equal(r.verdict, 'not-regulamin')
})

test('rejects a regulamin for the wrong thing entirely', () => {
  // Turbacz Trail (b4sport) has the Gorczański National Park's VISITOR
  // regulations as its regulamin_url. It is a real "regulamin", just not the
  // race's — a filename gate can never catch this, the text test does.
  const r = looksLikeRegulamin(fixture('gorce-park-visitor-rules.txt'))
  assert.equal(r.verdict, 'not-regulamin')
})

test('returns unknown — never not-regulamin — when there is too little text', () => {
  // A scanned PDF (zapisyonline) or a link-hub PDF (foxter) extracts to almost
  // nothing. Those must not be nulled: we cannot read them, which is not the
  // same as knowing they are wrong.
  for (const text of ['', '   ', 'Regulamin Biegu 10 km\nRegulamin Marszu Nordic Walking']) {
    const r = looksLikeRegulamin(text)
    assert.equal(r.verdict, 'unknown', JSON.stringify(text))
  }
})

test('accepts a regulamin published in English', () => {
  // Silesia 5K RUN 2026 (datasport:12741). pickRegulaminUrl landed on the site's
  // English translation, /en/regulamin-silesia-5k-run-2026/. It is the full
  // document — organiser, route, entry fee, registration deadline, race office,
  // time limit, classifications, final provisions — but the Polish-only stems
  // matched one section out of twelve, so the row was skipped and shipped with
  // registration_deadline and price_from null.
  const text = fixture('silesia-5k-en-regulamin.txt')
  assert.match(text, /PLN 79 – before September 13th, 2026/)
  assert.match(text, /until September 13th, 2026, or until the limit of spots is filled/)
  const r = looksLikeRegulamin(text)
  assert.equal(r.verdict, 'regulamin')
  assert.ok(r.sections >= 8, `sections=${r.sections}`)
})

test('an English consent form is still rejected', () => {
  // The English patterns must not reopen the hole they close: a translated
  // oświadczenie quotes the race name and the word regulations and nothing else.
  const text = [
    'CONSENT OF A LEGAL GUARDIAN',
    'I hereby declare that I have read the Terms and Conditions of the race and accept them.',
    'I consent to the participation of my child in the run and to the processing of personal data.',
    'I declare that there are no medical contraindications to taking part.',
    'Name and surname of the minor: ..............................................',
    'Signature of the parent or legal guardian: ..................................',
    'The above consent is submitted at the start.',
  ].join('\n').padEnd(1200, ' .')
  assert.equal(looksLikeRegulamin(text).verdict, 'not-regulamin')
})

test('a long document with many sections survives some declaration furniture', () => {
  // Several genuine regulamins embed an oświadczenie as their final annex.
  const text = fixture('olawa-regulamin.txt') + '\n\nOświadczam, że zapoznałem się.\nWyrażam zgodę na przetwarzanie.\nPodpis rodzica: ....'
  assert.equal(looksLikeRegulamin(text).verdict, 'regulamin')
})
