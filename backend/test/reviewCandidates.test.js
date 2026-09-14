import { test } from 'node:test'
import assert from 'node:assert/strict'
import { partitionCandidates, groupFindings } from '../scripts/lib/reviewAgents.js'

// A candidate without a source cannot be diagnosed. Three of the four layers the
// method traces — scraper_all, scraper_<source> and the calendar_events row — are
// all keyed on it, and the scraper file the agent is asked to read is named after
// it. On 2026-09-14 an update candidate arrived with no source, the prompt named
// backend/src/scrapers/sources/undefined.js, and the fix agent wrote an unrelated
// change against a file that does not exist.
test('a candidate with a source is diagnosable', () => {
  const c = { name: 'X', source: 'zapisyonline', source_id: '12' }
  const { diagnosable, undiagnosable } = partitionCandidates([c])
  assert.deepEqual(diagnosable, [c])
  assert.deepEqual(undiagnosable, [])
})

test('a candidate missing source or source_id is held back, not diagnosed', () => {
  const missingSource = { name: 'VII Bieg Pocztyliona', source_id: '7' }
  const missingId = { name: 'Y', source: 'datasport' }
  const blankSource = { name: 'Z', source: '   ', source_id: '9' }
  const { diagnosable, undiagnosable } = partitionCandidates([missingSource, missingId, blankSource])
  assert.deepEqual(diagnosable, [])
  assert.equal(undiagnosable.length, 3)
  for (const u of undiagnosable) assert.match(u.reason, /source/)
})

// The defect file comes back from the agent, so it is input, not fact. A path
// that no fix agent is allowed to touch is a path no fix agent should be sent to.
test('a finding naming an unusable file is not turned into a defect', () => {
  const findings = [
    { verdict: 'code-defect', defect: { layer: 'scraper', file: 'backend/src/scrapers/sources/undefined.js' }, event: {} },
    { verdict: 'code-defect', defect: { layer: 'scraper', file: 'backend/src/db/schema.js' }, event: {} },
    { verdict: 'code-defect', defect: { layer: 'scraper', file: '' }, event: {} },
  ]
  assert.deepEqual(groupFindings(findings), [])
})

test('a finding naming a real file still groups', () => {
  const findings = [
    { verdict: 'code-defect', defect: { layer: 'scraper', file: 'backend/src/scrapers/sources/b4sport.js' }, event: {} },
  ]
  const groups = groupFindings(findings)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].file, 'backend/src/scrapers/sources/b4sport.js')
})
