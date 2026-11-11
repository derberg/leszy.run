// Which year a regulamin file is for, and whether that is older than the event.
// Used by run-data-audit.js to flag a regulamin_url left over from a previous edition.
//
// Two shapes used to raise false alarms (daily audit, 2026-11-10):
// - a season that spans two years, in the file name ("Dwumaraton-2026-27") or in the
//   event name ("Trail!ON Stawiguda 2026/2027 #3", "PROTOUR CYCLOCROSS CUP SEZON 2026/27")
//   while the file only says 2026: a January 2027 race of that season is not stale;
// - a year inside a longer run of digits, which is an upload timestamp or a version
//   ("888reg20261105t203443.pdf" from bgtimesport, "REGULAMIN_ZADEK_v222012026.pdf",
//   read as 2012), not the edition.

const YEAR = /(?<![0-9])(20[12][0-9])(?![0-9])/g
const SEASON = /(?<![0-9])(20[12][0-9])\s*[-/_]\s*(20[12][0-9]|[0-9]{2})(?![0-9])/g

function seasonEndYears(text) {
  const out = []
  for (const m of String(text || '').matchAll(SEASON)) {
    const start = Number(m[1])
    const end = m[2].length === 2 ? Math.floor(start / 100) * 100 + Number(m[2]) : Number(m[2])
    if (end === start + 1) out.push(end)
  }
  return out
}

export function regulaminFileName(url) {
  if (!url) return ''
  const last = String(url).split(/[?#]/)[0].split('/').filter(Boolean).pop() || ''
  try {
    return decodeURIComponent(last)
  } catch {
    return last
  }
}

// The latest edition year the file name names: a standalone year, or the end year of a
// two-year season. Null when it names none.
export function regulaminYear(url) {
  const name = regulaminFileName(url)
  const years = [...name.matchAll(YEAR)].map((m) => Number(m[1])).concat(seasonEndYears(name))
  return years.length ? Math.max(...years) : null
}

// True when the file names an edition year before the event's year, and the event's own
// name does not put that year into a season ending in the event's year.
export function isStaleRegulaminYear({ url, eventDate, eventName }) {
  const docYear = regulaminYear(url)
  if (!docYear || !eventDate) return false
  const eventYear = Number(String(eventDate).slice(0, 4))
  if (docYear >= eventYear) return false
  return !seasonEndYears(eventName).some((end) => end >= eventYear && end - 1 <= docYear)
}
