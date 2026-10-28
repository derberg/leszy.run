// Which organizer step the club's "Wydarzenia" tab shows, from organizer-status.
//   null        — a plain member: no organizer actions at all
//   'waitlist'  — the club does not have online registration yet
//   'agreement' — enabled, but the current organizer agreement is not accepted
//   'wizard'    — enabled and accepted: the club can create events
// `waitlisted` never changes the step; the page uses it to swap the join button for the joined line.
export function nextOrganizerStep({ enabled, agreementAccepted, role }) {
  if (role !== 'owner' && role !== 'admin') return null
  if (!enabled) return 'waitlist'
  if (!agreementAccepted) return 'agreement'
  return 'wizard'
}
