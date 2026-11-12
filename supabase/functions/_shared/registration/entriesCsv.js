// The organizer's CSV of entries, for Polish Excel: UTF-8 BOM, `;`, CRLF, every cell quoted.
// Plain ESM: runs in Deno and Node.
import { warsawToday } from './dates.js'
import { formatDpayValue } from './money.js'
import { statusLabel } from './entries.js'
import { missingDetailsText } from './memberDetails.js'

const LIVE = new Set(['confirmed', 'pending_payment'])
const CONSENT = { awaiting: 'czeka na zgodę', office: 'podpisany w biurze' }
// A child waits for a parent who is not the captain, whose paper consent the office records.
const CHILD_CONSENT = { awaiting: 'czeka na zgodę opiekuna', office: 'zgoda opiekuna na papierze' }

const warsawTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Warsaw', hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
})

// A runner types their own name, club and team, so a cell can hold a formula aimed at the
// organizer's spreadsheet. The quote makes Excel read text. Leading spaces are looked past
// because some importers trim them, which would leave the formula standing.
const FORMULA = /^\s*[=+\-@]|^[\t\r]/

// A phone column keeps an international number as typed („+48 600 100 200”): `+`, a digit, then
// digits and spaces only (the ledger ruling), which a spreadsheet reads as a number at most.
// Anything else in it, a `-` or a bracket included, is guarded like every other cell.
const PHONE = /^\+\d[\d ]*$/

function cell(value, { phone = false } = {}) {
  const text = String(value ?? '')
  const safe = FORMULA.test(text) && !(phone && PHONE.test(text)) ? `'${text}` : text
  return `"${safe.replaceAll('"', '""')}"`
}

const zloty = (grosze) => (grosze == null ? '' : formatDpayValue(grosze).replace('.', ','))

function consentText(row) {
  if (!LIVE.has(row.status)) return ''
  if (row.role === 'minor') return CHILD_CONSENT[row.consentState] ?? 'opiekun'
  return CONSENT[row.consentState] ?? 'zaakceptowany'
}

function signedUp(instant) {
  if (!instant) return ''
  const date = new Date(instant)
  return `${warsawToday(date)} ${warsawTime.format(date)}`
}

const COLUMNS = [
  ['Nr', (r) => r.bib],
  ['Imię', (r) => r.firstName],
  ['Nazwisko', (r) => r.lastName],
  ['Data urodzenia', (r) => r.birthDate],
  ['Płeć', (r) => r.gender],
  ['Kategoria', (r) => r.ageGroupLabel],
  ['Konkurencja', (r) => r.competition],
  ['Drużyna', (r) => r.team?.name],
  ['Klub', (r) => r.club],
  ['Miejscowość', (r) => r.city],
  ['Narodowość', (r) => r.nationality],
  ['E-mail', (r) => r.email],
  ['Telefon', (r) => r.phone, { phone: true }],
  ['Kontakt ICE', (r) => r.iceName],
  ['Telefon ICE', (r) => r.icePhone, { phone: true }],
  ['Opiekun', (r) => r.guardianName],
  ['E-mail opiekuna', (r) => r.guardianEmail],
  ['Status', (r) => statusLabel(r.statusKey, r)],
  ['Wpłata (zł)', (r) => zloty(r.paidAmount)],
  // `refunded` holds unconfirmed reservations too; this column states money that left.
  // Clamped: inconsistent data must not throw in formatDpayValue and fail the whole export.
  ['Zwrócono (zł)', (r) => zloty(Math.max(0, (r.refunded ?? 0) - (r.refundUnconfirmed ?? 0)))],
  ['Regulamin', consentText],
  ['Partner', (r) => r.partnerName],
  ['Kod rabatowy', (r) => r.voucherCode],
  ['Data zapisu', (r) => signedUp(r.createdAt)],
  // New columns go at the end, so a sheet built on the earlier columns keeps its places.
  ['Brak danych', (r) => missingDetailsText(r.missingFields)],
  // „Opłacone poza systemem”: the club's own note on the order (the Status column says POZA SYSTEMEM).
  // Defused like every cell: the club's staff type it.
  ['Notatka o wpłacie', (r) => r.offlineNote],
]

function toCsv(columns, rows) {
  const header = columns.map(([title]) => cell(title)).join(';')
  const line = (row) => columns.map(([, read, options]) => cell(read(row), options)).join(';')
  return `\uFEFF${[header, ...rows.map(line)].join('\r\n')}`
}

/** @param {object[]} rows the panel's rows (list-event-registrations), plus `guardianEmail` */
export function entriesToCsv(rows) {
  return toCsv(COLUMNS, rows)
}

// The organizer's codes (organizer-vouchers `export`), on the same escaping: a partner name or a
// note is typed by the organizer's own staff, and still reaches a spreadsheet.
const VOUCHER_COLUMNS = [
  ['Kod', (v) => v.code],
  ['Rabat', (v) => `${v.percent}%`],
  ['Wykorzystano', (v) => v.used],
  ['Limit', (v) => v.maxUses],
  ['Ważny do', (v) => v.validUntil],
  ['Partner', (v) => v.partner?.name],
  ['Notatka', (v) => v.note],
]

/** @param {{ code, percent, used, maxUses, validUntil, partner, note }[]} vouchers organizer-vouchers' `list` */
export function vouchersToCsv(vouchers) {
  return toCsv(VOUCHER_COLUMNS, vouchers)
}
