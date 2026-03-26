import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'

/**
 * Tracks page views in GA4 on every route change.
 * GA may not be loaded (user rejected cookies), so we check for gtag first.
 */
export default function RouteTracker() {
  const location = useLocation()

  useEffect(() => {
    if (typeof window.gtag === 'function') {
      window.gtag('event', 'page_view', {
        page_path: location.pathname + location.search,
        page_title: document.title,
      })
    }
  }, [location.pathname, location.search])

  return null
}
