// Europe/Warsaw calendar days. Registration windows are whole Warsaw days stored as timestamptz.
// Plain ESM, no runtime APIs beyond Intl: runs in Deno and Node.

const TZ = 'Europe/Warsaw'
const DAY_MS = 24 * 3600 * 1000

const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
})

function warsawParts(date) {
  const p = {}
  for (const { type, value } of fmt.formatToParts(date)) p[type] = value
  return p
}

/** Warsaw calendar date (YYYY-MM-DD) of an instant. */
export function warsawToday(now = new Date()) {
  const p = warsawParts(now)
  return `${p.year}-${p.month}-${p.day}`
}

function parseIsoDate(isoDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate ?? '')
  if (!m) throw new Error(`Invalid date: ${isoDate}`)
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** The instant a Warsaw day begins (00:00 local). */
export function warsawDayStart(isoDate) {
  const [y, mo, d] = parseIsoDate(isoDate)
  const utcMidnight = Date.UTC(y, mo - 1, d)
  // Warsaw is UTC+1 or UTC+2; midnight local is one of two candidates. Midnight is never skipped by DST here.
  for (const offsetH of [2, 1]) {
    const cand = new Date(utcMidnight - offsetH * 3600 * 1000)
    const p = warsawParts(cand)
    if (p.day === String(d).padStart(2, '0') && p.hour === '00' && p.minute === '00') return cand
  }
  throw new Error(`Cannot resolve Warsaw day start for ${isoDate}`)
}

/** The instant the day after `isoDate` begins in Warsaw (exclusive end of that day). */
export function warsawDayAfter(isoDate) {
  const [y, mo, d] = parseIsoDate(isoDate)
  const next = new Date(Date.UTC(y, mo - 1, d) + DAY_MS)
  return warsawDayStart(next.toISOString().slice(0, 10))
}

/** `Zapisy online od` / `do` as whole Warsaw days: opens at the start of opensOn, closes (exclusive) after closesOn. */
export function registrationWindow({ opensOn, closesOn }) {
  return { opensAt: warsawDayStart(opensOn), closesAt: warsawDayAfter(closesOn) }
}

/** 'not_yet' before opensAt, 'open' while opensAt <= now < closesAt, else 'closed'. */
export function isOpen({ opensAt, closesAt }, now = new Date()) {
  const t = now.getTime()
  if (t < new Date(opensAt).getTime()) return 'not_yet'
  if (t >= new Date(closesAt).getTime()) return 'closed'
  return 'open'
}

/** Warsaw calendar days from today to the last open day (`Zapisy online do`): 0 on that day, and 0 once closed. */
export function daysLeft(closesAt, now = new Date()) {
  const lastDay = warsawToday(new Date(new Date(closesAt).getTime() - 1))
  const today = warsawToday(now)
  const diff = Math.round((Date.parse(lastDay) - Date.parse(today)) / DAY_MS)
  return Math.max(0, diff)
}
