// What a follower may still be told about, and when they may be told twice.
//
// Both notification producers used to ignore the event itself. Measured
// 2026-09-29: 203 of 212 event_notifications rows belonged to races whose date
// had already passed, and the deadline job would have raised two more for races
// already run (their registration_deadline sits after the race date — an
// enricher data error). A rejected event is worse than useless: it is never
// published to the static manifest, so the link in the email 404s.

// `cancelled` stays: a runner who follows a race wants to hear it was called
// off. `pending` and `rejected` have no public page to link to.
const NOTIFIABLE_STATUSES = new Set(['active', 'cancelled'])

export function eventIsStillAhead(event, todayIso) {
  if (!event) return false
  if (!NOTIFIABLE_STATUSES.has(event.status)) return false
  if (!event.date) return false // undated: nothing to promise, and the slug would be wrong
  return event.date >= todayIso
}

/**
 * The lines of one user's digest.
 *
 * @param notifs   event_notifications rows with an embedded `calendar_events`
 * @param favMap   Map<event_id, starred_at ISO> for THIS user
 * @param sinceIso nothing from before this reaches the user — their last
 *                 successful digest, so a re-run does not mail the same week
 *                 twice, which is what happened whenever the Monday job failed
 *                 part-way and was started again
 * @param todayIso YYYY-MM-DD
 */
export function pickDigestNotifications(notifs, favMap, sinceIso, todayIso) {
  return (notifs ?? []).filter((n) => {
    const starredAt = favMap?.get(n.event_id)
    if (!starredAt) return false
    if (new Date(n.created_at) <= new Date(starredAt)) return false
    if (sinceIso && new Date(n.created_at) <= new Date(sinceIso)) return false
    return eventIsStillAhead(n.calendar_events, todayIso)
  })
}
