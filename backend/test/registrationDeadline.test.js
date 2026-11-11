import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEADLINE_MAX_DAYS_BEFORE, plausibleDeadline } from '../src/lib/registrationDeadline.js'
import { AI_FILLABLE } from '../scripts/lib/ai-fillable.js'
import { deadlineAfterMove } from '../src/lib/publishDateMove.js'

// Checked at the sources on 2026-11-11 for every deadline run-data-audit
// flagged: each correct deadline sat 0–6 days before its race, each wrong one
// 132–389 days before it (the previous edition's deadline, an opening date, a
// season-pass or T-shirt cutoff, a blog post date) or after the race.

test('the window is the audit threshold', () => {
  assert.equal(DEADLINE_MAX_DAYS_BEFORE, 120)
})

test('a deadline on race day up to 120 days before it is kept as written', () => {
  assert.equal(plausibleDeadline('2026-12-19', '2026-12-19'), '2026-12-19')
  assert.equal(plausibleDeadline('2026-12-13', '2026-12-19'), '2026-12-13')
  assert.equal(plausibleDeadline('2026-08-21', '2026-12-19'), '2026-08-21') // 120 days
  assert.equal(plausibleDeadline('2026-04-13 09:40', '2026-04-20'), '2026-04-13 09:40')
  assert.equal(plausibleDeadline('2026-04-13T09:40:00Z', '2026-04-20'), '2026-04-13T09:40:00Z')
})

test('a deadline more than 120 days before the race, or after it, is dropped', () => {
  assert.equal(plausibleDeadline('2026-08-20', '2026-12-19'), null) // 121 days
  assert.equal(plausibleDeadline('2025-11-25', '2026-12-19'), null) // previous edition
  assert.equal(plausibleDeadline('2026-12-20', '2026-12-19'), null)
})

test('a missing or malformed value is dropped', () => {
  assert.equal(plausibleDeadline(null, '2026-12-19'), null)
  assert.equal(plausibleDeadline('', '2026-12-19'), null)
  assert.equal(plausibleDeadline('13.12.2026', '2026-12-19'), null)
  assert.equal(plausibleDeadline('2026-12-13', null), null)
  assert.equal(plausibleDeadline('2026-02-31', '2026-03-05'), null)
})

test('the AI-fillable validator uses the same window', () => {
  const v = AI_FILLABLE.registration_deadline.validate
  assert.equal(v('2026-12-13', { date: '2026-12-19' }), '2026-12-13')
  assert.equal(v('2026-06-01', { date: '2026-12-19' }), null)
  assert.equal(v('2027-01-05', { date: '2026-12-19' }), null)
})

test('a date move keeps a source deadline only when it is plausible for the new date', () => {
  const ce = { registration_deadline: '2026-09-20', locked_fields: [], community_locked_fields: [] }
  assert.deepEqual(deadlineAfterMove(ce, { registration_deadline: '2026-11-01' }, '2026-11-08'), { write: true, value: '2026-11-01' })
  assert.deepEqual(deadlineAfterMove(ce, { registration_deadline: '2026-05-01' }, '2026-11-08'), { write: true, value: null })
})

test('the merge and the publish carry a scraper deadline only when plausible', async () => {
  const { rowDeadline } = await import('../src/scrapers/index.js')
  assert.equal(rowDeadline({ date: '2026-12-19', registration_deadline: '2026-12-15' }), '2026-12-15')
  assert.equal(rowDeadline({ date: '2026-12-19', end_date: '2026-12-17', registration_deadline: '2026-01-01' }), '2026-12-17')
  // elektronicznezapisy 15282-style: the opening timestamp, months before the race
  assert.equal(rowDeadline({ date: '2026-12-19', end_date: '2026-04-13 09:40' }), null)
  assert.equal(rowDeadline({ date: '2026-12-19', registration_deadline: '2026-12-20' }), null)
  assert.equal(rowDeadline({ date: '2026-12-19' }), null)
})
