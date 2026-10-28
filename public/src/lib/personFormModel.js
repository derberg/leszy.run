// The registration form's person (RA2) as pure functions: prefill, the live
// category, the checks before „Dalej”, the request body and where a server
// refusal shows. PersonForm and Zapis render it; the unit tests call it.
//
// The rules are the server's own (validatePerson, ageGroupLabel), imported by
// relative path so node --test can load this module too; Vite serves the same
// files through the @registration alias elsewhere.
import { validatePerson } from '../../../supabase/functions/_shared/registration/person.js'
import { ageGroupLabel } from '../../../supabase/functions/_shared/registration/ageGroups.js'

export const EMPTY_PERSON = Object.freeze({
  firstName: '', lastName: '', birthDate: '', gender: '', email: '',
  phone: '', city: '', club: '', iceName: '', icePhone: '',
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

const SWITCHED = ['phone', 'city', 'club', 'ice']

/** registration_settings.form_fields with the default filled in: missing = optional. */
export function fieldModes(formFields) {
  const out = {}
  for (const k of SWITCHED) {
    const v = formFields?.[k]
    out[k] = v === 'required' || v === 'off' ? v : 'optional'
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

/** The server's validatePerson, run in the browser so errors show before any e-mail is sent. */
export function checkPerson(person, ctx) {
  return validatePerson(person, ctx)
}

const norm = (e) => (typeof e === 'string' ? e.trim().toLowerCase() : '')

/** register-free needs an e-mail code unless the session holds the person's own address. */
export function needsCode(sessionEmail, personEmail) {
  return !sessionEmail || norm(sessionEmail) !== norm(personEmail)
}

/** Every event consent ticked, and the LESZY.RUN service regulamin. */
export function consentsComplete(consents, accepted, serviceAccepted) {
  return !!serviceAccepted && (consents ?? []).every((c) => accepted?.[c.id] === true)
}

/** The register-free request. `person` is checkPerson(...).value. */
export function registerBody({ categoryId, person, consents, code }) {
  const body = {
    categoryId,
    person: {
      firstName: person.firstName, lastName: person.lastName, birthDate: person.birthDate, gender: person.gender,
      email: person.email, phone: person.phone, city: person.city, club: person.club,
      iceName: person.iceName, icePhone: person.icePhone,
    },
    acceptedConsentIds: (consents ?? []).map((c) => c.id),
    serviceRegulamin: true,
  }
  const c = typeof code === 'string' ? code.trim() : ''
  if (c) body.code = c
  return body
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
