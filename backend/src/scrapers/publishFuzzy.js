// The publish step's name+date duplicate test, against the calendar_events rows
// grouped by date (`pool`: Map date → rows). Extracted from publishToCalendar so
// the date-move wiring can be tested.
import { jaccardSimilarity, citiesMatch, citiesConflict, tokenize, distinguishingTags, hasDistinguishingConflict } from './dedup.js'

/**
 * @param {Map<string, object[]>} pool
 * @param {{ name, date, location, event_type?, event_types?, is_kids? }} event
 * @param {{ excludeId?: string|null, includePending?: boolean }} [opts]
 *   excludeId: a CE row about to move, which must not match itself.
 *   includePending: also compare against pending rows. Off for inserts, which
 *   have always been compared with active/rejected/cancelled rows only (and the
 *   rows inserted earlier in the same run); on for a date move, which must never
 *   land on a date where the same race already waits as pending.
 * @returns {{ matched: object, reason: string } | null}
 */
export function fuzzyMatchIn(pool, event, { excludeId = null, includePending = false } = {}) {
  const candidates = pool.get(event.date)
  if (!candidates) return null
  const saTags = distinguishingTags(event)
  for (const c of candidates) {
    if (excludeId && c.id === excludeId) continue
    if (!includePending && c.status === 'pending') continue
    // Same distinguishing-tag guard as the merge step — kids vs adult,
    // Maraton vs Półmaraton, trail vs uliczny, etc. Prevents publish from
    // suppressing a legitimate new CE row by misidentifying it as duplicate
    // of a semantically-distinct existing CE.
    if (hasDistinguishingConflict(saTags, distinguishingTags(c))) continue
    if (citiesConflict(c.location, event.location)) continue

    const jaccard = jaccardSimilarity(c.name, event.name)
    if (jaccard > 0.6) return { matched: c, reason: `jaccard=${jaccard.toFixed(2)}` }
    const locMatch = citiesMatch(c.location, event.location)
    if (locMatch && jaccard > 0.35) return { matched: c, reason: `city+jaccard=${jaccard.toFixed(2)}` }
    if (locMatch && tokenize(c.name).length <= 3 && tokenize(event.name).length <= 3 && jaccard > 0.25) return { matched: c, reason: `short+city+jaccard=${jaccard.toFixed(2)}` }
  }
  return null
}
