// RA5: each person's regulamin state, as the tags of RB4. The person registering and an added
// adult who accepted (or signed in the office) „✓ REGULAMIN”; a child „✓ OPIEKUN” (the guardian
// accepted for them); an added adult who has not accepted yet „CZEKA NA ZGODĘ”, with
// „Wyślij przypomnienie do <imię> →” (remind-consent, 3 per registration per 24 h).
// `role` and `consentState` come from order-status lines and my-event-registrations rows.

/** @param {{ role?: string, consentState?: string }} p → { kind, label } | null */
export function consentTag({ role, consentState } = {}) {
  if (role === 'minor') return { kind: 'guardian', label: '✓ OPIEKUN' }
  if (consentState === 'awaiting') return { kind: 'awaiting', label: 'CZEKA NA ZGODĘ' }
  if (consentState === 'accepted' || consentState === 'office') return { kind: 'accepted', label: '✓ REGULAMIN' }
  return null
}

/** Only an added adult still awaiting can be reminded. */
export const canRemind = (p) => p?.role === 'adult' && p?.consentState === 'awaiting'

export const remindLabel = (firstName) => `Wyślij przypomnienie do ${firstName} →`

/** The tags are a group's: a page listing only the person registering shows none. */
export const showsConsentTags = (people) => (people ?? []).some((p) => p.role && p.role !== 'self')

const ROLE_ORDER = { self: 0, adult: 1, minor: 2 }

/**
 * RA5's people in the order the form had them: the person registering first, then the added
 * adults, then the children, each kept in the server's order (which follows no person).
 */
export function orderPeople(people) {
  return (people ?? []).map((p, i) => [p, i])
    .sort(([a, i], [b, j]) => (ROLE_ORDER[a.role] ?? 1) - (ROLE_ORDER[b.role] ?? 1) || i - j)
    .map(([p]) => p)
}
