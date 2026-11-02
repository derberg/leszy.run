// The publish checklist (Publikacja step, A7). Plain ESM, no runtime APIs:
// runs in Deno (get-registration-event, publish-registration-event) and in the
// browser.
//
// publishChecklist(event) → { blocking, missing }
// * blocking: what must be filled before publish; publish answers 409 while
//   any is left. Hidden competitions do not count.
// * missing: worth adding, never stops publish; `step` names the wizard step
//   that holds it.
//
// `event` is the shape get-registration-event returns ({ settings,
// competitions, officeHours }, camelCase) plus `hasAgreement`: whether the
// owning club accepted the current organizer agreement, and `payout`:
// { mode: 'club'|'custom', ready } from eventPayout.js (never the account
// itself). A paid event with no `payout` given is not ready. `extras` (optional) lists the
// event's extras, each with its `price` in grosze and `orderUntil` (or `order_until`), and
// `tiers` (optional) the price tiers in the grid's order, each `endsOn` (or `ends_on`).
//
// takesMoney(event): whether the event collects money at all (D7-22): a pricing mode other than
// free, a priced extra, or donations on (a charity event with „Pozwól dopłacić darowiznę”,
// ruling 7). Such an event needs a payout account and is held by PAID_REGISTRATION_ENABLED.

import { warsawDayAfter, warsawToday } from './dates.js'
import { PAID_REGISTRATION_ENABLED } from './flags.js'
import { validateTiers } from './pricing.js'

// Raised by publish_registration_event when an ordinary events row took the
// slug after the draft reserved it. Not computable from the draft alone.
export const SLUG_TAKEN_ITEM = { key: 'slug_taken', label: 'Adres zawodów jest zajęty' }

const blank = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '')

function competitionGaps(c) {
  const gaps = []
  if (blank(c.name)) gaps.push('nazwa')
  if (blank(c.distanceLabel)) gaps.push('dystans')
  if (blank(c.startTime)) gaps.push('godzina startu')
  if (!Number.isInteger(c.capacity) || c.capacity < 1) gaps.push('limit miejsc')
  if (c.kind === 'team' && !(Number.isInteger(c.teamMin) && Number.isInteger(c.teamMax))) gaps.push('skład drużyny')
  return gaps
}

function regulaminGiven(s) {
  if (s.regulaminKind === 'pdf') return !blank(s.regulaminUploadId)
  if (s.regulaminKind === 'link') return !blank(s.regulaminUrl)
  return false
}

/**
 * What makes the event take money, the first that applies: 'pricing', 'extras', 'donations', or
 * null. The 409 and the checklist name it, so an organizer whose free event is held by donations
 * knows which switch it is (M-2).
 * @param {{ settings?: object, extras?: { price: number }[] }} event
 */
export function moneyReason(event) {
  const s = event?.settings ?? {}
  if ((s.pricingMode ?? 'free') !== 'free') return 'pricing'
  // Extras and donations take money only while Plan 7's money features are live (flags.js
  // moneyFeaturesLive, passed as event.moneyLive by the edge functions; absent means live). Off, a
  // free charity event is the free event it was before Plan 7 (final review I-1).
  if (event?.moneyLive === false) return null
  if ((event?.extras ?? []).some((x) => Number(x?.price) > 0)) return 'extras'
  if (s.isCharity === true && s.donationsEnabled === true) return 'donations'
  return null
}

/** @param {{ settings?: object, extras?: { price: number }[] }} event */
export function takesMoney(event) {
  return moneyReason(event) !== null
}

/**
 * Why an event that takes money cannot be published yet, by moneyReason. The checklist item's label;
 * publish-registration-event's 409 is paymentsRefusal() of the same text (M-2: one wording).
 */
export const PAYMENTS_SOON = {
  pricing: 'Płatności online — wkrótce',
  extras: 'Płatne dodatki to płatności online — wkrótce',
  donations: 'Darowizny przy zapisie to płatności online — wkrótce. Wyłącz „Pozwól dopłacić darowiznę” w Podstawach',
}

/** The 409 text for a publish held by `reason`: „Nie można opublikować: <the checklist label>.” */
export function paymentsRefusal(reason) {
  const label = PAYMENTS_SOON[reason]
  return `Nie można opublikować: ${label.charAt(0).toLowerCase()}${label.slice(1)}.`
}

/** '2026-12-06' → '2026-12-05' */
function dayBefore(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10)
}

