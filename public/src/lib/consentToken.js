// The consent link is ${PUBLIC_SITE_URL}/zgoda#<token> (Plan 4). The token is in the fragment,
// so it never reaches a server, a CDN log or analytics. This module takes it out of the address
// bar the moment the app starts (main.jsx), before the page asks anything of anybody: once
// dropped it is in no history entry, no referrer and no `document.location` a script could read.
//
// The token is kept for the tab in sessionStorage, so reopening the tab after fetching the
// e-mail code (a phone discarding a background tab) does not lose it. It goes on acceptance and
// on a link the server refused. Without storage it lives in memory only.

const KEY = 'leszy.consent.token'
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
const PATH = '/zgoda'

let held = null

function storage(win) {
  try { return win.sessionStorage ?? null } catch { return null }
}

/**
 * On /zgoda with a fragment: drop the fragment (replaceState, the router's state kept) and keep
 * the token if it is well formed. → the token held, or null.
 */
export function captureConsentToken(win = window) {
  const { location, history } = win
  if (location.pathname !== PATH) return held
  const raw = (location.hash ?? '').replace(/^#/, '')
  if (!raw) return held
  history.replaceState(history.state, '', location.pathname + location.search)
  if (!TOKEN_RE.test(raw)) return held
  held = raw
  try { storage(win)?.setItem(KEY, raw) } catch { /* private mode */ }
  return held
}

/** The token for this tab: the fragment just captured, or the one kept from earlier. */
export function consentToken(win = window) {
  const now = captureConsentToken(win)
  if (now) return now
  try {
    const kept = storage(win)?.getItem(KEY)
    if (kept && TOKEN_RE.test(kept)) held = kept
  } catch { /* private mode */ }
  return held
}

/** The link is done with (accepted, or refused by the server). */
export function forgetConsentToken(win = window) {
  held = null
  try { storage(win)?.removeItem(KEY) } catch { /* private mode */ }
}

export function resetConsentTokenForTests() {
  held = null
}
