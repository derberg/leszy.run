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
import { requiredConsents } from '../../../supabase/functions/_shared/registration/consents.js'
import { EMPTY_PERSON, consentsComplete, registrationFailure } from './personFormModel.js'

export { MAX_PEOPLE_PER_REQUEST }

let seq = 0
const newKey = () => `card-${++seq}`

// Plan 7: a card's cart. `voucher.state`: 'idle' (typed, not checked), 'checking', 'ok' (check-voucher
// accepted it for this competition: `percent`, `price`) or 'error'. `extras`: { [extraId]: { variantId, qty } }.
export const EMPTY_VOUCHER = { code: '', state: 'idle', percent: null, price: null }

const card = (categoryId, person = {}) => ({
  key: newKey(), categoryId, person: { ...EMPTY_PERSON, ...person }, guardianConsent: false, phoneTouched: false, open: true,
  voucher: EMPTY_VOUCHER, extras: {}, typed: {}, copied: {},
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

/**
 * A partial person patch. A phone typed on any card but card 1 is that card's own from then on,
 * and so is a typed club or town: carryOver never fills it again, and its „Skopiowano od” goes.
 */
export function updatePerson(draft, key, patch) {
  return mapCard(draft, key, (c, i) => {
    const own = CARRY_FIELDS.filter((k) => k in patch)
    const copied = { ...c.copied }
    for (const k of own) delete copied[k]
    return {
      ...c,
      person: { ...c.person, ...patch },
      phoneTouched: c.phoneTouched || (i > 0 && 'phone' in patch),
      typed: own.length ? { ...c.typed, ...Object.fromEntries(own.map((k) => [k, true])) } : (c.typed ?? {}),
      copied,
    }
  })
}

/** What a squad usually shares, so the next card starts with the previous one's (carryOver). */
export const CARRY_FIELDS = ['club', 'city']

/**
 * Card `key` takes `fromKey`'s club and town, where the person has typed nothing into that field
 * on this card. `copied` remembers the source card, for the form's „Skopiowano od: …”. The copy
 * follows the source while untyped: an emptied source empties it. `fields` leaves out a field the
 * organizer switched off. Nothing changes → the same draft.
 */
export function carryOver(draft, key, fromKey, fields = CARRY_FIELDS) {
  const target = draft.cards.find((c) => c.key === key)
  const source = draft.cards.find((c) => c.key === fromKey)
  if (!target || !source || key === fromKey) return draft
  const person = { ...target.person }
  const copied = { ...target.copied }
  let changed = false
  for (const k of fields) {
    if (target.typed?.[k]) continue
    const v = source.person[k] ?? ''
    // A value the card did not get from carryOver is left alone.
    if ((person[k] ?? '') !== '' && !copied[k]) continue
    const from = v === '' ? undefined : fromKey
    if (person[k] === v && copied[k] === from) continue
    person[k] = v
    if (from) copied[k] = from
    else delete copied[k]
    changed = true
  }
  return changed ? mapCard(draft, key, (c) => ({ ...c, person, copied })) : draft
}

/**
 * The names of the cards a card's club and town were copied from: { club?: 'Jan Kowalski', city?: … }.
 * `nameOf(index)` names a card; the team form passes one that counts nameless members by leg.
 */
export function copiedFromNames(draft, key, nameOf = (i) => cardName(draft, i)) {
  const c = draft.cards.find((x) => x.key === key)
  const out = {}
  for (const [field, from] of Object.entries(c?.copied ?? {})) {
    const i = draft.cards.findIndex((x) => x.key === from)
    out[field] = i < 0 ? 'poprzedniej osoby' : nameOf(i)
  }
  return out
}

/**
 * Another competition: a checked code is checked again (its competitions and price differ), the
 * extras start over. `priced: false` (the new competition costs 0 zł) drops the code: it would
 * discount nothing and be refused (voucher_not_applicable) on a card with no code field (review I-2).
 */
export function setCardCompetition(draft, key, categoryId, { priced = true } = {}) {
  return mapCard(draft, key, (c) => (c.categoryId === categoryId ? c : {
    ...c, categoryId, voucher: { ...EMPTY_VOUCHER, code: priced ? (c.voucher?.code ?? '') : '' }, extras: {},
  }))
}

/** A patch of the card's code: a new `code` is unchecked again. */
export function setCardVoucher(draft, key, patch) {
  return mapCard(draft, key, (c) => {
    const prev = c.voucher ?? EMPTY_VOUCHER
    const next = { ...prev, ...patch }
    if ('code' in patch && patch.code !== prev.code) Object.assign(next, { state: 'idle', percent: null, price: null })
    return { ...c, voucher: next }
  })
}

/** One extra of the card: { variantId?, qty? }. */
export function setCardExtra(draft, key, extraId, patch) {
  return mapCard(draft, key, (c) => ({ ...c, extras: { ...c.extras, [extraId]: { ...(c.extras?.[extraId] ?? { qty: 0 }), ...patch } } }))
}

/** The cards whose typed code has not been accepted yet (`state` idle or error). */
export function uncheckedCodes(draft) {
  return draft.cards.filter((c) => (c.voucher?.code ?? '').trim() && c.voucher.state !== 'ok').map((c) => c.key)
}

/**
 * Whether any card orders an extra (qty above 0): such a request is an order (ruling 7).
 * `extrasOf(card)` (cartOfCard's) counts only what the page still offers.
 */
export function draftOrdersExtras(draft, extrasOf = rawExtras) {
  return draft.cards.some((c, i) => !(i === 0 && draft.notRunning) && extrasOf(c).length > 0)
}

export function setCardOpen(draft, key, open) {
  return mapCard(draft, key, (c) => ({ ...c, open }))
}

export function setGuardianConsent(draft, key, value) {
  return mapCard(draft, key, (c) => ({ ...c, guardianConsent: value === true }))
}

/** Nothing typed or ticked on the card yet: a club or town carryOver copied in counts as nothing. */
export function cardEmpty(c) {
  return !!c && c.guardianConsent !== true
    && Object.keys(EMPTY_PERSON).every((k) => (c.person?.[k] ?? '') === '' || !!c.copied?.[k])
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
 * The event consents this request shows, requires and sends: a minors-only one (the guardian's)
 * only while a child's card is in it, so it appears and goes with that card (consents.js).
 */
export function draftConsents(draft, consents, today) {
  return requiredConsents(consents, { hasMinor: cardVariants(draft, today).includes('minor') })
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

/** people[] of the request: every card but card 1 under „Nie startuję”, each with its own competition. */
export function requestPeople(draft, day) {
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
  return people
}

/**
 * The register-free / create-order body (create-order adds the total).
 * A group of one with no buyer is sent as Plan 3's `{ categoryId, person }` (final review M-1):
 * the functions read it as a group of one with the same answers, and the functions still in
 * production while Vercel deploys ahead of `supabase functions deploy` read nothing else.
 */
export function toRequest(draft, { consents, code, today, extrasOf } = {}) {
  const people = requestPeople(draft, dayOf(today))
  // Plan 7: each person's code and extras (qty above 0 only), in the same order as people[].
  draft.cards.filter((_, i) => !(i === 0 && draft.notRunning)).forEach((c, i) => Object.assign(people[i], cartOfCard(c, extrasOf)))
  const shared = { acceptedConsentIds: draftConsents(draft, consents, today).map((k) => k.id), serviceRegulamin: true }
  const body = people.length === 1 && !draft.notRunning
    ? { categoryId: people[0].categoryId, person: people[0].person, ...cartOfCard(draft.cards[0], extrasOf), ...shared }
    : { people, ...shared }
  if (draft.notRunning) {
    const b = draft.cards[0].person
    body.buyer = { firstName: b.firstName, lastName: b.lastName, email: b.email }
  }
  const c = typeof code === 'string' ? code.trim() : ''
  if (c) body.code = c
  return body
}

/** A card's picks with qty above 0 as [{ variantId, qty }], unfiltered (the page passes its own filter). */
const rawExtras = (c) => Object.values(c.extras ?? {}).filter((e) => e.qty > 0 && e.variantId).map((e) => ({ variantId: e.variantId, qty: e.qty }))

/**
 * A card's cart fields as the request carries them: `voucherCode` and `extras`, each only when there
 * is one. `extrasOf(card)` → [{ variantId, qty }] is the page's filter (cartModel's pickedExtras over
 * what it still offers), so the request orders exactly what RA4 shows (review M-2).
 */
export function cartOfCard(c, extrasOf = rawExtras) {
  const out = {}
  const voucherCode = (c.voucher?.code ?? '').trim()
  if (voucherCode) out.voucherCode = voucherCode
  const extras = (extrasOf ?? rawExtras)(c)
  if (extras.length) out.extras = extras
  return out
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
  const r = validateGroup({ people: requestPeople(draft, dayOf(now)), buyer: body.buyer ?? null }, {
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

/**
 * „Dalej” is on when every consent that applies (draftConsents) and the service regulamin are
 * ticked. A child's guardian box sits on that child's step, where checkDraft sends the person with
 * the reason; a button that is merely off on the list could not say which child it waits for.
 */
export function draftReady(draft, { consents, accepted, serviceAccepted, today }) {
  return consentsComplete(draftConsents(draft, consents, today), accepted, serviceAccepted)
}

/** `at` of the group list step; any other `at` is a card key. */
export const LIST_STEP = 'list'

/**
 * What the form shows. One person on screen at a time (the user, after the Plan 4 screenshots:
 * two people on one page are hard to tell apart). One card is the plain form, with the consents
 * and „Dalej” under it; with more, it is one person's step or the list, which holds the consents.
 * → { kind: 'single' } | { kind: 'person', index } | { kind: 'list' }
 */
export function formStep(draft, at) {
  if (draft.cards.length === 1) return { kind: 'single' }
  const index = draft.cards.findIndex((c) => c.key === at)
  return index >= 0 ? { kind: 'person', index } : { kind: 'list' }
}

/**
 * Where finishing card `key` leads: the next person the server or checkDraft refused; from card 1
 * a person 2 who is still to be filled in („Nie startuję”); otherwise the list.
 */
export function stepAfter(draft, key, errors) {
  const refused = erroredCards(draft, errors).find((k) => k !== key)
  if (refused) return refused
  const next = draft.cards[1]
  return key === draft.cards[0].key && next?.open ? next.key : LIST_STEP
}

const ON_PERSON = new Set(['duplicate', 'email_retired'])
// Plan 7: a cart refusal about one person's code or extras lands on that field of their card.
const CART_FIELDS = new Set(['voucherCode', 'extras'])

/**
 * Where a refusal from register-free, create-order or the code step shows:
 * { step: 'form'|'code', errors: { [cardKey]: { field: message } }, code: message|null, message, focus: cardKey|null }.
 * An `index` names request person `index` (D4-6); without one an address refusal is card 1's.
 * A refusal that lands on a card also gets a form message naming the person, and `focus` is
 * the first such card: on a form of ten people the field itself can be screens away.
 * `full` with a `categoryId` lands on the competition select of every added card in that
 * competition (card 1's competition is the page's own and cannot be changed there).
 */
/**
 * The competitions an added person may pick on the group form: the open ones, in the event page's
 * order, less every team competition. A team signs up only through the team form (D5-12), so a
 * card there could only end in 409 team_competition after the whole form was filled.
 * @param {{ competitions: Array<{ state: string, kind?: string }> }} model eventPageModel's
 */
export function addableCompetitions(model) {
  return model.competitions.filter((c) => c.state === 'open' && c.kind !== 'team')
}

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
  if (err?.status != null && CART_FIELDS.has(err.field) && Number.isInteger(err.index)) {
    put(cardIndexOf(draft, err.index), err.field, err.message)
    return routed(null)
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
  // A full competition, or a team competition (team_competition, D5-12: a team signs up through
  // the team form), lands on the competition select of the added cards in it.
  if (err?.status != null && (err.code === 'full' || err.code === 'team_competition') && err.categoryId) {
    draft.cards.forEach((c, i) => { if (i > 0 && c.categoryId === err.categoryId) put(i, 'competition', err.message) })
    if (Object.keys(errors).length) {
      const names = erroredCards(draft, errors).map((key) => cardName(draft, draft.cards.findIndex((c) => c.key === key)))
      return { step: 'form', errors, code: null, message: `${err.message} Zmień konkurencję: ${names.join(', ')}.`, focus: erroredCards(draft, errors)[0] }
    }
  }
  const f = registrationFailure(err)
  return { step: f.step, errors, code: f.fields.code ?? null, message: f.message, focus: null }
}
