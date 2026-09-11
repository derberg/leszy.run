// The single definition of what makes a calendar event complete.
//
// WHY THIS IS SHARED CODE
// This rule existed in three places that disagreed. The admin list had two of
// them (isReadyToAccept over 8 fields, isIncomplete over 9) and the publisher
// had a third (COMPLETENESS_FIELDS over 6, ignoring locked_fields entirely). So
// the "missing:" line printed by run-publish described a different standard than
// the badge the operator was looking at on the same row, and the pre-publish
// review step would have chased yet another.
//
// Lives in packages/ui because the admin app and the backend both need it. The
// subpath export is React-free on purpose: the backend imports this file without
// pulling the component library in behind it.

// Fields an event must have before it is worth approving. `website` is
// deliberately not here. An event with everything else filled is good enough to
// publish, and a homepage requirement would hold back every race whose organizer
// only ever had a Facebook page.
export const REQUIRED_FIELDS = [
  'location',
  'voivodeship',
  'event_type',
  'distances',
  'registration_url',
  'regulamin_url',
  'registration_deadline',
  'price_from',
]

// Tracked, reported, never blocking.
export const OPTIONAL_FIELDS = ['website']

export const TRACKED_FIELDS = [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]

// A value counts as absent when it is null/undefined, an empty string, an empty
// array, or an empty location object. `location` arrives as free text on
// calendar_events but as {city, region, country} on some scraper rows, and an
// object with no usable parts is as empty as a null.
function isEmptyValue(value) {
  if (value === null || value === undefined) return true
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === 'string') return value.trim() === ''
  if (typeof value === 'object') {
    return Object.values(value).every((v) => v === null || v === undefined || v === '')
  }
  return false
}

// A field is decided when it carries a value OR when an admin has explicitly
// locked it as empty. The "brak" button in the admin list locks an empty value,
// which is how an operator records that a race has no regulamin at all. That
// answer has to survive. Otherwise the row stays incomplete forever and the
// review agents investigate a settled question every night.
export function isFieldDecided(row, field) {
  const locked = row?.locked_fields
  if (Array.isArray(locked) && locked.includes(field)) return true
  return !isEmptyValue(row?.[field])
}

export function missingRequiredFields(row) {
  return REQUIRED_FIELDS.filter((f) => !isFieldDecided(row, f))
}

export function missingTrackedFields(row) {
  return TRACKED_FIELDS.filter((f) => !isFieldDecided(row, f))
}

// The bar the admin list draws its "ready to accept" badge from, and the rule
// the pre-publish review step selects candidates with. Those must be the same
// bar or the step argues with the screen.
export function isReadyToAccept(row) {
  return missingRequiredFields(row).length === 0
}

// Looser: anything tracked is undecided, website included. Drives the
// "Niekompletne" filter and matches the enricher's --incomplete criteria.
export function isIncomplete(row) {
  return missingTrackedFields(row).length > 0
}
