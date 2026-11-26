// "PÓŹNIEJ" in the admin review queue (calendar_events.snoozed_at). A snoozed
// pending event is hidden from „Do przeglądu” and comes back once the pipeline
// brings data it lacked: run-publish fills an empty field. An overwrite of a
// value the row already had, or a date move, is not new data and wakes nothing.

function isEmpty(value) {
  return value === null || value === undefined || value === '' ||
    (Array.isArray(value) && value.length === 0)
}

// The fields of `upd` that fill a column empty on `ce`.
export function filledFields(ce, upd) {
  return Object.keys(upd).filter(
    (field) => field !== 'last_verified_at' && isEmpty(ce[field]) && !isEmpty(upd[field])
  )
}

// True when this publish update should put a snoozed event back in the queue.
export function wakesSnoozed(ce, upd) {
  return Boolean(ce?.snoozed_at) && filledFields(ce, upd).length > 0
}
