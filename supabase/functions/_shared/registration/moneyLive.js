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

/**
 * registration_raw as a runner may see it with the money features off: no donations, no extras.
 * The same strip /api/event applies (public/src/lib/moneyFeatures.js withoutMoneyFeatures), for
 * the organizer's „Podgląd jako zawodnik” (preview-registration-event, Plan 7 follow-up NB-3).
 */
export function rawWithoutMoneyFeatures(raw) {
  return raw ? { ...raw, donationsEnabled: false, extras: [] } : raw
}

/**
 * A staged payload (registration_pending_changes.payload) with the money features off: no staged
 * extras and no staged donations switch, so mergePending cannot bring either back into the preview.
 * The rest of the staged sections is untouched. The input is not changed.
 */
export function payloadWithoutMoneyFeatures(payload) {
  if (!payload || typeof payload !== 'object') return payload
  const { extras: _extras, ...rest } = payload
  if (rest.basics && typeof rest.basics === 'object' && 'donations_enabled' in rest.basics) {
    const { donations_enabled: _donations, ...basics } = rest.basics
    rest.basics = basics
  }
  return rest
}
