// Keeps each event's results snapshot fresh for every component that reads it.
// One poller per event: the category sections, the bib finder and "Blisko Mety"
// on one page share it, so a tab asks once per interval however many of them
// are mounted.

const POLL_MS = 10_000

/** @type {Map<string, { snapshot: object|null, listeners: Set<() => void>, timer: any, inFlight: boolean, onVisible: () => void }>} */
const entries = new Map()

function hidden() {
  return typeof document !== 'undefined' && document.hidden
}

async function refresh(eventId, fetchImpl) {
  const entry = entries.get(eventId)
  if (!entry || entry.inFlight) return
  entry.inFlight = true
  try {
    const res = await fetchImpl(`/api/results?event=${encodeURIComponent(eventId)}`)
    if (!res.ok) return
    const snapshot = await res.json()
    // The CDN answers with the same document until it expires, so most polls
    // change nothing and must not re-render the page.
    if (entries.get(eventId) !== entry || snapshot.generatedAt === entry.snapshot?.generatedAt) return
    entry.snapshot = snapshot
    entry.listeners.forEach(l => l())
  } catch {
    // A failed poll keeps the last snapshot on screen. The next one retries.
  } finally {
    entry.inFlight = false
  }
}

/**
 * Starts polling an event on its first listener and stops on its last.
 * Polling pauses while the tab is hidden and catches up when it is shown.
 * @param {string} eventId
 * @param {() => void} listener
 * @param {typeof fetch} [fetchImpl]
 * @returns {() => void} unsubscribe
 */
export function subscribe(eventId, listener, fetchImpl = globalThis.fetch) {
  let entry = entries.get(eventId)
  if (!entry) {
    entry = { snapshot: null, listeners: new Set(), timer: null, inFlight: false, onVisible: null }
    entries.set(eventId, entry)
    entry.onVisible = () => { if (!hidden()) refresh(eventId, fetchImpl) }
    entry.timer = setInterval(() => { if (!hidden()) refresh(eventId, fetchImpl) }, POLL_MS)
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', entry.onVisible)
    refresh(eventId, fetchImpl)
  }
  entry.listeners.add(listener)
  return () => {
    entry.listeners.delete(listener)
    if (entry.listeners.size) return
    clearInterval(entry.timer)
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', entry.onVisible)
    entries.delete(eventId)
  }
}

/** The latest snapshot of an event, or null before the first one arrives. */
export function getSnapshot(eventId) {
  return entries.get(eventId)?.snapshot ?? null
}
