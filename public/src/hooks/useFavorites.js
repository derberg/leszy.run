import { useState, useEffect } from 'react'
import { callFunction } from '../lib/auth.js'
import useAuth from './useAuth.js'

// Module-level cache: get-favorites is fetched once per page load and shared
// across all StarButton mounts. `undefined` = not fetched yet.
let cache
let inflight = null
const listeners = new Set()

function notifyAll() { listeners.forEach((fn) => fn()) }

/** Reset after login/logout without a full reload. */
export function clearFavoritesCache() {
  cache = undefined
  inflight = null
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
    inflight = callFunction('get-favorites', {})
      .then((d) => {
        cache = {
          ids: new Set((d.events ?? []).map((e) => e.id)),
          events: d.events ?? [],
          clubCounts: d.clubCounts ?? {},
        }
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
    // cache.ids. Consumers listing starred events get fresh data on next page
    // load; update cache.events here if that ever becomes insufficient.
    starredEvents: cache?.events ?? [],
    clubCounts: cache?.clubCounts ?? {},
  }
}
