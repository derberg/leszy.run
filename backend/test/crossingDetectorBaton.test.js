import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CrossingDetector } from '../src/mqtt/crossingDetector.js'
import { createFakeDb, createFakeBroadcast, wait } from './helpers/fakeDb.js'

// Relay in any order with a baton (team_lap_source = 'baton'): the team's laps come from its
// baton tag; runner tags only say who ran (attribution) or raise a candidate.
// All windows are scaled down so the tests run in real time. Reads of one EPC within 200 ms
// are dropped unless stronger (the detector's dedup window), so a tag "read continuously"
// is kept about every 200 ms; the burst gap (400 ms) is above that.
const QUIET = 40
const ARRIVAL = 500
const WINDOWS = { burstGapMs: 400, attributionBeforeMs: 600, attributionAfterMs: 200, candidateWindowMs: 300 }
// A runner burst is decided once it has ended (burst gap) and the candidate window after it passed.
const CANDIDATE_CHECK = WINDOWS.burstGapMs + WINDOWS.candidateWindowMs + 60

const config = (over = {}) => ({
  id: 'e1',
  rssiThreshold: -9000, goneWindowSeconds: 0.04, minFinishSeconds: 0, gunBackfillEnabled: false,
  rfidMode: 'single', rfidTopicMain: 'leszyrun', rfidTopicFinish: 'leszyrun/finish',
  teamMode: 'relay_free', teamLapCount: null, teamLapSource: 'baton',
  batons: [{ teamId: 'T', epc: 'B1' }],
  ...over,
})
const TEAM = [
  { id: 'p1', rfidEpc: 'E1', teamId: 'T' },
  { id: 'p2', rfidEpc: 'E2', teamId: 'T' },
]

async function makeRace(t, { cfg = config(), lapRows = [], gunAgoMs = 60_000 } = {}) {
  const db = createFakeDb({ lapRows })
  const broadcast = createFakeBroadcast()
  const detector = new CrossingDetector({
    db, broadcast, finishQuietMs: QUIET, finishMaxPassMs: 4 * QUIET, lapArrivalSilenceMs: ARRIVAL, batonWindows: WINDOWS,
  })
  const raceRun = { id: 'rr1', startedAt: new Date(Date.now() - gunAgoMs) }
  await detector.startRace(raceRun, cfg, TEAM)
  t.after(() => detector.stopRace(raceRun.id).catch(() => {}))
  return { detector, db, broadcast }
}
const read = (epc, rssi = -4000) => ({ epc, rssiCdbm: rssi, antennaPort: 1, topic: 'leszyrun', receivedAt: new Date().toISOString(), raw: {} })
const rows = (db) => db._inserts().team_laps ?? []
const counted = (db) => rows(db).filter(l => l.status === 'counted')
const candidates = (db) => rows(db).filter(l => l.status === 'candidate')
const teamState = (detector) => detector.activeRaces.get('rr1').freeRelay.teams.get('T')

// Reads `epcs` every `every` ms for `ms` ms.
async function hold(detector, epcs, ms, { every = 100, rssi = -5000 } = {}) {
  for (let elapsed = 0; elapsed < ms; elapsed += every) {
    for (const e of epcs) detector.processEvent(read(e, rssi))
    await wait(every)
  }
}

test('(a) a baton pass closes a lap credited to the runner who came in with it', async (t) => {
  const { detector, db, broadcast } = await makeRace(t)
  detector.processEvent(read('E1', -5000))
  detector.processEvent(read('B1', -5000))
  await wait(5)
  detector.processEvent(read('B1', -3500))
  detector.processEvent(read('E1', -3600))
  await wait(QUIET + 60)
  assert.deepEqual(rows(db).map(l => [l.participantId, l.source, l.status, l.peakRssiCdbm]), [['p1', 'baton', 'counted', -3500]])
  const sent = broadcast.sent.filter(s => s.event === 'team:lap').map(s => s.payload)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].lapNumber, 1)
  assert.equal(teamState(detector).laps, 1)
  await wait(CANDIDATE_CHECK + 60)
  assert.equal(candidates(db).length, 0, 'the runner came with the baton: no candidate')
  assert.equal((db._inserts().gate_events ?? []).filter(g => g.epc === 'B1').length, 2, 'baton reads are audited')
})

