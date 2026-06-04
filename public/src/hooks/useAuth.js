import { useState, useEffect } from 'react'
import { getMe } from '../lib/auth.js'

// Module-level cache so /auth-me is fetched once per page load and shared
// across all mounts. Navbar remounts on every route change — without this
// cache each navigation flashes the logged-out state until the edge
// function round-trip completes. `undefined` = not fetched yet, `null` = anon.
let cachedUser
let inflight = null

/** Reset the cache (call after login/logout if not doing a full page reload). */
export function clearAuthCache() {
  cachedUser = undefined
  inflight = null
}

export default function useAuth() {
  const [user, setUser] = useState(cachedUser === undefined ? null : cachedUser)
  const [loading, setLoading] = useState(cachedUser === undefined)

  useEffect(() => {
    if (cachedUser !== undefined) return
    if (!inflight) {
      inflight = getMe()
        .catch(() => null)
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
  }, [])

  return { user, loading }
}
