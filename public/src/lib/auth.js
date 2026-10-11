import { clearCache, USER_CACHE_KEYS } from './clientCache.js'
// Edge functions are reached through a SAME-ORIGIN path (`/edge/*`), which a
// Vercel rewrite (public/vercel.json) — and the vite dev-server proxy locally —
// proxies to `<project>.supabase.co/functions/v1/*`. This is load-bearing for
// auth: the session lives in an httpOnly cookie the functions set, and a cookie
// set by `*.supabase.co` while the page is on `leszy.run` is a THIRD-PARTY
// cookie that browsers block by default (Safari always, Chrome/Firefox
// increasingly). Routing through our own origin makes the cookie first-party so
// it actually persists and gets sent back. NEVER call the functions at the raw
// `VITE_SUPABASE_URL` when the call depends on the session cookie.
export const FUNCTIONS_BASE = '/edge'

// Client-side user cache. The session itself is a 90-day httpOnly cookie the
// browser sends automatically; this cache just remembers WHO that cookie
// belongs to so we don't have to hit /auth-me on every full page load. See
// useAuth.js for the stale-while-revalidate policy that consumes it.
const USER_CACHE_KEY = 'leszy.auth.user'

/** @returns {{user: object|null, ts: number}|null} cached entry, or null if none. */
export function readCachedUser() {
  try {
    const raw = localStorage.getItem(USER_CACHE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

export function writeCachedUser(user) {
  try { localStorage.setItem(USER_CACHE_KEY, JSON.stringify({ user: user ?? null, ts: Date.now() })) } catch { /* private mode / disabled */ }
}

export function clearCachedUser() {
  try { localStorage.removeItem(USER_CACHE_KEY) } catch { /* ignore */ }
}

async function callEdge(name, body) {
  const res = await fetch(`${FUNCTIONS_BASE}/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok) {
    // Session died server-side (expired / logged out elsewhere) — drop the
    // stale cached user so the next page load reflects the logged-out state.
    if (res.status === 401) clearCachedUser()
    throw new Error(data.error || `${name} failed`)
  }
  return data
}

export async function requestCode(email, honeypot = '', from = null) {
  return callEdge('auth-request-code', { email, honeypot, from })
}

export async function verifyCode(email, code) {
  return callEdge('auth-verify-code', { email, code })
}

export async function signOut() {
  clearCachedUser()
  // The identity cache is not the only thing holding the user's data: the
  // favorites and notifications caches are plain localStorage and survive a
  // logout, so on a shared machine the next visitor saw the previous user's
  // starred races (filled stars on /kalendarz) and their notification list.
  // Login already clears all three; logout has to as well.
  for (const key of USER_CACHE_KEYS) clearCache(key)
  return callEdge('auth-logout', {})
}

export async function getMe() {
  const res = await fetch(`${FUNCTIONS_BASE}/auth-me`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({}),
  })
  // Transient failure (network / 5xx): leave the existing cache untouched.
  if (!res.ok) return null
  const data = await res.json()
  const user = data.user ?? null
  // Authoritative result (including anon = null) → refresh the cache + timestamp.
  writeCachedUser(user)
  return user
}

export async function callFunction(name, body) {
  return callEdge(name, body)
}
