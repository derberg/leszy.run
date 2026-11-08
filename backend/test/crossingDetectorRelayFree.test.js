import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CrossingDetector, buildFreeRelay } from '../src/mqtt/crossingDetector.js'
import { createFakeDb, createFakeBroadcast, wait } from './helpers/fakeDb.js'

// Relay in any order (Sztafeta Mikołajów): laps per team, credited to whoever closes them.
const QUIET = 40
const ARRIVAL = 500 // stands in for the 60 s of silence; above the 200 ms read dedup window

const config = (over = {}) => ({
  rssiThreshold: -9000, goneWindowSeconds: 0.04, minFinishSeconds: 0, gunBackfillEnabled: false,
  rfidMode: 'single', rfidTopicMain: 'leszyrun', rfidTopicFinish: 'leszyrun/finish',
  teamMode: 'relay_free', teamLapCount: 3, ...over,
})
const TEAM = [
  { id: 'p1', rfidEpc: 'E1', teamId: 'T' },
  { id: 'p2', rfidEpc: 'E2', teamId: 'T' },
]

async function makeRace(t, { cfg = config(), lapRows = [], gunAgoMs = 60_000, arrival = ARRIVAL } = {}) {
  const db = createFakeDb({ lapRows })
  const broadcast = createFakeBroadcast()
  const detector = new CrossingDetector({ db, broadcast, finishQuietMs: QUIET, finishMaxPassMs: 4 * QUIET, lapArrivalSilenceMs: arrival })
  const raceRun = { id: 'rr1', startedAt: new Date(Date.now() - gunAgoMs) }
  await detector.startRace(raceRun, cfg, TEAM)
  t.after(() => detector.stopRace(raceRun.id).catch(() => {}))
  return { detector, db, broadcast }
}
const read = (epc, rssi = -4000) => ({ epc, rssiCdbm: rssi, antennaPort: 1, topic: 'leszyrun', receivedAt: new Date().toISOString(), raw: {} })
const laps = (db) => db._inserts().team_laps ?? []

test('a runner coming in from the course closes a lap credited to them', async (t) => {
  const { detector, db, broadcast } = await makeRace(t)
  detector.processEvent(read('E1', -5000))
  await wait(5)
  detector.processEvent(read('E1', -3500))
  await wait(QUIET + 60)
  assert.deepEqual(laps(db).map(l => [l.lapNumber, l.participantId, l.peakRssiCdbm]), [[1, 'p1', -3500]])
  assert.ok(laps(db)[0].lapMs >= 60_000)
  assert.equal(broadcast.sent.filter(s => s.event === 'team:lap').length, 1)
})

test('the same runner may run the next lap too; any order works', async (t) => {
  const { detector, db } = await makeRace(t)
  detector.processEvent(read('E1')); await wait(QUIET + 60)         // lap 1: p1
  await wait(ARRIVAL + 20)
  detector.processEvent(read('E1')); await wait(QUIET + 60)         // lap 2: p1 again
  await wait(ARRIVAL + 20)
  detector.processEvent(read('E2')); await wait(QUIET + 60)         // lap 3: p2
  assert.deepEqual(laps(db).map(l => [l.lapNumber, l.participantId]), [[1, 'p1'], [2, 'p1'], [3, 'p2']])
})

test('a teammate standing at the gate never closes a lap', async (t) => {
  // A generous silence, so a slow machine stretching the 50 ms gaps cannot fake an arrival.
  const { detector, db } = await makeRace(t, { arrival: 3000 })
  detector.processEvent(read('E2')); await wait(QUIET + 60)         // first read: counts (never seen)
  // then keeps being read every ~50 ms while waiting
  for (let i = 0; i < 8; i++) { detector.processEvent(read('E2', -6000)); await wait(50) }
  await wait(QUIET + 60)
  assert.equal(laps(db).length, 1, 'only the first pass counted; standing at the gate adds nothing')
})

test('no lap closes sooner than min_finish_seconds after the previous one', async (t) => {
  const { detector, db } = await makeRace(t, { cfg: config({ minFinishSeconds: 30 }), gunAgoMs: 10_000 })
  detector.processEvent(read('E1')); await wait(QUIET + 60)
  assert.equal(laps(db).length, 0, '10 s after the gun is no lap')
})

test('the team stops at its lap count; a restart resumes from recorded laps', async (t) => {
  const recorded = [
    { teamId: 'T', lapNumber: 1, closedAt: new Date(Date.now() - 40_000) },
    { teamId: 'T', lapNumber: 2, closedAt: new Date(Date.now() - 20_000) },
  ]
  const { detector, db } = await makeRace(t, { lapRows: recorded, cfg: config({ teamLapCount: 2 }) })
  detector.processEvent(read('E2')); await wait(QUIET + 60)
  assert.equal(laps(db).length, 0, 'the team is done')
})

test('without a lap count or time limit a team keeps lapping', async (t) => {
  const { detector, db } = await makeRace(t, { cfg: config({ teamLapCount: null }) })
  for (let i = 0; i < 4; i++) {
    detector.processEvent(read(i % 2 ? 'E2' : 'E1')); await wait(QUIET + 60)
    await wait(ARRIVAL + 20)
  }
  assert.equal(laps(db).length, 4)
})

test('a lap closed after the time limit does not count', async (t) => {
  const { detector, db } = await makeRace(t, { cfg: config({ teamLapCount: null, teamTimeLimitSeconds: 30 }), gunAgoMs: 60_000 })
  detector.processEvent(read('E1')); await wait(QUIET + 60)
  assert.equal(laps(db).length, 0)
})

test('buildFreeRelay: no lap count means no end', () => {
  const fr = buildFreeRelay(TEAM, [], { gunStartTime: new Date(0), lapCount: null, minLapMs: 0 })
  assert.equal(fr.teams.get('T').target, Infinity)
  assert.equal(fr.teamOf.get('p2'), 'T')
})

test('stopping the race closes a lap pass still open as a lap, never as a start or finish', async (t) => {
  const { detector, db, broadcast } = await makeRace(t)
  detector.processEvent(read('E1', -3500))
  await wait(5)
  await detector.stopRace('rr1')               // the operator clicks stop mid-pass
  assert.deepEqual(laps(db).map(l => [l.lapNumber, l.participantId]), [[1, 'p1']])
  assert.equal(broadcast.crossings().length, 0, 'no gate crossing was made of it')
  assert.equal((db._inserts().results ?? []).length, 0)
})
