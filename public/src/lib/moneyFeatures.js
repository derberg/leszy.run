// Plan 7's money features (donations, extras, vouchers) in the public app's read model (final review
// I-1 + I-4; the rule is flags.js moneyFeaturesLive). Only while PAID_REGISTRATION_ENABLED is false,
// /api/event drops them from the event it serves, so the form shows no donation chips, no extras and
// no code field, exactly as before Plan 7.
//
// No import from supabase/: a Vercel Function (public/api/*) may not reach outside public/. So the
// flag is copied here, and public/tests/unit/moneyFeatures.test.js fails when the copy differs.
export const MONEY_FEATURES_FLAG = true

const LOCAL_SUPABASE = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/

/**
 * Are the money features live for this /api/event request? With the flag false only on the local test
 * stack: REGISTRATION_MONEY_TEST=on and an http:// local VITE_SUPABASE_URL, unless the request carries
 * `x-registration-money: off` (`offHeader`).
 * @param {Record<string, string|undefined>} env  process.env
 */
export function moneyLiveForApi(env, offHeader) {
  if (MONEY_FEATURES_FLAG) return true
  return env?.REGISTRATION_MONEY_TEST === 'on' && LOCAL_SUPABASE.test(String(env?.VITE_SUPABASE_URL ?? '').trim()) && offHeader !== 'off'
}

/** The event as the public may see it with the money features off: no donations, no extras. */
export function withoutMoneyFeatures(raw) {
  return { ...raw, donationsEnabled: false, extras: [] }
}
