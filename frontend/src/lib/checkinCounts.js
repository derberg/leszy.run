// A QR self check-in creates the checkins row with checked_in_at NULL; the
// organiser sets checked_in_at later. An admin check-in with no prior QR step
// creates the row and sets checked_in_at in the same upsert, so the two
// timestamps are equal. A row older than its confirmation is therefore a QR
// check-in that the desk confirmed afterwards.
const SAME_WRITE_MS = 5_000

/** @param {{ createdAt?: string|null, checkedInAt?: string|null } | null | undefined} checkin */
export function isSelfCheckin(checkin) {
  if (!checkin) return false
  if (!checkin.checkedInAt) return true
  if (!checkin.createdAt) return false
  return new Date(checkin.checkedInAt) - new Date(checkin.createdAt) > SAME_WRITE_MS
}

/**
 * @param {Array<{ checkin?: object|null }>} participants
 * @returns {{ total: number, selfCheckins: number, confirmed: number }}
 */
export function checkinCounts(participants) {
  let selfCheckins = 0
  let confirmed = 0
  for (const p of participants) {
    if (isSelfCheckin(p.checkin)) selfCheckins++
    if (p.checkin?.checkedInAt) confirmed++
  }
  return { total: participants.length, selfCheckins, confirmed }
}
