// The registration form's person (RA2) as pure functions: prefill, the live
// category, the checks before „Dalej”, the request body and where a server
// refusal shows. PersonForm and Zapis render it; the unit tests call it.
//
// The rules are the server's own (validatePerson, ageGroupLabel), imported by
// relative path so node --test can load this module too; Vite serves the same
// files through the @registration alias elsewhere.
import { validatePerson } from '../../../supabase/functions/_shared/registration/person.js'
import { ageGroupLabel, kidsGroupFor } from '../../../supabase/functions/_shared/registration/ageGroups.js'
import { FORM_FIELD_DEFAULTS } from '../../../supabase/functions/_shared/registration/sections.js'

export const EMPTY_PERSON = Object.freeze({
  firstName: '', lastName: '', birthDate: '', gender: '', email: '',
  phone: '', city: '', club: '', iceName: '', icePhone: '', nationality: '',
})

const GENDER_FROM_PROFILE = { F: 'K', M: 'M' }

/**
 * Form values from the logged-in person's own profile (auth-me). Profiles
 * hold no first or last name, so those are always typed. `X` leaves the
 * gender to the runner.
 */
export function profilePrefill(user) {
  if (!user) return {}
  const out = {}
  if (user.email) out.email = user.email
  if (GENDER_FROM_PROFILE[user.gender]) out.gender = GENDER_FROM_PROFILE[user.gender]
  if (user.date_of_birth) out.birthDate = user.date_of_birth
  if (user.phone) out.phone = user.phone
  if (user.city) out.city = user.city
  if (user.club) out.club = user.club
  return out
}

/**
 * The person with the profile's values filled in, except in the fields the
 * person already touched (a Set of keys): what they typed or picked stays.
 */
export function mergePrefill(person, prefill, touched) {
  const out = { ...person }
  for (const [k, v] of Object.entries(prefill ?? {})) {
    if (!touched.has(k)) out[k] = v
  }
  return out
}

/**
 * registration_settings.form_fields with the defaults filled in (missing =
 * optional, nationality missing = off). The phone is no switch: it is always
 * required (P2-R32), so a stored phone mode is left out.
 */
export function fieldModes(formFields) {
  const out = {}
  for (const [k, fallback] of Object.entries(FORM_FIELD_DEFAULTS)) {
    const v = formFields?.[k]
    out[k] = v === 'required' || v === 'optional' || v === 'off' ? v : fallback
  }
  return out
}

/** validatePerson's context for one competition of the snapshot. */
export function personContext(raw, competition, now = new Date()) {
  return {
    formFields: raw.formFields ?? {},
    competition: { minAge: competition.minAge ?? null, maxAge: competition.maxAge ?? null, isKids: !!competition.isKids },
    raceDate: raw.eventDate,
    reckoning: raw.ageReckoning ?? 'race_day',
    ageGroups: competition.ageGroups ?? [],
    kidsGroups: (competition.kidsGroups ?? []).map((g) => ({ gender: g.gender ?? null, minYear: g.birthYearFrom, maxYear: g.birthYearTo })),
    now,
  }
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
function realDate(iso) {
  if (!ISO_DATE.test(iso ?? '')) return false
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10) === iso
}

/** „Twoja kategoria”: the age group on race day, or null until birth date and gender are known. */
export function categoryPreview(person, ctx) {
  if (!realDate(person.birthDate) || (person.gender !== 'K' && person.gender !== 'M') || !ctx.raceDate) return null
  return ageGroupLabel({
    birthDate: person.birthDate, gender: person.gender, raceDate: ctx.raceDate, reckoning: ctx.reckoning, groups: ctx.ageGroups,
  })
}

/**
 * A child's „Grupa” in a kids' competition: the kids' group of the birth year (and gender, when
 * the group has one), or null (then the age class shows, as for everyone).
 */
export function kidsGroupLabel(person, competition) {
  const groups = competition?.isKids ? (competition.kidsGroups ?? []) : []
  if (!groups.length || !realDate(person.birthDate)) return null
  const pool = groups.filter((g) => g.gender == null || g.gender === person.gender)
    .map((g) => ({ label: g.label, minYear: g.birthYearFrom, maxYear: g.birthYearTo }))
  return kidsGroupFor(person.birthDate, pool)?.label ?? null
}

/** The server's validatePerson, run in the browser so errors show before any e-mail is sent. */
export function checkPerson(person, ctx) {
  return validatePerson(person, ctx)
}

const norm = (e) => (typeof e === 'string' ? e.trim().toLowerCase() : '')

/**
 * An e-mail code is needed unless the session holds the person's own address, or this form
 * already verified that address at its code step (`verifiedEmail`, task 9 re-review N1: „Wróć”
 * from RA4 and the form sent again must not spend another of the address's codes).
 */
export function needsCode(sessionEmail, personEmail, verifiedEmail = null) {
  const person = norm(personEmail)
  if (verifiedEmail && norm(verifiedEmail) === person) return false
  return !sessionEmail || norm(sessionEmail) !== person
}

/** Every event consent ticked, and the LESZY.RUN service regulamin. */
export function consentsComplete(consents, accepted, serviceAccepted) {
  return !!serviceAccepted && (consents ?? []).every((c) => accepted?.[c.id] === true)
}

const OFFLINE = 'Nie udało się połączyć. Spróbuj ponownie.'
const ON_EMAIL = new Set(['email_retired', 'duplicate'])

/**
 * Where a refusal from auth-request-code or register-free shows:
 * { step: 'form'|'code', fields: { input: message }, message }.
 */
export function registrationFailure(err) {
  if (!err || err.status == null) return { step: 'form', fields: {}, message: OFFLINE }
  if (ON_EMAIL.has(err.code)) return { step: 'form', fields: { email: err.message }, message: null }
  if (err.code === 'invalid_person') return { step: 'form', fields: { ...(err.fields ?? {}) }, message: err.message }
  if (err.status === 401) return { step: 'code', fields: { code: err.message }, message: null }
  return { step: 'form', fields: {}, message: err.message }
}
