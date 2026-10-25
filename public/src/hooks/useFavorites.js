import { useState, useEffect } from 'react'
import { callFunction } from '../lib/auth.js'
import { readCache, writeCache, clearCache, isFresh, USER_CACHE_KEYS } from '../lib/clientCache.js'
import { createFavoritesStore } from '../lib/favoritesStore.js'
import useAuth from './useAuth.js'

const CACHE_KEY = USER_CACHE_KEYS[0]
const TTL_MS = 5 * 60 * 1000 // 5 min

const store = createFavoritesStore({
  fetchFavorites: () => callFunction('get-favorites', {}),
  toggleFavorite: (eventId) => callFunction('toggle-favorite', { event_id: eventId }),
  storage: {
    read: () => {
      const entry = readCache(CACHE_KEY)
      return isFresh(entry, TTL_MS) ? entry.value : null
    },
    write: (value) => writeCache(CACHE_KEY, value),
    clear: () => clearCache(CACHE_KEY),
  },
})

// Stable empty-collection identities. Without these, `x ?? {}` would allocate a
// fresh object/array on every render while nothing is loaded (anon users, or
// logged-in users before the favorites fetch resolves). That fresh identity
// propagates into consumers' useCallback/useMemo deps (e.g. Kalendarz's
// fetchEvents depends on clubCounts) and causes an infinite render→refetch loop.
const EMPTY_EVENTS = []
const EMPTY_COUNTS = {}

/** Reset after login/logout without a full reload. */
export function clearFavoritesCache() {
  store.reset()
}

/**
 * @param {{ fresh?: boolean }} [options] `fresh` re-asks the server when the
 *   component mounts and whenever the tab becomes visible again, so a list of
 *   starred events includes stars made elsewhere in the app or in another tab.
 */
export default function useFavorites({ fresh = false } = {}) {
  const { user } = useAuth()
  const [, force] = useState(0)

  useEffect(() => store.subscribe(() => force((x) => x + 1)), [])

  useEffect(() => {
    if (user) store.ensure()
  }, [user])

  useEffect(() => {
    if (!fresh || !user) return
    store.refresh()
    const onVisible = () => { if (!document.hidden) store.refresh() }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [fresh, user])

  return {
    ready: store.ready,
    isStarred: store.isStarred,
    toggle: store.toggle,
    starredEvents: store.events ?? EMPTY_EVENTS,
    clubCounts: store.clubCounts ?? EMPTY_COUNTS,
  }
}
