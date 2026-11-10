// The rules of one team request: squad size, adult captain, leg order, team name.
// Built on validateGroup and validatePerson, which own every per-person rule.
// Plain ESM: runs in Deno, Node and the public app (the `@registration` alias).

import { MIN_TEAM_SIZE } from './flags.js'
import { isValidEmail } from './emailAddress.js'
import { GUARDIAN_CONSENT_MESSAGE, UNKNOWN_COMPETITION_MESSAGE, validateGroup } from './group.js'
import { isMinorToday, validatePerson } from './person.js'

export const TEAM_NAME_MIN = 2
export const TEAM_NAME_MAX = 40
export const TEAM_NAME_MESSAGE = `Nazwa drużyny musi mieć od ${TEAM_NAME_MIN} do ${TEAM_NAME_MAX} znaków.`
export const TEAM_NAME_CHARS_MESSAGE = 'Nazwa drużyny nie może zawierać znaków sterujących.'
export const CAPTAIN_MESSAGE = 'Kapitanem drużyny może być tylko osoba pełnoletnia.'
export const CAPTAIN_SELF_MESSAGE = 'Kapitanem drużyny może być tylko osoba, która zapisuje drużynę.'
export const LEG_ORDER_MESSAGE = 'Ustal kolejność zmian.'
export const MEMBERS_CONSENT_MESSAGE = 'Zaznacz zgodę członków drużyny.'
export const PARENT_IS_CAPTAIN_MESSAGE = 'To Twój adres. Jeśli jesteś rodzicem lub opiekunem dziecka, wybierz „Jestem rodzicem lub opiekunem prawnym”.'

const NAME_MAX = 100

const text = (v) => (typeof v === 'string' ? v.trim() : '')

export const teamSizeMessage = (min, max) => `Drużyna musi mieć od ${min} do ${max} osób.`

// One spelling of a name: composed, with every run of whitespace a single space. A letter typed
// as a base and a combining mark is the same letter, and inner spaces do not lengthen a name.
const collapsed = (name) => text(name).normalize('NFC').replace(/\s+/g, ' ')

/**
 * The form of a team name two teams may not share in one competition. Mirrored in SQL by the
 * unique index on teams, so a change here is a change there.
 */
export function teamNameKey(name) {
  return collapsed(name).toLowerCase()
}

/**
 * The request body as a team. Member 0 is the captain.
 * → { categoryId, teamName, members: [{ person, leg: number|null, guardianConsent, parent? }], membersConsent }
 * `parent` ({ firstName, lastName, email }, text) is present only when the body sent an object: on
 * a child's card it names a parent or legal guardian who is not the captain.
 */
export function normalizeTeamRequest(body) {
  const b = body && typeof body === 'object' ? body : {}
  const members = (Array.isArray(b.members) ? b.members : []).map((item) => {
    const m = item && typeof item === 'object' ? item : {}
    const parent = m.parent && typeof m.parent === 'object' && !Array.isArray(m.parent)
      ? { firstName: text(m.parent.firstName), lastName: text(m.parent.lastName), email: text(m.parent.email) }
      : null
    return {
      person: m.person && typeof m.person === 'object' ? m.person : {},
      leg: Number.isInteger(m.leg) ? m.leg : null,
      guardianConsent: m.guardianConsent === true,
      ...(parent ? { parent } : {}),
    }
  })
  return { categoryId: b.categoryId ?? null, teamName: text(b.teamName), members, membersConsent: b.membersConsent === true }
}

/**
 * A child's parent or legal guardian named by the captain, who is not that person (on the team form
 * and the captain's squad add or swap). The parent gets the consent e-mail and accepts on /zgoda,
 * so the address must be one the captain does not hold: with their own, the captain is the parent
 * and ticks the guardian box instead.
 * → { ok, value: { name, email }|null, errors: { parentFirstName?, parentLastName?, parentEmail? } }
 */
export function validateParent(parent, { captainEmail = null } = {}) {
  const firstName = text(parent?.firstName)
  const lastName = text(parent?.lastName)
  const email = text(parent?.email).toLowerCase()
  const errors = {}
  if (!firstName) errors.parentFirstName = 'Podaj imię rodzica lub opiekuna.'
  else if (firstName.length > NAME_MAX) errors.parentFirstName = 'Imię jest za długie.'
  if (!lastName) errors.parentLastName = 'Podaj nazwisko rodzica lub opiekuna.'
  else if (lastName.length > NAME_MAX) errors.parentLastName = 'Nazwisko jest za długie.'
  if (!isValidEmail(email)) errors.parentEmail = 'Podaj poprawny adres e-mail rodzica lub opiekuna.'
  else if (email === text(captainEmail).toLowerCase()) errors.parentEmail = PARENT_IS_CAPTAIN_MESSAGE
  if (Object.keys(errors).length) return { ok: false, value: null, errors }
  // guardian_name's shape: one full name, as the captain's own is stored for the children they answer for.
  return { ok: true, value: { name: `${firstName} ${lastName}`, email }, errors }
}

function legsAreOneToN(members) {
  const legs = new Set(members.map((m) => m.leg))
  return legs.size === members.length && members.every((_, i) => legs.has(i + 1))
}

/**
 * @param {{ categoryId: string, teamName: string, members: object[], membersConsent: boolean }} req
 *   normalizeTeamRequest's result
 * @param {{ sessionEmail: string|null, competition: object, now?: Date }} ctx
 *   competition: { teamMin, teamMax, legOrderEnabled, …validatePerson's context }
 * @returns {{ ok: boolean, value: { teamName: string, members: object[] }|null,
 *   errors: Record<string, Record<string, string>>,
 *   fieldErrors: { teamName?: string, membersConsent?: string }, groupError: string|null }}
 */
