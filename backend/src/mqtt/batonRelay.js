/**
 * Relay in any order (categories.team_mode = 'relay_free'), timed by each team's baton. Pure helpers, no DB.
 *
 * The team's laps come from its baton tag only (crossingDetector.js). The runners' own tags
 * feed two things: who ran the lap (attribution) and laps that came in without the baton
 * (candidates, which never count until the operator approves them).
 *
 * A runner's reads are grouped into bursts. A burst "came from the course" when the tag had
 * been silent for the event's arrival silence before it: the runner arriving with the baton
 * did, the teammate waiting at the line (read continuously) did not.
 *
 * The window values are the design's first choice (2026-11-21), to be tuned from a test.
 */

// A read this long after the previous one of the same tag starts a new burst.
export const BURST_GAP_MS = 5000
// A baton lap at T is credited to the member whose from-the-course burst started in
// [T - ATTRIBUTION_BEFORE_MS, T + ATTRIBUTION_AFTER_MS].
export const ATTRIBUTION_BEFORE_MS = 10_000
export const ATTRIBUTION_AFTER_MS = 2000
// A runner burst is a candidate only with no baton lap of the team from this long before it
// started to this long after its last read.
export const CANDIDATE_WINDOW_MS = 10_000

/**
 * @typedef {{ start: number, lastSeen: number, peakRssi: number, peakAt: number, fromCourse: boolean, candidateDone: boolean }} Burst
 */

/**
 * Adds one read of a runner to their current burst, or starts a new one.
 * @param {Map<string, Burst>} bursts participantId -> current burst
 * @returns {Burst} the burst this read belongs to
 */
export function noteRead(bursts, participantId, atMs, rssi, arrivalSilenceMs, gapMs = BURST_GAP_MS) {
  const prev = bursts.get(participantId)
  if (!prev || atMs - prev.lastSeen > gapMs) {
    const burst = {
      start: atMs,
      lastSeen: atMs,
      peakRssi: rssi,
      peakAt: atMs,
      fromCourse: !prev || atMs - prev.lastSeen >= arrivalSilenceMs,
      candidateDone: false,
    }
    bursts.set(participantId, burst)
    return burst
  }
  prev.lastSeen = Math.max(prev.lastSeen, atMs)
  if (rssi > prev.peakRssi) {
    prev.peakRssi = rssi
    prev.peakAt = atMs
  }
  return prev
}

/**
 * The runner of a baton lap closed at `lapAtMs`: the one team member whose current burst came
 * from the course and started inside the attribution window. None or several → null (the lap
 * counts for the team, the operator picks the runner).
 * @returns {string|null}
 */
export function attributeLap(bursts, memberIds, lapAtMs, { beforeMs = ATTRIBUTION_BEFORE_MS, afterMs = ATTRIBUTION_AFTER_MS } = {}) {
  const found = []
  for (const id of memberIds) {
    const b = bursts.get(id)
    if (!b || !b.fromCourse) continue
    if (b.start >= lapAtMs - beforeMs && b.start <= lapAtMs + afterMs) found.push(id)
  }
  return found.length === 1 ? found[0] : null
}

/**
 * Whether a runner burst that has ENDED is a lap that came in without the baton. Decide it only
 * once no read has come for the burst gap and the window after the burst has passed, so a baton
 * lap that closes as the runner leaves is known. It is a candidate when it came from the course,
 * has not been decided yet, started at least `minLapMs` after the team's last counted lap (a
 * runner who handed over and walks back is not one), and no baton lap of the team closed between
 * `windowMs` before the burst started and `windowMs` after its last read (`burst.lastSeen`):
 * a runner who arrived with the baton, or a teammate who waited at the line and left with it,
 * is never a candidate.
 */
export function isCandidate(burst, { teamLastCountedMs, minLapMs, batonLapTimesMs, windowMs = CANDIDATE_WINDOW_MS }) {
  if (!burst.fromCourse || burst.candidateDone) return false
  if (burst.start - teamLastCountedMs < minLapMs) return false
  return !batonLapTimesMs.some(t => t >= burst.start - windowMs && t <= burst.lastSeen + windowMs)
}

/**
 * epc -> teamId of the batons that have a tag and belong to a team of this race.
 * @param {{ teamId: string, epc: string|null }[]|undefined} batons
 * @param {Map<string, unknown>} teams the race's teams by id
 */
export function batonTeamMap(batons, teams) {
  const map = new Map()
  for (const b of batons ?? []) {
    if (b.epc && teams.has(b.teamId)) map.set(b.epc, b.teamId)
  }
  return map
}
