import { useState, useEffect } from 'react'
import { getMeWithRetry, readCachedUser, clearCachedUser } from '../lib/auth.js'
import { createAuthStore } from '../lib/authStore.js'

// Two layers of caching keep /auth-me invocations low:
//   1. localStorage (survives full page loads — the SEO static pages navigate
//      via full reloads, so this is what actually cuts edge-function calls).
//   2. the module-level store (survives client-side route changes within one
//      page load; Navbar remounts on every navigation).
//
// Policy: hydrate instantly from localStorage (no logged-out flash, no network),
// then re-validate against /auth-me in the background at most once per
// REVALIDATE_MS. A fresh cache skips the call entirely. A failed call is
// retried (getMeWithRetry) and `loading` stays true meanwhile; only when every
// attempt failed does the page settle on what it had.
const REVALIDATE_MS = 24 * 60 * 60 * 1000 // 24h

// Seeded from localStorage on first import so the very first render already
// knows the user. readCachedUser catches, so this is safe during build-time
// static generation where localStorage is absent.
const store = createAuthStore({
  fetchUser: ({ isCurrent }) => getMeWithRetry({ isCurrent }),
  readCache: readCachedUser,
  clearCache: clearCachedUser,
  revalidateMs: REVALIDATE_MS,
})

/** Reset the cache (call after login/logout if not doing a full page reload). */
export function clearAuthCache() {
  store.clear()
}

/**
 * The user once the session check has answered, for a click that arrives while `loading` is
 * still true. A failed check settles as a visitor (the store does that itself), and so does one
 * that outlasts `timeoutMs`, so a caller never hangs on it.
 */
export function resolveUser(timeoutMs = 8000) {
  return Promise.race([
    store.load().catch(() => null),
    new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ])
}

export default function useAuth() {
  const [user, setUser] = useState(store.current() === undefined ? null : store.current())
  const [loading, setLoading] = useState(store.current() === undefined)

  useEffect(() => {
    if (!store.needsCheck()) {
      setLoading(false)
      return
    }
    // If a cached user is already shown it stays visible until the call lands
    // (stale-while-revalidate).
    let active = true
    store.load().then((u) => {
      if (active) {
        setUser(u)
        setLoading(false)
      }
    })
    return () => { active = false }
  }, [])

  return { user, loading }
}
