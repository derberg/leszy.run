import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BURST_GAP_MS, ATTRIBUTION_WINDOW_MS, BATON_PASS_MAX_MS, CANDIDATE_WINDOW_MS,
  noteRead, attributeLap, isCandidate, batonTeamMap,
} from '../src/mqtt/batonRelay.js'

const ARRIVAL = 15_000

test('the window values are the ones checked against the 2026-11-22 desk test', () => {
  assert.equal(BURST_GAP_MS, 5000)
  assert.equal(ATTRIBUTION_WINDOW_MS, 5000)
  assert.equal(BATON_PASS_MAX_MS, 30_000)
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

// T is the baton pass's first read.
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
    ['p2', { start: T + 5500, lastSeen: T + 5500, peakRssi: -3500, peakAt: T + 5500, fromCourse: true, candidateDone: false }],
    ['x9', { start: T - 1000, lastSeen: T, peakRssi: -3500, peakAt: T, fromCourse: true, candidateDone: false }], // another team
  ])
  assert.equal(attributeLap(bursts, ['p1', 'p2'], T), null)
})

test('attributeLap: the window is symmetric around the baton\'s first read and its edges are inclusive', () => {
  const T = 600_000
  const at = (start) => new Map([['p1', { start, lastSeen: start, peakRssi: -4000, peakAt: start, fromCourse: true, candidateDone: false }]])
  assert.equal(attributeLap(at(T - ATTRIBUTION_WINDOW_MS), ['p1'], T), 'p1')
  assert.equal(attributeLap(at(T + ATTRIBUTION_WINDOW_MS), ['p1'], T), 'p1')
  assert.equal(attributeLap(at(T - ATTRIBUTION_WINDOW_MS - 1), ['p1'], T), null)
  assert.equal(attributeLap(at(T + ATTRIBUTION_WINDOW_MS + 1), ['p1'], T), null)
  assert.equal(attributeLap(at(T - 1000), ['p1'], T, { windowMs: 500 }), null, 'the window can be passed in')
})

test('attributeLap 2026-11-22, Renifery lap 1: the runner heard 3.2 s before the baton, not the teammate waiting 16 s', () => {
  // Offsets from the gun. The baton was first heard at 39.936 s and peaked at 46.815 s; #15 (who
  // carried it) from 36.698 s, #17 (who took it) had waited at the antenna since 23.960 s. A window
  // around the peak (46.815 - 10 s) missed #15 by 0.08 s.
  const bursts = new Map([
    ['r15', { start: 36_698, lastSeen: 52_657, peakRssi: -3900, peakAt: 47_538, fromCourse: true, candidateDone: false }],
    ['r17', { start: 23_960, lastSeen: 49_212, peakRssi: -2750, peakAt: 27_591, fromCourse: true, candidateDone: false }],
  ])
  assert.equal(attributeLap(bursts, ['r15', 'r17'], 39_936), 'r15')
})

const burst = (over = {}) => ({ start: 400_000, lastSeen: 402_000, peakRssi: -4000, peakAt: 401_000, fromCourse: true, candidateDone: false, ...over })

test('isCandidate: a runner from the course with no lap near them', () => {
  assert.equal(isCandidate(burst(), { teamLastCountedMs: 300_000, minLapMs: 60_000, lapTimesMs: [300_000] }), true)
})

test('isCandidate: a runner who handed over and walks back within min lap is no candidate', () => {
  // the team's last lap closed at 380 s; the runner is back at 400 s with a 60 s min lap
  assert.equal(isCandidate(burst(), { teamLastCountedMs: 380_000, minLapMs: 60_000, lapTimesMs: [380_000] }), false)
})

test('isCandidate: a counted lap from 10 s before the burst to 10 s after it ended means the baton came or left with them', () => {
  // burst 400 s .. 402 s
  const opts = (t) => ({ teamLastCountedMs: 0, minLapMs: 60_000, lapTimesMs: [t] })
  assert.equal(isCandidate(burst(), opts(400_000 - CANDIDATE_WINDOW_MS)), false)
  assert.equal(isCandidate(burst(), opts(402_000 + CANDIDATE_WINDOW_MS)), false)
  assert.equal(isCandidate(burst(), opts(400_000 - CANDIDATE_WINDOW_MS - 1)), true)
  assert.equal(isCandidate(burst(), opts(402_000 + CANDIDATE_WINDOW_MS + 1)), true)
})

test('isCandidate: a teammate who waited at the line and left with the baton is no candidate', () => {
  // walked up at 70 s into the lap (min lap 60 s), waited 20 s, the baton lap closed at 90 s as
  // they took it; the burst ends a second later
  const waiter = burst({ start: 70_000, lastSeen: 91_000, peakAt: 72_000 })
  assert.equal(isCandidate(waiter, { teamLastCountedMs: 0, minLapMs: 60_000, lapTimesMs: [0, 90_000] }), false)
})

test('isCandidate: not from the course, or already raised, is no candidate', () => {
  const opts = { teamLastCountedMs: 0, minLapMs: 0, lapTimesMs: [] }
  assert.equal(isCandidate(burst({ fromCourse: false }), opts), false)
  assert.equal(isCandidate(burst({ candidateDone: true }), opts), false)
})

test('batonTeamMap: only batons with a tag, of teams in this race', () => {
  const teams = new Map([['T', {}], ['U', {}]])
  const m = batonTeamMap([{ teamId: 'T', epc: 'B1' }, { teamId: 'U', epc: null }, { teamId: 'X', epc: 'B9' }], teams)
  assert.deepEqual([...m], [['B1', 'T']])
  assert.equal(batonTeamMap(undefined, teams).size, 0)
})
