// Merge safety for distances mined out of a regulamin (run-enrich-from-regulamin.js).
//
// The regulamin is authoritative about the race it describes, so its distances
// normally replace whatever the scraper read off the listing. The exception is a
// document that only SUBTRACTS: that is the signature of a stale edition, not a
// correction.
//
// zapisyonline hosts one regulamin per edition of a recurring series, and an older
// upload predates races the organizer has since added. Kosakowo Biega 2026-10-03
// was scraped as "2 km, 5 km, 500 m"; an edition-741 regulamin listing only
// "Dystans biegu: 5 km" cut the public calendar entry down to "5 km" and lost both
// kids races. The same race's OWN regulamin describes only the 5 km as well. The
// organizer keeps the kids distances on the registration page and out of the rules.

// Split a distances string into a comparable set of tokens ("2 km, 5 km, 500 m").
function distanceSet(str) {
  if (!str) return new Set()
  return new Set(str.split(',').map(d => d.trim().toLowerCase()).filter(Boolean))
}

// True when the regulamin's set removes distances the scraper found and adds none.
// A regulamin that adds or changes anything is treated as a real update and wins.
function dropsDistances(scraperStr, regulaminStr) {
  const before = distanceSet(scraperStr)
  const after = distanceSet(regulaminStr)
  if (before.size === 0 || after.size === 0) return false
  for (const d of after) if (!before.has(d)) return false
  return after.size < before.size
}

export { distanceSet, dropsDistances }

// --- Distance normalization ---
//
// scraper_all.distances is a single comma-separated string, e.g. "1 km, 500m, 0.2 km".
// Canonical format (one agreed setup so the DB is consistent):
//   - distance < 1000 m  → metres, e.g. "200 m"
//   - distance >= 1000 m → kilometres, e.g. "5 km", "21.1 km"
//   - always a SPACE between number and unit
//   - dot for decimals
// Time-based ("6h"), word-based ("Maraton", "Półmaraton") and bare unitless numbers
// are left untouched (can't be safely converted). Duplicates are collapsed, order kept.

function formatMeters(meters) {
  if (!Number.isFinite(meters) || meters <= 0) return null
  if (meters < 1000) return `${Math.round(meters)} m`
  const km = parseFloat((meters / 1000).toFixed(3)) // strip float noise, max 3 decimals
  return `${km} km`
}

function normalizeDistanceToken(token) {
  // Drop a course-certification note first. Without this "5 km (ATEST PZLA)"
  // matches none of the patterns below and falls through to the DB verbatim.
  const t = stripCourseCertification(token.trim())
  if (!t) return null
  const lower = t.toLowerCase()

  // time-based: "6h", "12 h" → "6h"
  const time = lower.match(/^(\d{1,3})\s*h$/)
  if (time) return `${time[1]}h`

  // number + km / kilometr
  let m = lower.match(/^(\d+(?:[.,]\d+)?)\s*(?:km|kilometr\w*)$/)
  if (m) return formatMeters(parseFloat(m[1].replace(',', '.')) * 1000) || t

  // number + m / metr (but NOT km — handled above)
  m = lower.match(/^(\d+(?:[.,]\d+)?)\s*(?:m|metr\w*)$/)
  if (m) return formatMeters(parseFloat(m[1].replace(',', '.'))) || t

  // words ("maraton"), bare numbers, anything else → leave untouched
  return t
}

function normalizeDistances(raw) {
  if (!raw || typeof raw !== 'string') return raw
  // The data uses commas as BOTH decimal separators ("42,2 km") and token
  // separators ("5 km, 10 km"), plus ";" and "+" as alternative token separators.
  // Convert decimal-commas to dots first so the comma is unambiguously a separator,
  // then split on , ; +. Output always re-joins with ", ".
  const dotted = raw.replace(/(\d),(\d)/g, '$1.$2')
  const out = []
  const seen = new Set()
  for (const tok of dotted.split(/[,;+]/)) {
    const norm = normalizeDistanceToken(tok)
    if (!norm) continue
    const key = norm.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(norm)
  }
  return out.join(', ')
}

// A PZLA atest (or an AIMS certificate) says the COURSE was measured. It is a
// property of the route, not part of the distance, but it arrives glued to one:
// zmierzymyczas publishes "5 km (ATEST PZLA)" in its distance column and that
// string reached calendar_events verbatim, so users were shown "(ATEST PZLA)" as
// the distance of VI Szybka Piatka Jurka Siemaszki.
//
// Stripping every parenthetical would be wrong. Measured in scraper_all the same
// day: "4 x 100 m (400m)" gives a relay's total, "petla 16 km (12h)" is a
// 12-hour race, "6 km (nordic walking)" names the discipline, "do 35 km (RAJD)"
// separates a rally from a race. Only a parenthetical that is NOTHING BUT a
// certification marker is dropped.
const COURSE_CERTIFICATION = /\s*\((?:\s*(?:atest|certyfikat|pomiar)\w*)?(?:\s*(?:pzla|aims|iaaf|world\s+athletics))?(?:\s*(?:nr\.?\s*)?[\w/-]{0,12})?\s*\)\s*$/i

function stripCourseCertification(token) {
  if (!token || typeof token !== 'string') return token
  const stripped = token.replace(COURSE_CERTIFICATION, (m) => {
    const inner = m.trim().slice(1, -1).trim().toLowerCase()
    // Require a certification word. Without one the parenthetical carries content.
    return /(atest|certyfikat|pzla|aims|iaaf|world\s+athletics)/.test(inner) ? '' : m
  })
  return stripped.trim() || token
}

export { normalizeDistances, normalizeDistanceToken, stripCourseCertification }

