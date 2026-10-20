// Run: node --test frontend/src/lib/chipTie.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chipTies, chipTieCount, chipTieSpreadMs, finishToLeadGroup, frameWallMs, nearestFrameIndex, sessionAt } from './chipTie.js'

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

// Session d24c81ea at Wilczy Półmaraton 2026-10-17: frames every 200 ms.
const OFFSET = 1792216734.9973624
const frames = ['10689400700000', '10689600690000', '10689800682000', '10690000656000']

test('a frame stamp maps to wall time through the clock offset', () => {
  assert.equal(new Date(Math.round(frameWallMs(frames[0], OFFSET))).toISOString(), '2026-10-17T08:57:04.398Z')
})

test('the frame nearest 203 and 201 at the line', () => {
  assert.equal(nearestFrameIndex(frames, OFFSET, Date.parse(at('08:57:04.673'))), 1) // frame at .598
  assert.equal(nearestFrameIndex(frames, OFFSET, Date.parse(at('08:57:04.701'))), 2) // frame at .798
  assert.equal(nearestFrameIndex([], OFFSET, 0), -1)
})

test('the session recording at the finish is picked, not the later replay', () => {
  const sessions = [
    { id: 'replay', clockOffset: OFFSET, startedAt: '2026-10-17T21:01:14Z', stoppedAt: '2026-10-18T09:50:40Z' },
    { id: 'race', clockOffset: OFFSET, startedAt: '2026-10-17T06:38:47Z', stoppedAt: '2026-10-17T15:49:28Z' },
    { id: 'open', clockOffset: null, startedAt: '2026-10-17T06:00:00Z', stoppedAt: null },
  ]
  assert.equal(sessionAt(sessions, Date.parse(at('08:57:04.673'))).id, 'race')
  assert.equal(sessionAt(sessions, Date.parse('2026-10-19T00:00:00Z')), null)
})
