import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CrossingDetector } from '../src/mqtt/crossingDetector.js'
import { createFakeDb, createFakeBroadcast, wait } from './helpers/fakeDb.js'

// Short windows so the exit-triggered start confirms in milliseconds, not seconds.
const GONE_MS = 60

function baseConfig(over = {}) {
  return {
    rssiThreshold: -6500,
    goneWindowSeconds: GONE_MS / 1000,
    minFinishSeconds: 0,       // no ghost-read guard unless a test wants one
    gunBackfillEnabled: false, // backfill is a separate concern; keep tests focused
    rfidMode: 'single',
    rfidTopicMain: 'leszyrun',
    rfidTopicFinish: 'leszyrun/finish',
    ...over,
  }
}

async function makeRace(t, { config = baseConfig(), resultsRows = [], participants = [{ id: 'p1', rfidEpc: 'EPC1' }] } = {}) {
  const db = createFakeDb({ resultsRows })
  const broadcast = createFakeBroadcast()
  const detector = new CrossingDetector({ db, broadcast })
  const raceRun = { id: 'rr1', startedAt: new Date(Date.now() - 60_000) }
  await detector.startRace(raceRun, config, participants)
  t.after(() => detector.stopRace(raceRun.id).catch(() => {}))
  return { detector, db, broadcast, raceRun }
}

const read = (rssi, over = {}) => ({
  epc: 'EPC1',
  rssiCdbm: rssi,
  antennaPort: 1,
  topic: 'leszyrun',
  receivedAt: new Date().toISOString(),
  raw: {},
  ...over,
})

// ---------------------------------------------------------------------------
// Baseline behaviour — these must hold both before and after the peak gate, and
// they are what proves the fake DB is faithful enough to trust the new tests.
// ---------------------------------------------------------------------------

test('START confirms at the peak reading after the silence window', async (t) => {
  const { detector, broadcast, db } = await makeRace(t)

  detector.processEvent(read(-6000))
  await wait(5)
  detector.processEvent(read(-3500)) // the peak: runner closest to the antenna
  await wait(5)
  detector.processEvent(read(-6200))

  await wait(GONE_MS + 60)

  const crossings = broadcast.crossings()
  assert.equal(crossings.length, 1)
  assert.equal(crossings[0].gate, 'start')
  const inserted = db._inserts().gate_crossings
  assert.equal(inserted.length, 1)
  assert.equal(inserted[0].peakRssiCdbm, -3500) // peak, not first or last
})

test('reads weaker than rssiThreshold are ignored entirely', async (t) => {
  const { detector, broadcast, db } = await makeRace(t, { config: baseConfig({ rssiThreshold: -6500 }) })

  detector.processEvent(read(-7100))
  detector.processEvent(read(-7800, { receivedAt: new Date(Date.now() + 1).toISOString() }))
  await wait(GONE_MS + 60)

  assert.equal(broadcast.crossings().length, 0)
  assert.equal(db._inserts().gate_events.length, 0, 'sub-threshold reads are not persisted for audit either')
})

test('an already-started participant finishes on the FIRST qualifying read', async (t) => {
  const { detector, broadcast } = await makeRace(t, {
    resultsRows: [{ id: 'res-1', participantId: 'p1', startTime: new Date(Date.now() - 30_000), status: 'started' }],
  })

  detector.processEvent(read(-4000))
  await wait(40)

  const crossings = broadcast.crossings()
  assert.equal(crossings.length, 1)
  assert.equal(crossings[0].gate, 'finish')
})

// ---------------------------------------------------------------------------
// confirmRssiCdbm — the two-tier gate.
//
// rssiThreshold is a TRACKING floor: permissive, so a weak-but-real tag still
// accumulates readings. confirmRssiCdbm is a CROSSING bar: strict, so a tag that
// never actually came close to the antenna is not recorded as having crossed.
// One number cannot do both jobs when tag performance spans 30 dB.
// ---------------------------------------------------------------------------

test('START is NOT confirmed when the peak never reaches confirmRssiCdbm', async (t) => {
  const { detector, broadcast, db } = await makeRace(t, {
    config: baseConfig({ rssiThreshold: -6500, confirmRssiCdbm: -5500 }),
  })

  // Loitering 15 m away: above the tracking floor, never near the gate.
  detector.processEvent(read(-6400))
  await wait(5)
  detector.processEvent(read(-6250))
  await wait(5)
  detector.processEvent(read(-6300))

  await wait(GONE_MS + 60)

  assert.equal(broadcast.crossings().length, 0, 'far-field loiterer must not produce a start crossing')
  assert.equal(db._inserts().gate_crossings.length, 0)
  // Still persisted for audit — the reads happened and are worth keeping. Only 2
  // of the 3 land: DEDUP_WINDOW_MS (200 ms) drops a read that doesn't improve on
  // the best RSSI seen in the window, and -6300 doesn't beat -6250.
  assert.equal(db._inserts().gate_events.length, 2)
})

