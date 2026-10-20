// Run: node --test frontend/src/lib/chipTie.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chipTies, chipTieCount, chipTieSpreadMs, finishToLeadGroup } from './chipTie.js'

const at = (hms) => `2026-10-17T${hms}Z`
const row = (id, finish, extra = {}) => ({ id, raceRunId: 'run', finishTime: finish ? at(finish) : null, status: 'finished', ...extra })

// Wilczy Półmaraton 2026-10-17, Canicross 21 km
const wilczy = () => [
  row('206', '08:53:22.440'),
  row('203', '08:57:04.673'),
  row('201', '08:57:04.701'),
  row('204', '09:03:16.455'),
  row('210', '09:32:49.437'),
  row('217', '09:32:49.751'),
]

test('the 2026-10-17 pairs are flagged and nobody else', () => {
  const ties = chipTies(wilczy())
  assert.deepEqual([...ties.keys()].sort(), ['201', '203', '210', '217'])
  assert.equal(chipTieCount(ties), 2)
  assert.equal(chipTieSpreadMs(ties.get('201')), 28)
  assert.deepEqual(ties.get('203').map(r => r.id), ['203', '201'])
})

test('finishes 500 ms apart are not a tie', () => {
  assert.equal(chipTies([row('a', '10:00:00.000'), row('b', '10:00:00.500')]).size, 0)
  assert.equal(chipTies([row('a', '10:00:00.000'), row('b', '10:00:00.499')]).size, 2)
})

test('a chain of close finishes is one group', () => {
  const ties = chipTies([row('a', '10:00:00.000'), row('b', '10:00:00.400'), row('c', '10:00:00.800')])
  assert.equal(chipTieCount(ties), 1)
  assert.equal(chipTieSpreadMs(ties.get('c')), 800)
})

test('runners of different race runs never tie', () => {
  const ties = chipTies([row('a', '10:00:00.000'), row('b', '10:00:00.100', { raceRunId: 'other' })])
  assert.equal(ties.size, 0)
})

test('DNS, DNF and DSQ results and runners with no finish are left out', () => {
  for (const status of ['dns', 'dnf', 'dsq']) {
    assert.equal(chipTies([row('a', '10:00:00.000'), row('b', '10:00:00.100', { status })]).size, 0)
  }
  assert.equal(chipTies([row('a', '10:00:00.000'), row('b', null)]).size, 0)
})

test('a group with a finish set by hand is settled', () => {
  const ties = chipTies([row('a', '10:00:00.000'), row('b', '10:00:00.100', { manualOverride: true })])
  assert.equal(ties.size, 0)
})

test('choosing 201 first puts her 1 ms ahead of 203', () => {
  const group = chipTies(wilczy()).get('201')
  const [r203, r201] = group
  assert.equal(finishToLeadGroup(group, r201), at('08:57:04.672'))
  assert.equal(finishToLeadGroup(group, r203), at('08:57:04.673'))
})
