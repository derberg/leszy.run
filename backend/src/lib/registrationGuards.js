// Online registration: participants removed online (removed_at) are ignored by the
// timing host, and events owned by a club (registration events) refuse deletes.
// The Supabase trigger is the authority; these are the local UX guard.
export const REGISTRATION_DELETE_REFUSAL = 'Wydarzenie z zapisami online — usuwanie wyłączone.'

export const isRemoved = (p) => Boolean(p?.removedAt)

export const isRegistrationEvent = (event) => Boolean(event?.clubId)

// Result status to seed at race start; null = no result row (removed online).
export function seedStatus(p) {
  if (isRemoved(p)) return null
  if (p.withdrawnAt) return 'dns'
  return p.checkin ? 'checked_in' : 'registered'
}

// Participants the detector and the results seeding see.
export const startListFor = (participants) => participants.filter((p) => !isRemoved(p))
