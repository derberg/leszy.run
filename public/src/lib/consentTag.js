// RA5: each person's regulamin state, as the tags of RB4. The person registering and an added
// adult who accepted (or signed in the office) „✓ REGULAMIN”; a child „✓ OPIEKUN” (the guardian
// accepted for them); an added adult who has not accepted yet „CZEKA NA ZGODĘ”, with
// „Wyślij przypomnienie do <imię> →” (remind-consent, 3 per registration per 24 h).
// `role` and `consentState` come from order-status lines and my-event-registrations rows.

/**
 * The viewer's own row (`mine`) carries no tag: the tags tell the payer about the others.
 * @param {{ role?: string, consentState?: string, mine?: boolean }} p → { kind, label, srLabel } | null
 */
export function consentTag({ role, consentState, mine } = {}) {
  if (mine === true) return null
  if (role === 'minor') return { kind: 'guardian', label: '✓ OPIEKUN', srLabel: 'zgoda opiekuna' }
  if (consentState === 'awaiting') return { kind: 'awaiting', label: 'CZEKA NA ZGODĘ', srLabel: 'czeka na zgodę na regulamin' }
  if (consentState === 'accepted' || consentState === 'office') return { kind: 'accepted', label: '✓ REGULAMIN', srLabel: 'regulamin zaakceptowany' }
  return null
}

/** Only an added adult still awaiting can be reminded. */
export const canRemind = (p) => p?.role === 'adult' && p?.consentState === 'awaiting'

// Inside the person's row, so the visible text needs no name; the accessible name carries it.
export const remindLabel = () => 'Wyślij przypomnienie →'
export const remindAriaLabel = (name) => `Wyślij przypomnienie do: ${name}`

const OFFLINE = 'Nie udało się połączyć. Spróbuj ponownie.'
const SEND_FAILED = 'Nie udało się wysłać przypomnienia. Spróbuj ponownie później.'

/**
 * remind-consent's refusal as the row shows it, always in Polish: 409 / 429 / 502 carry the
 * server's own Polish text; 401, 404 and any other 5xx answer in English, so they are replaced.
 */
export function remindError(err) {
  if (!err || err.status == null) return OFFLINE
  if (err.status === 401) return 'Zaloguj się ponownie, żeby wysłać przypomnienie.'
  if (err.status === 404) return 'Nie znaleźliśmy tego zgłoszenia.'
  if (err.status === 502 && err.code === 'email_failed') return err.message || SEND_FAILED
  if (err.status >= 500) return SEND_FAILED
  if (err.status === 409 || err.status === 429) return err.message
  return SEND_FAILED
}

/**
 * The tags are a group's: shown only when the page lists somebody other than the viewer (a
 * solo runner, or an added adult looking at their own entry, sees none).
 */
export const showsConsentTags = (people) => (people ?? []).some((p) => p.mine !== true && p.role && p.role !== 'self')

/** RA5's group column: the kids' group when the person has one, otherwise the age class. */
export const personGroupLabel = (p) => p?.kidsGroupLabel ?? p?.ageGroupLabel ?? null

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
