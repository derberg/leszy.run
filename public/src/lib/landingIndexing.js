// Which /listy/* pages Google may index. The static generator writes this into the HTML
// and LandingPage passes the same answer to useSeo, so the robots tag a crawler sees
// does not change when the page hydrates. Before 2026-11 the client only noindexed
// zero-event pages, which turned 529 noindexed monthly and thin pages back to
// "index, follow" after render.
//
// Monthly pages (/listy/.../2026/lipiec) are date-sliced copies of the evergreen pages;
// pages with fewer than 4 races have no content of their own.
export const MIN_INDEXABLE_EVENTS = 4

/** @param {{ filters?: { month?: string }, eventCount?: number } | null | undefined} entry */
export function isLandingIndexable(entry) {
  if (!entry) return false
  if (entry.filters && entry.filters.month) return false
  return (entry.eventCount || 0) >= MIN_INDEXABLE_EVENTS
}
