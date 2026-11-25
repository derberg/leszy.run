// Which organizer step the club's "Wydarzenia" tab shows, from organizer-status.
//   null        — a plain member: no organizer actions at all
//   'waitlist'  — the club does not have online registration yet
//   'agreement' — enabled, but the club never accepted the organizer agreement
//   'wizard'    — enabled and accepted (ANY version): the club can create events. A later version is
//                 an update with a notice e-mail, never a re-acceptance (agreement §13 ust. 6).
// `waitlisted` never changes the step; the page uses it to swap the join button for the joined line.
export function nextOrganizerStep({ enabled, agreementAccepted, role }) {
  if (role !== 'owner' && role !== 'admin') return null
  if (!enabled) return 'waitlist'
  if (!agreementAccepted) return 'agreement'
  return 'wizard'
}

// The payout form and the organizer agreement exist only for a club with online
// registration switched on. A waitlisted or disabled club sees the waitlist copy only:
// no payout data is collected and no draft agreement is offered before that.
export function organizerFeaturesShown(status) {
  return status?.enabled === true
}

// The club accepted an older version than the current one: the panel shows the informational
// „Zaktualizowaliśmy umowę organizatora” strip to the owner and admins. It never blocks anything.
export function agreementUpdated(status) {
  if (!status || status.agreementAccepted !== true) return false
  if (status.role !== 'owner' && status.role !== 'admin') return false
  const current = status.currentVersion ?? status.version
  return !!status.acceptedVersion && !!current && status.acceptedVersion !== current
}
