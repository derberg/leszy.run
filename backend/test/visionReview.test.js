import { test } from 'node:test'
import assert from 'node:assert/strict'
import { framesAround, parseVerdict } from '../src/vision/review.js'

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
