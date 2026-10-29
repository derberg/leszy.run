// The registration form's person, checked on the server before register_free.
// Plain ESM: runs in Deno and Node.

import { ageOn, ageGroupLabel, kidsGroupFor } from './ageGroups.js'
import { warsawToday } from './dates.js'
import { isCountryCode } from './countries.js'

export const ADULT_AGE = 18

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PHONE_RE = /^\+?[0-9][0-9 -]{5,19}$/
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

const NAME_MAX = 100
const TEXT_MAX = 200

// Fields the event can switch on, off or make required (registration_settings.form_fields).
// ice is one switch for two inputs. The phone is always required (P2-R32):
// `always` ignores whatever mode is stored. Nationality is handled below.
const SWITCHED = [
  { key: 'phone', fields: ['phone'], max: 40, phone: true, always: true, label: 'Podaj numer telefonu.' },
  { key: 'city', fields: ['city'], max: TEXT_MAX, label: 'Podaj miejscowość.' },
  { key: 'club', fields: ['club'], max: TEXT_MAX, label: 'Podaj klub.' },
  { key: 'ice', fields: ['iceName', 'icePhone'], max: TEXT_MAX, label: 'Podaj kontakt w razie wypadku.' },
]

const text = (v) => (typeof v === 'string' ? v.trim() : '')

function validDate(iso) {
  const m = ISO_DATE_RE.exec(iso)
  if (!m) return false
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return d.toISOString().slice(0, 10) === iso
}

function rangeMessage(minAge, maxAge) {
  if (minAge != null && maxAge != null) return `Ta konkurencja jest dla osób w wieku ${minAge}–${maxAge} lat.`
  if (minAge != null) return `Ta konkurencja jest dla osób w wieku ${minAge}+.`
  return `Ta konkurencja jest dla osób w wieku do ${maxAge} lat.`
}

/**
 * @param {object} person  { firstName, lastName, birthDate, gender, email, phone, city?, club?, iceName?, icePhone?, nationality? }
 * @param {object} ctx
 *   formFields  { city|club|ice: 'required'|'optional'|'off' } (missing = optional),
 *               nationality (missing = off); a stored phone mode is ignored
 *   competition { minAge, maxAge, isKids }
 *   raceDate    'YYYY-MM-DD'
 *   reckoning   'race_day' | 'year_end' (registration_settings.age_reckoning)
 *   ageGroups   [{ gender, label, minAge, maxAge }]
 *   kidsGroups  [{ id, minYear, maxYear, gender|null }]
 *   now         Date (the registration instant; the minor check uses its Warsaw day)
 * @returns {{ ok: boolean, value: object|null, errors: Record<string, string> }}
 */
export function validatePerson(person, {
  formFields = {}, competition = {}, raceDate, reckoning = 'race_day', ageGroups = [], kidsGroups = [], now = new Date(),
} = {}) {
  const p = person && typeof person === 'object' ? person : {}
  const errors = {}

  const firstName = text(p.firstName)
  const lastName = text(p.lastName)
  if (!firstName) errors.firstName = 'Podaj imię.'
  else if (firstName.length > NAME_MAX) errors.firstName = 'Imię jest za długie.'
  if (!lastName) errors.lastName = 'Podaj nazwisko.'
  else if (lastName.length > NAME_MAX) errors.lastName = 'Nazwisko jest za długie.'

  const email = text(p.email).toLowerCase()
  const emailOk = EMAIL_RE.test(email) && email.length <= 254

  const gender = p.gender === 'K' || p.gender === 'M' ? p.gender : null
  if (!gender) errors.gender = 'Wybierz płeć.'

  const birthDate = text(p.birthDate)
  const today = warsawToday(now)
  // Adulthood is judged today, whatever the event's age reckoning says about race
  // categories: the person accepts the regulamin now.
  let isMinor = false
  if (!validDate(birthDate) || birthDate < '1900-01-01' || birthDate > today) {
    errors.birthDate = 'Podaj poprawną datę urodzenia.'
  } else {
    const { minAge = null, maxAge = null } = competition
    const age = ageOn(birthDate, raceDate, reckoning)
    if ((minAge != null && age < minAge) || (maxAge != null && age > maxAge)) {
      errors.birthDate = rangeMessage(minAge, maxAge)
    } else {
      isMinor = ageOn(birthDate, today, 'race_day') < ADULT_AGE
    }
  }

  // A minor has no e-mail of their own (the guardian is the contact), but one that is
  // given must still be an address.
  if (isMinor && !email) { /* stored as null */ } else if (!emailOk) errors.email = 'Podaj poprawny adres e-mail.'

  const optional = {}
  for (const { key, fields, max, phone, always, label } of SWITCHED) {
    const mode = always ? 'required' : formFields[key] ?? 'optional'
    for (const field of fields) {
      const v = text(p[field])
      if (mode === 'off') { optional[field] = null; continue }
      if (!v) {
        if (mode === 'required') errors[field] = label
        optional[field] = null
        continue
      }
      const isPhone = phone || field === 'icePhone'
      if (v.length > max) errors[field] = 'Za długi tekst.'
      else if (isPhone && !PHONE_RE.test(v)) errors[field] = 'Podaj poprawny numer telefonu.'
      optional[field] = v
    }
  }

  // Nationality (P2-R31): an ISO 3166-1 alpha-2 code from the list, off unless the event asks for it.
  const nationalityMode = formFields.nationality ?? 'off'
  let nationality = null
  if (nationalityMode !== 'off') {
    const raw = p.nationality
    const code = typeof raw === 'string' ? raw.trim().toUpperCase() : raw
    if (code === '' || code == null) {
      if (nationalityMode === 'required') errors.nationality = 'Wybierz narodowość.'
    } else if (!isCountryCode(code)) {
      errors.nationality = 'Wybierz kraj z listy.'
    } else {
      nationality = code
    }
  }

  if (Object.keys(errors).length) return { ok: false, value: null, errors }

  const label = ageGroupLabel({ birthDate, gender, raceDate, reckoning, groups: ageGroups })
  const kidsGroup = competition.isKids
    ? kidsGroupFor(birthDate, kidsGroups.filter((g) => g.gender == null || g.gender === gender))
    : null

  return {
    ok: true,
    errors,
    value: {
      firstName, lastName, birthDate, gender, email: email || null, isMinor,
      phone: optional.phone, city: optional.city, club: optional.club,
      iceName: optional.iceName, icePhone: optional.icePhone, nationality,
      ageGroupLabel: label, kidsGroupId: kidsGroup?.id ?? null,
    },
  }
}
