// The in-memory side of useAuth: who is signed in, and the one /auth-me call in
// flight. Kept free of React so the races can be unit-tested.
//
// `user`: undefined = unknown, null = confirmed visitor.
// `generation` goes up on every clear(). A call started before a clear (a login
// or logout happened meanwhile) never writes its answer: whoever waits on it
// gets the answer of a call started after the clear instead.

/**
 * @param {{ fetchUser: (o: { isCurrent: () => boolean }) => Promise<object|null>,
 *   readCache: () => ({ user: object|null, ts: number }|null), clearCache: () => void, revalidateMs: number,
 *   now?: () => number }} deps
 */
export function createAuthStore({ fetchUser, readCache, clearCache, revalidateMs, now = () => Date.now() }) {
  const seeded = readCache()
  let user = seeded ? seeded.user ?? null : undefined
  let inflight = null
  let generation = 0
  // Mounted useAuth hooks: told on every clear(), so a page that stays mounted through a login
  // (the registration form's code step) re-reads the session instead of keeping the visitor.
  const listeners = new Set()

  function start() {
    const gen = generation
    const isCurrent = () => gen === generation
    const p = fetchUser({ isCurrent })
      // Every attempt failed: settle on what was known before.
      .catch(() => user ?? null)
      .then((u) => {
        // Cleared meanwhile: answer with what is known since, or wait for it.
        if (!isCurrent()) return user !== undefined ? user : load()
        user = u
        if (inflight === p) inflight = null
        return u
      })
    inflight = p
    return p
  }

  /** False when a fresh cache already says who this is. */
  function needsCheck() {
    const stored = readCache()
    const fresh = stored && (now() - stored.ts) < revalidateMs
    return !(fresh && user !== undefined)
  }

  /** The user, from the call in flight or a new one. */
  function load() {
    return inflight ?? start()
  }

  return {
    current: () => user,
    needsCheck,
    /**
     * For a component mounting now: the user (null = visitor) when no call is needed, else
     * undefined (call load). A component that rendered while another one's call was in flight
     * must take its answer from here: the call can land before the component's effect runs.
     */
    knownUser() {
      return needsCheck() ? undefined : user
    },
    load,
    /** @param {() => void} fn called after every clear(); returns the unsubscribe. */
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    clear() {
      generation += 1
      user = undefined
      inflight = null
      clearCache()
      for (const fn of [...listeners]) fn()
    },
  }
}