// Rules that tie a later step to the race date or the window, judged on the event as it is (or
// will be, for staged changes): a section save only sees its own patch, and Podstawy can move the
// race or the window afterwards (I-1, M-4).
function datedItems(event, s, block) {
  if (s.transferEnabled === true) {
    if (blank(s.transferUntil)) block('transfer_until', 'Przekazanie pakietu: podaj, do kiedy')
    else if (!blank(s.eventDate) && s.transferUntil > dayBefore(s.eventDate)) {
      block('transfer_until', 'Przekazanie pakietu: najpóźniej dzień przed zawodami')
    }
  }
  if (!blank(s.eventDate) && (event?.extras ?? []).some((x) => (x?.orderUntil ?? x?.order_until ?? '') > s.eventDate)) {
    block('extras_order_until', 'Dodatki: zamówienia najpóźniej w dniu zawodów')
  }
  if (s.pricingMode === 'tiered') {
    const at = (iso, shift) => (blank(iso) ? undefined : warsawToday(new Date(Date.parse(iso) + shift)))
    const tiers = (event?.tiers ?? []).map((t) => ({ endsOn: t?.endsOn ?? t?.ends_on ?? null }))
    const checked = validateTiers(tiers, { opensOn: at(s.opensAt, 0), closesOn: at(s.closesAt, -1) })
    if (!checked.ok) block('tiers', `Progi cenowe: ${checked.errors.tiers}`)
  }
}

/**
 * @param {{ settings: object, competitions?: object[], officeHours?: object[], extras?: object[], hasAgreement: boolean, payout?: { mode: string, ready: boolean } }} event
 * @returns {{ blocking: { key: string, label: string }[], missing: { key: string, label: string, step: string }[] }}
 */
export function publishChecklist(event) {
  const s = event?.settings ?? {}
  const competitions = (event?.competitions ?? []).filter((c) => !c.hiddenAt)
  const blocking = []
  const missing = []
  const block = (key, label) => blocking.push({ key, label })

  if (blank(s.name)) block('name', 'Nazwa wydarzenia')
  if (blank(s.slug)) block('slug', 'Adres strony zawodów')
  if (blank(s.eventDate)) block('event_date', 'Data zawodów')
  if (blank(s.opensAt) || blank(s.closesAt)) {
    block('registration_dates', 'Daty zapisów online')
  } else if (!blank(s.eventDate) && new Date(s.closesAt).getTime() > warsawDayAfter(s.eventDate).getTime()) {
    block('registration_dates', 'Zapisy online muszą się skończyć najpóźniej w dniu zawodów')
  }
  if (blank(s.townLabel) || s.lat == null || s.lng == null) block('place', 'Miejscowość i pinezka na mapie')

  if (!competitions.length) block('competitions', 'Co najmniej jedna konkurencja')
  for (const c of competitions) {
    const gaps = competitionGaps(c)
    if (gaps.length) block(`competition:${c.categoryId}`, `Konkurencja „${blank(c.name) ? 'bez nazwy' : c.name.trim()}”: ${gaps.join(', ')}`)
  }

  if (!regulaminGiven(s)) block('regulamin', 'Regulamin (PDF albo link)')
  if (blank(s.contactEmail)) block('contact_email', 'Adres kontaktowy organizatora')
  if (!event?.hasAgreement) block('agreement', 'Akceptacja umowy organizatora')
  datedItems(event, s, block)
  const reason = moneyReason(event)
  const paid = reason !== null
  if (!PAID_REGISTRATION_ENABLED && paid) block('payments', PAYMENTS_SOON[reason])
  if (paid && !event?.payout?.ready) {
    const custom = event?.payout?.mode === 'custom' && event.payout.clubReady !== false
    block('payout', custom ? 'Dane do wypłat tego wydarzenia' : 'Uzupełnij dane do wypłat w ustawieniach klubu')
  }

  if (!(event?.officeHours ?? []).length) {
    missing.push({ key: 'office_hours', label: 'Godziny otwarcia biura zawodów', step: 'biuro' })
  }
  for (const c of competitions) {
    if (blank(c.gpxUploadId)) {
      missing.push({ key: `gpx:${c.categoryId}`, label: `Ślad GPX: ${blank(c.name) ? 'bez nazwy' : c.name.trim()}`, step: 'konkurencje' })
    }
  }
  if (blank(s.posterUploadId)) missing.push({ key: 'poster', label: 'Plakat', step: 'podstawy' })
  if (!competitions.some((c) => c.isKids)) missing.push({ key: 'kids', label: 'Dystanse dzieci', step: 'konkurencje' })

  return { blocking, missing }
}

/** „Uzupełnij: a, b, c” — the 409 message for a refused publish. */
export function blockingMessage(blocking) {
  return `Uzupełnij: ${blocking.map((b) => b.label).join(', ')}`
}
