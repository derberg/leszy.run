// A team member's own details. The captain must give an adult member's name, birth date, gender
// and e-mail only (validateTeam passes `detailsLater` to validatePerson); the rest the event asks
// for (phone, city, club, ICE, nationality) is optional for the captain, and whatever is left
// empty the member fills on /zgoda, where accept-consent refuses the acceptance while a required
// one is still empty. The birth date and gender stay the
// captain's, so the squad's rules are judged at registration. A child's details are the
// captain's to give, as before. Plain ESM: runs in Deno, Node and the public app.
import { registrationRole } from './group.js'
import { warsawToday } from './dates.js'

// The fields a member owes, in form order, with the form's own words (validatePerson's). The
// phone is always required (P2-R32); ICE is one switch for two inputs; nationality defaults off.
const OWED = [
  { field: 'phone', always: true, message: 'Podaj numer telefonu.', label: 'telefon' },
  { field: 'city', key: 'city', mode: 'optional', message: 'Podaj miejscowość.', label: 'miejscowość' },
  { field: 'club', key: 'club', mode: 'optional', message: 'Podaj klub.', label: 'klub' },
  { field: 'iceName', key: 'ice', mode: 'optional', message: 'Podaj kontakt w razie wypadku.', label: 'kontakt ICE' },
  { field: 'icePhone', key: 'ice', mode: 'optional', message: 'Podaj kontakt w razie wypadku.', label: 'kontakt ICE' },
  { field: 'nationality', key: 'nationality', mode: 'off', message: 'Wybierz narodowość.', label: 'narodowość' },
]

const blank = (v) => (typeof v === 'string' ? v.trim() === '' : v == null)

/**
 * The fields the event requires that `person` (the form's shape) leaves empty → { [field]: message },
 * in form order. `formFields` is registration_settings.form_fields; a stored phone mode is ignored.
 */
export function missingDetails(person, formFields = {}) {
  const p = person ?? {}
  const out = {}
  for (const { field, key, mode, always, message } of OWED) {
    const required = always || (formFields?.[key] ?? mode) === 'required'
    if (required && blank(p[field])) out[field] = message
  }
  return out
}

/**
 * Whether a stored registration's details are the person's own to give: an adult in a team who is
 * not its captain. A group's added adult was registered with the full form, and a child's data is
 * the captain's (registrationRole decides who is a child and who registered themself).
 */
export const ownsDetails = (row) => Boolean(row?.team_id) && registrationRole(row) === 'adult'

/** A registrations row as the form's person. */
const personOfRow = (r) => ({
  phone: r.phone, city: r.city, club: r.club, iceName: r.ice_name, icePhone: r.ice_phone, nationality: r.nationality,
})

/** The fields a stored row still owes (form order), [] for a row whose details are not the person's. */
export function owedDetails(row, formFields = {}) {
  if (!ownsDetails(row)) return []
  return Object.keys(missingDetails(personOfRow(row), formFields))
}

/**
 * The consent page's check: of `owed` (the fields consent-request said were missing), the ones
 * `person` still leaves empty → { [field]: message }. Nothing owed asks nothing.
 */
export function stillMissing(owed, person, formFields = {}) {
  if (!owed?.length) return {}
  const missing = missingDetails(person, formFields)
  return Object.fromEntries(Object.entries(missing).filter(([field]) => owed.includes(field)))
}

/** „telefon, kontakt ICE, narodowość”: the organizer's panel and CSV wording, the ICE pair once. */
export function missingDetailsText(fields) {
  const labels = OWED.filter((o) => fields?.includes(o.field)).map((o) => o.label)
  return [...new Set(labels)].join(', ')
}

const LIVE = new Set(['confirmed', 'pending_payment'])

/**
 * The organizer panel's flag („brak danych”) for one registrations row: owedDetails for a live
 * entry through race day (Warsaw). After it, the 30-day contact purge nulls every phone, which is
 * not a detail anybody owes.
 */
export function entryOwedDetails(row, settings, now = new Date()) {
  if (!LIVE.has(row?.status)) return []
  if (settings?.event_date && warsawToday(now) > settings.event_date) return []
  return owedDetails(row, settings?.form_fields ?? {})
}
