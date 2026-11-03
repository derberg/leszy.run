// RB4, the captain's team page, as pure functions. Druzyna.jsx holds the state: the squad from
// team-squad and at most one member's form, whose request and checks are built here on the same
// rules as the sign-up (groupDraft.js, team.js).
import { validateSquadMember } from '../../../supabase/functions/_shared/registration/team.js'
import { cardVariant } from './groupDraft.js'
import { EMPTY_PARENT, moveMember, ownPart } from './teamDraft.js'
import { countPl } from './plural.js'
import { EMPTY_PERSON } from './personFormModel.js'

const OFFLINE = 'Nie udało się połączyć. Spróbuj ponownie.'
// The server moved on from the page: the squad is read again.
const STALE = new Set(['invalid_legs', 'not_member', 'team_inactive', 'team_full', 'leg_order_off', 'captain_fixed'])
const STATUS = { paid: 'OPŁACONA', awaiting: 'CZEKA NA WPŁATĘ', free: 'ZAPISANA' }

const warsawDay = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Warsaw', day: 'numeric', month: '2-digit' })

export const teamPath = (slug, teamId) => `/events/${slug}/druzyna/${teamId}`

/** The way to RB4 from RA5 and the order page: only for the line that is the captain's. */
export function captainTeamPath(slug, lines) {
  const line = (lines ?? []).find((l) => l.isCaptain && l.teamId)
  return line && slug ? teamPath(slug, line.teamId) : null
}

/** „Zmiany do d.mm”: closes_at is exclusive, so the last day holds the millisecond before it. */
export function lastChangeDay(closesAt) {
  if (!closesAt) return null
  const p = Object.fromEntries(warsawDay.formatToParts(new Date(Date.parse(closesAt) - 1)).map((x) => [x.type, x.value]))
  return `${p.day}.${p.month}`
}

export const teamStatusLabel = (paymentStatus) => STATUS[paymentStatus] ?? null

/** „Dodaj N. osobę”, or null at the maximum. */
export const addLabel = ({ count, max }) => (max != null && count >= max ? null : `Dodaj ${count + 1}. osobę`)

/** A deleted account's entry carries its marker as the first name and no surname. */
export const memberName = (m) => [m.firstName, m.lastName].filter(Boolean).join(' ')

/** A row's line under the name. */
export function memberMeta(m, legOrder) {
  const leg = legOrder && m.leg ? `ZMIANA ${m.leg}` : null
  // A child's row needs no „OPIEKUN: KAPITAN” here: the tag says it, and the line stays on one row at 390 px.
  if (m.role === 'minor') return [leg, m.ageGroupLabel, m.age == null ? null : memberAge(m.age)].filter(Boolean)
  return [leg, m.isCaptain ? 'KAPITAN' : null, m.ageGroupLabel].filter(Boolean)
}
const memberAge = (age) => countPl(age, ['rok', 'lata', 'lat']).toUpperCase()

/** The order step's ↑/↓, on registration ids. */
export const moveLeg = (ids, index, dir) => moveMember({ order: ids }, index, index + dir).order

/** The one form on the page: an empty person, or (in tests) a given one. */
export function newMember(person = EMPTY_PERSON) {
  return { person: { ...EMPTY_PERSON, ...person }, guardianConsent: false }
}

/**
 * The body's person part. A child has no address; their acceptances are the captain's as guardian.
 * `detailsLater` (the captain's own add or swap, never the organizer's): an adult's other fields go
 * only while „Pokaż więcej pól” shows them (`moreFields`), as on the sign-up form.
 */
export function toMemberRequest({ person, guardianConsent, moreFields, parentOther, parent }, { consents, today, detailsLater = false }) {
  if (cardVariant(person, today) !== 'minor') return { person: detailsLater && !moreFields ? ownPart(person) : person }
  const { email: _none, ...child } = person
  // A parent who is not the captain accepts on /zgoda: the captain sends neither box nor consents.
  if (parentOther === true) return { person: child, parent: { ...EMPTY_PARENT, ...parent } }
  return {
    person: child,
    guardianConsent: guardianConsent === true,
    acceptedConsentIds: (consents ?? []).map((k) => k.id),
    serviceRegulamin: true,
  }
}

/** validateSquadMember over that body: { field: message }, empty when the server would take it. */
export function checkMember(member, { context, today, now = new Date(), detailsLater = false, captainEmail = null }) {
  return validateSquadMember(toMemberRequest(member, { today, detailsLater }), { ...context, now, detailsLater, captainEmail }).errors ?? {}
}

/**
 * A refused edit: { closed } the page goes to its closed state; { login } no session; { missing } the
 * team is gone; { stale } the squad is read again; { consentsChanged } the event's consents moved on
 * from the page, so it reads them again and asks anew; otherwise { fields, message } stay on the form.
 */
export function squadFailure(err) {
  const base = { closed: false, login: false, missing: false, stale: false, consentsChanged: false, fields: {}, message: null }
  if (err?.status == null) return { ...base, message: OFFLINE }
  if (err.code === 'squad_closed') return { ...base, closed: true }
  if (err.status === 401) return { ...base, login: true }
  if (err.status === 404) return { ...base, missing: true }
  if (STALE.has(err.code)) return { ...base, stale: true, message: err.message }
  if (err.code === 'consents_changed') return { ...base, consentsChanged: true, message: err.message }
  if (err.code === 'email_retired') return { ...base, fields: { [err.field === 'parentEmail' ? 'parentEmail' : 'email']: err.message } }
  if (err.fields) return { ...base, fields: err.fields, message: err.code === 'invalid_person' ? err.message : null }
  return { ...base, message: err.status >= 500 ? 'Nie udało się zmienić składu. Spróbuj ponownie.' : err.message }
}
