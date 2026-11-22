// Review rules of a relay team's laps in the admin panel (TeamLapsPanel).

// Without the event's min lap time (min_finish_seconds), two laps this close are one lap.
export const SAME_LAP_FALLBACK_MS = 60_000

const live = (l) => !l.deletedAt

/**
 * The other live laps of the same team, candidate or counted, closer than `windowMs` to `lap`.
 * A missed baton read raises a candidate for the runner who brought the lap and another for the
 * teammate who walked up to take over: both are one lap.
 */
export function sameLapNeighbours(lap, laps, windowMs) {
  const at = new Date(lap.closedAt).getTime()
  return laps.filter(l => l.id !== lap.id && live(l) && l.teamId === lap.teamId
    && Math.abs(new Date(l.closedAt).getTime() - at) < windowMs)
}

// A counted lap this many times longer than the team's median counted lap may hide a lap whose
// baton read was missed (the runner who brought it stayed at the line, so no candidate came).
export const MISSED_LAP_FACTOR = 1.7
// The median says nothing about fewer counted laps.
export const MISSED_LAP_MIN_LAPS = 3

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/**
 * Ids of counted laps that may hide a missed lap: lap time (`legMs`) more than
 * MISSED_LAP_FACTOR x the median of the team's live counted laps that have a time, once the
 * team has at least MISSED_LAP_MIN_LAPS of them. The operator adds the missing lap
 * („+ Okrążenie”), which splits the long one, or approves it as it is (Zatwierdź).
 * @param {{ id: string, teamId: string, status: string, legMs?: number|null, deletedAt?: string|null }[]} laps
 * @returns {Set<string>}
 */
export function possiblyMissedLaps(laps) {
  const byTeam = new Map()
  for (const l of laps) {
    if (!live(l) || l.status !== 'counted' || l.legMs == null) continue
    const list = byTeam.get(l.teamId) ?? []
    list.push(l)
    byTeam.set(l.teamId, list)
  }
  const flagged = new Set()
  for (const list of byTeam.values()) {
    if (list.length < MISSED_LAP_MIN_LAPS) continue
    const bound = MISSED_LAP_FACTOR * median(list.map(l => l.legMs))
    for (const l of list) if (l.legMs > bound) flagged.add(l.id)
  }
  return flagged
}

/**
 * Whether a lap still waits for the operator: a candidate, a counted lap with no runner nobody
 * approved, or a possibly missed lap (`possiblyMissed`, from possiblyMissedLaps) nobody approved.
 */
export function needsDecision(l, possiblyMissed = new Set()) {
  return live(l) && (l.status === 'candidate'
    || (l.status === 'counted' && !l.reviewedAt && (!l.participantId || possiblyMissed.has(l.id))))
}
