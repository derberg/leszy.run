// Tiny localStorage TTL cache. Lets per-page-load edge-function fetches (the
// notifications badge, the favorites set) survive full page loads for a short
// window instead of re-firing on every navigation — the SEO static pages
// navigate via full reloads, so this is what actually cuts invocations.
// All access is wrapped so private-mode / disabled storage degrades to a miss.

export function readCache(key) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null // { value, ts } | null
  } catch { return null }
}

export function writeCache(key, value) {
  try { localStorage.setItem(key, JSON.stringify({ value, ts: Date.now() })) } catch { /* ignore */ }
}

export function clearCache(key) {
  try { localStorage.removeItem(key) } catch { /* ignore */ }
}

/** True when `entry` (from readCache) exists and is younger than ttlMs. */
export function isFresh(entry, ttlMs) {
  return !!entry && (Date.now() - entry.ts) < ttlMs
}
