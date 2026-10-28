import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reloadActiveRaces } from '../src/lib/reloadActiveRaces.js'

test('restart reload leaves removed participants out of the detector start list', async () => {
  const event = { id: 'e1' }
  const run = {
    id: 'r1',
    status: 'active',
    category: {
      event,
      participants: [
        { id: 'p1', rfidEpc: 'A' },
        { id: 'p2', rfidEpc: 'B', removedAt: new Date() },
        { id: 'p3', rfidEpc: 'C', withdrawnAt: new Date() },
      ],
    },
  }
  const db = { query: { raceRuns: { findMany: async () => [run] } } }
  const calls = []
  const detector = { startRace: async (...args) => { calls.push(args) } }

  const n = await reloadActiveRaces(db, detector)

  assert.equal(n, 1)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], run)
  assert.equal(calls[0][1], event)
  assert.deepEqual(calls[0][2].map((p) => p.id), ['p1', 'p3'])
})

test('no detector: nothing reloaded, no query', async () => {
  let queried = false
  const db = { query: { raceRuns: { findMany: async () => { queried = true; return [] } } } }
  assert.equal(await reloadActiveRaces(db, null), 0)
  assert.equal(queried, false)
})
