// Feature switches for online registration. Plain ESM, no runtime APIs: runs in Deno and Node.

// A paid event can be drafted but not published until payments ship.
export const PAID_REGISTRATION_ENABLED = false

// People in one registration request (a group: one payer, up to ten participants).
export const MAX_PEOPLE_PER_REQUEST = 10

// Never register a dpay transaction with a preselected `channel`: that requires `accept_tos` and the
// payer's names, and BLIK Level 0 is deferred. The payer picks the method on dpay's page.
export const PAYMENT_CHANNEL_PRESELECT = false
