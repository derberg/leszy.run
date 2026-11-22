import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CrossingDetector, buildFreeRelay } from '../src/mqtt/crossingDetector.js'
import { createFakeDb, createFakeBroadcast, wait } from './helpers/fakeDb.js'

// Relay in any order (Sztafeta Mikołajów): laps per team, closed by the team's baton tag and
// credited to the member who came in from the course with it. The pass rules (arrival silence,
// min lap, lap count, time limit, restart, stop) all apply to the baton.
const QUIET = 40
const ARRIVAL = 500 // stands in for the event's arrival silence; above the 200 ms read dedup window
const WINDOWS = { burstGapMs: 400, attributionWindowMs: 450, batonPassMaxMs: 1000, candidateWindowMs: 300 }
// A baton pass closes once the baton has been silent for the gone window (40 ms here), and never
// before the attribution window after its first read has passed.
const CLOSE = WINDOWS.attributionWindowMs + 60

const config = (over = {}) => ({
  rssiThreshold: -9000, goneWindowSeconds: 0.04, minFinishSeconds: 0, gunBackfillEnabled: false,
  rfidMode: 'single', rfidTopicMain: 'leszyrun', rfidTopicFinish: 'leszyrun/finish',
  teamMode: 'relay_free', teamLapCount: 3, batons: [{ teamId: 'T', epc: 'B' }], ...over,
})
const TEAM = [
  { id: 'p1', rfidEpc: 'E1', teamId: 'T' },
  { id: 'p2', rfidEpc: 'E2', teamId: 'T' },
]

async function makeRace(t, { cfg = config(), lapRows = [], gunAgoMs = 60_000, arrival = ARRIVAL } = {}) {
  const db = createFakeDb({ lapRows })
  const broadcast = createFakeBroadcast()
  const detector = new CrossingDetector({ db, broadcast, finishQuietMs: QUIET, finishMaxPassMs: 4 * QUIET, lapArrivalSilenceMs: arrival, batonWindows: WINDOWS })
  const raceRun = { id: 'rr1', startedAt: new Date(Date.now() - gunAgoMs) }
  await detector.startRace(raceRun, cfg, TEAM)
  t.after(() => detector.stopRace(raceRun.id).catch(() => {}))
  return { detector, db, broadcast }
}
const read = (epc, rssi = -4000) => ({ epc, rssiCdbm: rssi, antennaPort: 1, topic: 'leszyrun', receivedAt: new Date().toISOString(), raw: {} })
const laps = (db) => (db._inserts().team_laps ?? []).filter(l => l.status === 'counted')
// A runner comes in from the course carrying the baton: the runner's tag, then the baton's.
const lapBy = (detector, epc, rssi = -4000) => { detector.processEvent(read(epc, rssi)); detector.processEvent(read('B', rssi)) }

test('a baton coming in from the course closes a lap credited to the runner who brought it', async (t) => {
  const { detector, db, broadcast } = await makeRace(t)
  lapBy(detector, 'E1', -5000)
  await wait(5)
  lapBy(detector, 'E1', -3500)
  await wait(CLOSE)
  assert.deepEqual(laps(db).map(l => [l.participantId, l.peakRssiCdbm, l.source]), [['p1', -3500, 'baton']])
  const sent = broadcast.sent.filter(s => s.event === 'team:lap').map(s => s.payload)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].lapNumber, 1)
  assert.ok(sent[0].lapMs >= 60_000)
})

test('the same runner may run the next lap too; any order works', async (t) => {
  const { detector, db } = await makeRace(t)
  lapBy(detector, 'E1'); await wait(CLOSE)                     // lap 1: p1
  await wait(ARRIVAL + 20)
  lapBy(detector, 'E1'); await wait(CLOSE)                     // lap 2: p1 again
  await wait(ARRIVAL + 20)
  lapBy(detector, 'E2'); await wait(CLOSE)                     // lap 3: p2
  assert.deepEqual(laps(db).map(l => l.participantId), ['p1', 'p1', 'p2'])
})

test('a baton lying at the gate never closes a second lap', async (t) => {
  // A generous silence, so a slow machine stretching the 50 ms gaps cannot fake an arrival.
  const { detector, db } = await makeRace(t, { arrival: 3000 })
  detector.processEvent(read('B')); await wait(CLOSE)          // first read: counts (never seen)
  // then keeps being read every ~50 ms while it lies there
  for (let i = 0; i < 8; i++) { detector.processEvent(read('B', -6000)); await wait(50) }
  await wait(CLOSE)
  assert.equal(laps(db).length, 1, 'only the first pass counted; lying at the gate adds nothing')
})

test('a baton pass stays open while the baton is heard: a peak long after the first read times the lap', async (t) => {
  // A slow approach. Gone window 0.3 s (above the 200 ms read dedup). The baton is heard weakly for
  // 0.7 s, past the 0.45 s attribution window and far past the finish pass's 40 ms quiet time,
  // then strongly, then it leaves.
  const { detector, db } = await makeRace(t, { cfg: config({ teamLapCount: null, goneWindowSeconds: 0.3 }) })
  detector.processEvent(read('E1', -7000))
  for (let i = 0; i < 7; i++) { detector.processEvent(read('B', -7700)); await wait(100) }
  const peak = read('B', -4700)
  detector.processEvent(peak)
  await wait(100)
  detector.processEvent(read('B', -6000))
  await wait(300 + 100)
  assert.deepEqual(laps(db).map(l => [l.participantId, l.peakRssiCdbm, l.closedAt.getTime()]),
    [['p1', -4700, new Date(peak.receivedAt).getTime()]])
})

