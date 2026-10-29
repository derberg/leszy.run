// The group form (RA2 + RA3) as pure functions: a list of person cards, the first of which
// is „Twoje dane” (the person registering, or with „Nie startuję” only the payer and
// guardian: imię, nazwisko, e-mail, D4-23). Every other card is an adult or a child, decided by
// the birth date on today's Warsaw date. The draft lives in React memory only; Zapis.jsx holds
// it and these functions change it, always returning a new draft.
//
// The checks are the server's own: validateGroup (group.js) over the same request this module
// builds, so a card shows the error the server would answer, before any e-mail is sent.
import { validateGroup } from '../../../supabase/functions/_shared/registration/group.js'
import { MAX_PEOPLE_PER_REQUEST } from '../../../supabase/functions/_shared/registration/flags.js'
import { ADULT_AGE } from '../../../supabase/functions/_shared/registration/person.js'
import { ageOn } from '../../../supabase/functions/_shared/registration/ageGroups.js'
import { warsawToday } from '../../../supabase/functions/_shared/registration/dates.js'
import { EMPTY_PERSON, consentsComplete, registrationFailure } from './personFormModel.js'

export { MAX_PEOPLE_PER_REQUEST }

let seq = 0
const newKey = () => `card-${++seq}`

const card = (categoryId, person = {}) => ({
  key: newKey(), categoryId, person: { ...EMPTY_PERSON, ...person }, guardianConsent: false, phoneTouched: false, open: true,
})

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
function realDate(iso) {
  if (!ISO_DATE.test(iso ?? '')) return false
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10) === iso
}
const dayOf = (today) => (today instanceof Date ? warsawToday(today) : today ?? warsawToday())

/** A fresh draft: card 1 („Twoje dane”) in the competition the form was opened for. */
export function newDraft(categoryId) {
  return { notRunning: false, cards: [card(categoryId)] }
}

/** People the request registers: every card, less card 1 with „Nie startuję”. */
export function peopleCount(draft) {
  return draft.cards.length - (draft.notRunning ? 1 : 0)
}

export function canAdd(draft) {
  return peopleCount(draft) < MAX_PEOPLE_PER_REQUEST
}

/**
 * One more card. `{ categoryId }` opens an empty one; `{ after: key }` („+ Kolejne dziecko”)
 * takes that card's competition and surname. At MAX_PEOPLE_PER_REQUEST the draft is returned as is.
 */
export function addPerson(draft, { categoryId, after } = {}) {
  if (!canAdd(draft)) return draft
  const prev = after ? draft.cards.find((c) => c.key === after) : null
  const next = prev
    ? card(prev.categoryId, { lastName: prev.person.lastName })
    : card(categoryId ?? draft.cards[0].categoryId)
  return { ...draft, cards: [...draft.cards, next] }
}

/** Card 1 is never removed. */
export function removePerson(draft, key) {
  const i = draft.cards.findIndex((c) => c.key === key)
  if (i <= 0) return draft
  return { ...draft, cards: draft.cards.filter((c) => c.key !== key) }
}

const mapCard = (draft, key, fn) => ({ ...draft, cards: draft.cards.map((c, i) => (c.key === key ? fn(c, i) : c)) })

/** A partial person patch. A phone typed on any card but card 1 is that card's own from then on. */
export function updatePerson(draft, key, patch) {
  return mapCard(draft, key, (c, i) => ({
    ...c,
    person: { ...c.person, ...patch },
    phoneTouched: c.phoneTouched || (i > 0 && 'phone' in patch),
  }))
}

export function setCardCompetition(draft, key, categoryId) {
  return mapCard(draft, key, (c) => ({ ...c, categoryId }))
}

export function setCardOpen(draft, key, open) {
  return mapCard(draft, key, (c) => ({ ...c, open }))
}

export function setGuardianConsent(draft, key, value) {
  return mapCard(draft, key, (c) => ({ ...c, guardianConsent: value === true }))
}

/** Nothing typed or ticked on the card yet. */
export function cardEmpty(c) {
  return !!c && c.guardianConsent !== true && Object.keys(EMPTY_PERSON).every((k) => (c.person?.[k] ?? '') === '')
}

/**
 * „Nie startuję — zapisuję tylko inne osoby” (D4-23). Switched on with nobody else, a card opens
 * (its key is `autoCard`, so the form can focus it). Switched off again, that card goes while it
 * is still empty; once anything is typed into it, it stays.
 */
