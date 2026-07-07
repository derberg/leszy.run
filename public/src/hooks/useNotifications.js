import { useState, useEffect } from 'react'
import { callFunction } from '../lib/auth.js'
import { readCache, writeCache, clearCache, isFresh } from '../lib/clientCache.js'
import useAuth from './useAuth.js'

// The navbar badge shows on every page, so a naive fetch = one get-notifications
// per full page load per logged-in user. A short-TTL localStorage cache lets the
// badge survive reloads without re-fetching, while staying fresh enough that a
// new notification surfaces within TTL_MS.
const CACHE_KEY = 'leszy.notifications'
const TTL_MS = 5 * 60 * 1000 // 5 min

let cache
let inflight = null
const listeners = new Set()
const EMPTY_NOTIFICATIONS = []

function notifyAll() { listeners.forEach((fn) => fn()) }

// Seed from a fresh localStorage entry so the badge renders instantly, no fetch.
const seeded = readCache(CACHE_KEY)
if (isFresh(seeded, TTL_MS)) cache = seeded.value

export function clearNotificationsCache() {
  cache = undefined
  inflight = null
  clearCache(CACHE_KEY)
}

export default function useNotifications({ markSeen = false } = {}) {
  const { user } = useAuth()
  const [, force] = useState(0)

  useEffect(() => {
    const fn = () => force((x) => x + 1)
    listeners.add(fn)
    return () => listeners.delete(fn)
  }, [])

  useEffect(() => {
    if (!user) return
    // markSeen consumers (the profile feed) always refetch so the cursor advances.
    // Plain badge consumers reuse a fresh in-memory OR localStorage cache.
    if (!markSeen) {
      if (cache !== undefined) return
      const stored = readCache(CACHE_KEY)
      if (isFresh(stored, TTL_MS)) { cache = stored.value; notifyAll(); return }
    }

    const run = () => {
      inflight = callFunction('get-notifications', markSeen ? { markSeen: true } : {})
        .then((d) => {
          cache = { notifications: d.notifications ?? EMPTY_NOTIFICATIONS, unseenCount: markSeen ? 0 : (d.unseenCount ?? 0) }
          writeCache(CACHE_KEY, cache)
        })
        .catch(() => { cache = { notifications: EMPTY_NOTIFICATIONS, unseenCount: 0 } })
        .finally(() => { inflight = null; notifyAll() })
    }

    if (inflight) {
      // A plain (badge) fetch is already running. A markSeen consumer must still
      // advance the cursor — chain it after the inflight fetch settles. Plain
      // consumers just piggyback on the inflight result.
      if (markSeen) inflight.finally(run)
      return
    }
    run()
  }, [user, markSeen])

  return {
    ready: cache !== undefined,
    notifications: cache?.notifications ?? EMPTY_NOTIFICATIONS,
    unseenCount: cache?.unseenCount ?? 0,
  }
}