test('(b) a teammate waiting at the antenna while the baton comes and goes is never credited, never a candidate', async (t) => {
  const { detector, db } = await makeRace(t, { cfg: config({ minFinishSeconds: 1 }), gunAgoMs: 0 })
  await hold(detector, ['E2'], 1500)                       // p2 waits at the line from the gun
  await hold(detector, ['E2', 'E1', 'B1'], 300)            // p1 arrives with the baton, hands over
  await hold(detector, ['E1'], 1500)                       // p2 runs off with it; p1 stays at the line
  await hold(detector, ['E1', 'E2', 'B1'], 300)            // p2 back with the baton
  await wait(QUIET + CANDIDATE_CHECK + 100)
  assert.deepEqual(counted(db).map(l => [l.participantId, l.source]), [['p1', 'baton'], ['p2', 'baton']])
  assert.equal(candidates(db).length, 0)
})

test('(c) a baton left next to the antenna makes one lap, never more', async (t) => {
  const { detector, db } = await makeRace(t)
  await hold(detector, ['B1'], 1500)
  await wait(QUIET + 60)
  assert.equal(counted(db).length, 1)
  assert.equal(counted(db)[0].participantId, null, 'no runner came in: the lap has none')
  assert.equal(teamState(detector).laps, 1)
})

test('(d) a runner from the course without the baton raises one candidate, which does not count', async (t) => {
  const { detector, db, broadcast } = await makeRace(t)
  detector.processEvent(read('E1', -5000))
  await wait(5)
  const peak = read('E1', -3500)
  detector.processEvent(peak)
  await hold(detector, ['E1'], 300, { rssi: -6000 })
  await wait(CANDIDATE_CHECK + 100)
  assert.deepEqual(candidates(db).map(l => [l.participantId, l.source, l.peakRssiCdbm]), [['p1', 'chip', -3500]])
  assert.equal(candidates(db)[0].closedAt.getTime(), new Date(peak.receivedAt).getTime(), 'timed at the runner\'s peak')
  assert.equal(counted(db).length, 0)
  assert.equal(teamState(detector).laps, 0)
  assert.equal(broadcast.sent.filter(s => s.event === 'team:lap')[0].payload.status, 'candidate')
  // The team's first counted lap is still lap 1.
  detector.processEvent(read('B1'))
  await wait(QUIET + 60)
  assert.equal(counted(db).length, 1)
  assert.equal(broadcast.sent.filter(s => s.event === 'team:lap').at(-1).payload.lapNumber, 1)
})

test('(e) runner tags alone never close a lap', async (t) => {
  const { detector, db } = await makeRace(t)
  for (let i = 0; i < 3; i++) {
    detector.processEvent(read(i % 2 ? 'E2' : 'E1', -3500))
    await wait(QUIET + 60)
    await wait(ARRIVAL + 20)
  }
  await wait(CANDIDATE_CHECK)
  assert.equal(counted(db).length, 0)
  assert.equal(teamState(detector).laps, 0)
  assert.ok(candidates(db).length >= 1, 'they are candidates for the operator')
})

test('(f) a category counting runner tags ignores batons entirely', async (t) => {
  const { detector, db } = await makeRace(t, { cfg: config({ teamLapSource: 'runner', teamLapCount: 3 }) })
  assert.equal(detector.activeRaces.get('rr1').freeRelay.batonTeamOf, undefined)
  detector.processEvent(read('B1', -3000))
  await wait(QUIET + 60)
  assert.equal(rows(db).length, 0, 'the baton tag is nobody here')
  assert.equal((db._inserts().gate_events ?? []).length, 0)
  detector.processEvent(read('E1', -3500))
  await wait(QUIET + 60)
  assert.deepEqual(rows(db).map(l => [l.participantId, l.source]), [['p1', 'chip']])
  await wait(CANDIDATE_CHECK)
  assert.equal(rows(db).length, 1)
})

test('(g) slow approach: a weak first baton read, then stronger ones; the lap is timed at the peak', async (t) => {
  const { detector, db } = await makeRace(t)
  detector.processEvent(read('B1', -7300))
  await wait(10)
  detector.processEvent(read('B1', -6300))
  await wait(10)
  const peak = read('B1', -3450)
  detector.processEvent(peak)
  await wait(10)
  detector.processEvent(read('B1', -5000))
  await wait(QUIET + 60)
  assert.equal(counted(db).length, 1)
  assert.equal(counted(db)[0].peakRssiCdbm, -3450)
  assert.equal(counted(db)[0].closedAt.getTime(), new Date(peak.receivedAt).getTime())
})

test('min lap from the gun: batons standing at the start line make no lap', async (t) => {
  const { detector, db } = await makeRace(t, { cfg: config({ minFinishSeconds: 30 }), gunAgoMs: 100 })
  await hold(detector, ['B1', 'E1'], 500)
  await wait(QUIET + CANDIDATE_CHECK + 60)
  assert.equal(rows(db).length, 0)
})

