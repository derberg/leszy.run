import { plausibleDeadline } from './registrationDeadline.js'

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

function lockedOn(ce, field) {
  return [...(ce.locked_fields || []), ...(ce.community_locked_fields || [])].includes(field)
}

/**
 * The registration deadline of a row that moves. The old deadline belongs to
 * the old date (Kluki moved from 2026-09-27 to 2026-11-08 and kept 2026-09-20,
 * which the public page shows and the deadline_soon notice reads), so it
 * follows the source: the scraper_all row's deadline when it is plausible
 * for the new date (registrationDeadline.js: on it or up to 120 days before),
 * otherwise none. A blank is honest; a stale deadline
 * tells runners sign-up closed when it may be open. An admin's deadline
 * (locked_fields / community_locked_fields) stays.
 * @returns {null | { write: true, value: string|null } | { write: false, reason: 'locked' }}
 */
export function deadlineAfterMove(ce, sa, newDate) {
  const fromSource = sa?.registration_deadline || null
  const value = plausibleDeadline(fromSource, newDate)
  if ((ce.registration_deadline || null) === value) return null
  if (lockedOn(ce, 'registration_deadline')) return { write: false, reason: 'locked' }
  return { write: true, value }
}

/**
 * Dates of every scraper_all row that resolves to each CE row, matched as the
 * publish loop matches (first source key found, rejected rows left out). Two
 * rows that disagree move nothing ('conflicting_sources').
 * @returns {Map<string, Set<string>>} ce id → dates
 */
export function collectSaDates(saRows, existingByLink, rejectedKeys) {
  const byCe = new Map()
  for (const raw of saRows) {
    const keys = rowKeys(raw)
    if (keys.some(k => rejectedKeys.has(k))) continue
    const found = keys.map(k => existingByLink.get(k)).find(Boolean)
    if (!found?.id || !raw.date) continue
    const set = byCe.get(found.id) || new Set()
    set.add(raw.date)
    byCe.set(found.id, set)
  }
  return byCe
}

/**
 * Re-file a moved CE row under its new date in the fuzzy pool (Map date →
 * rows), so the rest of the run compares later rows with where it is now.
 * A no-op when the row is not under the old date.
 */
export function refileByDate(pool, ceId, oldDate, newDate) {
  const old = pool.get(oldDate)
  const entry = old?.find(r => r.id === ceId)
  if (!entry) return false
  pool.set(oldDate, old.filter(r => r !== entry))
  const group = pool.get(newDate) || []
  group.push({ ...entry, date: newDate })
  pool.set(newDate, group)
  return true
}

/**
 * Apply one decision to the update being built for a CE row: the date and
 * deadline writes or skips, and one report line per CE row and new date, how
 * ever many scraper_all rows lead to the same decision.
 * @param {object} p
 * @param {object} p.ce, p.sa
 * @param {ReturnType<typeof decideDateMove>} p.decision
 * @param {object} p.upd        the update row (mutated)
 * @param {object[]} p.skipped  per-field skips (mutated)
 * @param {object[]} p.log      the date-move report (mutated)
 */
export function applyDateMove({ ce, sa, decision, upd, skipped, log }) {
  if (!decision) return
  let deadline = null
  if (decision.move) {
    upd.date = decision.date
    deadline = deadlineAfterMove(ce, sa, decision.date)
    if (deadline?.write) {
      upd.registration_deadline = deadline.value
    } else if (deadline && !deadline.write) {
      skipped.push({ field: 'registration_deadline', reason: `date_move_${deadline.reason}`, ce_value: ce.registration_deadline ?? null, sa_value: sa.registration_deadline ?? null })
    } else if (!lockedOn(ce, 'registration_deadline') && (ce.registration_deadline || null) === null) {
      // fillIfEmpty may have offered a source deadline that falls after the new date.
      delete upd.registration_deadline
    }
  } else {
    skipped.push({ field: 'date', reason: `date_${decision.reason}`, ce_value: ce.date, sa_value: sa.date })
  }
  if (log.some(m => m.ce_id === ce.id && m.sa_date === sa.date)) return
  log.push({
    ce_id: ce.id,
    name: ce.name,
    ce_date: ce.date,
    sa_date: sa.date,
    source: sa.source,
    source_id: sa.source_id,
    moved: decision.move,
    reason: decision.move ? null : decision.reason,
    collides_with: decision.collides_with || null,
    deadline: deadline?.write ? { from: ce.registration_deadline ?? null, to: deadline.value } : null,
  })
}

/** decideDateMove's findCollision over the fuzzy pool, pending rows included. */
export function collisionFinder(pool, ce, fuzzyMatchIn) {
  return (date, excludeId) => {
    const hit = fuzzyMatchIn(pool, { name: ce.name, date, location: ce.location, event_type: ce.event_type }, { excludeId, includePending: true })
    return hit ? hit.matched : null
  }
}
