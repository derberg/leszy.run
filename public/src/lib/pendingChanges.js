// Text for a published event's staged changes (A8, A8a): the values in the
// before → after rows, the bar's summary, whom a notice reaches, its
// suggested subject and body, and the line after „Opublikuj zmiany”.
// The diff rows are publish-registration-event's (changeDiff): snake_case
// fields, values as the database spells them.
import { noticeRows } from '../../../supabase/functions/_shared/registration/changeDiff.js'
import { countLabel } from './categoryRows.js'

const PEOPLE = ['osoba', 'osoby', 'osób']
// „Powiadomiono 34 osoby”, „nie udało się wysłać do 4 osób”.
const PEOPLE_ACC = ['osobę', 'osoby', 'osób']
const PEOPLE_GEN = ['osoby', 'osób', 'osób']

const warsawDate = new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', day: 'numeric', month: 'numeric', year: 'numeric' })
const warsawDay = new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', day: 'numeric', month: 'numeric' })

const CHOICES = {
  discipline: { run: 'bieg', nw: 'nordic walking' },
  pricing_mode: { free: 'bezpłatne', fixed: 'stała', tiered: 'rośnie z datą zapisu' },
  age_reckoning: { race_day: 'w dniu zawodów', year_end: 'rocznikiem' },
  kind: { individual: 'indywidualna', team: 'drużyna' },
  regulamin_kind: { pdf: 'PDF', link: 'link' },
}
const FORM_FIELDS = { phone: 'telefon', city: 'miejscowość', club: 'klub', ice: 'kontakt ICE' }
const FORM_MODES = { required: 'wymagane', optional: 'opcjonalne', off: 'brak' }

/** 'YYYY-MM-DD' → '6.12.2026' (no time zone shift: it is a calendar day). */
function day(iso, withYear = true) {
  const [y, m, d] = iso.split('-')
  return withYear ? `${Number(d)}.${m}.${y}` : `${Number(d)}.${m}`
}

function listItem(item) {
  if (typeof item !== 'object' || item === null) return String(item)
  if (item.date) return `${day(item.date, false)} ${item.from}–${item.to}`
  return item.label ?? item.text ?? JSON.stringify(item)
}

/** One side of a diff row, as the dialog shows it. */
export function changeValue({ field }, v) {
  const key = field.split('.').pop()
  if (v === null || v === undefined || v === '') return '—'
  if (Array.isArray(v)) return v.length ? v.map(listItem).join(', ') : '—'
  if (key === 'form_fields' && typeof v === 'object') {
    return Object.entries(v).map(([k, m]) => `${FORM_FIELDS[k] ?? k}: ${FORM_MODES[m] ?? m}`).join(', ')
  }
  if (typeof v === 'boolean') return v ? 'tak' : 'nie'
  if (key === 'price') return `${(v / 100).toLocaleString('pl-PL')} zł`
  if (key.endsWith('_upload_id')) return 'plik'
  if (CHOICES[key]?.[v]) return CHOICES[key][v]
  if (key === 'event_date') return day(v)
  // closes_at is the start of the day after the last day of registration.
  if (key === 'opens_at') return warsawDate.format(new Date(v))
  if (key === 'closes_at') return warsawDate.format(new Date(Date.parse(v) - 1))
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

/** The bar's list of what is staged. */
export const changesSummary = (diff) => diff.map((d) => d.label).join(', ')

/** Whom the notice goes to: the event, or the competitions concerned. */
export function noticeTarget(affected, competitions, eventName) {
  if (affected.all) return eventName
  const names = new Map(competitions.map((c) => [c.categoryId, c.name]))
  return affected.categoryIds.map((id) => names.get(id)).filter(Boolean).join(', ')
}

export const peopleLabel = (n) => countLabel(n, PEOPLE)

/** The suggested e-mail: the event's name and the rows that concern runners. */
export function defaultNotice(eventName, diff) {
  const lines = noticeRows(diff).map((d) => `- ${d.label}: ${changeValue(d, d.before)} → ${changeValue(d, d.after)}`)
  return {
    subject: `${eventName}: zmiany`,
    body: `Cześć,\n\nzmieniamy:\n${lines.join('\n')}\n\nPozostałe informacje bez zmian.`,
  }
}

/**
 * The line after „Opublikuj zmiany”, from the response's notice
 * ({ sent, recipientCount, failed }). `requested`: the box was ticked.
 */
export function noticeResult(notice, requested = false) {
  const out = ['Opublikowano zmiany.']
  if (notice?.sent) {
    out.push(`Powiadomiono ${countLabel(notice.recipientCount, PEOPLE_ACC)}.`)
    if (notice.failed > 0) out.push(`Nie udało się wysłać do ${countLabel(notice.failed, PEOPLE_GEN)}.`)
  } else if (requested) {
    out.push('Powiadomienia nie wysłano.')
  }
  return out.join(' ')
}

/** „1 / 70 zapisanych”: the limit counts visible competitions only. */
export function registeredLine(registered, competitions) {
  const limit = competitions.filter((c) => !c.hiddenAt).reduce((sum, c) => sum + (c.capacity ?? 0), 0)
  return `${registered} / ${limit} zapisanych`
}

/** The last day of registration ('YYYY-MM-DD') → „3.12”. */
export const closesLabel = (closesOn) => (closesOn ? warsawDay.format(new Date(`${closesOn}T12:00:00Z`)) : null)
