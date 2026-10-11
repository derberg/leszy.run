// Clubmate followed events: which upcoming races the club's members follow, how
// many of them, and which ones. Lifted out of get-club so the aggregation can be
// tested without a deployed function (supabase/functions/tests/club-followers.test.js).
//
// Only members who share what they follow are counted OR named — the club panel
// shows both numbers and names from the same list, so a member who turned
// "Pokazuj klubowiczom co obserwuję" off appears in neither.

const SHOWN_EVENT_STATUSES = ['active', 'cancelled']

export function sharingMemberIds(memberRows) {
  return (memberRows ?? [])
    .filter((m) => m.status === 'active')
    .filter((m) => (m.profiles?.privacy_settings?.favorites ?? true) !== false)
    .map((m) => m.user_id)
}

// favRows: event_favorites rows with `user_id` and the embedded `calendar_events`.
// today: ISO date string (YYYY-MM-DD) — anything earlier has already been run.
export function aggregateFollowedEvents(memberRows, favRows, today) {
  const sharing = new Set(sharingMemberIds(memberRows))
  const eventsById = {}

  for (const f of favRows ?? []) {
    const ev = f.calendar_events
    if (!ev) continue
    if (!sharing.has(f.user_id)) continue
    if (!SHOWN_EVENT_STATUSES.includes(ev.status)) continue
    if (ev.date && ev.date < today) continue
    if (!eventsById[ev.id]) eventsById[ev.id] = { event: ev, count: 0, followers: [] }
    const entry = eventsById[ev.id]
    if (entry.followers.includes(f.user_id)) continue
    entry.followers.push(f.user_id)
    entry.count += 1
  }

  return Object.values(eventsById)
    .sort((a, b) => (a.event.date || '').localeCompare(b.event.date || ''))
}
