// A tab opened before a deploy still runs the old entry bundle, which lazy-loads
// pages by their old hashed file names. The new deployment no longer has those
// files, so in-app navigation to a page not loaded yet failed with "Failed to
// fetch dynamically imported module" and left a white page until a manual
// refresh. Vite reports that failure as `vite:preloadError`. By then the router
// has already moved to the new address, so one reload opens the page the user
// clicked on, from the current deployment.
//
// A second failure within RELOAD_GUARD_MS is not a stale tab, so it is left to
// surface instead of reloading in a loop.

const KEY = 'leszy.chunkReloadAt'
export const RELOAD_GUARD_MS = 10_000

/**
 * @param {{ addEventListener: Function, location: { reload: Function } }} win
 * @param {{ getItem: Function, setItem: Function }} storage
 * @param {() => number} [now]
 */
export function installStaleChunkReload(win, storage, now = Date.now) {
  win.addEventListener('vite:preloadError', (event) => {
    let last = 0
    try { last = Number(storage.getItem(KEY)) || 0 } catch { /* storage blocked */ }
    if (now() - last < RELOAD_GUARD_MS) return
    try { storage.setItem(KEY, String(now())) } catch { return } // no guard, no reload
    event.preventDefault()
    win.location.reload()
  })
}
