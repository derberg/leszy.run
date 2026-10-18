import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'

const IS_DEV = import.meta.env.DEV

/**
 * Tracks page views in GA4 on every route change.
 * GA may not be loaded (user rejected cookies or dev mode), so we check for gtag first.
 */
export default function RouteTracker() {
  const location = useLocation()
  // The results page keeps the searched bib in ?nr=. It is not a new page, and
  // a bib names a runner, so it never reaches analytics.
  const search = (() => {
    const params = new URLSearchParams(location.search)
    params.delete('nr')
    const s = params.toString()
    return s ? `?${s}` : ''
  })()

  useEffect(() => {
    if (IS_DEV) {
      console.log('[DEV] Page view (not tracked):', location.pathname + search)
      return
    }
    if (typeof window.gtag === 'function') {
      window.gtag('event', 'page_view', {
        page_path: location.pathname + search,
        page_title: document.title,
      })
    }
  }, [location.pathname, search])

  return null
}
