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
// owning club accepted the current organizer agreement.

import { warsawDayAfter } from './dates.js'
import { PAID_REGISTRATION_ENABLED } from './flags.js'

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
  return gaps
}

function regulaminGiven(s) {
  if (s.regulaminKind === 'pdf') return !blank(s.regulaminUploadId)
  if (s.regulaminKind === 'link') return !blank(s.regulaminUrl)
  return false
}

/**
 * @param {{ settings: object, competitions?: object[], officeHours?: object[], hasAgreement: boolean }} event
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
  if (!event?.hasAgreement) block('agreement', 'Akceptacja umowy organizatora')
  if (!PAID_REGISTRATION_ENABLED && (s.pricingMode ?? 'free') !== 'free') block('payments', 'Płatności online — wkrótce')

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
