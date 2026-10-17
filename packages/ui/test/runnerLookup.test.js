import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findRunners, bibCouldMatch, runnerSummary } from '../src/lib/runnerLookup.js'
import { estimatePositions } from '../src/lib/positionEstimation.js'

const people = [
  { id: 'a', bibNumber: 20, firstName: 'Łukasz', lastName: 'Marzec' },
  { id: 'b', bibNumber: 207, firstName: 'Jagoda', lastName: 'Marzec' },
  { id: 'c', bibNumber: 200, firstName: 'Marcin', lastName: 'Dorecki', deleted_at: '2026-10-01' },
]

test('a bib search matches the whole number only', () => {
  assert.deepEqual(findRunners(people, '20', 'bib').map(p => p.id), ['a'])
  assert.deepEqual(findRunners(people, '#207', 'bib').map(p => p.id), ['b'])
  assert.deepEqual(findRunners(people, '2', 'bib'), [])
})

test('a partial bib is still on its way to a real one', () => {
  assert.equal(bibCouldMatch(people, '2'), true)
  assert.equal(bibCouldMatch(people, '9'), false)
})

test('a name search ignores case and Polish letters', () => {
  assert.deepEqual(findRunners(people, 'lukasz', 'name').map(p => p.id), ['a'])
  assert.deepEqual(findRunners(people, 'MARZ', 'name').map(p => p.id), ['a', 'b'])
})

test('a name search needs two characters and skips deleted accounts', () => {
  assert.deepEqual(findRunners(people, 'm', 'name'), [])
  assert.deepEqual(findRunners(people, 'dorecki', 'name'), [])
})

const gun = '2026-10-17T07:00:00Z'
const cps = [{ id: 'cp1', name: 'Premia lotna' }, { id: 'cp2', name: 'Tuż tuż' }]
const results = [
  { id: 'r1', participantId: 'a', startTime: gun, finishTime: '2026-10-17T08:30:00Z', gunDurationMs: 5_400_000, durationMs: 5_390_000, participant: { bibNumber: 20 } },
  { id: 'r2', participantId: 'b', startTime: gun, participant: { bibNumber: 207 } },
  { id: 'r3', participantId: 'c', startTime: gun, status: 'dnf', participant: { bibNumber: 200 } },
]
const obs = [
  { checkpointId: 'cp1', participantId: null, bibNumber: 207, observedAt: '2026-10-17T07:58:12Z' },
]

test('a finisher gets place and both times', () => {
  const s = runnerSummary(estimatePositions(results, cps, obs), 'a', cps, obs, gun)
  assert.deepEqual(s, { positionType: 'final', position: 1, gunDurationMs: 5_400_000, durationMs: 5_390_000, lastCheckpoint: null })
})

test('a runner on course gets the furthest checkpoint, matched by bib, with no place', () => {
  const s = runnerSummary(estimatePositions(results, cps, obs), 'b', cps, obs, gun)
  assert.equal(s.positionType, 'checkpoint')
  assert.equal(s.position, null)
  assert.deepEqual(s.lastCheckpoint, { name: 'Premia lotna', splitMs: 58 * 60_000 + 12_000 })
})

test('an unranked runner gets no place, and a missing runner gets nothing', () => {
  const ranked = estimatePositions(results, cps, obs)
  assert.equal(runnerSummary(ranked, 'c', cps, obs, gun).position, null)
  assert.equal(runnerSummary(ranked, 'zzz', cps, obs, gun), null)
})
