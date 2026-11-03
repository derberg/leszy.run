// The team form (RB1 + RB2) as pure functions, built on the group form's draft (groupDraft.js):
// `cards[0]` is the captain, and a card's index is its member index in the request, so the group
// form's person helpers and refusal routing work unchanged. On top of it a team holds its name,
// the members' consent and `order`, the card keys in the order shown on RB2: with leg order on
// that is the order of the legs, which the captain can run any of while staying member 0 of the
// request. The draft lives in React memory only; TeamSignup.jsx holds it.
//
// The checks are the server's own: validateTeam (team.js) over the same request this module
// builds, so a card shows the error the server would answer.
import { normalizeTeamRequest, validateTeam, CAPTAIN_SELF_MESSAGE } from '../../../supabase/functions/_shared/registration/team.js'
import { ageOn } from '../../../supabase/functions/_shared/registration/ageGroups.js'
import {
  addPerson, carryOver, CARRY_FIELDS, copiedFromNames, cartOfCard, cardVariant, claimedEmail, erroredCards, groupFailure, LIST_STEP, newDraft, removePerson, requestPeople,
  withoutHiddenFields,
} from './groupDraft.js'
import { personContext } from './personFormModel.js'
import { requiredConsents } from '../../../supabase/functions/_shared/registration/consents.js'
import { countPl } from './plural.js'

/** The hint under an adult member's e-mail: the label itself stays „E-mail”, so it never wraps. */
export const ADULT_EMAIL_NOTE = 'Wyślemy prośbę o akceptację regulaminu.'

/** An adult member's card on RB2, beside „Pokaż więcej pól” (PersonForm's `detailsNote`; memberDetails.js). */
export const MEMBER_DETAILS_NOTE = 'Nie musisz ich wypełniać: ta osoba dostanie e-mail z linkiem i resztę uzupełni sama.'

// What the captain must give for an adult member. The other fields are optional for the captain
// and sent only while the card shows them („Pokaż więcej pól”): a value the captain cannot see,
// typed before the fields were hidden or while the card showed a child's layout, never leaves
// the browser. What is left the member fills on /zgoda. The squad page (teamPage.js) uses it too.
const MEMBER_KEYS = ['firstName', 'lastName', 'birthDate', 'gender', 'email']
export const ownPart = (person) => Object.fromEntries(MEMBER_KEYS.filter((k) => k in person).map((k) => [k, person[k]]))

/** „Pokaż więcej pól” / „Ukryj dodatkowe pola” on an adult member's card. */
export function setMoreFields(draft, key, on) {
  return { ...draft, cards: draft.cards.map((c) => (c.key === key ? { ...c, moreFields: on === true } : c)) }
}

/** The parent's fields on a child's card when „Rodzic lub opiekun to ktoś inny” is chosen. */
export const EMPTY_PARENT = { firstName: '', lastName: '', email: '' }

/**
 * A child's card: the captain is the parent or legal guardian (`false`, the default: the guardian
 * box) or names somebody else (`true`: that parent gets the consent e-mail, validateParent in team.js).
 * The parent typed stays on the card when the captain switches back, but is sent only while chosen.
 */
export function setParentChoice(draft, key, other) {
  return { ...draft, cards: draft.cards.map((c) => (c.key === key ? { ...c, parentOther: other === true } : c)) }
}

/** The named parent's fields, a partial patch. */
export function setParent(draft, key, patch) {
  return { ...draft, cards: draft.cards.map((c) => (c.key === key ? { ...c, parent: { ...EMPTY_PARENT, ...c.parent, ...patch } } : c)) }
}

const namesParent = (card, variant) => variant === 'minor' && card?.parentOther === true

/**
 * The event consents the team form shows, requires and sends: a minors-only one only while the squad
 * holds a child the captain answers for. A child whose parent is named gets it from that parent on
 * /zgoda (consents.js), so it goes with the last such card.
 */
export function teamConsents(draft, consents, today) {
  const variants = draft.cards.map((c, i) => (i === 0 ? 'self' : cardVariant(c.person, today)))
  const answersFor = draft.cards.some((c, i) => variants[i] === 'minor' && !namesParent(c, variants[i]))
  return requiredConsents(consents, { hasMinor: answersFor })
}

/** The captain and `size - 1` empty cards. */
export function initTeam(size, categoryId = null) {
  const first = newDraft(categoryId)
  return setSize({ ...first, teamName: '', membersConsent: false, order: [first.cards[0].key] }, size)
}

const captainKey = (draft) => draft.cards[0].key

/** The cards `setSize` would drop: from the end of the squad as shown, never the captain. */
export function droppedBy(draft, size) {
  const extra = draft.cards.length - Math.max(size, 1)
  if (extra <= 0) return []
  const keys = draft.order.filter((k) => k !== captainKey(draft)).slice(-extra)
  return keys.map((k) => draft.cards.find((c) => c.key === k))
}

