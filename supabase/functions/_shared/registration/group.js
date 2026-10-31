// The rules of one registration request that signs up several people (a group):
// who is the runner logged in, who is a minor, who pays and who is the guardian.
// Built on validatePerson, which owns every per-field rule. Plain ESM: runs in Deno,
// Node and the public app (the `@registration` alias).

import { validatePerson } from './person.js'
import { MAX_PEOPLE_PER_REQUEST } from './flags.js'

export const GUARDIAN_CONSENT_MESSAGE = 'Zaznacz zgodę opiekuna.'
export const MINOR_SELF_MESSAGE = 'Osobę niepełnoletnią zapisuje rodzic lub opiekun.'
export const DUPLICATE_MESSAGE = 'Ten adres jest już w tym zgłoszeniu.'
export const TOO_MANY_MESSAGE = `W jednym zgłoszeniu możesz zapisać najwyżej ${MAX_PEOPLE_PER_REQUEST} osób.`
export const EMPTY_GROUP_MESSAGE = 'Dodaj co najmniej jedną osobę.'
export const UNKNOWN_COMPETITION_MESSAGE = 'Ta konkurencja nie przyjmuje zapisów.'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const text = (v) => (typeof v === 'string' ? v.trim() : '')
const lower = (v) => text(v).toLowerCase()

/**
 * The request body as a group. The legacy `{ categoryId, person }` (and the earlier
 * `{ categoryId, people: [person] }`) becomes a group of one.
 * → { people: [{ categoryId, person, guardianConsent }], buyer: { firstName, lastName, email } | null }
 */
export function normalizeGroupRequest(body) {
  const b = body && typeof body === 'object' ? body : {}
  let raw = []
  if (Array.isArray(b.people)) raw = b.people
  else if (b.person) raw = [{ categoryId: b.categoryId, person: b.person }]
  const people = raw.map((item) => {
    const it = item && typeof item === 'object' ? item : {}
    const wrapped = it.person && typeof it.person === 'object'
    return {
      categoryId: it.categoryId ?? b.categoryId,
      person: wrapped ? it.person : it,
      guardianConsent: it.guardianConsent === true,
    }
  })
  const bu = b.buyer && typeof b.buyer === 'object' ? b.buyer : null
  const buyer = bu ? { firstName: text(bu.firstName), lastName: text(bu.lastName), email: text(bu.email) } : null
  return { people, buyer }
}

const addError = (errors, index, field, message) => {
  errors[index] = { ...(errors[index] ?? {}), [field]: message }
}

/**
 * @param {{ people: object[], buyer: object|null }} group  (normalizeGroupRequest's result)
 * @param {{ sessionEmail: string|null, competitions: Map<string, object>, now?: Date }} ctx
 *   competitions: categoryId → validatePerson's context (formFields, competition, raceDate, …)
 * errors: { [personIndex]: { [field]: message } } (a minor without consent: `guardianConsent`),
 *   plus `errors.buyer: { firstName|lastName|email: message }` when the payer is not in the group.
 * @returns {{ ok: boolean, buyerEmail: string|null, value: object[]|null,
 *   errors: Record<string, Record<string, string>>, groupError: string|null }}
 */
export function validateGroup({ people = [], buyer = null } = {}, { sessionEmail = null, competitions, now = new Date() } = {}) {
  const errors = {}
  const fail = (groupError) => ({ ok: false, buyerEmail: null, value: null, errors, groupError })

  if (people.length === 0) return fail(EMPTY_GROUP_MESSAGE)
  if (people.length > MAX_PEOPLE_PER_REQUEST) return fail(TOO_MANY_MESSAGE)
  for (const p of people) {
    if (!competitions?.get(p.categoryId)) return fail(UNKNOWN_COMPETITION_MESSAGE)
  }

  const session = lower(sessionEmail)
  const results = people.map((p) => validatePerson(p.person, { ...competitions.get(p.categoryId), now }))
  results.forEach((r, i) => { if (!r.ok) errors[i] = { ...r.errors } })

  let groupError = null
  const seenEmail = new Set()
  const seenMinor = new Set()
  let selfIndex = -1
  const roles = []

  people.forEach((p, i) => {
    const r = results[i]
    const email = lower(p.person?.email)

    if (email) {
      if (seenEmail.has(email)) addError(errors, i, 'email', DUPLICATE_MESSAGE)
      seenEmail.add(email)
    }

    const isSelf = Boolean(session) && email === session
    if (!r.ok) {
      // A self whose own fields fail still counts as self: no buyer error on top of theirs.
      if (isSelf && selfIndex === -1) selfIndex = i
      roles.push(null)
      return
    }
    const minor = r.value.isMinor
    let role = minor ? 'minor' : 'adult'

    if (isSelf) {
      if (minor) groupError ??= MINOR_SELF_MESSAGE
      else if (selfIndex === -1) { selfIndex = i; role = 'self' }
      // a second person with the session's address is the duplicate flagged above
    }

    if (minor) {
      if (p.guardianConsent !== true) addError(errors, i, 'guardianConsent', GUARDIAN_CONSENT_MESSAGE)
      const key = `${lower(r.value.firstName)}|${lower(r.value.lastName)}|${r.value.birthDate}`
      if (seenMinor.has(key)) addError(errors, i, 'firstName', DUPLICATE_MESSAGE)
      seenMinor.add(key)
    }
    roles.push(role)
  })

  // Who pays: the logged-in runner when they are in the group, otherwise the buyer.
  let buyerEmail = null
  if (selfIndex >= 0) {
    buyerEmail = session
  } else {
    const be = lower(buyer?.email)
    const berr = {}
    if (!text(buyer?.firstName)) berr.firstName = 'Podaj imię.'
    if (!text(buyer?.lastName)) berr.lastName = 'Podaj nazwisko.'
    if (!EMAIL_RE.test(be) || be.length > 254) berr.email = 'Podaj poprawny adres e-mail.'
    if (Object.keys(berr).length) errors.buyer = berr
    else buyerEmail = be
  }

  if (groupError || Object.keys(errors).length) return { ok: false, buyerEmail, value: null, errors, groupError }

  const value = people.map((p, i) => ({ categoryId: p.categoryId, role: roles[i], ...results[i].value }))
  return { ok: true, buyerEmail, value, errors, groupError: null }
}

/**
 * A stored registration's role in its group, from the row (registrations has no role column).
 * The one derivation for every reader (order-status, my-event-registrations,
 * list-event-registrations), final review M-2.
 * - A child's row always has a guardian: guardian_profile_id (or guardian_name) until the
 *   guardian deletes the account, guardian_removed_at after. The 30-day contact purge nulls the
 *   other guardian fields of every past child entry, so null guardian fields alone prove nothing.
 * - An added adult was registered by an account that is not theirs, or still waits for their
 *   acceptance or was signed in the office: delete-my-account nulls registered_by when the payer
 *   deletes their account, and only an added adult is ever 'awaiting' or 'office'.
 * - A row from before groups has no registered_by_profile_id and was always the person's own.
 * @param {{ profile_id?: string|null, registered_by_profile_id?: string|null, guardian_name?: string|null,
 *   guardian_profile_id?: string|null, guardian_removed_at?: string|null, consent_state?: string|null }} row
 * @returns {'self'|'adult'|'minor'}
 */
export function registrationRole(row) {
  if (row.guardian_name != null || row.guardian_profile_id != null || row.guardian_removed_at != null) return 'minor'
  if (row.registered_by_profile_id != null && row.profile_id !== row.registered_by_profile_id) return 'adult'
  if (row.consent_state === 'awaiting' || row.consent_state === 'office') return 'adult'
  return 'self'
}