export function setNotRunning(draft, value) {
  const on = value === true
  const { autoCard, ...rest } = draft
  if (on) {
    const next = { ...rest, notRunning: true }
    if (next.cards.length !== 1) return next
    const added = addPerson(next, { categoryId: next.cards[0].categoryId })
    return { ...added, autoCard: added.cards[1].key }
  }
  const next = { ...rest, notRunning: false }
  const auto = autoCard && next.cards.find((c) => c.key === autoCard)
  return auto && cardEmpty(auto) ? { ...next, cards: next.cards.filter((c) => c.key !== autoCard) } : next
}

/** 'minor' when the birth date is under 18 on today's Warsaw date, otherwise 'adult'. */
export function cardVariant(person, today) {
  const birth = person?.birthDate
  if (!realDate(birth)) return 'adult'
  const day = dayOf(today)
  if (birth > day) return 'adult'
  return ageOn(birth, day, 'race_day') < ADULT_AGE ? 'minor' : 'adult'
}

/** Every card's layout: card 1 'self' or 'buyer', the others 'adult' or 'minor'. */
export function cardVariants(draft, today) {
  return draft.cards.map((c, i) => (i === 0 ? (draft.notRunning ? 'buyer' : 'self') : cardVariant(c.person, today)))
}

/**
 * The card's person as it is sent: a child whose phone was never typed takes card 1's (the
 * guardian's, D4-26) and follows it while untouched.
 */
export function effectivePerson(draft, index, today) {
  const c = draft.cards[index]
  if (index === 0 || c.phoneTouched || cardVariant(c.person, today) !== 'minor') return c.person
  return { ...c.person, phone: draft.cards[0].person.phone }
}

const PERSON_KEYS = ['firstName', 'lastName', 'birthDate', 'gender', 'email', 'phone', 'city', 'club', 'iceName', 'icePhone', 'nationality']

/** Card index of request person `i` (people[] skips card 1 with „Nie startuję”). */
const cardIndexOf = (draft, i) => i + (draft.notRunning ? 1 : 0)

/** The register-free / create-order body (create-order adds the support choice and total). */
export function toRequest(draft, { consents, code, today } = {}) {
  const day = dayOf(today)
  const people = []
  draft.cards.forEach((c, i) => {
    if (i === 0 && draft.notRunning) return
    const p = effectivePerson(draft, i, day)
    const minor = i > 0 && cardVariant(p, day) === 'minor'
    const person = {}
    for (const k of PERSON_KEYS) {
      if (k === 'email' && minor) continue
      person[k] = p[k]
    }
    people.push(minor ? { categoryId: c.categoryId, person, guardianConsent: c.guardianConsent === true } : { categoryId: c.categoryId, person })
  })
  const body = { people, acceptedConsentIds: (consents ?? []).map((k) => k.id), serviceRegulamin: true }
  if (draft.notRunning) {
    const b = draft.cards[0].person
    body.buyer = { firstName: b.firstName, lastName: b.lastName, email: b.email }
  }
  const c = typeof code === 'string' ? code.trim() : ''
  if (c) body.code = c
  return body
}

/** The address the code goes to and the session must hold: card 1's (self or buyer). */
export function claimedEmail(draft) {
  return draft.cards[0].person.email ?? ''
}

/**
 * validateGroup over toRequest's group. `contexts`: categoryId → personContext(raw, competition, now).
 * → { ok, errors: { [cardKey]: { field: message } }, groupError }
 */
export function checkDraft(draft, { contexts, now = new Date() }) {
  const body = toRequest(draft, { today: now })
  const r = validateGroup({ people: body.people, buyer: body.buyer ?? null }, {
    sessionEmail: claimedEmail(draft).trim().toLowerCase() || null, competitions: contexts, now,
  })
  const errors = {}
  for (const [k, v] of Object.entries(r.errors ?? {})) {
    const key = k === 'buyer' ? draft.cards[0].key : draft.cards[cardIndexOf(draft, Number(k))].key
    // card 1's own field errors win over the buyer block's (the same field, worded alike)
    errors[key] = k === 'buyer' ? { ...v, ...(errors[key] ?? {}) } : { ...(errors[key] ?? {}), ...v }
  }
  const shown = withoutHiddenFields(draft, errors, now)
  const ok = r.ok || (!r.groupError && Object.keys(shown).length === 0)
  return { ok, errors: shown, groupError: r.groupError }
}

/**
 * A child's card has no e-mail field, so an e-mail error on it can neither be seen nor fixed:
 * it is dropped (and a card left with no error drops out). validatePerson treats a child as
 * a minor only when the birth date fits the competition; outside it, the birth date error is
 * the one the person can act on.
 */
