// Turning get-club's `followedEvents[].followers` (user_ids) into the names the
// club panel prints. get-club sends ids, not names, so the display rule lives in
// one place — the same fallback chain the roster uses (Roster.jsx displayNameFor).

export const ANONYMOUS_LABEL = 'Uczestnik anonimowy'

export function followerNames(followers, members) {
  const byId = new Map((members ?? []).map((m) => [m.user_id, m]))
  return (followers ?? [])
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((m) => m.display_name || m.nickname || ANONYMOUS_LABEL)
    .sort((a, b) => a.localeCompare(b, 'pl'))
}

// Beyond `max` names the row gets unreadable, so the rest hide behind a counter.
export function splitFollowers(names, max) {
  const all = names ?? []
  if (all.length <= max) return { shown: all, hidden: [] }
  return { shown: all.slice(0, max), hidden: all.slice(max) }
}
