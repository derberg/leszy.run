import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseLog,
  matchRoster,
  sessionStats,
  healthVerdict,
} from '../src/vision/ingest.js'

// ─── parseLog ───────────────────────────────────────────────────────────────
// The reader appends to sightings.jsonl while the backend reads it. A reader
// that consumed a partial line would turn one runner into two rows, the second
// of them a crossing with no bib, which is indistinguishable from a real
// unreadable runner. So the cursor only ever advances past a newline.

test('a complete line is consumed and the cursor lands after it', () => {
  const text = '{"bib_number":"47"}\n'
  const { records, nextCursor } = parseLog(Buffer.from(text), 0)
  assert.equal(records.length, 1)
  assert.equal(records[0].bib_number, '47')
  assert.equal(nextCursor, Buffer.byteLength(text))
})

test('a half-written final line is left for the next poll', () => {
  const complete = '{"bib_number":"47"}\n'
  const torn = '{"bib_num'
  const { records, nextCursor } = parseLog(Buffer.from(complete + torn), 0)
  assert.equal(records.length, 1)
  // The cursor stops at the newline, so the torn line is re-read whole once
  // the writer finishes it.
  assert.equal(nextCursor, Buffer.byteLength(complete))
})

test('the torn line is recovered intact on the next poll', () => {
  const first = '{"bib_number":"47"}\n'
  const partial = '{"bib_number":"8'
  const rest = '6"}\n'
  const a = parseLog(Buffer.from(first + partial), 0)
  const whole = Buffer.from(first + partial + rest)
  const b = parseLog(whole.subarray(a.nextCursor), a.nextCursor)
  assert.deepEqual(b.records.map(r => r.bib_number), ['86'])
})

test('a line that is not JSON is skipped rather than killing the poll', () => {
  const text = 'this is not json\n{"bib_number":"47"}\n'
  const { records } = parseLog(Buffer.from(text), 0)
  assert.deepEqual(records.map(r => r.bib_number), ['47'])
})

test('an empty read advances nothing', () => {
  const { records, nextCursor } = parseLog(Buffer.alloc(0), 512)
  assert.deepEqual(records, [])
  assert.equal(nextCursor, 512)
})

test('the cursor is counted in bytes, not characters', () => {
  // A Polish name or a non-ASCII note would desync a character-counted
  // cursor and every subsequent line would be shifted.
  const text = '{"note":"zażółć"}\n{"bib_number":"47"}\n'
  const { nextCursor } = parseLog(Buffer.from(text), 0)
  assert.equal(nextCursor, Buffer.byteLength(text))
  assert.notEqual(Buffer.byteLength(text), text.length)
})

// ─── matchRoster ────────────────────────────────────────────────────────────
// The only quality signal available with no ground truth: a recognised number
// that matches nobody in this race is almost certainly a misread.

const roster = new Map([['47', 'p-47'], ['86', 'p-86'], ['007', 'p-7']])

test('a number in the roster resolves to that participant', () => {
  assert.equal(matchRoster('47', roster), 'p-47')
})

test('a number nobody is wearing resolves to nothing', () => {
  assert.equal(matchRoster('863', roster), null)
})

test('an unreadable sighting is not a roster miss', () => {
  // It never claimed a number, so counting it as a wrong number would
  // slander the recognizer and hide the real misreads.
  assert.equal(matchRoster(null, roster), null)
})

test('a leading zero is not normalised away', () => {
  // The recognizer is allowed to return 007 and bib 007 may exist alongside
  // bib 7. Stripping the zero would hand one runner the other's row.
  assert.equal(matchRoster('007', roster), 'p-7')
  assert.equal(matchRoster('7', roster), null)
})

// ─── sessionStats ───────────────────────────────────────────────────────────

const sighting = (over = {}) => ({
  bibNumber: '47', participantId: 'p-47', confidence: 0.9, frameCount: 20, ...over,
})

test('recognition rate keeps unreadable tracks in the denominator', () => {
  const stats = sessionStats([
    sighting(), sighting(), sighting({ bibNumber: null, participantId: null }),
    sighting({ bibNumber: null, participantId: null }),
  ])
  assert.equal(stats.recognitionRate, 0.5)
})

test('roster match rate is measured against recognised numbers only', () => {
  // Dividing by every track would punish the recognizer for runners it never
  // claimed to read, and the number would stop meaning "how often is a
  // number we produced a real one".
  const stats = sessionStats([
    sighting(), sighting({ bibNumber: '999', participantId: null }),
    sighting({ bibNumber: null, participantId: null }),
  ])
  assert.equal(stats.recognised, 2)
  assert.equal(stats.rosterMatched, 1)
  assert.equal(stats.rosterMatchRate, 0.5)
})

test('an empty session reports zero rather than dividing by zero', () => {
  const stats = sessionStats([])
  assert.equal(stats.recognitionRate, 0)
  assert.equal(stats.rosterMatchRate, 0)
  assert.equal(stats.total, 0)
})

test('frames per track is bucketed so a bad camera angle is visible', () => {
  // ~30 frames means the camera points down the lane. A cluster at 4 means
  // it points across it and votes cannot outvote a bad frame.
  const stats = sessionStats([
    sighting({ frameCount: 2 }), sighting({ frameCount: 4 }),
    sighting({ frameCount: 30 }), sighting({ frameCount: 40 }),
  ])
  assert.equal(stats.framesPerTrack['1-4'], 2)
  assert.equal(stats.framesPerTrack['25+'], 2)
})

test('stats never report a read rate, because nothing here measures one', () => {
  // Naming an unmeasured number after a measured one is how confirm_rssi_cdbm
  // got set from an assumption that measurement later contradicted.
  assert.ok(!('readRate' in sessionStats([sighting()])))
})

// ─── healthVerdict ──────────────────────────────────────────────────────────

const health = (over = {}) => ({
  capture_alive: true, keeping_up: true, clock_synced: true,
  exposure: 'ok', torn_frames: 0, ordering_anomalies: [],
  pending: 0, updated_at: Date.now() / 1000, ...over,
})

test('everything healthy reads as ok', () => {
  assert.equal(healthVerdict(health()).level, 'ok')
})

test('a dead camera outranks every other complaint', () => {
  // If no frame is arriving, the exposure and the backlog are consequences,
  // not the thing to go and fix.
  const v = healthVerdict(health({ capture_alive: false, exposure: 'dark', keeping_up: false }))
  assert.equal(v.level, 'error')
  assert.match(v.headline, /kamer/i)
})

test('a stale heartbeat means the reader died, not the camera', () => {
  const v = healthVerdict(health({ updated_at: Date.now() / 1000 - 120 }))
  assert.equal(v.level, 'error')
  assert.match(v.headline, /odczyt/i)
})

test('a missing health file is unknown, not healthy', () => {
  // The dangerous default. "No news is good news" on a race morning check is
  // exactly the wrong reading.
  const v = healthVerdict(null)
  assert.equal(v.level, 'unknown')
})

test('wrong exposure is a warning the operator can act on', () => {
  const v = healthVerdict(health({ exposure: 'dark' }))
  assert.equal(v.level, 'warn')
  assert.match(v.headline, /ciemn/i)
})

test('falling behind is a warning and names the backlog', () => {
  const v = healthVerdict(health({ keeping_up: false, pending: 240 }))
  assert.equal(v.level, 'warn')
  assert.match(v.headline, /240/)
})

test('an unsynced clock is an error because every timestamp is then suspect', () => {
  assert.equal(healthVerdict(health({ clock_synced: false })).level, 'error')
})
