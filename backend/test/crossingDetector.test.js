import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CrossingDetector } from '../src/mqtt/crossingDetector.js'
import { createFakeDb, createFakeBroadcast, wait } from './helpers/fakeDb.js'

// Short windows so the exit-triggered start confirms in milliseconds, not seconds.
const GONE_MS = 60
// The finish pass, scaled the same way: closes GONE_MS after its last new peak,
// and FINISH_MAX_MS after its first read at the latest.
const FINISH_MAX_MS = 4 * GONE_MS

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

async function makeRace(t, { config = baseConfig(), resultsRows = [], checkinRows = [], participants = [{ id: 'p1', rfidEpc: 'EPC1' }] } = {}) {
  const db = createFakeDb({ resultsRows, checkinRows })
  const broadcast = createFakeBroadcast()
  const detector = new CrossingDetector({ db, broadcast, finishQuietMs: GONE_MS, finishMaxPassMs: FINISH_MAX_MS })
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

test('FINISH confirms at the peak of the window, not at the first read', async (t) => {
  const { detector, broadcast } = await makeRace(t, {
    resultsRows: [{ id: 'res-1', participantId: 'p1', startTime: new Date(Date.now() - 30_000), status: 'started' }],
  })

  detector.processEvent(read(-7800)) // first heard far out
  await wait(5)
  const peakAt = new Date().toISOString()
  detector.processEvent(read(-4000, { receivedAt: peakAt })) // at the line
  await wait(5)
  detector.processEvent(read(-6900))
  await wait(20)
  assert.equal(broadcast.crossings().length, 0, 'nothing is confirmed while the window is open')

  await wait(GONE_MS + 60)
  const crossings = broadcast.crossings()
  assert.equal(crossings.length, 1)
  assert.equal(crossings[0].gate, 'finish')
  assert.equal(new Date(crossings[0].confirmedAt).toISOString(), peakAt)
  assert.equal(crossings[0].peakRssiCdbm, -4000)
})

test('a chip finish keeps a DSQ that the operator set', async (t) => {
  const { detector, db } = await makeRace(t, {
    resultsRows: [{ id: 'res-1', participantId: 'p1', startTime: new Date(Date.now() - 30_000), status: 'dsq', statusNote: 'skrót' }],
  })

  detector.processEvent(read(-4000))
  await wait(GONE_MS + 60)

  const r = db._rows().find(x => x.participantId === 'p1')
  assert.ok(r.finishTime, 'the finish time is still recorded')
  assert.equal(r.status, 'dsq')
  assert.equal(r.position ?? null, null, 'a DSQ never places')
})

test('a FINISH pass stays open while the signal is still rising (2026-10-15, bib 4)', async (t) => {
  // Bib 4 was first heard 4.5 s before its peak. The old fixed 3 s window closed
  // while the runner was still walking in and timed the finish 1.58 s early, at
  // -6450 instead of the -3300 read at the line. Scaled down: reads every 40 ms,
  // each stronger, for longer than the quiet window.
  const { detector, broadcast } = await makeRace(t, {
    resultsRows: [{ id: 'res-1', participantId: 'p1', startTime: new Date(Date.now() - 30_000), status: 'started' }],
  })

  let peakAt
  for (const r of [-7850, -7550, -7000, -6450, -5400, -4800, -3300]) {
    peakAt = new Date().toISOString()
    detector.processEvent(read(r, { receivedAt: peakAt }))
    await wait(40)
  }
  assert.equal(broadcast.crossings().length, 0, 'still open: the last new peak is under GONE_MS old')

  await wait(GONE_MS + 60)
  const crossings = broadcast.crossings()
  assert.equal(crossings.length, 1)
  assert.equal(crossings[0].peakRssiCdbm, -3300)
  assert.equal(new Date(crossings[0].confirmedAt).toISOString(), peakAt)
})

test('a FINISH pass closes once no stronger read arrives for the quiet window', async (t) => {
  const { detector, broadcast } = await makeRace(t, {
    resultsRows: [{ id: 'res-1', participantId: 'p1', startTime: new Date(Date.now() - 30_000), status: 'started' }],
  })

  const peakAt = new Date().toISOString()
  detector.processEvent(read(-3500, { receivedAt: peakAt }))
  await wait(GONE_MS + 30)
  assert.equal(broadcast.crossings().length, 1, 'closed GONE_MS after the peak, not FINISH_MAX_MS after the first read')
  assert.equal(new Date(broadcast.crossings()[0].confirmedAt).toISOString(), peakAt)
})

test('a FINISH pass closes FINISH_MAX_MS after its first read, even while reads keep getting stronger', async (t) => {
  // A finisher who stops right under the antenna can keep producing slightly
  // stronger reads. The cap stops them from moving their own finish time.
  const { detector, broadcast } = await makeRace(t, {
    resultsRows: [{ id: 'res-1', participantId: 'p1', startTime: new Date(Date.now() - 30_000), status: 'started' }],
  })

  const t0 = Date.now()
  let rssi = -6400 // above the -6500 tracking floor, so the first read opens the pass
  while (Date.now() - t0 < FINISH_MAX_MS + 150) {
    detector.processEvent(read(rssi, { receivedAt: new Date().toISOString() }))
    rssi += 100
    await wait(30)
  }
  const crossings = broadcast.crossings()
  assert.equal(crossings.length, 1, 'closed by the cap although every read was a new peak')
  assert.ok(new Date(crossings[0].confirmedAt).getTime() - t0 <= FINISH_MAX_MS, 'no read after the cap competes for the peak')

  await wait(GONE_MS + 60)
  assert.equal(broadcast.crossings().length, 1, 'a finish is never re-timed')
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

test('a FINISH pass whose peak misses the crossing bar is discarded and the real pass still counts', async (t) => {
  const { detector, broadcast } = await makeRace(t, {
    config: baseConfig({ rssiThreshold: -9000, confirmRssiCdbm: -7000 }),
    resultsRows: [{ id: 'res-1', participantId: 'p1', startTime: new Date(Date.now() - 30_000), status: 'started' }],
  })

  // Heard once from a stretch of course 30 m from the gate, mid-race.
  detector.processEvent(read(-7900))
  await wait(GONE_MS + 60)
  assert.equal(broadcast.crossings().length, 0, 'a far-away pass is not a finish')

  const realAt = new Date().toISOString()
  detector.processEvent(read(-6800, { receivedAt: realAt }))
  await wait(GONE_MS + 60)
  assert.equal(broadcast.crossings().length, 1)
  assert.equal(broadcast.crossings()[0].gate, 'finish')
  assert.equal(new Date(broadcast.crossings()[0].confirmedAt).toISOString(), realAt)
})

test('the 2026-08-07 case: a pass just under the old -6500 floor is now timed', async (t) => {
  const { detector, broadcast } = await makeRace(t, {
    config: baseConfig({ rssiThreshold: -9000, confirmRssiCdbm: -7000 }),
    resultsRows: [{ id: 'res-1', participantId: 'p1', startTime: new Date(Date.now() - 30_000), status: 'started' }],
  })

  for (const r of [-7600, -7100, -6700, -6900]) {
    detector.processEvent(read(r, { receivedAt: new Date().toISOString() }))
    await wait(3)
  }
  await wait(GONE_MS + 60)
  assert.equal(broadcast.crossings().length, 1)
  assert.equal(broadcast.crossings()[0].peakRssiCdbm, -6700)
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

// ---------------------------------------------------------------------------
// Post-finish audit window. The tail of a finish pass must reach gate_events so
// "solid crossing or one lucky ping?" is answerable after the race, while later
// reads never re-time an existing finish.
// ---------------------------------------------------------------------------

test('reads after a confirmed finish are still persisted for audit', async (t) => {
  const { detector, broadcast, db } = await makeRace(t, {
    resultsRows: [{ id: 'res-1', participantId: 'p1', startTime: new Date(Date.now() - 30_000), status: 'started' }],
  })

  detector.processEvent(read(-6300))                 // the pass, confirmed after silence
  await wait(GONE_MS + 60)
  assert.equal(broadcast.crossings().length, 1)

  // Ascending RSSI: the 200 ms dedup window keeps only improving reads per EPC,
  // so a descending sequence would be dropped there and prove nothing about audit.
  detector.processEvent(read(-5200, { receivedAt: new Date(Date.now() + 1).toISOString() }))
  await wait(20)
  detector.processEvent(read(-4800, { receivedAt: new Date(Date.now() + 2).toISOString() }))
  await wait(GONE_MS + 60)

  assert.equal(broadcast.crossings().length, 1, 'still exactly one finish')
  assert.equal(db._inserts().gate_crossings.length, 1)

  const events = db._inserts().gate_events
  assert.equal(events.length, 3, 'reads after the finish are audited too')
  assert.deepEqual(events.map(e => e.rssiCdbm), [-6300, -5200, -4800])
})

test('post-finish reads still respect rssiThreshold', async (t) => {
  const { detector, db } = await makeRace(t, {
    resultsRows: [{ id: 'res-1', participantId: 'p1', startTime: new Date(Date.now() - 30_000), status: 'started' }],
  })

  detector.processEvent(read(-6300))                 // the finish pass
  await wait(GONE_MS + 60)
  detector.processEvent(read(-7400, { receivedAt: new Date(Date.now() + 1).toISOString() }))
  await wait(30)

  assert.equal(db._inserts().gate_events.length, 1, 'far-field noise stays out of the audit trail')
})

// ---------------------------------------------------------------------------
// Gun-time backfill only ever credits a CHECKED-IN runner.
//
// A runner who never checked in has not accepted the regulamin and is not
// allowed to start. Crediting them with gun time made them 'started', so the
// stop button's markRemainingDnf turned them into DNF instead of DNS. The tag
// alone proves nothing: chips are assigned before bib pickup.
// ---------------------------------------------------------------------------

const BACKFILL_MS = 50
const twoRunners = [
  { id: 'p1', rfidEpc: 'EPC1' }, // checked in
  { id: 'p2', rfidEpc: 'EPC2' }, // registered only
]
const p1CheckedIn = [{ participantId: 'p1', checkedInAt: new Date() }, { participantId: 'p2', checkedInAt: null }]

test('backfill timer gives gun time to a checked-in runner but not to one who never checked in', async (t) => {
  const { db } = await makeRace(t, {
    config: baseConfig({ gunBackfillEnabled: true, gunBackfillSeconds: BACKFILL_MS / 1000 }),
    participants: twoRunners,
    checkinRows: p1CheckedIn,
  })

  await wait(BACKFILL_MS + 60)

  const byId = Object.fromEntries(db._rows().map((r) => [r.participantId, r]))
  assert.equal(byId.p1?.startTimeSource, 'gun')
  assert.equal(byId.p1?.status, 'started')
  assert.equal(byId.p2, undefined, 'a runner without check-in gets no result row, so stopping the race marks them DNS')
})

test('backfill timer leaves a runner the operator marked DNS alone', async (t) => {
  const { db } = await makeRace(t, {
    config: baseConfig({ gunBackfillEnabled: true, gunBackfillSeconds: BACKFILL_MS / 1000 }),
    participants: [{ id: 'p1', rfidEpc: 'EPC1' }],
    checkinRows: [{ participantId: 'p1', checkedInAt: new Date() }],
    resultsRows: [{ id: 'res-1', participantId: 'p1', status: 'dns' }],
  })

  await wait(BACKFILL_MS + 60)

  const r = db._rows().find(x => x.participantId === 'p1')
  assert.equal(r.status, 'dns')
  assert.equal(r.startTime, undefined)
})

test('a finish read does not credit gun time to a runner who never checked in', async (t) => {
  const { detector, db, broadcast } = await makeRace(t, {
    config: baseConfig({ rfidMode: 'separate', gunBackfillEnabled: true, gunBackfillSeconds: 3600 }),
    participants: twoRunners,
    checkinRows: p1CheckedIn,
  })

  detector.processEvent(read(-4000, { topic: 'leszyrun/finish' }))
  detector.processEvent(read(-4000, { epc: 'EPC2', topic: 'leszyrun/finish' }))
  await wait(GONE_MS + 60)

  assert.equal(broadcast.crossings().length, 2)
  const byId = Object.fromEntries(db._rows().map((r) => [r.participantId, r]))
  assert.equal(byId.p1.startTimeSource, 'gun')
  assert.equal(byId.p1.startTimeTrigger, 'finish_crossing')
  assert.ok(byId.p1.durationMs > 0)
  assert.ok(byId.p2.finishTime, 'the raw finish is still recorded for the operator')
  assert.equal(byId.p2.startTime, undefined)
  assert.equal(byId.p2.durationMs, null)
  assert.equal(byId.p2.gunDurationMs, null)
})
