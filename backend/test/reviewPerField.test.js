import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeDiagnosis } from '../scripts/lib/reviewAgents.js'

// On 2026-09-18 X-RUN Wielki Finał reached the accept queue missing voivodeship,
// regulamin_url, registration_deadline and price_from. The diagnose agent was
// asked for one verdict and one defect, so it wrote about price_from and said
// nothing at all about voivodeship. No finding meant no defect, no defect meant
// no fix, and the operator was left looking at a blank column the harness had
// already been paid to explain. A diagnosis now answers per field, and a field
// the agent skipped is reported rather than dropped.

const candidate = {
  name: 'X-RUN Wielki Finał',
  date: '2026-10-04',
  source: 'biegigorskie',
  source_id: 'x-run-wielki-final-2026-10-04',
  missing_required: ['voivodeship', 'regulamin_url', 'registration_deadline', 'price_from'],
}

test('every missing field comes back with its own verdict', () => {
  const json = {
    fields: [
      { field: 'voivodeship', verdict: 'code-defect', summary: 'the city name is misspelled at source', defect: { layer: 'scraper', file: 'backend/src/scrapers/sources/biegigorskie.js' } },
      { field: 'regulamin_url', verdict: 'absent-at-source', summary: 'the portal links no rules document', defect: null },
      { field: 'registration_deadline', verdict: 'absent-at-source', summary: 'registration closes on a participant cap', defect: null },
      { field: 'price_from', verdict: 'code-defect', summary: 'the price sits on the registration page the enricher never reads', defect: { layer: 'enricher', file: 'enricher/enricher/pipeline.py' } },
    ],
  }
  const findings = normalizeDiagnosis(json, candidate)
  assert.deepEqual(findings.map((f) => f.field), candidate.missing_required)
  assert.equal(findings.find((f) => f.field === 'voivodeship').verdict, 'code-defect')
  assert.equal(findings.find((f) => f.field === 'regulamin_url').verdict, 'absent-at-source')
})

test('a field the agent never answered for is reported, not dropped', () => {
  const json = {
    fields: [
      { field: 'price_from', verdict: 'code-defect', summary: 'prices are on the product page', defect: { layer: 'enricher', file: 'enricher/enricher/pipeline.py' } },
    ],
  }
  const findings = normalizeDiagnosis(json, candidate)
  assert.equal(findings.length, 4)
  const voivodeship = findings.find((f) => f.field === 'voivodeship')
  assert.equal(voivodeship.verdict, 'needs-human')
  assert.match(voivodeship.summary, /did not answer/i)
})

test('a field the agent invented is discarded', () => {
  const json = {
    fields: [
      { field: 'website', verdict: 'absent-at-source', summary: 'no homepage', defect: null },
      { field: 'price_from', verdict: 'absent-at-source', summary: 'free race', defect: null },
    ],
  }
  const findings = normalizeDiagnosis(json, candidate)
  assert.equal(findings.some((f) => f.field === 'website'), false)
})

// The old single-verdict answer still parses, because a model that ignores the
// new schema must not take the whole event down with it.
test('a single-verdict answer is spread over the fields it claims', () => {
  const json = {
    verdict: 'absent-at-source',
    summary: 'the organizer has not configured the event page',
    missing_fields: ['regulamin_url', 'price_from'],
    defect: null,
  }
  const findings = normalizeDiagnosis(json, candidate)
  assert.equal(findings.find((f) => f.field === 'regulamin_url').verdict, 'absent-at-source')
  assert.equal(findings.find((f) => f.field === 'price_from').verdict, 'absent-at-source')
  assert.equal(findings.find((f) => f.field === 'voivodeship').verdict, 'needs-human')
})

test('an answer that is not an object leaves every field needing a human', () => {
  const findings = normalizeDiagnosis(null, candidate)
  assert.equal(findings.length, 4)
  assert.equal(findings.every((f) => f.verdict === 'needs-human'), true)
})

// Grouping happens on the defect, and a per-field finding carries the event it
// came from so a fix agent can still name the race in its commit message.
test('each finding carries the event it came from', () => {
  const findings = normalizeDiagnosis({ fields: [{ field: 'price_from', verdict: 'absent-at-source' }] }, candidate)
  for (const f of findings) {
    assert.equal(f.event.name, 'X-RUN Wielki Finał')
    assert.equal(f.event.source_id, 'x-run-wielki-final-2026-10-04')
  }
})
