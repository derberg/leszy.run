// A link whose secret travels in the URL fragment: ${PUBLIC_SITE_URL}<path>#<token> (Plan 4's
// /zgoda, Plan 7's /przekazanie). The fragment never reaches a server, a CDN log or analytics.
// The token is taken out of the address bar the moment the app starts (main.jsx), before the page
// asks anything of anybody: once dropped it is in no history entry, no referrer and no
// `document.location` a script could read.
//
// The token is kept for the tab in sessionStorage, so reopening the tab after fetching the e-mail
// code (a phone discarding a background tab) does not lose it. The page forgets it when the link is
// done with. Without storage it lives in memory only.

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

function storage(win) {
  try { return win.sessionStorage ?? null } catch { return null }
}

/**
 * → { capture, token, forget, reset } for the link on `path`, kept under `key`.
 *   capture(win): on `path` with a fragment, drop the fragment (replaceState, the router's state
 *     and the query kept) and keep the token if it is well formed → the token held, or null.
 *   token(win): the fragment just captured, or the one kept from earlier in this tab.
 *   forget(win): the link is done with (used, or refused by the server).
 */
export function fragmentToken(path, key) {
  let held = null

  function capture(win = window) {
    const { location, history } = win
    if (location.pathname !== path) return held
    const raw = (location.hash ?? '').replace(/^#/, '')
    if (!raw) return held
    history.replaceState(history.state, '', location.pathname + location.search)
    if (!TOKEN_RE.test(raw)) return held
    held = raw
    try { storage(win)?.setItem(key, raw) } catch { /* private mode */ }
    return held
  }

  function token(win = window) {
    const now = capture(win)
    if (now) return now
    try {
      const kept = storage(win)?.getItem(key)
      if (kept && TOKEN_RE.test(kept)) held = kept
    } catch { /* private mode */ }
    return held
  }

  function forget(win = window) {
    held = null
    try { storage(win)?.removeItem(key) } catch { /* private mode */ }
  }

  const reset = () => { held = null }

  return { capture, token, forget, reset }
}
