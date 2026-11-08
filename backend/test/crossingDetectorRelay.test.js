import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CrossingDetector, buildRelayChains } from '../src/mqtt/crossingDetector.js'
import { createFakeDb, createFakeBroadcast, wait } from './helpers/fakeDb.js'

const GONE_MS = 60
const FINISH_MAX_MS = 4 * GONE_MS

const config = (over = {}) => ({
  rssiThreshold: -9000,
  goneWindowSeconds: GONE_MS / 1000,
  minFinishSeconds: 0,
  gunBackfillEnabled: false,
  rfidMode: 'single',
  rfidTopicMain: 'leszyrun',
  rfidTopicFinish: 'leszyrun/finish',
  teamMode: 'relay',
  ...over,
})

// One relay team of three: p1 (leg 1) → p2 → p3.
const TEAM = [
  { id: 'p1', rfidEpc: 'E1', teamId: 'T', teamLeg: 1 },
  { id: 'p2', rfidEpc: 'E2', teamId: 'T', teamLeg: 2 },
  { id: 'p3', rfidEpc: 'E3', teamId: 'T', teamLeg: 3 },
]

async function makeRace(t, { cfg = config(), resultsRows = [], participants = TEAM } = {}) {
  const db = createFakeDb({ resultsRows })
  const broadcast = createFakeBroadcast()
  const detector = new CrossingDetector({ db, broadcast, finishQuietMs: GONE_MS, finishMaxPassMs: FINISH_MAX_MS })
  const raceRun = { id: 'rr1', startedAt: new Date(Date.now() - 60_000) }
  await detector.startRace(raceRun, cfg, participants)
  t.after(() => detector.stopRace(raceRun.id).catch(() => {}))
  return { detector, db, broadcast }
}

const read = (epc, rssi = -4000, over = {}) => ({
  epc, rssiCdbm: rssi, antennaPort: 1, topic: 'leszyrun', receivedAt: new Date().toISOString(), raw: {}, ...over,
})
const resultOf = (db, pid) => db._rows().find(r => r.participantId === pid)

test('buildRelayChains links legs in order and refuses a team with a missing leg', () => {
  const { nextLeg, prevLeg, warnings } = buildRelayChains([
    ...TEAM,
    { id: 'q1', teamId: 'U', teamLeg: 1 }, { id: 'q2', teamId: 'U', teamLeg: null },
    { id: 'solo' },
  ])
  assert.equal(nextLeg.get('p1'), 'p2')
  assert.equal(nextLeg.get('p2'), 'p3')
  assert.equal(prevLeg.get('p3'), 'p2')
  assert.equal(prevLeg.has('p1'), false)
  assert.equal(nextLeg.has('q1'), false)
  assert.equal(warnings.length, 1)
})

test('a waiting leg near the gate gets neither a start nor a finish before the handover', async (t) => {
  const { detector, db, broadcast } = await makeRace(t, {
    resultsRows: [{ participantId: 'p1', startTime: new Date(Date.now() - 50_000), status: 'started' }],
  })
  detector.processEvent(read('E2', -3500))
  await wait(GONE_MS + 80)
  assert.equal(broadcast.crossings().length, 0)
  assert.equal(resultOf(db, 'p2'), undefined)
  assert.equal(db._inserts().gate_events.length, 1, 'the read is still audited')
})

test('leg 1 finish is leg 2 start; leg 2 finish is timed from the handover', async (t) => {
  const { detector, db } = await makeRace(t, {
    resultsRows: [{ participantId: 'p1', startTime: new Date(Date.now() - 50_000), status: 'started' }],
  })
  const handoverAt = new Date().toISOString()
  detector.processEvent(read('E1', -3500, { receivedAt: handoverAt }))
  await wait(GONE_MS + 80)

  assert.equal(resultOf(db, 'p1').status, 'finished')
  const p2 = resultOf(db, 'p2')
  assert.equal(p2.status, 'started')
  assert.equal(new Date(p2.startTime).toISOString(), handoverAt)
  assert.equal(p2.startTimeSource, 'handover')

  await wait(30)
  detector.processEvent(read('E2', -3600))
  await wait(GONE_MS + 80)
  const p2done = resultOf(db, 'p2')
  assert.equal(p2done.status, 'finished')
  assert.ok(p2done.durationMs > 0 && p2done.durationMs < 1000, 'netto is the leg time, from the handover')
  assert.equal(resultOf(db, 'p3').startTimeSource, 'handover', 'and the chain moves on to leg 3')
})

test('min_finish counts from the handover for a later leg, not from the gun', async (t) => {
  const { detector, db } = await makeRace(t, {
    cfg: config({ minFinishSeconds: 30 }), // the gun was 60 s ago, so a gun anchor would let this through
    resultsRows: [
      { participantId: 'p1', startTime: new Date(Date.now() - 55_000), status: 'started' },
    ],
  })
  detector.processEvent(read('E1', -3500))
  await wait(GONE_MS + 80)
  assert.equal(resultOf(db, 'p2').status, 'started')

  // leg 2 runs off right after taking over: still near the antenna
  detector.processEvent(read('E2', -3800))
  await wait(GONE_MS + 80)
  assert.equal(resultOf(db, 'p2').finishTime ?? null, null, 'no finish seconds after the handover')
})

test('a DNS on the next leg is left alone at the handover', async (t) => {
  const { detector, db } = await makeRace(t, {
    resultsRows: [
      { participantId: 'p1', startTime: new Date(Date.now() - 50_000), status: 'started' },
      { participantId: 'p2', status: 'dns' },
    ],
  })
  detector.processEvent(read('E1', -3500))
  await wait(GONE_MS + 80)
  assert.equal(resultOf(db, 'p2').status, 'dns')
  assert.equal(resultOf(db, 'p2').startTime ?? null, null)
})

test('after a restart a leg that already took over keeps racing; one that did not still waits', async (t) => {
  const { detector, db, broadcast } = await makeRace(t, {
    resultsRows: [
      { participantId: 'p1', startTime: new Date(Date.now() - 50_000), finishTime: new Date(Date.now() - 20_000), status: 'finished' },
      { participantId: 'p2', startTime: new Date(Date.now() - 20_000), status: 'started', startTimeSource: 'handover' },
    ],
  })
  detector.processEvent(read('E3', -3500))
  detector.processEvent(read('E2', -3500))
  await wait(GONE_MS + 80)
  const gates = broadcast.crossings().map(c => [c.participantId, c.gate])
  assert.deepEqual(gates, [['p2', 'finish']])
  assert.equal(resultOf(db, 'p3').startTimeSource, 'handover')
})

test('outside relay mode team members are plain individuals', async (t) => {
  const { detector, broadcast } = await makeRace(t, { cfg: config({ teamMode: null }) })
  detector.processEvent(read('E2', -3500))
  await wait(GONE_MS + 80)
  assert.deepEqual(broadcast.crossings().map(c => [c.participantId, c.gate]), [['p2', 'start']])
})