/** Growing keeps everybody and adds empty cards; shrinking drops from the end of the squad. */
export function setSize(draft, size) {
  let next = draft
  while (next.cards.length < size) {
    const grown = addPerson(next, { categoryId: next.cards[0].categoryId })
    if (grown === next) break
    next = { ...grown, order: [...next.order, grown.cards[grown.cards.length - 1].key] }
  }
  const gone = new Set(droppedBy(next, size).map((c) => c.key))
  if (!gone.size) return next
  return { ...next, cards: next.cards.filter((c) => !gone.has(c.key)), order: next.order.filter((k) => !gone.has(k)) }
}

/** The list step's „Usuń”. The captain is never removed. */
export function removeMember(draft, key) {
  const next = removePerson(draft, key)
  return next === draft ? draft : { ...next, order: next.order.filter((k) => k !== key) }
}

/** ↑/↓ on RB2: `from` and `to` are positions in the squad as shown. Everybody between renumbers. */
export function moveMember(draft, from, to) {
  const n = draft.order.length
  if (from === to || from < 0 || to < 0 || from >= n || to >= n) return draft
  const order = [...draft.order]
  const [key] = order.splice(from, 1)
  order.splice(to, 0, key)
  return { ...draft, order }
}

/** The member's place in the squad as shown, from 1: their leg with leg order on. */
export const legOf = (draft, key) => draft.order.indexOf(key) + 1

/** The squad as shown: [{ card, index (the card's own, for the request), leg }]. */
export function squadCards(draft) {
  return draft.order.map((key, i) => {
    const index = draft.cards.findIndex((c) => c.key === key)
    return { card: draft.cards[index], index, leg: i + 1 }
  })
}

/** The carried fields the form shows: `fields` is fieldModes', and an 'off' field is never copied. */
const carried = (fields) => CARRY_FIELDS.filter((k) => fields?.[k] !== 'off')

/**
 * A member's step opening: the club and town come from the nearest filled card before it in the
 * squad as shown (a finished member, or the captain, who is always filled). Captain-first that is
 * the captain for member 2 and member 2 for member 3. The captain's own card never takes a copy.
 */
export function carryOverMember(draft, key, fields) {
  if (key === captainKey(draft)) return draft
  const before = draft.order.slice(0, Math.max(draft.order.indexOf(key), 0)).reverse()
  const from = before.find((k) => k === captainKey(draft) || draft.cards.find((c) => c.key === k)?.open === false) ?? captainKey(draft)
  return carryOver(draft, key, from, carried(fields))
}

/**
 * Every member already carried over (finished, or holding a copy) takes it again, in squad order,
 * so a copy follows its source after the step that made it: the captain's club fixed on RB1 reaches
 * member 2 and, through them, member 3. The form runs it on every change. Nothing changes → the same draft.
 */
export function carryOverSquad(draft, fields) {
  let next = draft
  for (const key of draft.order) {
    const c = next.cards.find((x) => x.key === key)
    if (key === captainKey(next) || (c.open && !Object.keys(c.copied ?? {}).length)) continue
    next = carryOverMember(next, key, fields)
  }
  return next
}

/** What carryOver filled between two drafts: [{ key, field }], for clearing those fields' errors. */
export function carriedIn(prev, next) {
  const out = []
  for (const c of next.cards) {
    const was = prev.cards.find((x) => x.key === c.key)
    for (const field of CARRY_FIELDS) {
      if (c.copied?.[field] && c.person[field] !== was?.person[field]) out.push({ key: c.key, field })
    }
  }
  return out
}

/** copiedFromNames with a nameless member counted by their place in the squad as shown. */
export function memberCopiedFrom(draft, key) {
  return copiedFromNames(draft, key, (i) => {
    const p = draft.cards[i].person
    const name = [p.firstName, p.lastName].map((x) => (x ?? '').trim()).filter(Boolean).join(' ')
    return name || `osoba ${legOf(draft, draft.cards[i].key)}`
  })
}

/** 'minor' under 18 on today's Warsaw date, otherwise 'adult': the group form's rule (T-61). */
export const memberVariant = cardVariant

/** „12 LAT”: the age the competition counts, for a child's row on RB2. */
export function memberAgeLabel(person, raceDate, reckoning) {
  return countPl(ageOn(person.birthDate, raceDate, reckoning), ['rok', 'lata', 'lat']).toUpperCase()
}

/**
 * The register-team body. Member 0 is the captain. `leg` goes only with leg order on.
 * `website` is the form's honeypot, sent only when something filled it.
 */
