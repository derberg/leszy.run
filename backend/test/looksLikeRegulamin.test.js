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

test('a long document with many sections survives some declaration furniture', () => {
  // Several genuine regulamins embed an oświadczenie as their final annex.
  const text = fixture('olawa-regulamin.txt') + '\n\nOświadczam, że zapoznałem się.\nWyrażam zgodę na przetwarzanie.\nPodpis rodzica: ....'
  assert.equal(looksLikeRegulamin(text).verdict, 'regulamin')
})
