// Feature switches for online registration. Plain ESM, no runtime APIs: runs in Deno and Node.

// Paid registration through dpay. False is the kill switch: a paid event can be drafted but not
// published, and every money feature below is off.
export const PAID_REGISTRATION_ENABLED = true

// People in one registration request (a group: one payer, up to ten participants).
export const MAX_PEOPLE_PER_REQUEST = 10

// The smallest team. The largest is MAX_PEOPLE_PER_REQUEST: a team is registered in one request.
export const MIN_TEAM_SIZE = 2

// Never register a dpay transaction with a preselected `channel`: that requires `accept_tos` and the
// payer's names, and BLIK Level 0 is deferred. The payer picks the method on dpay's page.
export const PAYMENT_CHANNEL_PRESELECT = false

// Plan 7's money features (donations, extras priced or 0 zł, vouchers, the organizer's codes and
// partners) are live only with PAID_REGISTRATION_ENABLED (final review I-1 + I-4). While it is false a
// published free charity event behaves exactly as before Plan 7: no donation chips, no extras, no
// codes, and „Opublikuj zmiany” is not held by them. Transfers are not money and stay live.
//
// Only while the flag is false: REGISTRATION_MONEY_TEST=on (tests/registration/functions.env, the
// Playwright Vite env) turns them on, but only where SUPABASE_URL is an http:// local address, never
// on a deployed project (https), and `x-registration-money: off` turns them off for one request.
export const MONEY_TEST_ENV = 'REGISTRATION_MONEY_TEST'
export const MONEY_OFF_HEADER = 'x-registration-money'
const LOCAL_SUPABASE = /^http:\/\/(127\.0\.0\.1|localhost|kong|host\.docker\.internal)(:\d+)?(\/|$)/

/** Are Plan 7's money features live? `offHeader` is the request's MONEY_OFF_HEADER value. */
export function moneyFeaturesLive({ supabaseUrl, testSwitch, offHeader } = {}) {
  if (PAID_REGISTRATION_ENABLED) return true
  return testSwitch === 'on' && LOCAL_SUPABASE.test(String(supabaseUrl ?? '').trim()) && offHeader !== 'off'
}
