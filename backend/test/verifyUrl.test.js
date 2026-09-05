import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildVerifyPrompt,
  parseVerdicts,
  verifySearchUrls,
} from '../scripts/lib/verify-url.js'

const EVENT = {
  id: 'row-1',
  name: 'Bieg Nadziei',
  date: '2026-10-11',
  location: 'Poznań',
  voivodeship: 'Wielkopolskie',
  distances: '5 km, 10 km',
}

function stubRunner(text, extra = {}) {
  const calls = []
  const run = async prompt => {
    calls.push(prompt)
    return { text, costUsd: 0.01, inputTokens: 100, outputTokens: 20, ...extra }
  }
  run.calls = calls
  return run
}

test('a match verdict keeps the URL', async () => {
  const runClaude = stubRunner(JSON.stringify({
    regulamin_url: { verdict: 'match', confidence: 0.93, reasoning: 'Name, 2026 and Poznań all on the page.' },
  }))
  const res = await verifySearchUrls(
    EVENT, { regulamin_url: 'https://example.pl/regulamin.pdf' }, { runClaude }
  )
  assert.deepEqual(res.kept, { regulamin_url: 'https://example.pl/regulamin.pdf' })
  assert.equal(res.dropped.length, 0)
  assert.equal(res.costUsd, 0.01)
})

test('a mismatch verdict drops the URL', async () => {
  const runClaude = stubRunner(JSON.stringify({
    regulamin_url: { verdict: 'mismatch', confidence: 0.9, reasoning: 'Page is the 2025 edition.' },
  }))
  const res = await verifySearchUrls(
    EVENT, { regulamin_url: 'https://example.pl/regulamin-2025.pdf' }, { runClaude }
  )
  assert.deepEqual(res.kept, {})
  assert.equal(res.dropped.length, 1)
  assert.equal(res.dropped[0].field, 'regulamin_url')
  assert.match(res.dropped[0].reasoning, /2025/)
})

test('an uncertain verdict drops the URL', async () => {
  const runClaude = stubRunner(JSON.stringify({
    registration_url: { verdict: 'uncertain', confidence: 0.5, reasoning: 'Cannot tell.' },
  }))
  const res = await verifySearchUrls(
    EVENT, { registration_url: 'https://example.pl/zapisy' }, { runClaude }
  )
  assert.deepEqual(res.kept, {})
  assert.equal(res.dropped.length, 1)
})

test('each field is judged on its own', async () => {
  const runClaude = stubRunner(JSON.stringify({
    registration_url: { verdict: 'match', confidence: 0.9, reasoning: 'ok' },
    regulamin_url: { verdict: 'mismatch', confidence: 0.9, reasoning: 'different race' },
  }))
  const res = await verifySearchUrls(EVENT, {
    registration_url: 'https://example.pl/zapisy',
    regulamin_url: 'https://wrong.pl/reg.pdf',
  }, { runClaude })
  assert.deepEqual(res.kept, { registration_url: 'https://example.pl/zapisy' })
  assert.equal(res.dropped.length, 1)
  assert.equal(res.dropped[0].field, 'regulamin_url')
})

test('unparseable output drops every candidate', async () => {
  const runClaude = stubRunner('I could not fetch those pages, sorry.')
  const res = await verifySearchUrls(EVENT, {
    registration_url: 'https://example.pl/zapisy',
    regulamin_url: 'https://example.pl/reg.pdf',
  }, { runClaude })
  assert.deepEqual(res.kept, {})
  assert.equal(res.dropped.length, 2)
  for (const d of res.dropped) assert.equal(d.verdict, 'mismatch')
})

test('a field the verifier omitted is dropped, not kept', async () => {
  const runClaude = stubRunner(JSON.stringify({
    registration_url: { verdict: 'match', confidence: 0.9, reasoning: 'ok' },
  }))
  const res = await verifySearchUrls(EVENT, {
    registration_url: 'https://example.pl/zapisy',
    regulamin_url: 'https://example.pl/reg.pdf',
  }, { runClaude })
  assert.deepEqual(res.kept, { registration_url: 'https://example.pl/zapisy' })
  assert.equal(res.dropped.length, 1)
  assert.equal(res.dropped[0].field, 'regulamin_url')
})

test('an invented verdict name is treated as a rejection', () => {
  const out = parseVerdicts(JSON.stringify({
    regulamin_url: { verdict: 'probably_fine', confidence: 0.99, reasoning: 'trust me' },
  }), ['regulamin_url'])
  assert.equal(out.regulamin_url.verdict, 'mismatch')
  assert.equal(out.regulamin_url.confidence, 0)
})

test('a crashed verifier drops every candidate', async () => {
  const runClaude = async () => { throw new Error('claude exited with code 1') }
  const res = await verifySearchUrls(EVENT, { regulamin_url: 'https://example.pl/reg.pdf' }, { runClaude })
  assert.deepEqual(res.kept, {})
  assert.equal(res.dropped.length, 1)
  assert.match(res.dropped[0].reasoning, /Verifier failed/)
})

test('no candidates means no subprocess and no cost', async () => {
  const runClaude = stubRunner('{}')
  const res = await verifySearchUrls(EVENT, {}, { runClaude })
  assert.deepEqual(res.kept, {})
  assert.deepEqual(res.dropped, [])
  assert.equal(res.costUsd, 0)
  assert.equal(runClaude.calls.length, 0)
})

test('a null URL is not sent for verification', async () => {
  const runClaude = stubRunner('{}')
  const res = await verifySearchUrls(EVENT, { registration_url: null }, { runClaude })
  assert.deepEqual(res.kept, {})
  assert.equal(runClaude.calls.length, 0)
})

test('confidence outside 0..1 is clamped', () => {
  const out = parseVerdicts(JSON.stringify({
    a: { verdict: 'match', confidence: 4.2, reasoning: 'x' },
    b: { verdict: 'match', confidence: -1, reasoning: 'x' },
  }), ['a', 'b'])
  assert.equal(out.a.confidence, 1)
  assert.equal(out.b.confidence, 0)
})

test('output wrapped in a code fence still parses', () => {
  const out = parseVerdicts(
    '```json\n{"regulamin_url": {"verdict": "match", "confidence": 0.8, "reasoning": "ok"}}\n```',
    ['regulamin_url']
  )
  assert.equal(out.regulamin_url.verdict, 'match')
})

test('the prompt tells the verifier not to search and not to replace', () => {
  const prompt = buildVerifyPrompt(EVENT, { regulamin_url: 'https://example.pl/reg.pdf' })
  assert.match(prompt, /Do not search the web/)
  assert.match(prompt, /Do not propose a replacement URL/)
})

test('the prompt names the year so a wrong edition can be caught', () => {
  const prompt = buildVerifyPrompt(EVENT, { regulamin_url: 'https://example.pl/reg.pdf' })
  assert.match(prompt, /year: 2026/)
  assert.match(prompt, /different year is a mismatch/)
})

test('the prompt carries every URL under review', () => {
  const prompt = buildVerifyPrompt(EVENT, {
    registration_url: 'https://example.pl/zapisy',
    regulamin_url: 'https://example.pl/reg.pdf',
  })
  assert.match(prompt, /registration_url: https:\/\/example\.pl\/zapisy/)
  assert.match(prompt, /regulamin_url: https:\/\/example\.pl\/reg\.pdf/)
})
