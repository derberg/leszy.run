import { useSyncExternalStore, useCallback } from 'react'
import { subscribe, getSnapshot } from '../lib/snapshotStore.js'

/**
 * The event's public results snapshot, refreshed while the page is open.
 * @param {string|undefined} eventId
 * @returns {object|null} null until the first snapshot arrives
 */
export function useResultsSnapshot(eventId) {
  const sub = useCallback(
    (listener) => (eventId ? subscribe(eventId, listener) : () => {}),
    [eventId],
  )
  return useSyncExternalStore(sub, () => (eventId ? getSnapshot(eventId) : null))
}
