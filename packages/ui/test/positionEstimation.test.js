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
  assert.equal(r2.estimatedPosition, 1)
  assert.equal(r1.estimatedPosition, null, 'a DNS runner has no place')
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
  assert.equal(r1.estimatedPosition, null)
})

// DNF and DSQ runners WERE on course, so their splits stay load-bearing. They no
// longer sort among the runners still racing: an operator has ended their race,
// so they go after everyone who can still finish.
test('DNF keeps its checkpoint observation and goes after runners on course', () => {
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
  assert.equal(byBib(rows)[2].estimatedPosition, 1)
  assert.equal(r1.estimatedPosition, 2)
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

// A chip finish does not make a runner a finisher once an operator has said
// otherwise. Wilczy Półmaraton 2026-10-17: bibs 149, 35 and 71 were marked DNS
// but kept the finish the chip gave them (two unworn bibs carried past the gate,
// one stray read), so they took places 83, 84 and 118 and pushed every runner
// behind them down by up to three places.
test('DNS, DNF and DSQ with a finish time do not take a finisher\'s place', () => {
  const rows = estimatePositions(
    [
      result(1, { finishTime: '2026-10-17T09:00:00Z', gunDurationMs: 100, status: 'finished' }),
      result(2, { finishTime: '2026-10-17T09:00:01Z', gunDurationMs: 101, status: 'dns' }),
      result(3, { finishTime: '2026-10-17T09:00:02Z', gunDurationMs: 102, status: 'dnf', startTime: '2026-10-17T07:00:00Z' }),
      result(4, { finishTime: '2026-10-17T09:00:03Z', gunDurationMs: 103, status: 'dsq', startTime: '2026-10-17T07:00:00Z' }),
      result(5, { finishTime: '2026-10-17T09:00:04Z', gunDurationMs: 104, status: 'finished' }),
    ],
    CHECKPOINTS,
    [],
  )
  const b = byBib(rows)
  assert.equal(b[1].estimatedPosition, 1)
  assert.equal(b[5].estimatedPosition, 2)
  assert.equal(b[2].positionType, 'dns')
  assert.equal(b[3].positionType, 'dnf')
  assert.equal(b[4].positionType, 'dsq')
  assert.deepEqual(rows.slice(0, 2).map(r => r.participant.bibNumber), [1, 5])
})

// Wilczy Półmaraton 2026-10-17: a DNS runner never ran, so a place or a time next
// to their name is wrong. A DNF ran and stopped, so it keeps a number, after
// everyone else; DSQ the same, after the DNFs.
test('order: finishers and runners on course, then DNF, then DSQ, then DNS without a place', () => {
  const rows = estimatePositions(
    [
      result(1, { status: 'dns', finishTime: '2026-10-17T09:00:00Z', gunDurationMs: 50, startTime: '2026-10-17T07:00:00Z' }),
      result(2, { status: 'dsq', finishTime: '2026-10-17T09:00:00Z', gunDurationMs: 60, startTime: '2026-10-17T07:00:00Z' }),
      result(3, { status: 'dnf', startTime: '2026-10-17T07:00:00Z' }),
      result(4, { status: 'finished', finishTime: '2026-10-17T09:10:00Z', gunDurationMs: 600 }),
      result(5, { status: 'started', startTime: '2026-10-17T07:00:00Z' }),
      result(6, { status: 'registered' }),
    ],
    CHECKPOINTS,
    [],
  )
  assert.deepEqual(rows.map(r => r.participant.bibNumber), [4, 5, 6, 3, 2, 1])
  assert.deepEqual(rows.map(r => r.estimatedPosition), [1, 2, 3, 4, 5, null])
})