export function toTeamRequest(draft, { consents, legOrder = false, displayedTotal, today, website, extrasOf } = {}) {
  const members = requestPeople(draft, today).map(({ person, guardianConsent }, i) => ({
    // requestPeople marks a child by the guardian box: every other member but the captain is an adult.
    person: i > 0 && guardianConsent === undefined && !draft.cards[i].moreFields ? ownPart(person) : person,
    // A child's card: the box, or the parent the captain named instead of it.
    ...(guardianConsent === undefined ? {}
      : draft.cards[i].parentOther === true ? { parent: { ...EMPTY_PARENT, ...draft.cards[i].parent } } : { guardianConsent }),
    ...(legOrder ? { leg: legOf(draft, draft.cards[i].key) } : {}),
    // Plan 7: each member's extras. The code is the team line's, never a member's.
    ...memberExtras(draft.cards[i], extrasOf),
  }))
  // Plan 7 (RB1): the team line's one code, typed on the captain's step and kept on the captain's card.
  const voucherCode = cartOfCard(draft.cards[0], () => []).voucherCode
  return {
    categoryId: draft.cards[0].categoryId,
    teamName: draft.teamName,
    ...(voucherCode ? { voucherCode } : {}),
    members,
    membersConsent: draft.membersConsent === true,
    // A minors-only consent goes only with a child the captain answers for (teamConsents).
    acceptedConsentIds: teamConsents(draft, consents, today).map((k) => k.id),
    serviceRegulamin: true,
    ...(displayedTotal === undefined ? {} : { displayedTotal }),
    ...(website ? { website } : {}),
  }
}

function memberExtras(card, extrasOf) {
  const { extras } = cartOfCard(card, extrasOf)
  return extras ? { extras } : {}
}

/** validateTeam's competition: validatePerson's context plus the squad's rules. */
export function teamContext(raw, competition, now = new Date()) {
  return {
    ...personContext(raw, competition, now),
    teamMin: competition.teamMin, teamMax: competition.teamMax, legOrderEnabled: competition.legOrderEnabled === true,
  }
}

/**
 * validateTeam over toTeamRequest's body.
 * → { ok, errors: { [cardKey]: { field: message } }, fieldErrors: { teamName?, membersConsent? }, groupError }
 */
export function checkTeam(draft, { context, now = new Date() }) {
  const body = toTeamRequest(draft, { legOrder: context.legOrderEnabled, today: now })
  const r = validateTeam(normalizeTeamRequest(body), {
    sessionEmail: claimedEmail(draft).trim().toLowerCase() || null, competition: context, now,
  })
  const errors = {}
  for (const [i, fields] of Object.entries(r.errors ?? {})) errors[draft.cards[Number(i)].key] = fields
  const shown = withoutHiddenFields(draft, errors, now)
  const ok = r.ok || (!r.groupError && Object.keys(shown).length === 0 && Object.keys(r.fieldErrors).length === 0)
  return { ok, errors: shown, fieldErrors: r.fieldErrors, groupError: r.groupError }
}

/**
 * RB1 only: the name and the captain, whatever the empty cards behind them would answer. With no
 * address yet the server's „only the person signing up” says nothing the e-mail field does not.
 * → { ok, errors, nameError, groupError }
 */
export function checkCaptain(draft, options) {
  const r = checkTeam(draft, options)
  const key = captainKey(draft)
  const own = r.errors[key]
  const nameError = r.fieldErrors.teamName ?? null
  const groupError = r.groupError === CAPTAIN_SELF_MESSAGE ? null : r.groupError
  return { ok: !own && !nameError && !groupError, errors: own ? { [key]: own } : {}, nameError, groupError }
}

/** The first member still to be filled in, in squad order, or the list. */
export function firstOpenMember(draft) {
  const next = squadCards(draft).find(({ index, card }) => index > 0 && card.open)
  return next ? next.card.key : LIST_STEP
}

/** Where finishing member `key` leads: the next one refused, the next one to fill in, the list. */
export function memberAfter(draft, key, errors) {
  const refused = erroredCards(draft, errors).find((k) => k !== key && k !== captainKey(draft))
  if (refused) return refused
  const next = squadCards(draft).find(({ index, card }) => index > 0 && card.key !== key && card.open)
  return next ? next.card.key : LIST_STEP
}

/**
 * Where a refusal from register-team or the code step shows:
 * { step: 'captain'|'squad'|'code', errors, nameError, message, focus: cardKey|null }.
 * groupFailure does the routing: an `index` names the card, and a child's duplicate lands on the
 * name, since a child's card has no e-mail field. The name and the captain's own fields live on
 * RB1; anything that names no card (`refused`, a size refusal) is the list's message.
 */
export function teamFailure(err, draft, today) {
  const f = groupFailure(err?.errors ? { status: err.status, code: err.code, message: err.message, index: err.index, people: err.errors } : err, draft, today)
  if (f.step === 'code') return { ...f, step: 'code', nameError: null }
  const nameError = err?.fields?.teamName ?? null
  if (nameError) return { step: 'captain', errors: f.errors, nameError, message: null, focus: captainKey(draft) }
  if (f.focus === captainKey(draft)) return { step: 'captain', errors: f.errors, nameError: null, message: null, focus: f.focus }
  return { step: 'squad', errors: f.errors, nameError: null, message: f.message, focus: f.focus }
}

/**
 * register-team's 409 price_changed carries the new fee (`amounts.entryTotal`, 0 zł included): the
 * form keeps it, so the next „Zapisz” sends the server's fee instead of the page's (final review
 * L-1). → grosze, or null for any other answer.
 */
export function repricedFee(err) {
  if (err?.code !== 'price_changed') return null
  const fee = err.amounts?.entryTotal
  return Number.isSafeInteger(fee) && fee >= 0 ? fee : null
}
