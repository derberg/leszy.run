// Run: node --test frontend/src/lib/overviewOrder.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sortOverviewRows } from './overviewOrder.js'

const cps = [{ id: 'cp1' }, { id: 'cp2' }]
const bibs = (rows) => rows.map(r => r.participant.bibNumber)
const row = (bib, extra = {}) => ({ participantId: `p${bib}`, participant: { bibNumber: bib }, ...extra })

test('finishers from several categories run in finish-time order, latest last', () => {
  // Positions are per category, so sorting by position interleaves categories:
  // the three winners first, then the three second places, out of time order.
  const rows = [
    row(8, { finishTime: '2026-10-16T13:26:11.500Z', position: 1 }),
    row(5, { finishTime: '2026-10-16T13:26:09.000Z', position: 1 }),
    row(1, { finishTime: '2026-10-16T13:26:13.000Z', position: 2 }),
    row(2, { finishTime: '2026-10-16T13:26:12.000Z', position: 1 }),
    row(6, { finishTime: '2026-10-16T13:26:10.000Z', position: 2 }),
  ]
  assert.deepEqual(bibs(sortOverviewRows(rows, cps, {})), [5, 6, 8, 2, 1])
})

test('finishers come before runners still on course', () => {
  const rows = [
    row(3, { startTime: '2026-10-16T13:20:00Z' }),
    row(4, { startTime: '2026-10-16T13:20:00Z', finishTime: '2026-10-16T13:30:00Z' }),
  ]
  assert.deepEqual(bibs(sortOverviewRows(rows, cps, {})), [4, 3])
})

test('runners on course: furthest checkpoint first, then bib', () => {
  const rows = [
    row(9, { startTime: 'x' }),
    row(7, { startTime: 'x' }),
    row(2, { startTime: 'x' }),
  ]
  const obs = { 'p9:cp1': 't', 'p2:cp2': 't' }
  assert.deepEqual(bibs(sortOverviewRows(rows, cps, obs)), [2, 9, 7])
})
