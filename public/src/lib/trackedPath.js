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
