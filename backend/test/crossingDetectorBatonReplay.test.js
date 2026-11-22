import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { CrossingDetector } from '../src/mqtt/crossingDetector.js'
import { createFakeDb, createFakeBroadcast } from './helpers/fakeDb.js'

// Replay of a real desk test of the baton relay (checkpoint1, 2026-11-22): every read of the two
// baton teams' tags, in the order the reader sent them, through the detector with the production
// windows. The clock is node:test's mock timers (setTimeout and Date), so the detector runs
// unchanged: each read is delivered at its own time, and every timer due before it fires first,
// as it did on the host.
//
// The operator's record of who carried each team's baton, in order, is the ground truth.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/relay-baton-2026-11-22.json', import.meta.url), 'utf8'))

const RENIFERY = [15, 17, 8, 20, 17, 15]
const ELFY = [12, 13, 14, 19, 19, 12, 12]
// The strongest read of each baton pass (ms after the gun, rssi), read off the fixture by hand:
// the reads of one baton with no gap over 5 s between them are one pass. Elfy lap 1 is the
// -4700 read at 16:43:38.119 Warsaw, 10 s after the baton was first heard at -7700.
const RENIFERY_PEAKS = [[46815, -3500], [95194, -5000], [135230, -4950], [184614, -4750], [217276, -4450], [242190, -4450]]
const ELFY_PEAKS = [[47098, -4700], [95890, -5100], [136479, -4250], [186053, -5400], [217525, -5150], [243459, -4800], [268735, -4350]]

const EPC = alias => `EPC-${alias}`

async function replay(t) {
  const gunMs = new Date(fixture.gunAt).getTime()
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: gunMs })
  let clock = gunMs
  const advanceTo = async (ms) => {
    if (ms > clock) { t.mock.timers.tick(ms - clock); clock = ms }
    // Let the lap writes the timers started settle before the next read.
    for (let i = 0; i < 5; i++) await Promise.resolve()
  }

  const participants = []
  const teamOfId = new Map()
  const bibOf = new Map()
  const batons = []
  for (const [alias, { team, bib }] of Object.entries(fixture.tags)) {
    if (bib === null) { batons.push({ teamId: team, epc: EPC(alias) }); continue }
    const id = `p-${alias}`
    participants.push({ id, rfidEpc: EPC(alias), teamId: team })
    teamOfId.set(id, team)
    bibOf.set(id, bib)
  }

  const db = createFakeDb()
  const detector = new CrossingDetector({ db, broadcast: createFakeBroadcast() })
  const raceRun = { id: 'rr-replay', startedAt: new Date(gunMs) }
  await detector.startRace(raceRun, {
    id: 'e-replay', rfidMode: 'single', rfidTopicMain: 'leszyrun', rfidTopicFinish: 'leszyrun/finish',
    confirmRssiCdbm: null, gunBackfillEnabled: true, gunBackfillSeconds: 60,
    teamMode: 'relay_free', teamLapCount: null, teamTimeLimitSeconds: null,
    ...fixture.event, batons,
  }, participants)

  for (const [offsetMs, alias, rssiCdbm, antennaPort] of fixture.reads) {
    await advanceTo(gunMs + offsetMs)
    detector.processEvent({
      epc: EPC(alias), rssiCdbm, antennaPort, topic: 'leszyrun',
      receivedAt: new Date(gunMs + offsetMs).toISOString(), raw: {},
    })
  }
  // The operator stopped the race 2 s after the last read: Elfy's last pass was still open.
  await advanceTo(gunMs + fixture.stoppedAtMs)
  await detector.stopRace(raceRun.id)
  await advanceTo(clock + 60_000)

  const laps = db._inserts().team_laps ?? []
  const table = team => laps
    .filter(l => l.teamId === team && l.status === 'counted')
    .sort((a, b) => a.closedAt - b.closedAt)
    .map(l => ({ bib: bibOf.get(l.participantId) ?? null, atMs: l.closedAt.getTime() - gunMs, peak: l.peakRssiCdbm }))
  return { laps, table, gunMs }
}

test('replay 2026-11-22: every baton lap is credited to the runner who carried the baton', async (t) => {
  const { laps, table } = await replay(t)
  assert.deepEqual(table('renifery').map(l => l.bib), RENIFERY)
  assert.deepEqual(table('elfy').map(l => l.bib), ELFY)
  assert.deepEqual(laps.filter(l => l.status === 'candidate'), [], 'no candidates')
  assert.ok(laps.every(l => l.closedAt.getTime() - new Date(fixture.gunAt).getTime() >= fixture.event.minFinishSeconds * 1000),
    'the batons at the start line made no lap')
})

test('replay 2026-11-22: every baton lap is timed at the baton pass\'s strongest read', async (t) => {
  const { table } = await replay(t)
  assert.deepEqual(table('renifery').map(l => [l.atMs, l.peak]), RENIFERY_PEAKS)
  assert.deepEqual(table('elfy').map(l => [l.atMs, l.peak]), ELFY_PEAKS)
})
