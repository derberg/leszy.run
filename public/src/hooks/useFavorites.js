import { useState, useEffect } from 'react'
import { callFunction } from '../lib/auth.js'
import { readCache, writeCache, clearCache, isFresh } from '../lib/clientCache.js'
import useAuth from './useAuth.js'

// Module-level cache: get-favorites is fetched once per page load and shared
// across all StarButton mounts. `undefined` = not fetched yet.
// Also mirrored to a short-TTL localStorage entry so the set survives full page
// loads (StarButton is on kalendarz, which navigates via full reloads). Only
// { events, clubCounts } is persisted — `ids` is rebuilt from `events`, and any
// toggle invalidates the persisted copy so the two never drift.
const CACHE_KEY = 'leszy.favorites'
const TTL_MS = 5 * 60 * 1000 // 5 min

let cache
let inflight = null

/** Rebuild the in-memory cache shape from a persisted { events, clubCounts }. */
function fromStored(value) {
  return {
    ids: new Set((value.events ?? []).map((e) => e.id)),
    events: value.events ?? [],
    clubCounts: value.clubCounts ?? {},
  }
}

const seeded = readCache(CACHE_KEY)
if (isFresh(seeded, TTL_MS)) cache = fromStored(seeded.value)

// Stable empty-collection identities. Without these, `cache?.x ?? {}` would
// allocate a fresh object/array on every render while cache is undefined (anon
// users, or logged-in users before the favorites fetch resolves). That fresh
// identity propagates into consumers' useCallback/useMemo deps (e.g. Kalendarz's
// fetchEvents depends on clubCounts) and causes an infinite render→refetch loop.
const EMPTY_EVENTS = []
const EMPTY_COUNTS = {}
const listeners = new Set()

function notifyAll() { listeners.forEach((fn) => fn()) }

/** Reset after login/logout without a full reload. */
export function clearFavoritesCache() {
  cache = undefined
  inflight = null
  clearCache(CACHE_KEY)
}

export default function useFavorites() {
  const { user } = useAuth()
  const [, force] = useState(0)

  useEffect(() => {
    const fn = () => force((x) => x + 1)
    listeners.add(fn)
    return () => listeners.delete(fn)
  }, [])

  useEffect(() => {
    if (!user || cache !== undefined || inflight) return
    const stored = readCache(CACHE_KEY)
    if (isFresh(stored, TTL_MS)) { cache = fromStored(stored.value); notifyAll(); return }
    inflight = callFunction('get-favorites', {})
      .then((d) => {
        cache = {
          ids: new Set((d.events ?? []).map((e) => e.id)),
          events: d.events ?? [],
          clubCounts: d.clubCounts ?? {},
        }
        writeCache(CACHE_KEY, { events: cache.events, clubCounts: cache.clubCounts })
      })
      .catch(() => { cache = { ids: new Set(), events: [], clubCounts: {} } })
      .finally(() => { inflight = null; notifyAll() })
  }, [user])

  const isStarred = (eventId) => !!cache?.ids?.has(eventId)

  /** Optimistic toggle. Returns true when this was the user's FIRST ever star. */
  async function toggle(eventId) {
    if (!cache) return false
    const wasFirstStar = cache.ids.size === 0 && !cache.ids.has(eventId)
    const had = cache.ids.has(eventId)
    if (had) cache.ids.delete(eventId)
    else cache.ids.add(eventId)
    // Persisted copy (events+ids rebuilt from events) can no longer be trusted
    // once ids diverges — drop it so the next full page load refetches fresh.
    clearCache(CACHE_KEY)
    notifyAll()
    try {
      const res = await callFunction('toggle-favorite', { event_id: eventId })
      if (res.starred) cache.ids.add(eventId)
      else cache.ids.delete(eventId)
    } catch {
      // revert optimistic change
      if (had) cache.ids.add(eventId)
      else cache.ids.delete(eventId)
    }
    notifyAll()
    return wasFirstStar && cache.ids.has(eventId)
  }

  return {
    ready: cache !== undefined,
    isStarred,
    toggle,
    // NOTE: cache.events is the load-time snapshot — toggle() only updates
    // cache.ids (and invalidates the persisted copy, so the next full page load
    // refetches fresh events). Update cache.events here if in-session freshness
    // of the starred-events list ever becomes insufficient.
    starredEvents: cache?.events ?? EMPTY_EVENTS,
    clubCounts: cache?.clubCounts ?? EMPTY_COUNTS,
  }
}
