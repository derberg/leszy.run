// What Google Analytics may see of an address. The results page keeps the
// searched bib in ?nr=, and a bib names a runner. The others are credentials
// or identify a person: the check-in link's participant and token (p, t), the
// volunteer link's checkpoint PIN, and the login link's email and code.
//
// Both page_path AND page_location must be cleaned: gtag sends
// document.location.href as page_location on every hit unless told otherwise,
// so cleaning page_path alone still shipped the check-in token.
export const PRIVATE_PARAMS = ['nr', 'p', 't', 'pin', 'email', 'code']

export function cleanSearch(search) {
  const params = new URLSearchParams(search)
  for (const key of PRIVATE_PARAMS) params.delete(key)
  const s = params.toString()
  return s ? `?${s}` : ''
}

/** origin + path + cleaned query, without the hash. */
export function cleanLocation(href) {
  const url = new URL(href)
  return `${url.origin}${url.pathname}${cleanSearch(url.search)}`
}
