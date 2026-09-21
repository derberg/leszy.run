import { test } from 'node:test'
import assert from 'node:assert/strict'
import { unsettledFields, settledVerdicts, verdictKey } from '../scripts/lib/reviewAgents.js'

// An agent proved on 2026-09-18 that foxter's Mentor page publishes no distances
// and no regulamin, and that proof went into a JSON log nobody opens. The next
// run paid another agent to reach the same answer, and the operator kept seeing
// an unexplained blank column. A verdict is now recorded, so the harness stops
// re-asking and the queue can say why the column is empty.

const DAY = 24 * 60 * 60 * 1000
const now = new Date('2026-09-21T09:00:00Z')
const ago = (days) => new Date(now.getTime() - days * DAY).toISOString()

const mentor = {
  source: 'foxter',
  source_id: 'mentor',
  missing_required: ['distances', 'regulamin_url', 'registration_deadline', 'price_from'],
}

test('a field is keyed by the row it belongs to', () => {
  assert.equal(verdictKey({ source: 'foxter', source_id: 'mentor', field: 'distances' }), 'foxter|mentor|distances')
})

test('a fresh absent-at-source verdict settles its field', () => {
  const verdicts = settledVerdicts([
    { source: 'foxter', source_id: 'mentor', field: 'distances', verdict: 'absent-at-source', decided_at: ago(3) },
  ], { now })
  const open = unsettledFields(mentor, verdicts, { now })
  assert.equal(open.includes('distances'), false)
  assert.deepEqual(open, ['regulamin_url', 'registration_deadline', 'price_from'])
})

// An organizer who has published nothing today may publish next month, so a
// verdict expires. Otherwise one early answer hides a race that has since been
// filled in, for as long as the event exists.
test('a stale verdict stops settling its field', () => {
  const verdicts = settledVerdicts([
    { source: 'foxter', source_id: 'mentor', field: 'distances', verdict: 'absent-at-source', decided_at: ago(45) },
  ], { now })
  assert.equal(unsettledFields(mentor, verdicts, { now }).includes('distances'), true)
})

// A code-defect is not settled by recording it. The fix either landed, in which
// case the field fills and the event stops being a candidate, or it did not, in
// which case the event deserves another look.
test('a code-defect verdict never settles a field', () => {
  const verdicts = settledVerdicts([
    { source: 'foxter', source_id: 'mentor', field: 'distances', verdict: 'code-defect', decided_at: ago(1) },
  ], { now })
  assert.equal(unsettledFields(mentor, verdicts, { now }).includes('distances'), true)
})

test('a verdict for another event settles nothing here', () => {
  const verdicts = settledVerdicts([
    { source: 'egepard', source_id: '1697', field: 'distances', verdict: 'absent-at-source', decided_at: ago(1) },
  ], { now })
  assert.equal(unsettledFields(mentor, verdicts, { now }).includes('distances'), true)
})

test('an event whose every missing field is settled has nothing left to diagnose', () => {
  const rows = mentor.missing_required.map((field) => ({
    source: 'foxter', source_id: 'mentor', field, verdict: 'absent-at-source', decided_at: ago(2),
  }))
  assert.deepEqual(unsettledFields(mentor, settledVerdicts(rows, { now }), { now }), [])
})
