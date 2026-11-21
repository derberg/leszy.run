import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BURST_GAP_MS, ATTRIBUTION_BEFORE_MS, ATTRIBUTION_AFTER_MS, CANDIDATE_WINDOW_MS,
  noteRead, attributeLap, isCandidate, batonTeamMap,
} from '../src/mqtt/batonRelay.js'

const ARRIVAL = 15_000

test('the window values are the ones the design names', () => {
  assert.equal(BURST_GAP_MS, 5000)
  assert.equal(ATTRIBUTION_BEFORE_MS, 10_000)
  assert.equal(ATTRIBUTION_AFTER_MS, 2000)
  assert.equal(CANDIDATE_WINDOW_MS, 10_000)
})

test('noteRead: the first read opens a burst from the course and tracks its peak', () => {
  const bursts = new Map()
  const b = noteRead(bursts, 'p1', 1000, -6000, ARRIVAL)
  assert.deepEqual(b, { start: 1000, lastSeen: 1000, peakRssi: -6000, peakAt: 1000, fromCourse: true, candidateDone: false })
  noteRead(bursts, 'p1', 2000, -4000, ARRIVAL)
  noteRead(bursts, 'p1', 3000, -5000, ARRIVAL)
  const same = bursts.get('p1')
  assert.equal(same, b, 'reads within 5 s extend the same burst')
  assert.equal(same.start, 1000)
  assert.equal(same.lastSeen, 3000)
  assert.equal(same.peakRssi, -4000)
  assert.equal(same.peakAt, 2000)
})

test('noteRead: a gap over 5 s starts a new burst; it came from the course only after the arrival silence', () => {
  const bursts = new Map()
  noteRead(bursts, 'p1', 0, -5000, ARRIVAL)
  const nearby = noteRead(bursts, 'p1', 5000, -5000, ARRIVAL)
  assert.equal(nearby.start, 0, 'exactly 5 s is still the same burst')
  const back = noteRead(bursts, 'p1', 11_000, -5000, ARRIVAL) // 6 s unheard: new burst, not from the course
  assert.equal(back.start, 11_000)
  assert.equal(back.fromCourse, false)
  const lap = noteRead(bursts, 'p1', 26_000, -5000, ARRIVAL) // 15 s unheard: from the course
  assert.equal(lap.start, 26_000)
  assert.equal(lap.fromCourse, true)
})

test('attributeLap: the incoming runner, not the teammate read continuously at the antenna', () => {
  const T = 600_000
  const bursts = new Map([
    // waiting since two minutes before the lap, read all the time
    ['p2', { start: T - 120_000, lastSeen: T + 1000, peakRssi: -4000, peakAt: T - 60_000, fromCourse: true, candidateDone: false }],
    // came in with the baton
    ['p1', { start: T - 3000, lastSeen: T + 1000, peakRssi: -3500, peakAt: T, fromCourse: true, candidateDone: false }],
  ])
  assert.equal(attributeLap(bursts, ['p1', 'p2', 'p3'], T), 'p1')
})

test('attributeLap: two members arriving together leave the lap without a runner', () => {
  const T = 600_000
  const bursts = new Map([
    ['p1', { start: T - 3000, lastSeen: T, peakRssi: -3500, peakAt: T, fromCourse: true, candidateDone: false }],
    ['p2', { start: T - 1000, lastSeen: T, peakRssi: -3500, peakAt: T, fromCourse: true, candidateDone: false }],
  ])
  assert.equal(attributeLap(bursts, ['p1', 'p2'], T), null)
})

test('attributeLap: nobody arrived (or only a burst that did not come from the course) → no runner', () => {
  const T = 600_000
  assert.equal(attributeLap(new Map(), ['p1', 'p2'], T), null)
  const bursts = new Map([
    ['p1', { start: T - 3000, lastSeen: T, peakRssi: -3500, peakAt: T, fromCourse: false, candidateDone: false }],
    ['p2', { start: T + 2500, lastSeen: T + 2500, peakRssi: -3500, peakAt: T + 2500, fromCourse: true, candidateDone: false }],
    ['x9', { start: T - 1000, lastSeen: T, peakRssi: -3500, peakAt: T, fromCourse: true, candidateDone: false }], // another team
  ])
  assert.equal(attributeLap(bursts, ['p1', 'p2'], T), null)
})

test('attributeLap: the window edges are inclusive', () => {
  const T = 600_000
  const at = (start) => new Map([['p1', { start, lastSeen: start, peakRssi: -4000, peakAt: start, fromCourse: true, candidateDone: false }]])
  assert.equal(attributeLap(at(T - ATTRIBUTION_BEFORE_MS), ['p1'], T), 'p1')
  assert.equal(attributeLap(at(T + ATTRIBUTION_AFTER_MS), ['p1'], T), 'p1')
  assert.equal(attributeLap(at(T - ATTRIBUTION_BEFORE_MS - 1), ['p1'], T), null)
  assert.equal(attributeLap(at(T + ATTRIBUTION_AFTER_MS + 1), ['p1'], T), null)
})

const burst = (over = {}) => ({ start: 400_000, lastSeen: 402_000, peakRssi: -4000, peakAt: 401_000, fromCourse: true, candidateDone: false, ...over })

test('isCandidate: a runner from the course with no baton lap near them', () => {
  assert.equal(isCandidate(burst(), { teamLastCountedMs: 300_000, minLapMs: 60_000, batonLapTimesMs: [300_000] }), true)
})

test('isCandidate: a runner who handed over and walks back within min lap is no candidate', () => {
  // the team's last lap closed at 380 s; the runner is back at 400 s with a 60 s min lap
  assert.equal(isCandidate(burst(), { teamLastCountedMs: 380_000, minLapMs: 60_000, batonLapTimesMs: [380_000] }), false)
})

test('isCandidate: a baton lap within 10 s of the runner\'s peak means the baton came too', () => {
  const opts = (t) => ({ teamLastCountedMs: 0, minLapMs: 60_000, batonLapTimesMs: [t] })
  assert.equal(isCandidate(burst(), opts(401_000 + CANDIDATE_WINDOW_MS)), false)
  assert.equal(isCandidate(burst(), opts(401_000 - CANDIDATE_WINDOW_MS)), false)
  assert.equal(isCandidate(burst(), opts(401_000 + CANDIDATE_WINDOW_MS + 1)), true)
})

test('isCandidate: not from the course, or already raised, is no candidate', () => {
  const opts = { teamLastCountedMs: 0, minLapMs: 0, batonLapTimesMs: [] }
  assert.equal(isCandidate(burst({ fromCourse: false }), opts), false)
  assert.equal(isCandidate(burst({ candidateDone: true }), opts), false)
})

test('batonTeamMap: only batons with a tag, of teams in this race', () => {
  const teams = new Map([['T', {}], ['U', {}]])
  const m = batonTeamMap([{ teamId: 'T', epc: 'B1' }, { teamId: 'U', epc: null }, { teamId: 'X', epc: 'B9' }], teams)
  assert.deepEqual([...m], [['B1', 'T']])
  assert.equal(batonTeamMap(undefined, teams).size, 0)
})
