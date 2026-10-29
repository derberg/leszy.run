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

// Browsers cap the bodies of all in-flight keepalive requests at 64 KB together.
const KEEPALIVE_MAX_BYTES = 60_000

async function callEdge(name, body, { keepalive = false } = {}) {
  const payload = JSON.stringify(body)
  const res = await fetch(`${FUNCTIONS_BASE}/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: payload,
    // keepalive lets a save started while the page unloads finish.
    keepalive: keepalive && payload.length < KEEPALIVE_MAX_BYTES,
  })
  const data = await res.json()
  if (!res.ok) {
    // Session died server-side (expired / logged out elsewhere) — drop the
    // stale cached user so the next page load reflects the logged-out state.
    if (res.status === 401) clearCachedUser()
    const err = new Error(data.error || `${name} failed`)
    err.status = res.status
    if (data.code) err.code = data.code
    if (data.fields) err.fields = data.fields
    throw err
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

// A hung /auth-me (a cold edge worker that never answers) is given up after
// this long and counts as a failed attempt, so getMeWithRetry tries again.
export const AUTH_TIMEOUT_MS = 5000

/**
 * Who the session cookie belongs to: the user, or null for a visitor. Throws
 * on anything else (see isTransientAuthError for which throws are retried).
 * `isCurrent` says whether the answer still matters: once clearAuthCache ran
 * (a login or logout meanwhile), an old answer must not reach the cache.
 * @param {{ timeoutMs?: number, isCurrent?: () => boolean }} [o]
 */
export async function getMe({ timeoutMs = AUTH_TIMEOUT_MS, isCurrent = () => true } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res
  let data
  try {
    res = await fetch(`${FUNCTIONS_BASE}/auth-me`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({}),
      signal: controller.signal,
    })
    // A failed answer says nothing about who is signed in, so throw rather than
    // answer „anonymous”. The cache is left untouched.
    if (!res.ok) {
      const err = new Error(`auth-me failed (${res.status})`)
      err.status = res.status
      throw err
    }
    data = await res.json()
  } finally {
    clearTimeout(timer)
  }
  const user = data.user ?? null
  // Authoritative result (including anon = null) → refresh the cache + timestamp.
  if (isCurrent()) writeCachedUser(user)
  return user
}

// Waits before the 2nd, 3rd… attempt of getMeWithRetry.
export const AUTH_RETRY_DELAYS_MS = [500, 1500, 4000]

/**
 * Worth another attempt: no answer at all (network error, timeout, unreadable
 * body), a 5xx (a cold or recycled edge worker), 408 or 429. A 403 (origin
 * refused) or 404 (no profile) will answer the same every time.
 */
export function isTransientAuthError(err) {
  const status = err?.status
  return status === undefined || status >= 500 || status === 408 || status === 429
}

/**
 * getMe, retried while it fails transiently. A failed /auth-me is not
 * „anonymous”: taking it for that showed a signed-in runner the visitor's form
 * (no prefill, a code to their own address) for the rest of the page load.
 * Rejects on a non-transient failure, when every attempt failed, or once
 * `isCurrent` turns false (the cache was cleared; the answer is no longer wanted).
 * @param {{ load?: (o: { isCurrent: () => boolean }) => Promise<object|null>, delays?: number[],
 *   sleep?: (ms: number) => Promise<void>, isCurrent?: () => boolean }} [o]
 */
export async function getMeWithRetry({
  load = getMe, delays = AUTH_RETRY_DELAYS_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), isCurrent = () => true,
} = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await load({ isCurrent })
    } catch (err) {
      if (!isTransientAuthError(err) || attempt >= delays.length) throw err
      await sleep(delays[attempt])
      if (!isCurrent()) throw new Error('auth-me no longer wanted')
    }
  }
}

export async function callFunction(name, body, options) {
  return callEdge(name, body, options)
}