test('reloadBatons: a baton changed mid-race takes effect for the event\'s races', async (t) => {
  const { detector, db } = await makeRace(t)
  detector.reloadBatons('other-event', [{ teamId: 'T', epc: 'B7' }])
  assert.equal(detector.activeRaces.get('rr1').freeRelay.batonTeamOf.get('B1'), 'T', 'another event: untouched')
  detector.reloadBatons('e1', [{ teamId: 'T', epc: 'B2' }])
  detector.processEvent(read('B1'))
  await wait(QUIET + 60)
  assert.equal(counted(db).length, 0, 'the old tag is no baton any more')
  detector.processEvent(read('B2'))
  await wait(QUIET + 60)
  assert.equal(counted(db).length, 1)
})

test('a baton-mode team without a baton gets only candidates', async (t) => {
  const { detector, db } = await makeRace(t, { cfg: config({ batons: [] }) })
  detector.processEvent(read('E1', -3500))
  await wait(QUIET + CANDIDATE_CHECK + 60)
  assert.equal(counted(db).length, 0)
  assert.equal(candidates(db).length, 1)
})

test('stopping the race closes an open baton pass as a lap', async (t) => {
  const { detector, db } = await makeRace(t)
  detector.processEvent(read('E1', -3600))
  detector.processEvent(read('B1', -3500))
  await wait(5)
  await detector.stopRace('rr1')
  assert.deepEqual(counted(db).map(l => [l.participantId, l.source]), [['p1', 'baton']])
  await wait(CANDIDATE_CHECK + 60)
  assert.equal(candidates(db).length, 0, 'no candidate check runs after the stop')
})

test('after a restart, recorded baton laps keep a returning runner from becoming a candidate', async (t) => {
  // A baton lap 0.1 s ago (restored), and the runner who brought it is read now.
  const lapRows = [{ teamId: 'T', closedAt: new Date(Date.now() - 100), source: 'baton', status: 'counted', participantId: 'p1' }]
  const { detector, db } = await makeRace(t, { lapRows })
  detector.processEvent(read('E1', -3500))
  await wait(QUIET + CANDIDATE_CHECK + 60)
  assert.equal(candidates(db).length, 0)
  assert.equal(teamState(detector).laps, 1)
})

test('a teammate who walks up mid-lap, waits longer than the window, and leaves with the baton is no candidate', async (t) => {
  // min lap 1 s. Lap 1: p1 brings the baton (p2 runs off with it, unread).
  const { detector, db } = await makeRace(t, { cfg: config({ minFinishSeconds: 1 }) })
  await hold(detector, ['E1', 'B1'], 300)
  await wait(1000)                                      // p1 off the line, p2 on the course
  await hold(detector, ['E1'], 1200)                    // p1 walks up (min lap + δ) and waits
  await hold(detector, ['E1', 'E2', 'B1'], 300)         // p2 brings the baton, p1 takes it
  await hold(detector, ['E2'], 300)                     // p1 gone with the baton, p2 stays a moment
  await wait(QUIET + CANDIDATE_CHECK + 100)
  assert.deepEqual(counted(db).map(l => [l.participantId, l.source]), [['p1', 'baton'], ['p2', 'baton']])
  assert.equal(candidates(db).length, 0)
})

test('a runner in from the course without the baton is one candidate, written only after the burst ends', async (t) => {
  const { detector, db } = await makeRace(t)
  detector.processEvent(read('E1', -6000))
  await wait(10)
  const peak = read('E1', -3500)
  detector.processEvent(peak)
  await hold(detector, ['E1'], 800, { rssi: -6000 })     // stays longer than the window
  assert.equal(candidates(db).length, 0, 'still at the line: undecided')
  await wait(CANDIDATE_CHECK + 100)
  assert.equal(candidates(db).length, 1)
  assert.equal(candidates(db)[0].participantId, 'p1')
  assert.equal(candidates(db)[0].closedAt.getTime(), new Date(peak.receivedAt).getTime())
  assert.equal(teamState(detector).laps, 0)
})

test('a waiter who arrived just before the baton and its runner leaves the lap without a runner', async (t) => {
  const { detector, db } = await makeRace(t)
  await hold(detector, ['E2'], 300)                     // p2 walks up 0.3 s before (window 0.6 s)
  await hold(detector, ['E2', 'E1', 'B1'], 300)         // p1 arrives with the baton
  await wait(QUIET + CANDIDATE_CHECK + 100)
  assert.equal(counted(db).length, 1)
  assert.equal(counted(db)[0].participantId, null, 'two arrivals: the operator picks the runner')
  assert.equal(candidates(db).length, 0)
})
