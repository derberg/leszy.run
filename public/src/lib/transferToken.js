// The package transfer link is ${PUBLIC_SITE_URL}/przekazanie#<token> (Plan 7, RA7). Same rules as
// the consent link (fragmentToken.js): main.jsx takes the token out of the address bar before the
// page sends anything, so it reaches no request, referrer, log or analytics hit. It is kept for the
// tab in sessionStorage and forgotten once the package is taken or the server says the link is gone.
import { fragmentToken } from './fragmentToken.js'

export const TRANSFER_PATH = '/przekazanie'

const link = fragmentToken(TRANSFER_PATH, 'leszy.transfer.token')

/** On /przekazanie with a fragment: drop it and keep the token → the token held, or null. */
export const captureTransferToken = (win = window) => link.capture(win)

/** The token for this tab: the fragment just captured, or the one kept from earlier. */
export const transferToken = (win = window) => link.token(win)

/** The link is done with (the package taken, or the server refused the link). */
export const forgetTransferToken = (win = window) => link.forget(win)

export const resetTransferTokenForTests = () => link.reset()
