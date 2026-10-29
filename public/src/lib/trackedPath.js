// What a page view sends to GA as page_path: the path and query minus anything
// that names a person. `nr` is a searched bib (results page); `email` and
// `code` arrive on a magic login link (/login?email=&code=).
const PRIVATE = ['nr', 'email', 'code']

export function trackedPath(pathname, search) {
  const params = new URLSearchParams(search)
  for (const k of PRIVATE) params.delete(k)
  const s = params.toString()
  return s ? `${pathname}?${s}` : pathname
}

/** The full address GA may see: origin + trackedPath. */
export function trackedLocation({ origin, pathname, search }) {
  return origin + trackedPath(pathname, search)
}

// GA4 reads page_location from the address bar on every hit, including the
// automatic ones (scroll, outbound click) that no page_view call covers. A
// global `set` replaces it on all of them, so it is set before `config` and
// again on every route change.

/** Loads the GA config with the cleaned page_location; gtag('js') is the caller's. */
export function initGa(gtag, gaId, loc) {
  const pageLocation = trackedLocation(loc)
  gtag('set', { page_location: pageLocation })
  gtag('config', gaId, { send_page_view: false, page_location: pageLocation })
}

/** One page view, after pointing every later hit at the cleaned address. */
export function sendPageView(gtag, loc, title) {
  const pageLocation = trackedLocation(loc)
  gtag('set', { page_location: pageLocation })
  gtag('event', 'page_view', {
    page_path: trackedPath(loc.pathname, loc.search),
    page_location: pageLocation,
    page_title: title,
  })
}
