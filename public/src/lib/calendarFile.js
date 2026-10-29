// „Dodaj do kalendarza” on RA5: one VEVENT as an .ics file (RFC 5545; text
// values escape \\, ; and , and line breaks). The
// start is the competition's Warsaw start time written in UTC, so every
// calendar shows it right; without a start time it is an all-day entry.
// Warsaw wall time → instant: try UTC+2 and UTC+1 and keep the one whose
// Warsaw reading is that wall time (the pattern of warsawDayStart in
// _shared/registration/dates.js, applied at the start instant itself, so the
// clock-change Sundays come out right).
const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Warsaw', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
})
function warsawInstant(isoDate, h, min) {
  const [y, m, d] = isoDate.split('-').map(Number)
  const want = `${isoDate} ${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
  for (const offsetH of [2, 1]) {
    const cand = new Date(Date.UTC(y, m - 1, d, h, min) - offsetH * 3600 * 1000)
    const p = Object.fromEntries(fmt.formatToParts(cand).map(({ type, value }) => [type, value]))
    if (`${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}` === want) return cand
  }
  // 02:00–02:59 on the March Sunday does not exist; read it as UTC+1.
  return new Date(Date.UTC(y, m - 1, d, h, min) - 3600 * 1000)
}

const DURATION_MS = 2 * 3600 * 1000

const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
const utc = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
const day = (iso) => iso.replace(/-/g, '')

function nextDay(iso) {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10)
}

/** → the .ics text (CRLF line ends). */
export function icsFor({ uid, title, eventDate, startTime, location, url, now = new Date() }) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//LESZY.RUN//zapisy//PL', 'CALSCALE:GREGORIAN', 'BEGIN:VEVENT',
    `UID:${uid}@leszy.run`, `DTSTAMP:${utc(now)}`]
  if (startTime) {
    const [h, min] = startTime.split(':').map(Number)
    const start = warsawInstant(eventDate, h, min)
    lines.push(`DTSTART:${utc(start)}`, `DTEND:${utc(new Date(start.getTime() + DURATION_MS))}`)
  } else {
    lines.push(`DTSTART;VALUE=DATE:${day(eventDate)}`, `DTEND;VALUE=DATE:${day(nextDay(eventDate))}`)
  }
  lines.push(`SUMMARY:${esc(title)}`)
  if (location) lines.push(`LOCATION:${esc(location)}`)
  if (url) lines.push(`URL:${url}`)
  lines.push('END:VEVENT', 'END:VCALENDAR', '')
  return lines.join('\r\n')
}
