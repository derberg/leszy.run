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
 * A baton pass closes once the baton has been silent for the event's gone window (it has left the
 * antenna's range), never later than BATON_PASS_MAX_MS after its first read, and is timed at its
 * strongest read. The windows were checked against the desk test of 2026-11-22
 * (test/crossingDetectorBatonReplay.test.js).
 */

// A read this long after the previous one of the same tag starts a new burst.
export const BURST_GAP_MS = 5000
// A baton pass is credited to the member whose from-the-course burst STARTED in
// [first read - ATTRIBUTION_BEFORE_MS, first read + ATTRIBUTION_AFTER_MS], the first read being the
// baton pass's: the runner who brings the baton enters the antenna's range together with it, while
// a teammate waiting at the line was heard long before. Which of the two tags is heard first
// depends on where each is carried. On 2026-11-22 the carrier's burst began 4.83 s before to 2.60 s
// after the baton's first read, and the nearest waiting teammate's 9.61 s before it.
export const ATTRIBUTION_BEFORE_MS = 7000
export const ATTRIBUTION_AFTER_MS = 5000
// A baton pass closes once the baton has been unheard for the event's gone window, but never less
// than this: on 2026-11-22 a baton inside one pass went up to 2.4 s unheard, and a runner's burst
// splits at the same 5 s (BURST_GAP_MS).
export const BATON_GONE_MIN_MS = 5000
// A baton pass closes this long after its first read even if the baton is still heard (a baton
// left lying at the antenna). The longest pass on 2026-11-22 lasted 12.3 s (a runner walking in
// slowly, then handing over). Later reads of the same presence never open a new lap: a pass opens
// only after the arrival silence.
export const BATON_PASS_MAX_MS = 30_000
// Runner bursts are kept this long after their last read, so a pass can be attributed to the burst
// that began around its first read even when the runner was heard again since.
export const BURST_HISTORY_MS = 120_000
// A runner burst is a candidate only with no counted lap of the team from this long before it
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
 * Keeps `burst` in the runner's recent bursts (`history`: participantId -> Burst[]) and drops the
 * ones unheard for longer than `keepMs`.
 */
export function rememberBurst(history, participantId, burst, atMs, keepMs = BURST_HISTORY_MS) {
  const list = (history.get(participantId) ?? []).filter(b => b !== burst && atMs - b.lastSeen <= keepMs)
  list.push(burst)
  history.set(participantId, list)
}

/**
 * The runner of a baton pass whose first read was at `batonFirstReadMs`: the one team member with
 * a burst that came from the course and started in [batonFirstReadMs - beforeMs, batonFirstReadMs
 * + afterMs] (inclusive). Every recent burst of a member is judged, not only the latest, so a
 * carrier heard again since still counts. None or several members → null (the lap counts for the
 * team, the operator picks the runner).
 * @param {Map<string, Burst|Burst[]>} bursts participantId -> recent bursts (or the current one)
 * @returns {string|null}
 */
export function attributeLap(bursts, memberIds, batonFirstReadMs, { beforeMs = ATTRIBUTION_BEFORE_MS, afterMs = ATTRIBUTION_AFTER_MS } = {}) {
  const found = []
  for (const id of memberIds) {
    const list = [].concat(bursts.get(id) ?? [])
    const arrived = list.some(b => b.fromCourse && b.start >= batonFirstReadMs - beforeMs && b.start <= batonFirstReadMs + afterMs)
    if (arrived) found.push(id)
  }
  return found.length === 1 ? found[0] : null
}

/**
 * Whether a runner burst that has ENDED is a lap that came in without the baton. Decide it only
 * once no read has come for the burst gap and the window after the burst has passed, so a baton
 * lap that closes as the runner leaves is known. It is a candidate when it came from the course,
 * has not been decided yet, started at least `minLapMs` after the team's last counted lap (a
 * runner who handed over and walks back is not one), and no counted lap of the team (a baton lap,
 * a lap the operator added, an approved candidate) closed between `windowMs` before the burst
 * started and `windowMs` after its last read (`burst.lastSeen`): a runner who arrived with the
 * baton, or a teammate who waited at the line and left with it, is never a candidate, and neither
 * is a runner whose lap the operator already entered by hand.
 */
export function isCandidate(burst, { teamLastCountedMs, minLapMs, lapTimesMs, windowMs = CANDIDATE_WINDOW_MS }) {
  if (!burst.fromCourse || burst.candidateDone) return false
  if (burst.start - teamLastCountedMs < minLapMs) return false
  return !lapTimesMs.some(t => t >= burst.start - windowMs && t <= burst.lastSeen + windowMs)
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
