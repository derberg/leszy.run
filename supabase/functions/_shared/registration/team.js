// The rules of one team request: squad size, adult captain, leg order, team name.
// Built on validateGroup and validatePerson, which own every per-person rule.
// Plain ESM: runs in Deno, Node and the public app (the `@registration` alias).

import { MIN_TEAM_SIZE } from './flags.js'
import { UNKNOWN_COMPETITION_MESSAGE, validateGroup } from './group.js'
import { isMinorToday } from './person.js'

export const TEAM_NAME_MIN = 2
export const TEAM_NAME_MAX = 40
export const TEAM_NAME_MESSAGE = `Nazwa drużyny musi mieć od ${TEAM_NAME_MIN} do ${TEAM_NAME_MAX} znaków.`
export const CAPTAIN_MESSAGE = 'Kapitanem drużyny może być tylko osoba pełnoletnia.'
export const CAPTAIN_SELF_MESSAGE = 'Kapitanem drużyny może być tylko osoba, która zapisuje drużynę.'
export const LEG_ORDER_MESSAGE = 'Ustal kolejność zmian.'
export const MEMBERS_CONSENT_MESSAGE = 'Zaznacz zgodę członków drużyny.'

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
 * → { categoryId, teamName, members: [{ person, leg: number|null, guardianConsent }], membersConsent }
 */
export function normalizeTeamRequest(body) {
  const b = body && typeof body === 'object' ? body : {}
  const members = (Array.isArray(b.members) ? b.members : []).map((item) => {
    const m = item && typeof item === 'object' ? item : {}
    return {
      person: m.person && typeof m.person === 'object' ? m.person : {},
      leg: Number.isInteger(m.leg) ? m.leg : null,
      guardianConsent: m.guardianConsent === true,
    }
  })
  return { categoryId: b.categoryId ?? null, teamName: text(b.teamName), members, membersConsent: b.membersConsent === true }
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
  if (membersConsent !== true) fieldErrors.membersConsent = MEMBERS_CONSENT_MESSAGE

  const refuse = (errors, groupError) => ({ ok: false, value: null, errors, fieldErrors, groupError })

  const { teamMax, legOrderEnabled = false } = competition ?? {}
  if (!categoryId || !Number.isInteger(competition?.teamMin) || !Number.isInteger(teamMax)) return refuse({}, UNKNOWN_COMPETITION_MESSAGE)
  // A team always has a captain and a member, whatever a raw row says.
  const teamMin = Math.max(competition.teamMin, MIN_TEAM_SIZE)
  if (members.length < teamMin || members.length > teamMax) return refuse({}, teamSizeMessage(teamMin, teamMax))

  const group = validateGroup(
    { people: members.map((m) => ({ categoryId, person: m.person, guardianConsent: m.guardianConsent })), buyer: null },
    { sessionEmail, competitions: new Map([[categoryId, competition]]), now },
  )

  // The captain pays, so a team has no separate buyer.
  const { buyer: _buyer, ...errors } = group.errors

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
      teamName: text(teamName),
      members: group.value.map((v, i) => ({ ...v, leg: legOrderEnabled ? members[i].leg : null })),
    },
    errors: {},
    fieldErrors,
    groupError: null,
  }
}
