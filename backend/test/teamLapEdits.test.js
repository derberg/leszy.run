import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lapEdit } from '../src/lib/teamLapEdits.js'

const NOW = new Date('2026-12-06T11:00:00Z')
const run = { id: 'rr', startedAt: '2026-12-06T10:00:00Z', category: { id: 'c', teamMode: 'relay_free' } }
const p = (over = {}) => ({ id: 'p1', teamId: 'T', categoryId: 'c', ...over })
const lap = { teamId: 'T', participantId: 'p1' }

test('a new lap: team from the runner, manual source, time defaults to now', () => {
  const out = lapEdit({ run, participant: p(), lap: null, body: {}, now: NOW })
  assert.deepEqual(out.values, { participantId: 'p1', teamId: 'T', closedAt: NOW, source: 'manual' })
})

test('only in a relay in any order, and only after the gun', () => {
  assert.equal(lapEdit({ run: { ...run, category: { id: 'c', teamMode: 'relay' } }, participant: p(), lap: null, body: {}, now: NOW }).status, 409)
  assert.equal(lapEdit({ run: { ...run, startedAt: null }, participant: p(), lap: null, body: {}, now: NOW }).status, 409)
})

test('the runner must be in a team of this category and not removed', () => {
  assert.equal(lapEdit({ run, participant: p({ teamId: null }), lap: null, body: {}, now: NOW }).status, 422)
  assert.equal(lapEdit({ run, participant: p({ categoryId: 'x' }), lap: null, body: {}, now: NOW }).status, 422)
  assert.equal(lapEdit({ run, participant: p({ removedAt: NOW }), lap: null, body: {}, now: NOW }).status, 422)
  assert.equal(lapEdit({ run, participant: null, lap: null, body: {}, now: NOW }).status, 400)
})

test('a lap moves only to a teammate', () => {
  assert.equal(lapEdit({ run, participant: p({ id: 'p2', teamId: 'U' }), lap, body: { participantId: 'p2' }, now: NOW }).status, 422)
  assert.deepEqual(lapEdit({ run, participant: p({ id: 'p2' }), lap, body: { participantId: 'p2' }, now: NOW }).values,
    { participantId: 'p2', teamId: 'T' })
})

test('the time must fall between the gun and now', () => {
  assert.equal(lapEdit({ run, participant: null, lap, body: { closedAt: '2026-12-06T09:59:00Z' }, now: NOW }).status, 422)
  assert.equal(lapEdit({ run, participant: null, lap, body: { closedAt: '2026-12-06T11:05:00Z' }, now: NOW }).status, 422)
  assert.equal(lapEdit({ run, participant: null, lap, body: { closedAt: 'nonsense' }, now: NOW }).status, 400)
  assert.deepEqual(lapEdit({ run, participant: null, lap, body: { closedAt: '2026-12-06T10:30:00Z' }, now: NOW }).values,
    { closedAt: new Date('2026-12-06T10:30:00Z') })
})

test('remove and restore', () => {
  assert.deepEqual(lapEdit({ run, participant: null, lap, body: { deleted: true }, now: NOW }).values, { deletedAt: NOW })
  assert.deepEqual(lapEdit({ run, participant: null, lap, body: { deleted: false }, now: NOW }).values, { deletedAt: null })
})

test('a candidate lap is approved with status counted; a counted one is 409', () => {
  assert.deepEqual(lapEdit({ run, participant: null, lap: { ...lap, status: 'candidate' }, body: { status: 'counted' }, now: NOW }).values, { status: 'counted' })
  const out = lapEdit({ run, participant: null, lap: { ...lap, status: 'counted' }, body: { status: 'counted' }, now: NOW })
  assert.equal(out.status, 409)
  assert.equal(out.error, 'To okrążenie jest już liczone.')
})

test('reviewed sets or clears reviewedAt', () => {
  assert.deepEqual(lapEdit({ run, participant: null, lap, body: { reviewed: true }, now: NOW }).values, { reviewedAt: NOW })
  assert.deepEqual(lapEdit({ run, participant: null, lap, body: { reviewed: false }, now: NOW }).values, { reviewedAt: null })
})

test('participantId null clears the runner and keeps the team in any relay in any order', () => {
  // team_lap_source is deprecated and never read: 'runner' stored changes nothing.
  for (const category of [run.category, { ...run.category, teamLapSource: 'runner' }]) {
    assert.deepEqual(lapEdit({ run: { ...run, category }, participant: null, lap, body: { participantId: null }, now: NOW }).values, { participantId: null })
  }
})

test('reviewed must be a boolean', () => {
  for (const reviewed of ['yes', 1, null, {}]) {
    const out = lapEdit({ run, participant: null, lap, body: { reviewed }, now: NOW })
    assert.equal(out.status, 400, JSON.stringify(reviewed))
    assert.equal(out.error, 'Nieprawidłowa wartość zatwierdzenia.')
  }
})

test('an unknown status is refused in operator Polish', () => {
  const out = lapEdit({ run, participant: null, lap: { ...lap, status: 'candidate' }, body: { status: 'maybe' }, now: NOW })
  assert.equal(out.status, 400)
  assert.equal(out.error, 'Nieprawidłowy status okrążenia.')
})
