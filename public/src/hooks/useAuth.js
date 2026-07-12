import { useState, useEffect } from 'react'
import { getMe, readCachedUser, clearCachedUser } from '../lib/auth.js'
import useBeta from './useBeta.js'

// Two layers of caching keep /auth-me invocations low:
//   1. localStorage (survives full page loads — the SEO static pages navigate
//      via full reloads, so this is what actually cuts edge-function calls).
//   2. this module-level var (survives client-side route changes within one
//      page load; Navbar remounts on every navigation).
// `undefined` = unknown/not hydrated, `null` = confirmed anonymous.
//
// Policy: hydrate instantly from localStorage (no logged-out flash, no network),
// then re-validate against /auth-me in the background at most once per
// REVALIDATE_MS. A fresh cache skips the call entirely.
const REVALIDATE_MS = 24 * 60 * 60 * 1000 // 24h

let cachedUser
let inflight = null

// Seed the module cache from localStorage on first import so the very first
// render already knows the user. Guarded (readCachedUser catches) so it's safe
// during build-time static generation where localStorage is absent.
const seeded = readCachedUser()
if (seeded) cachedUser = seeded.user ?? null

/** Reset the cache (call after login/logout if not doing a full page reload). */
export function clearAuthCache() {
  cachedUser = undefined
  inflight = null
  clearCachedUser()
}

export default function useAuth() {
  const beta = useBeta()
  const [user, setUser] = useState(cachedUser === undefined ? null : cachedUser)
  const [loading, setLoading] = useState(cachedUser === undefined)

  useEffect(() => {
    // Accounts dark-launched off → treat everyone as anonymous, no /auth-me call.
    if (!beta) return
    const stored = readCachedUser()
    const fresh = stored && (Date.now() - stored.ts) < REVALIDATE_MS
    // Fresh cache and we already know the user → trust it, skip /auth-me.
    if (fresh && cachedUser !== undefined) {
      setLoading(false)
      return
    }

    // Missing or stale cache → (re)validate. If a cached user is already shown
    // it stays visible until the call lands (stale-while-revalidate).
    if (!inflight) {
      inflight = getMe()
        .catch(() => cachedUser ?? null)
        .then(u => {
          cachedUser = u
          inflight = null
          return u
        })
    }
    let active = true
    inflight.then(u => {
      if (active) {
        setUser(u)
        setLoading(false)
      }
    })
    return () => { active = false }
  }, [beta])

  if (!beta) return { user: null, loading: false }
  return { user, loading }
}
