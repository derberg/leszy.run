// Which event consents a registration shows and requires. A minors-only consent (the Formularz
// step's „Zgoda opiekuna · dzieci” preset) is the guardian's: it applies only when the request
// enters a child, and is accepted for that child's registration only. An adult entering themself,
// an added adult on the consent page, a transfer's recipient and the office signature never see it.
// The same rule is in SQL (registration_group_lock and the functions of
// 20261105090000_consent_minors_only.sql); the edge functions and the pages read it from here.

/** A consent row (minors_only) or a wire object (minorsOnly). */
const minorsOnly = (c) => (c?.minorsOnly ?? c?.minors_only) === true

/** The consents that apply: every one when a child is entered, otherwise all but the minors-only ones. */
export function requiredConsents(consents, { hasMinor = false } = {}) {
  return (consents ?? []).filter((c) => hasMinor || !minorsOnly(c))
}

/** Does the request enter a child (a person with role 'minor')? */
export function hasMinor(people) {
  return (people ?? []).some((p) => p?.role === 'minor')
}