export function validateTeam(req, { sessionEmail = null, competition = null, now = new Date() } = {}) {
  const { categoryId = null, teamName = '', members = [], membersConsent = false } = req ?? {}

  const fieldErrors = {}
  // Code points, as char_length counts them: a single emoji is two UTF-16 units.
  const nameLength = [...collapsed(teamName)].length
  if (nameLength < TEAM_NAME_MIN || nameLength > TEAM_NAME_MAX) fieldErrors.teamName = TEAM_NAME_MESSAGE
  // What collapsed() leaves: BEL, ESC, DEL, NEL and the like reach e-mails and the start list otherwise.
  else if (/\p{Cc}/u.test(collapsed(teamName))) fieldErrors.teamName = TEAM_NAME_CHARS_MESSAGE
  if (membersConsent !== true) fieldErrors.membersConsent = MEMBERS_CONSENT_MESSAGE

  const refuse = (errors, groupError) => ({ ok: false, value: null, errors, fieldErrors, groupError })

  const { teamMax, legOrderEnabled = false } = competition ?? {}
  if (!categoryId || !Number.isInteger(competition?.teamMin) || !Number.isInteger(teamMax)) return refuse({}, UNKNOWN_COMPETITION_MESSAGE)
  // A team always has a captain and a member, whatever a raw row says.
  const teamMin = Math.max(competition.teamMin, MIN_TEAM_SIZE)
  if (members.length < teamMin || members.length > teamMax) return refuse({}, teamSizeMessage(teamMin, teamMax))

  // An adult member other than the captain may give the rest of their details on /zgoda
  // (memberDetails.js), so the captain need not; the birth date and gender stay required here, so
  // every rule they decide still holds.
  // A child whose parent is not the captain: the parent consents on /zgoda, so the captain's box is
  // not asked for. Judged by today's date, as validatePerson judges a minor; an adult's or the
  // captain's `parent` is dropped.
  const captainEmail = text(members[0].person?.email).toLowerCase() || text(sessionEmail).toLowerCase()
  const parents = members.map((m, i) => (i > 0 && m.parent && isMinorToday(m.person?.birthDate, now)
    ? validateParent(m.parent, { captainEmail })
    : null))

  const group = validateGroup(
    {
      people: members.map((m, i) => ({
        categoryId, person: m.person, guardianConsent: parents[i] ? true : m.guardianConsent, detailsLater: i > 0,
      })),
      buyer: null,
    },
    { sessionEmail, competitions: new Map([[categoryId, competition]]), now },
  )

  // The captain pays, so a team has no separate buyer.
  const { buyer: _buyer, ...errors } = group.errors
  parents.forEach((p, i) => { if (p && !p.ok) errors[i] = { ...(errors[i] ?? {}), ...p.errors } })

  const session = text(sessionEmail).toLowerCase()
  const captainIsSession = Boolean(session) && text(members[0].person?.email).toLowerCase() === session
  const captainIsMinor = isMinorToday(members[0].person?.birthDate, now)
  // Logging in cannot fix being a minor, so that is the one a minor captain reads.
  const captainError = captainIsMinor ? CAPTAIN_MESSAGE : captainIsSession ? null : CAPTAIN_SELF_MESSAGE
  if (captainError && errors[0]) {
    // A captain has no guardian: the refusal below replaces that question.
    const { guardianConsent: _consent, ...captainErrors } = errors[0]
    if (Object.keys(captainErrors).length) errors[0] = captainErrors
    else delete errors[0]
  }

  let groupError = captainError ?? group.groupError
  if (legOrderEnabled && !legsAreOneToN(members)) groupError ??= LEG_ORDER_MESSAGE

  if (groupError || Object.keys(errors).length || Object.keys(fieldErrors).length) return refuse(errors, groupError)

  return {
    ok: true,
    value: {
      teamName: collapsed(teamName),
      members: group.value.map((v, i) => ({
        ...v, leg: legOrderEnabled ? members[i].leg : null,
        ...(v.role === 'minor' && parents[i] ? { guardian: parents[i].value } : {}),
      })),
    },
    errors: {},
    fieldErrors,
    groupError: null,
  }
}

/**
 * One person joining a squad (team-squad's add and swap). The role comes from the birth date, never
 * from the request, and a child needs the captain's guardian consent, or a parent named in `parent`
 * (validateParent), who then consents on /zgoda. A bad date stops here, because the RPC would raise
 * a raw 22007 on it.
 * @param {{ person?: object, guardianConsent?: boolean, parent?: object }} request
 * @param {object} context validatePerson's context, plus `captainEmail` (the parent's address may not be it)
 * @returns {{ ok: boolean, value: object|null, errors: Record<string, string> }}
 */
export function validateSquadMember({ person, guardianConsent, parent } = {}, context = {}) {
  const named = parent && typeof parent === 'object' && isMinorToday(person?.birthDate, context.now ?? new Date())
    ? validateParent(parent, { captainEmail: context.captainEmail })
    : null
  const checked = validatePerson(person, context)
  if (!checked.ok || (named && !named.ok)) {
    return { ok: false, value: null, errors: { ...(checked.errors ?? {}), ...(named?.errors ?? {}) } }
  }
  const { isMinor, ...value } = checked.value
  if (isMinor && !named && guardianConsent !== true) {
    return { ok: false, value: null, errors: { guardianConsent: GUARDIAN_CONSENT_MESSAGE } }
  }
  return {
    ok: true,
    value: { role: isMinor ? 'minor' : 'adult', ...value, ...(isMinor && named ? { guardian: named.value } : {}) },
    errors: {},
  }
}
