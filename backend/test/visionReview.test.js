import { test } from 'node:test'
import assert from 'node:assert/strict'
import { framesAround, parseVerdict, likelyMisread } from '../src/vision/review.js'

// Wilczy Półmaraton 2026-10-17: offset from vision_sessions.clock_offset, and
// a frame whose sensor stamp is 8739.160873 s, read at 08:24:34.158 UTC.
const OFFSET = 1792216734.997
const SENSOR = 8739160873000
const WALL_MS = Date.parse('2026-10-17T08:24:34.158Z')

const stamps = Array.from({ length: 100 }, (_, i) => SENSOR - 5e9 + i * 2e8)  // 5 fps, 20 s

test('the window holds the frames from 3 s before to 1 s after the chip time', () => {
  const frames = framesAround(stamps, OFFSET, WALL_MS)
  assert.ok(frames.length >= 20 && frames.length <= 21)  // 4 s at 5 fps, edges inclusive
  assert.ok(frames[0] >= SENSOR - 3e9 - 1e6)
  assert.ok(frames.at(-1) <= SENSOR + 1e9 + 1e6)
})

test('a session with no clock offset shows no frames rather than wrong ones', () => {
  assert.deepEqual(framesAround(stamps, null, WALL_MS), [])
})

test('a finish outside the recording has no frames', () => {
  assert.deepEqual(framesAround(stamps, OFFSET, WALL_MS + 3600e3), [])
})

test('a visible bib needs the number, the frame and the point', () => {
  assert.ok(parseVerdict({ verdict: 'visible', bibNumber: '185' }).error)
  const ok = parseVerdict({ verdict: 'visible', bibNumber: ' 185 ', frameTs: SENSOR, x: 0.4, y: 0.7 })
  assert.deepEqual(ok.value, { verdict: 'visible', bibNumber: '185', frameTs: SENSOR, x: 0.4, y: 0.7 })
})

test('a point outside the frame is refused', () => {
  assert.ok(parseVerdict({ verdict: 'visible', bibNumber: '1', frameTs: 1, x: 1.2, y: 0.5 }).error)
})

test('covered, no number on the front and not in the photos carry nothing else', () => {
  for (const verdict of ['covered', 'no_front', 'absent']) {
    assert.deepEqual(parseVerdict({ verdict, bibNumber: '5', x: 0.1 }).value,
      { verdict, bibNumber: null, frameTs: null, x: null, y: null })
  }
  assert.ok(parseVerdict({ verdict: 'maybe' }).error)
})

// ─── likelyMisread ──────────────────────────────────────────────────────────
// Every case is a read from the Wilczy Półmaraton 2026-10-17 replay, checked
// against the frame by eye.

const at = (hms) => Date.parse(`2026-10-17T${hms}+02:00`)
const fin = (bibNumber, hms, status = 'finished') =>
  ({ bibNumber, status, finishMs: hms ? at(hms) : null })

const FIELD = [
  fin('112', '10:57:47'), fin('106', '10:57:55'), fin('12', null, 'dns'),
  fin('64', '11:13:58'), fin('84', '11:11:04'), fin('13', '11:14:07'),
  fin('219', '11:23:41'), fin('119', '11:48:47'),
  fin('138', '11:31:46'), fin('136', '11:56:57'),
  fin('148', '10:33:18'), fin('146', null, 'dns'), fin('175', '10:35:10'),
  fin('172', '10:59:56'), fin('178', '10:59:57'),
  fin('90', '11:05:46'), fin('95', '11:05:46'),
  fin('210', '11:32:49'), fin('217', '11:32:49'),
]

test('a read one digit from a chip finisher at that moment names the finisher', () => {
  for (const [read, hms, truth] of [
    ['12', '10:57:47', '112'],   // dropped digit
    ['84', '11:13:58', '64'],    // swapped digit
    ['119', '11:23:41', '219'],  // leading digit under the arm
    ['136', '11:31:46', '138'],  // last digit under the watch
  ]) {
    const s = likelyMisread({ bibNumber: read, sightedAtMs: at(hms) }, FIELD)
    assert.deepEqual(s, { reason: 'neighbour', bib: truth }, read)
  }
})

test('a read of a DNS runner is suspect even with no neighbour at that moment', () => {
  // 148 walking back out with the bib on his back, read as 146.
  assert.deepEqual(likelyMisread({ bibNumber: '146', sightedAtMs: at('10:35:15') }, FIELD), { reason: 'dns' })
})

test('two runners with neighbouring numbers finishing together are both left alone', () => {
  for (const [read, hms] of [['172', '11:00:01'], ['178', '11:00:01'], ['90', '11:05:44'],
    ['95', '11:05:44'], ['210', '11:32:48'], ['217', '11:32:47']]) {
    assert.equal(likelyMisread({ bibNumber: read, sightedAtMs: at(hms) }, FIELD), null, read)
  }
})

test('a finisher walking back past the gate later is not suspect', () => {
  // 148 two minutes after his chip finish: nobody one digit away finished then.
  assert.equal(likelyMisread({ bibNumber: '148', sightedAtMs: at('10:35:15') }, FIELD), null)
})

test('an unreadable pass is never suspect', () => {
  assert.equal(likelyMisread({ bibNumber: null, sightedAtMs: at('10:57:47') }, FIELD), null)
})