test('START IS confirmed once the peak clears confirmRssiCdbm', async (t) => {
  const { detector, broadcast, db } = await makeRace(t, {
    config: baseConfig({ rssiThreshold: -6500, confirmRssiCdbm: -5500 }),
  })

  detector.processEvent(read(-6400)) // far-field approach
  await wait(5)
  detector.processEvent(read(-3300)) // actually crosses the gate
  await wait(5)
  detector.processEvent(read(-6100)) // receding

  await wait(GONE_MS + 60)

  const crossings = broadcast.crossings()
  assert.equal(crossings.length, 1)
  assert.equal(crossings[0].gate, 'start')
  assert.equal(db._inserts().gate_crossings[0].peakRssiCdbm, -3300)
})

test('the confirm bar is inclusive — a peak exactly at confirmRssiCdbm counts', async (t) => {
  const { detector, broadcast } = await makeRace(t, {
    config: baseConfig({ rssiThreshold: -6500, confirmRssiCdbm: -5500 }),
  })
  detector.processEvent(read(-5500))
  await wait(GONE_MS + 60)
  assert.equal(broadcast.crossings().length, 1)
})

test('FINISH ignores a far-field read and confirms on the first strong one', async (t) => {
  const { detector, broadcast } = await makeRace(t, {
    config: baseConfig({ rssiThreshold: -6500, confirmRssiCdbm: -5500 }),
    resultsRows: [{ id: 'res-1', participantId: 'p1', startTime: new Date(Date.now() - 30_000), status: 'started' }],
  })

  // Approaching from 15 m out: must NOT be recorded as the finish, otherwise the
  // runner gets a time from before they reached the line.
  detector.processEvent(read(-6300))
  await wait(30)
  assert.equal(broadcast.crossings().length, 0, 'weak approach read must not finish the runner')

  const strongAt = new Date().toISOString()
  detector.processEvent(read(-3600, { receivedAt: strongAt }))
  await wait(40)

  const crossings = broadcast.crossings()
  assert.equal(crossings.length, 1)
  assert.equal(crossings[0].gate, 'finish')
  assert.equal(new Date(crossings[0].confirmedAt).toISOString(), strongAt)
})

test('a rejected weak finish read does not block the real one (finishedParticipants not poisoned)', async (t) => {
  const { detector, broadcast } = await makeRace(t, {
    config: baseConfig({ rssiThreshold: -6500, confirmRssiCdbm: -5500 }),
    resultsRows: [{ id: 'res-1', participantId: 'p1', startTime: new Date(Date.now() - 30_000), status: 'started' }],
  })

  for (const r of [-6400, -6300, -6450, -6200]) {
    detector.processEvent(read(r, { receivedAt: new Date().toISOString() }))
    await wait(3)
  }
  assert.equal(broadcast.crossings().length, 0)

  detector.processEvent(read(-4100, { receivedAt: new Date().toISOString() }))
  await wait(40)
  assert.equal(broadcast.crossings().length, 1)
  assert.equal(broadcast.crossings()[0].gate, 'finish')
})

test('confirmRssiCdbm unset (null) preserves existing behaviour exactly', async (t) => {
  const { detector, broadcast } = await makeRace(t, {
    config: baseConfig({ rssiThreshold: -6500, confirmRssiCdbm: null }),
  })

  // A peak that would fail any sane confirm bar still confirms when unset.
  detector.processEvent(read(-6400))
  await wait(GONE_MS + 60)

  assert.equal(broadcast.crossings().length, 1)
  assert.equal(broadcast.crossings()[0].gate, 'start')
})

test('confirmRssiCdbm weaker than rssiThreshold is harmless (floor still dominates)', async (t) => {
  const { detector, broadcast } = await makeRace(t, {
    config: baseConfig({ rssiThreshold: -5000, confirmRssiCdbm: -7000 }),
  })
  detector.processEvent(read(-6000)) // below the floor -> never tracked
  await wait(GONE_MS + 60)
  assert.equal(broadcast.crossings().length, 0)

  detector.processEvent(read(-4500)) // above floor, trivially above confirm
  await wait(GONE_MS + 60)
  assert.equal(broadcast.crossings().length, 1)
})
