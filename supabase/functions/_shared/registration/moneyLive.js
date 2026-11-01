// moneyFeaturesLive (flags.js) for an edge function's request: the function's own SUPABASE_URL and
// REGISTRATION_MONEY_TEST, and the request's x-registration-money header.
import { MONEY_OFF_HEADER, MONEY_TEST_ENV, moneyFeaturesLive } from './flags.js'

/** @param {Request} req */
export function moneyLiveFor(req) {
  const env = globalThis.Deno?.env
  return moneyFeaturesLive({
    supabaseUrl: env?.get('SUPABASE_URL'),
    testSwitch: env?.get(MONEY_TEST_ENV),
    offHeader: req?.headers?.get?.(MONEY_OFF_HEADER) ?? null,
  })
}

/** The 409 every money path answers while the features are off. */
export const PAYMENTS_OFF_REFUSAL = { error: 'Płatności online będą dostępne wkrótce.', code: 'payments' }
