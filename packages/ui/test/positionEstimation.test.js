import { test } from 'node:test'
import assert from 'node:assert/strict'
import { estimatePositions } from '../src/lib/positionEstimation.js'

const CHECKPOINTS = [
  { id: 'cp-5', name: '5km', kmMarker: 5 },
  { id: 'cp-10', name: '10km', kmMarker: 10 },
]

function result(bib, over = {}) {
  return {
    id: `r-${bib}`,
    participantId: `p-${bib}`,
    startTime: null,
    finishTime: null,
    gunDurationMs: null,
    status: 'started',
    participant: { bibNumber: bib, firstName: 'A', lastName: String(bib) },
    ...over,
  }
}

const byBib = (rows) => Object.fromEntries(rows.map(r => [r.participant.bibNumber, r]))

// A DNS runner never left the start line, so a checkpoint observation for their
// bib is always bogus (mistyped bib on the volunteer numpad, stray RFID read).
// Nocny Zew Wilka 2026-08-07: bib 1 was DNS and got a manual 5 km entry, which
// ranked him above every runner who was actually on course.
test('DNS: a checkpoint observation does not rank the runner as on-course', () => {
  const rows = estimatePositions(
    [
      result(1, { status: 'dns' }),
      result(2, { startTime: '2026-08-07T18:40:00Z' }),
    ],
    CHECKPOINTS,
    [{ checkpointId: 'cp-5', participantId: 'p-1', observedAt: '2026-08-07T19:01:15Z' }],
  )

  const r1 = byBib(rows)[1]
  const r2 = byBib(rows)[2]
  assert.equal(r1.positionType, 'dns')
  assert.equal(r2.positionType, 'started')
  assert.ok(
    r2.estimatedPosition < r1.estimatedPosition,
    `runner who started (pos ${r2.estimatedPosition}) must outrank the DNS runner (pos ${r1.estimatedPosition})`,
  )
})

test('DNS: the observation is dropped, so consumers cannot render it as a split', () => {
  const rows = estimatePositions(
    [result(1, { status: 'dns' })],
    CHECKPOINTS,
    [{ checkpointId: 'cp-5', participantId: 'p-1', observedAt: '2026-08-07T19:01:15Z' }],
  )
  assert.equal(rows[0]._obs, undefined)
})

test('DNS: observations resolved by bib number are dropped too', () => {
  const rows = estimatePositions(
    [
      result(1, { status: 'dns' }),
      result(2, { startTime: '2026-08-07T18:40:00Z' }),
    ],
    CHECKPOINTS,
    [{ checkpointId: 'cp-5', bibNumber: 1, participantId: null, observedAt: '2026-08-07T19:01:15Z' }],
  )
  const r1 = byBib(rows)[1]
  assert.equal(r1._obs, undefined)
  assert.ok(byBib(rows)[2].estimatedPosition < r1.estimatedPosition)
})

// DNF and DSQ runners WERE on course, so their splits stay load-bearing.
test('DNF keeps its checkpoint observation and its ordering', () => {
  const rows = estimatePositions(
    [
      result(1, { status: 'dnf', startTime: '2026-08-07T18:40:00Z' }),
      result(2, { startTime: '2026-08-07T18:40:00Z' }),
    ],
    CHECKPOINTS,
    [{ checkpointId: 'cp-10', participantId: 'p-1', observedAt: '2026-08-07T19:01:15Z' }],
  )
  const r1 = byBib(rows)[1]
  assert.equal(r1.positionType, 'dnf')
  assert.ok(r1._obs, 'DNF observation must survive')
  assert.ok(r1.estimatedPosition < byBib(rows)[2].estimatedPosition)
})

test('DSQ keeps its checkpoint observation', () => {
  const rows = estimatePositions(
    [result(1, { status: 'dsq', startTime: '2026-08-07T18:40:00Z' })],
    CHECKPOINTS,
    [{ checkpointId: 'cp-5', participantId: 'p-1', observedAt: '2026-08-07T19:01:15Z' }],
  )
  assert.equal(rows[0].positionType, 'dsq')
  assert.ok(rows[0]._obs, 'DSQ observation must survive')
})

// Guardrail on the tiers CLAUDE.md calls load-bearing.
test('ordering tiers unchanged: finish time, then furthest checkpoint, then start time', () => {
  const rows = estimatePositions(
    [
      result(1, { startTime: '2026-08-07T18:40:00Z' }),
      result(2, { startTime: '2026-08-07T18:40:00Z', finishTime: '2026-08-07T19:30:00Z', gunDurationMs: 3000000 }),
      result(3, { startTime: '2026-08-07T18:39:00Z' }),
      result(4, { startTime: '2026-08-07T18:40:00Z' }),
      result(5, { startTime: '2026-08-07T18:40:00Z', finishTime: '2026-08-07T19:25:00Z', gunDurationMs: 2700000 }),
    ],
    CHECKPOINTS,
    [
      { checkpointId: 'cp-5', participantId: 'p-1', observedAt: '2026-08-07T19:01:00Z' },
      { checkpointId: 'cp-10', participantId: 'p-4', observedAt: '2026-08-07T19:20:00Z' },
    ],
  )
  assert.deepEqual(rows.map(r => r.participant.bibNumber), [5, 2, 4, 1, 3])
})