test('min lap is decided on the lap\'s peak, not on the baton\'s first read', async (t) => {
  // Min lap 1 s from the gun. The baton is first heard 0.7 s after the gun and peaks at 1.1 s.
  const { detector, db } = await makeRace(t, { cfg: config({ minFinishSeconds: 1 }), gunAgoMs: 700 })
  for (let i = 0; i < 8; i++) { detector.processEvent(read('B', -7000)); await wait(30) }
  await wait(1100 - 700 - 240)
  const peak = read('B', -4000)
  detector.processEvent(peak)
  await wait(CLOSE)
  assert.deepEqual(laps(db).map(l => l.closedAt.getTime()), [new Date(peak.receivedAt).getTime()])
})

test('no lap closes sooner than min_finish_seconds after the previous one', async (t) => {
  const { detector, db } = await makeRace(t, { cfg: config({ minFinishSeconds: 30 }), gunAgoMs: 10_000 })
  lapBy(detector, 'E1'); await wait(CLOSE)
  assert.equal(laps(db).length, 0, '10 s after the gun is no lap')
})

test('the team stops at its lap count; a restart resumes from recorded laps', async (t) => {
  const recorded = [
    { teamId: 'T', closedAt: new Date(Date.now() - 40_000) },
    { teamId: 'T', closedAt: new Date(Date.now() - 30_000), deletedAt: new Date() }, // removed: not counted
    { teamId: 'T', closedAt: new Date(Date.now() - 20_000) },
  ]
  const { detector, db } = await makeRace(t, { lapRows: recorded, cfg: config({ teamLapCount: 2 }) })
  lapBy(detector, 'E2'); await wait(CLOSE)
  assert.equal(laps(db).length, 0, 'the team is done')
})

test('without a lap count or time limit a team keeps lapping', async (t) => {
  const { detector, db } = await makeRace(t, { cfg: config({ teamLapCount: null }) })
  for (let i = 0; i < 4; i++) {
    lapBy(detector, i % 2 ? 'E2' : 'E1'); await wait(CLOSE)
    await wait(ARRIVAL + 20)
  }
  assert.equal(laps(db).length, 4)
})

test('a lap closed after the time limit does not count', async (t) => {
  const { detector, db } = await makeRace(t, { cfg: config({ teamLapCount: null, teamTimeLimitSeconds: 30 }), gunAgoMs: 60_000 })
  lapBy(detector, 'E1'); await wait(CLOSE)
  assert.equal(laps(db).length, 0)
})

test('buildFreeRelay: no lap count means no end', () => {
  const fr = buildFreeRelay(TEAM, [], { gunStartTime: new Date(0), lapCount: null, minLapMs: 0 })
  assert.equal(fr.teams.get('T').target, Infinity)
  assert.equal(fr.teamOf.get('p2'), 'T')
})

test('stopping the race closes a lap pass still open as a lap, never as a start or finish', async (t) => {
  const { detector, db, broadcast } = await makeRace(t)
  lapBy(detector, 'E1', -3500)
  await wait(5)
  await detector.stopRace('rr1')               // the operator clicks stop mid-pass
  assert.deepEqual(laps(db).map(l => l.participantId), ['p1'])
  assert.equal(broadcast.crossings().length, 0, 'no gate crossing was made of it')
  assert.equal((db._inserts().results ?? []).length, 0)
})

test('reloadTeamLaps: a lap removed by the operator frees the team to count again', async (t) => {
  const lapRows = [{ teamId: 'T', closedAt: new Date(Date.now() - 20_000) }, { teamId: 'T', closedAt: new Date(Date.now() - 10_000) }]
  const { detector, db } = await makeRace(t, { lapRows, cfg: config({ teamLapCount: 2 }) })
  lapBy(detector, 'E1'); await wait(CLOSE)
  assert.equal(laps(db).length, 0, 'done at 2 laps')
  lapRows[1].deletedAt = new Date()
  await detector.reloadTeamLaps('rr1')
  await wait(ARRIVAL + 20)
  lapBy(detector, 'E1'); await wait(CLOSE)
  assert.equal(laps(db).length, 1)
})

test('the event sets the arrival silence; it wins over the default', async (t) => {
  // The default would need 5 s of silence; the event asks for 0.3 s (a short loop).
  const { detector, db } = await makeRace(t, { arrival: 5000, cfg: config({ lapArrivalSilenceSeconds: 0.3 }) })
  lapBy(detector, 'E1'); await wait(CLOSE)                     // lap 1: p1
  await wait(320)
  lapBy(detector, 'E1'); await wait(CLOSE)                     // back after 0.3 s+: lap 2
  assert.deepEqual(laps(db).map(l => l.participantId), ['p1', 'p1'])
})

test('a silence shorter than the event setting does not close a lap', async (t) => {
  const { detector, db } = await makeRace(t, { arrival: 10, cfg: config({ lapArrivalSilenceSeconds: 2 }) })
  lapBy(detector, 'E1'); await wait(CLOSE)                     // lap 1: p1
  await wait(300)
  lapBy(detector, 'E1'); await wait(CLOSE)                     // only 0.4 s unheard: no lap
  assert.deepEqual(laps(db).map(l => l.participantId), ['p1'])
})

test('buildFreeRelay: a candidate lap is not counted', () => {
  const fr = buildFreeRelay(TEAM, [{ teamId: 'T', closedAt: new Date(5000).toISOString(), status: 'candidate' }], { gunStartTime: new Date(0), lapCount: null, minLapMs: 0 })
  assert.equal(fr.teams.get('T').laps, 0)
  assert.equal(fr.teams.get('T').lastBoundary.getTime(), 0)
})
