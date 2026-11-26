// "PÓŹNIEJ" in the admin review queue (calendar_events.snoozed_at). A snoozed
// pending event is hidden from „Do przeglądu” and comes back once the pipeline
// brings data it lacked: a tracked field (the ones the queue shows as missing)
// filled where it was empty. An overwrite of a value the row already had, a
// date move, or bookkeeping such as lat/lng or source_links wakes nothing.
// enricher/enricher/sync.py applies the same rule (wake_snoozed).
import { TRACKED_FIELDS } from '@leszyrun/ui/eventCompleteness'

function isEmpty(value) {
  return value === null || value === undefined || value === '' ||
    (Array.isArray(value) && value.length === 0)
}

// The tracked fields of `upd` that fill a column empty on `ce`.
export function filledFields(ce, upd) {
  return TRACKED_FIELDS.filter(
    (field) => field in upd && isEmpty(ce[field]) && !isEmpty(upd[field])
  )
}

// True when this publish update should put a snoozed event back in the queue.
export function wakesSnoozed(ce, upd) {
  return Boolean(ce?.snoozed_at) && filledFields(ce, upd).length > 0
}
