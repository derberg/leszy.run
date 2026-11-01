// The organizer's CSV of entries, for Polish Excel: UTF-8 BOM, `;`, CRLF, every cell quoted.
// Plain ESM: runs in Deno and Node.
import { warsawToday } from './dates.js'
import { formatDpayValue } from './money.js'
import { statusLabel } from './entries.js'

const LIVE = new Set(['confirmed', 'pending_payment'])
const CONSENT = { awaiting: 'czeka na zgodę', office: 'podpisany w biurze' }

const warsawTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Warsaw', hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
})

// A runner types their own name, club and team, so a cell can hold a formula aimed at the
// organizer's spreadsheet. The quote makes Excel read text. Leading spaces are looked past
// because some importers trim them, which would leave the formula standing.
const FORMULA = /^\s*[=+\-@]|^[\t\r]/

function cell(value) {
  const text = String(value ?? '')
  const safe = FORMULA.test(text) ? `'${text}` : text
  return `"${safe.replaceAll('"', '""')}"`
}

const zloty = (grosze) => (grosze == null ? '' : formatDpayValue(grosze).replace('.', ','))

function consentText(row) {
  if (!LIVE.has(row.status)) return ''
  return CONSENT[row.consentState] ?? (row.role === 'minor' ? 'opiekun' : 'zaakceptowany')
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
  ['Telefon', (r) => r.phone],
  ['Kontakt ICE', (r) => r.iceName],
  ['Telefon ICE', (r) => r.icePhone],
  ['Opiekun', (r) => r.guardianName],
  ['E-mail opiekuna', (r) => r.guardianEmail],
  ['Status', (r) => statusLabel(r.statusKey, r)],
  ['Wpłata (zł)', (r) => zloty(r.paidAmount)],
  // `refunded` holds unconfirmed reservations too; this column states money that left.
  ['Zwrócono (zł)', (r) => zloty((r.refunded ?? 0) - (r.refundUnconfirmed ?? 0))],
  ['Regulamin', consentText],
  ['Partner', (r) => r.partnerName],
  ['Data zapisu', (r) => signedUp(r.createdAt)],
]

/** @param {object[]} rows the panel's rows (list-event-registrations), plus `guardianEmail` */
export function entriesToCsv(rows) {
  const line = (cells) => cells.map(cell).join(';')
  const header = line(COLUMNS.map(([title]) => title))
  return `﻿${[header, ...rows.map((row) => line(COLUMNS.map(([, read]) => read(row))))].join('\r\n')}`
}
