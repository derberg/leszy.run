// „Dodaj do kalendarza” on RA5: one VEVENT as an .ics file (RFC 5545). The
// start is the competition's Warsaw start time written in UTC, so every
// calendar shows it right; without a start time it is an all-day entry.
import { warsawDayStart } from '../../../supabase/functions/_shared/registration/dates.js'

const DURATION_MS = 2 * 3600 * 1000

const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
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
    // Midnight is never the DST switch in Warsaw, and no race starts at 2–3 am.
    const start = new Date(warsawDayStart(eventDate).getTime() + (h * 60 + min) * 60_000)
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
