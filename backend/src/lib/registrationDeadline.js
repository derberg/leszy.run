/**
 * The one rule for a registration deadline, applied wherever one is written
 * (scraper → scraper_all in the merge, the AI enrichers, scraper_all →
 * calendar_events in the publish) and reported by run-data-audit.js. The
 * Python enricher mirrors it in enricher/steps/merge.py
 * (DEADLINE_MAX_DAYS_BEFORE): change both together.
 *
 * A deadline is kept only when it falls on the race day or up to
 * DEADLINE_MAX_DAYS_BEFORE days before it; anything else is dropped, never
 * "corrected". Calibrated on 731 future calendar_events deadlines (median 5
 * days before the race, p95 88). Checked at the sources on 2026-11-11 for every
 * row the audit flagged: each correct deadline sat 0–6 days before its race,
 * each wrong one 132–389 days before it (the previous edition's deadline, the
 * day registration opened, a season-pass or T-shirt cutoff, a blog post date)
 * or after the race.
 */
export const DEADLINE_MAX_DAYS_BEFORE = 120

const DAY_MS = 864e5

/** UTC midnight of the YYYY-MM-DD prefix, or null when it is not a real date. */
function dayOf(value) {
  if (typeof value !== 'string') return null
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/.exec(value.trim())
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const t = Date.UTC(y, mo - 1, d)
  const back = new Date(t)
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null
  return t
}

/**
 * Days from the deadline to the event (positive = before the race), or null
 * when either value is not a date.
 */
export function deadlineDaysBefore(deadline, eventDate) {
  const dl = dayOf(deadline)
  const ev = dayOf(eventDate)
  if (dl === null || ev === null) return null
  return Math.round((ev - dl) / DAY_MS)
}

/** @returns {boolean} whether the deadline is plausible for an event on eventDate */
export function isPlausibleDeadline(deadline, eventDate) {
  const days = deadlineDaysBefore(deadline, eventDate)
  return days !== null && days >= 0 && days <= DEADLINE_MAX_DAYS_BEFORE
}

/**
 * The deadline as given when it is plausible for an event on eventDate,
 * otherwise null.
 * @param {string|null|undefined} deadline
 * @param {string|null|undefined} eventDate
 * @returns {string|null}
 */
export function plausibleDeadline(deadline, eventDate) {
  return isPlausibleDeadline(deadline, eventDate) ? deadline : null
}
