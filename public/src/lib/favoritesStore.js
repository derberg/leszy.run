// The signed-in user's starred events, shared by every StarButton, the
// kalendarz club counts and the Obserwowane list. One store per page load, so a
// page full of stars asks get-favorites once.
//
// `ids` answers "is this starred" and changes the moment a star is clicked.
// `events` is the list Obserwowane renders, and only get-favorites can fill it,
// because a star click knows the event id and nothing else. Obserwowane calls
// `refresh()` whenever it is shown. Before that, an event starred in the
// kalendarz was missing from Obserwowane until a full reload, because in-app
// navigation kept the list loaded with the page.
//
// The list is also mirrored to a short-lived storage entry, so the static
// kalendarz pages, which navigate by full reloads, do not each re-fetch it.

/**
 * @param {{
 *   fetchFavorites: () => Promise<{ events?: object[], clubCounts?: object }>,
 *   toggleFavorite: (eventId: string) => Promise<{ starred: boolean }>,
 *   storage: { read: () => object|null, write: (value: object) => void, clear: () => void },
 * }} deps `storage.read()` returns the stored value only while it is fresh.
 */
export function createFavoritesStore({ fetchFavorites, toggleFavorite, storage }) {
  let cache // undefined until loaded: { ids: Set, events: [], clubCounts: {} }
  let inflight = null
  // Bumped by every toggle and reset. A fetch that started before one of those
  // carries an older answer than what is on screen, so it must not land.
  let generation = 0
  let inflightGeneration = -1
  const listeners = new Set()

  const notify = () => listeners.forEach((fn) => fn())

  function build(value) {
    const events = value?.events ?? []
    return { ids: new Set(events.map((e) => e.id)), events, clubCounts: value?.clubCounts ?? {} }
  }

  function fetchNow() {
    const started = generation
    const p = fetchFavorites()
      .then((d) => {
        if (generation !== started) return
        cache = build(d)
        storage.write({ events: cache.events, clubCounts: cache.clubCounts })
      })
      .catch(() => {
        if (generation === started && cache === undefined) cache = build(null)
      })
      .finally(() => {
        if (inflight === p) inflight = null
        notify()
      })
    inflight = p
    inflightGeneration = started
    return p
  }

  return {
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },

    get ready() { return cache !== undefined },
    get events() { return cache?.events },
    get clubCounts() { return cache?.clubCounts },
    isStarred: (eventId) => !!cache?.ids.has(eventId),

    /** Loads once per page: from storage when fresh, otherwise from the server. */
    ensure() {
      if (cache !== undefined || inflight) return inflight
      const stored = storage.read()
      if (stored) { cache = build(stored); notify(); return null }
      return fetchNow()
    },

    /** Always asks the server, keeping the current list on screen meanwhile. */
    refresh() {
      if (inflight && inflightGeneration === generation) return inflight
      return fetchNow()
    },

    /** Optimistic toggle. Resolves true when this was the user's FIRST ever star. */
    async toggle(eventId) {
      if (!cache) return false
      const wasFirstStar = cache.ids.size === 0
      const had = cache.ids.has(eventId)
      if (had) cache.ids.delete(eventId)
      else cache.ids.add(eventId)
      generation++
      // The stored list no longer matches; the next full page load refetches.
      storage.clear()
      notify()
      try {
        const res = await toggleFavorite(eventId)
        if (res.starred) cache.ids.add(eventId)
        else cache.ids.delete(eventId)
      } catch {
        if (had) cache.ids.add(eventId)
        else cache.ids.delete(eventId)
      }
      notify()
      return wasFirstStar && cache.ids.has(eventId)
    },

    /** Drops everything after login/logout without a full reload. */
    reset() {
      cache = undefined
      inflight = null
      generation++
      storage.clear()
    },
  }
}
