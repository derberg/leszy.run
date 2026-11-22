// Run: node --test frontend/src/lib/teamLapReview.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { possiblyMissedLaps, needsDecision, MISSED_LAP_FACTOR, MISSED_LAP_MIN_LAPS } from './teamLapReview.js'

const min = 60_000
// Counted laps of one team with their lap times (legMs from computeTeamResults).
const lap = (id, legMs, over = {}) => ({ id, teamId: 'T', status: 'counted', participantId: 'p1', legMs, ...over })

test('a counted lap over 1.7 times the team median is a possibly missed lap', () => {
  const laps = [lap('a', 10 * min), lap('b', 11 * min), lap('c', 21 * min), lap('d', 10 * min)]
  assert.deepEqual([...possiblyMissedLaps(laps)], ['c'])
})

test('the factor is a strict bound: exactly 1.7 times the median is not flagged', () => {
  assert.equal(MISSED_LAP_FACTOR, 1.7)
  const laps = [lap('a', 10 * min), lap('b', 10 * min), lap('c', 17 * min)]
  assert.deepEqual([...possiblyMissedLaps(laps)], [])
})

test('fewer than three counted laps: no median to judge by, nothing flagged', () => {
  assert.equal(MISSED_LAP_MIN_LAPS, 3)
  assert.deepEqual([...possiblyMissedLaps([lap('a', 10 * min), lap('b', 40 * min)])], [])
})

test('candidates, removed laps and laps with no time neither count toward the median nor get flagged', () => {
  const laps = [
    lap('a', 10 * min), lap('b', 10 * min), lap('c', 30 * min),
    lap('x', 2 * min, { status: 'candidate' }),
    lap('y', 1 * min, { deletedAt: '2026-11-21T10:00:00Z' }),
    lap('z', null),
  ]
  assert.deepEqual([...possiblyMissedLaps(laps)], ['c'])
  // Without them the team has two counted laps with a time: nothing to judge.
  assert.deepEqual([...possiblyMissedLaps(laps.filter(l => l.id !== 'a'))], [])
})

test('teams are judged by their own median', () => {
  const laps = [
    lap('a', 10 * min), lap('b', 10 * min), lap('c', 18 * min),
    lap('d', 18 * min, { teamId: 'U' }), lap('e', 18 * min, { teamId: 'U' }), lap('f', 19 * min, { teamId: 'U' }),
  ]
  assert.deepEqual([...possiblyMissedLaps(laps)], ['c'])
})

test('a possibly missed lap waits for a decision until it is approved', () => {
  const flagged = new Set(['c'])
  assert.equal(needsDecision(lap('c', 30 * min), flagged), true)
  assert.equal(needsDecision(lap('c', 30 * min, { reviewedAt: '2026-11-21T10:00:00Z' }), flagged), false)
  assert.equal(needsDecision(lap('c', 30 * min, { deletedAt: '2026-11-21T10:00:00Z' }), flagged), false)
  assert.equal(needsDecision(lap('a', 10 * min), flagged), false)
  // The existing rules stand without the set.
  assert.equal(needsDecision(lap('n', 10 * min, { participantId: null })), true)
  assert.equal(needsDecision(lap('k', null, { status: 'candidate' })), true)
})