export function withoutHiddenFields(draft, errors, today) {
  const day = dayOf(today)
  const out = {}
  for (const [key, fields] of Object.entries(errors ?? {})) {
    const i = draft.cards.findIndex((c) => c.key === key)
    const minor = i > 0 && cardVariant(draft.cards[i].person, day) === 'minor'
    const kept = { ...fields }
    if (minor) delete kept.email
    if (Object.keys(kept).length) out[key] = kept
  }
  return out
}

/** How a card is named in a message: imię nazwisko, or „osoba N” while both are empty. */
export function cardName(draft, index) {
  const p = draft.cards[index]?.person ?? {}
  return [p.firstName, p.lastName].map((s) => (s ?? '').trim()).filter(Boolean).join(' ') || `osoba ${index + 1}`
}

/** The cards with an error, in form order. */
export function erroredCards(draft, errors) {
  return draft.cards.filter((c) => errors?.[c.key] && Object.keys(errors[c.key]).length).map((c) => c.key)
}

/** „Popraw dane: Piotr Leśny, Zosia Leśna.” for the cards with an error; null when none has one. */
export function fixMessage(draft, errors) {
  const names = erroredCards(draft, errors).map((key) => cardName(draft, draft.cards.findIndex((c) => c.key === key)))
  return names.length ? `Popraw dane: ${names.join(', ')}.` : null
}

/** „Dalej” is on when every consent, the service regulamin and each child's guardian box are ticked. */
export function draftReady(draft, { consents, accepted, serviceAccepted, today }) {
  if (!consentsComplete(consents, accepted, serviceAccepted)) return false
  return cardVariants(draft, today).every((v, i) => v !== 'minor' || draft.cards[i].guardianConsent === true)
}

const ON_PERSON = new Set(['duplicate', 'email_retired'])

/**
 * Where a refusal from register-free, create-order or the code step shows:
 * { step: 'form'|'code', errors: { [cardKey]: { field: message } }, code: message|null, message, focus: cardKey|null }.
 * An `index` names request person `index` (D4-6); without one an address refusal is card 1's.
 * A refusal that lands on a card also gets a form message naming the person, and `focus` is
 * the first such card: on a form of ten people the field itself can be screens away.
 * `full` with a `categoryId` lands on the competition select of every added card in that
 * competition (card 1's competition is the page's own and cannot be changed there).
 */
export function groupFailure(err, draft, today) {
  const errors = {}
  const put = (ci, field, message) => {
    const key = draft.cards[ci]?.key
    if (key) errors[key] = { ...(errors[key] ?? {}), [field]: message }
  }
  const routed = (message) => {
    const shown = withoutHiddenFields(draft, errors, today)
    return { step: 'form', errors: shown, code: null, message: fixMessage(draft, shown) ?? message, focus: erroredCards(draft, shown)[0] ?? null }
  }
  if (err?.status != null && ON_PERSON.has(err.code)) {
    if (Number.isInteger(err.index)) {
      const ci = cardIndexOf(draft, err.index)
      const minor = ci > 0 && cardVariant(draft.cards[ci]?.person, today) === 'minor'
      put(ci, minor ? 'firstName' : 'email', err.message)
    } else {
      put(0, 'email', err.message)
    }
    return routed(null)
  }
  if (err?.status != null && err.code === 'invalid_person') {
    if (err.people && typeof err.people === 'object') {
      for (const [i, fields] of Object.entries(err.people)) {
        for (const [f, m] of Object.entries(fields ?? {})) put(cardIndexOf(draft, Number(i)), f, m)
      }
    } else {
      for (const [f, m] of Object.entries(err.fields ?? {})) put(cardIndexOf(draft, 0), f, m)
    }
    for (const [f, m] of Object.entries(err.buyer ?? {})) put(0, f, m)
    return routed(err.message)
  }
  if (err?.status != null && err.code === 'full' && err.categoryId) {
    draft.cards.forEach((c, i) => { if (i > 0 && c.categoryId === err.categoryId) put(i, 'competition', err.message) })
    if (Object.keys(errors).length) {
      const names = erroredCards(draft, errors).map((key) => cardName(draft, draft.cards.findIndex((c) => c.key === key)))
      return { step: 'form', errors, code: null, message: `${err.message} Zmień konkurencję: ${names.join(', ')}.`, focus: erroredCards(draft, errors)[0] }
    }
  }
  const f = registrationFailure(err)
  return { step: f.step, errors, code: f.fields.code ?? null, message: f.message, focus: null }
}
