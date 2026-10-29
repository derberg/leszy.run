import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { kmMarkers, markerStepKm, isLoop, profileShape } from '../../src/lib/courseGeometry.js'

// A straight line north along a meridian: 0.009° of latitude ≈ 1.0 km.
const north = (n) => Array.from({ length: n + 1 }, (_, i) => [50 + i * 0.009, 18.5])

describe('markerStepKm', () => {
  it('every km on short courses, every 2 km on a 9 km loop, then 5 and 10', () => {
    assert.equal(markerStepKm(3), 1)
    assert.equal(markerStepKm(9.1), 2)
    assert.equal(markerStepKm(21.1), 5)
    assert.equal(markerStepKm(42.2), 10)
  })
})

describe('kmMarkers', () => {
  it('one marker at each step along the track, never at the start or past the end', () => {
    const m = kmMarkers(north(10), 2)
    assert.deepEqual(m.map((x) => x.km), [2, 4, 6, 8, 10].filter((k) => k < 10.0))
    for (const x of m) assert.ok(Math.abs(x.lat - (50 + x.km * 0.009)) < 0.0005, JSON.stringify(x))
  })

  it('nothing for a track too short or missing', () => {
    assert.deepEqual(kmMarkers([[50, 18]], 1), [])
    assert.deepEqual(kmMarkers(null, 1), [])
  })
})

describe('isLoop', () => {
  it('start and finish within 300 m', () => {
    assert.equal(isLoop([[50, 18.5], [50.01, 18.5], [50.0005, 18.5]]), true)
    assert.equal(isLoop(north(3)), false)
  })
})

describe('profileShape', () => {
  it('an SVG line and area scaled to the box, with the km ticks at start, middle and end', () => {
    const s = profileShape([[0, 250], [3, 300], [9, 250]], { width: 350, height: 90, pad: 14 })
    assert.equal(s.line, 'M0 62 L116.67 14 L350 62')
    assert.equal(s.area, 'M0 62 L116.67 14 L350 62 L350 90 L0 90 Z')
    assert.deepEqual(s.ticks, [{ x: 0, label: '0' }, { x: 175, label: '4,5' }, { x: 350, label: '9 km' }])
    assert.equal(profileShape([[0, 1], [9.1, 2]], { width: 350, height: 90 }).ticks[2].label, '9,1 km')
    assert.deepEqual({ min: s.minEle, max: s.maxEle }, { min: 250, max: 300 })
  })

  it('a flat course sits in the middle; fewer than two points draw nothing', () => {
    const flat = profileShape([[0, 100], [3, 100]], { width: 300, height: 90, pad: 14 })
    assert.equal(flat.line, 'M0 38 L300 38')
    assert.equal(profileShape([[0, 1]], { width: 300, height: 90 }), null)
  })
})
