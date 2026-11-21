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

test('a baton relay category reloads with its lap source and the event\'s tagged batons', async () => {
  const event = { id: 'e1' }
  const run = { id: 'r1', status: 'active', category: { event, teamMode: 'relay_free', teamLapCount: null, teamTimeLimitSeconds: null, teamLapSource: 'baton', participants: [] } }
  const batons = [{ teamId: 'T', epc: 'B1' }]
  let selected = 0
  const db = {
    query: { raceRuns: { findMany: async () => [run] } },
    select: () => ({ from: () => ({ where: async () => { selected++; return batons } }) }),
  }
  const calls = []
  await reloadActiveRaces(db, { startRace: async (...args) => { calls.push(args) } })
  assert.equal(selected, 1)
  assert.equal(calls[0][1].teamLapSource, 'baton')
  assert.deepEqual(calls[0][1].batons, batons)
})

test('a relay category counting runner tags never reads team_batons', async () => {
  const event = { id: 'e1' }
  const run = { id: 'r1', status: 'active', category: { event, teamMode: 'relay_free', teamLapSource: 'runner', participants: [] } }
  const db = { query: { raceRuns: { findMany: async () => [run] } }, select: () => { throw new Error('no team_batons read') } }
  const calls = []
  await reloadActiveRaces(db, { startRace: async (...args) => { calls.push(args) } })
  assert.equal(calls[0][1].teamLapSource, 'runner')
  assert.equal(calls[0][1].batons, undefined)
})
