// When does run-publish move an existing calendar_events row to the date its
// scraper_all row now carries?
//
// Every other field on an existing row is filled only when empty, so before
// this a race the organizer moved kept its old date on the public calendar
// forever, even though a re-scrape is authoritative for its own record
// (incomingWinsOver) and scraper_all had the new date.
//
// The date is also what the fuzzy dedup keys on, so a move is guarded harder
// than a fill:
//   - an admin's date (locked_fields / community_locked_fields) wins;
//   - a rejected or cancelled row is an admin's decision and stays put;
//   - only the record the row was published from (its primary
//     source+source_id, found among the scraper_all row's own record and
//     links) may move it. A link stitched on later by a name+date match is not
//     proof that it is the same race;
//   - two scraper_all rows on one CE row that disagree move nothing, or the
//     row would flip between their dates every run;
//   - never into the past: a source going back in time is a stale edition, not
//     a postponement;
//   - a row whose date has passed is history (results, its public page) and
//     moves only for a postponement, up to POSTPONEMENT_MAX_DAYS after it. A
//     date a year on is the next edition of a source that reuses its ids;
//   - a move onto a date that already holds the same race (the fuzzy match,
//     the row itself excluded) would make two rows of one race, so an admin
//     decides.

export const POSTPONEMENT_MAX_DAYS = 183

/** 'source:source_id' of a row's primary record and of every source link. */
export function rowKeys(row) {
  const keys = []
  if (row?.source && row?.source_id) keys.push(`${row.source}:${row.source_id}`)
  const links = Array.isArray(row?.source_links) ? row.source_links : []
  for (const l of links) {
    if (l?.source && l?.source_id) keys.push(`${l.source}:${l.source_id}`)
  }
  return keys
}

/** Today's date in Warsaw, YYYY-MM-DD. */
export function warsawToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(now)
}

function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000)
}

/**
 * @param {object} p
 * @param {object} p.ce        the calendar_events row
 * @param {object} p.sa        the scraper_all row matched to it
 * @param {string} p.today     YYYY-MM-DD, Warsaw
 * @param {Set<string>} p.saDates  dates of every scraper_all row matched to this CE row
 * @param {(date: string, excludeId: string) => object|null} p.findCollision
 * @returns {null | { move: true, date: string } | { move: false, reason: string, collides_with?: string }}
 */
export function decideDateMove({ ce, sa, today, saDates, findCollision }) {
  const next = sa?.date
  if (!next || next === ce.date) return null

  const locked = [...(ce.locked_fields || []), ...(ce.community_locked_fields || [])]
  if (locked.includes('date')) return { move: false, reason: 'locked' }
  if (ce.status === 'rejected') return { move: false, reason: 'rejected' }
  if (ce.status === 'cancelled') return { move: false, reason: 'cancelled' }

  const primary = ce.source && ce.source_id ? `${ce.source}:${ce.source_id}` : null
  if (!primary || !rowKeys(sa).includes(primary)) return { move: false, reason: 'not_primary_source' }

  if (saDates && saDates.size > 1) return { move: false, reason: 'conflicting_sources' }

  if (next < today) return { move: false, reason: 'moved_to_past' }
  if (ce.date && ce.date < today && daysBetween(ce.date, next) > POSTPONEMENT_MAX_DAYS) {
    return { move: false, reason: 'past_edition' }
  }

  const other = findCollision ? findCollision(next, ce.id) : null
  if (other) return { move: false, reason: 'collides', collides_with: other.id }

  return { move: true, date: next }
}
