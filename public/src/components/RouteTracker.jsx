import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { sendPageView, trackedPath } from '../lib/trackedPath.js'

const IS_DEV = import.meta.env.DEV

/**
 * Tracks page views in GA4 on every route change.
 * GA may not be loaded (user rejected cookies or dev mode), so we check for gtag first.
 */
export default function RouteTracker() {
  const location = useLocation()
  // trackedPath drops what names a person: a searched bib (?nr=) and a magic
  // link's address and code (?email=, ?code=).
  const path = trackedPath(location.pathname, location.search)

  useEffect(() => {
    if (IS_DEV) {
      console.log('[DEV] Page view (not tracked):', path)
      return
    }
    if (typeof window.gtag === 'function') {
      // Sets the cleaned page_location for every later hit too, not just this one.
      sendPageView(window.gtag, window.location, document.title)
    }
  }, [path])

  return null
}
