// Which events a /listy/* landing page lists.
//
// One definition, read by both halves of the pipeline, because they used to
// disagree and the page then advertised a number it did not show:
//
//   backend/scripts/publish-landing-pages.js  computes the eventCount baked
//                                             into each page's h1, title, meta
//                                             description and JSON-LD
//   public/scripts/generate-landing-pages.js  renders the list itself
//
// The rule is: a race that has not happened yet. A race whose registration has
// closed still shows, because the list is also how Google reaches the
// /kalendarz/:slug pages, and a race being unenterable today does not make its
// page less worth indexing. Only the date decides.
//
// publish-landing-pages.js additionally keeps `thresholdEvents`, a wider window
// (date >= today-30d) that decides whether a facet page is worth creating at
// all. That is a different question and stays separate.

/**
 * Pick the events a landing page lists, from the kalendarz manifest.
 *
 * @param {Record<string, object>} kalendarzManifest slug → event entry
 * @param {string} today ISO date, YYYY-MM-DD
 * @returns {{ slug: string, e: object }[]} date-ascending
 */
export function selectDisplayEvents(kalendarzManifest, today) {
  return Object.keys(kalendarzManifest || {})
    .map(slug => ({ slug, e: kalendarzManifest[slug] }))
    .filter(({ e }) => (e.date || '').slice(0, 10) >= today)
    .sort((a, b) => (a.e.date || '').localeCompare(b.e.date || ''))
}
