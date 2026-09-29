// "Registration closes soon" is a fact about an event AND a date, so it is
// computed when someone reads their notifications — not stored once per event.
//
// It used to be a row in event_notifications, and that table has
// UNIQUE(event_id, type): the fact fires once, ever, for an event. Every reader
// then drops notifications created before the user starred the race
// (correctly — nobody wants to be told about things that happened before they
// were interested). Put together, anyone who starred a race AFTER its single
// deadline_soon row was written could never be told the deadline was coming,
// and no replacement row could ever be created. Starring a race two days before
// entries close is exactly when the warning matters most.
//
// Pure, and shared: the edge function and the weekly digest must agree, or the
// email and the in-app feed disagree about what the user was told.

export const DEADLINE_WINDOW_DAYS = 7

// Only these have a public page to link to; `cancelled` stays because someone
// following a race wants to hear it was called off.
const NOTIFIABLE_STATUSES = new Set(['active', 'cancelled'])

function shiftDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d
}

/**
 * @param event {{ id, date, status, registration_deadline }} a calendar_events row
 * @param todayIso YYYY-MM-DD
 * @returns {{ event_id, type, created_at }|null}
 */
export function deadlineSoonFor(event, todayIso) {
  if (!event) return null
  if (!NOTIFIABLE_STATUSES.has(event.status)) return null
  if (!event.registration_deadline) return null
  if (!event.date || event.date < todayIso) return null // already run
  if (event.registration_deadline < todayIso) return null // already closed

  const windowOpens = shiftDays(event.registration_deadline, -DEADLINE_WINDOW_DAYS)
  if (shiftDays(todayIso, 0) < windowOpens) return null // not yet worth saying

  return {
    event_id: event.id,
    type: 'deadline_soon',
    // Dated from the deadline, so it is the same timestamp on every read and
    // can be compared against when the user starred the race and when they last
    // looked at their notifications.
    created_at: windowOpens.toISOString(),
  }
}
