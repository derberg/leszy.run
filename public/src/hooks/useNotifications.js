import { useState, useEffect } from 'react'
import { callFunction } from '../lib/auth.js'
import useAuth from './useAuth.js'

// Module cache so the navbar badge costs one fetch per page load.
let cache
let inflight = null
const listeners = new Set()
const EMPTY_NOTIFICATIONS = []

function notifyAll() { listeners.forEach((fn) => fn()) }

export function clearNotificationsCache() {
  cache = undefined
  inflight = null
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
    // markSeen consumers (the profile feed) always refetch so the cursor advances
    if (cache !== undefined && !markSeen) return

    const run = () => {
      inflight = callFunction('get-notifications', markSeen ? { markSeen: true } : {})
        .then((d) => {
          cache = { notifications: d.notifications ?? EMPTY_NOTIFICATIONS, unseenCount: markSeen ? 0 : (d.unseenCount ?? 0) }
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
