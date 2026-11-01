// The organizer panel's filter over the rows of list-event-registrations (B3). Shared by the panel
// (public/src/lib/entriesModel.js re-exports it) and export-event-registrations, so the CSV holds
// exactly the rows the organizer sees. Plain ESM: runs in Deno, Node and the browser.

/** „Czeka na zgody” in the status filter: a state of the consent, not an entry status. */
export const AWAITING_CONSENT = 'awaiting_consent'

// Lower case, „ł” → „l”, diacritics dropped: what startList.js's foldPl does.
const fold = (text) => String(text ?? '')
  .toLowerCase()
  .replace(/ł/g, 'l')
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .trim()

export const awaitingConsent = (row) => row.status === 'confirmed' && row.consentState === 'awaiting'

function matches(row, needle) {
  return [row.name, row.email, row.team?.name, row.bib].some((value) => fold(value).includes(needle))
}

/**
 * @param {object[]} rows
 * @param {{ categoryId?: string, statusKey?: string, q?: string, partnerId?: string }} [filters]
 *   `q` looks in the name, e-mail, team name and bib, ignoring case and diacritics
 */
export function filterEntries(rows, { categoryId, statusKey, q, partnerId } = {}) {
  const needle = fold(q)
  return rows.filter((row) => {
    if (categoryId && row.categoryId !== categoryId) return false
    if (partnerId && row.partnerId !== partnerId) return false
    if (statusKey === AWAITING_CONSENT) {
      if (!awaitingConsent(row)) return false
    } else if (statusKey && row.statusKey !== statusKey) return false
    return !needle || matches(row, needle)
  })
}

const SUMMARY_KEYS = ['categoryId', 'statusKey', 'partnerId']

/**
 * What the CSV export's audit row keeps of the filter: which filter keys were used and whether
 * there was a search. Never the search text: it is usually a runner's name or address, and
 * organizer_actions outlives every retention rule (review I1).
 * @returns {{ keys: string[], search: boolean }}
 */
export function filterSummary(filter) {
  const f = filter && typeof filter === 'object' ? filter : {}
  return {
    keys: SUMMARY_KEYS.filter((k) => typeof f[k] === 'string' && f[k] !== ''),
    search: fold(f.q) !== '',
  }
}
