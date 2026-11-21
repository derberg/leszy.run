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

/** Whether a lap still waits for the operator: a candidate, or a counted lap with no runner nobody approved. */
export function needsDecision(l) {
  return live(l) && (l.status === 'candidate' || (!l.participantId && !l.reviewedAt))
}
