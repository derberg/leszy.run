// The consent link is ${PUBLIC_SITE_URL}/zgoda#<token> (Plan 4). The rules are fragmentToken.js's:
// the token leaves the address bar before anything renders, and is kept for the tab in
// sessionStorage. It goes on acceptance and on a link the server refused.
import { fragmentToken } from './fragmentToken.js'

const link = fragmentToken('/zgoda', 'leszy.consent.token')

/** On /zgoda with a fragment: drop it and keep the token → the token held, or null. */
export const captureConsentToken = (win = window) => link.capture(win)

/** The token for this tab: the fragment just captured, or the one kept from earlier. */
export const consentToken = (win = window) => link.token(win)

/** The link is done with (accepted, or refused by the server). */
export const forgetConsentToken = (win = window) => link.forget(win)

export const resetConsentTokenForTests = () => link.reset()
