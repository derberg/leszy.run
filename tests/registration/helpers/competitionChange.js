// Competition change RPC helpers for the LOCAL stack: change_competition and cancel_surcharge
// through PostgREST as service_role, the way organizer-entry-action calls them.
import crypto from 'node:crypto'
import { rpc } from './orders.js'
import { ORGANIZER_AGREEMENT_VERSION } from '../../../supabase/functions/_shared/organizer.js'

/**
 * change_competition → the RPC's raw { data, error }. `agreement` is p_agreement_version, the
 * current version by default as the edge functions pass it; `agreement: null` leaves it out.
 */
export const changeCompetition = (registrationId, to, expected, {
  actor = null, kind = 'organizer', key = crypto.randomUUID(), offlineAck, agreement = ORGANIZER_AGREEMENT_VERSION,
} = {}) => rpc('change_competition', {
  p_registration_id: registrationId, p_to: to, p_expected_difference: expected,
  p_actor: actor, p_actor_kind: kind, p_request_key: key,
  ...(offlineAck === undefined ? {} : { p_offline_ack: offlineAck }),
  ...(agreement === null ? {} : { p_agreement_version: agreement }),
})

/** change_competition that must succeed → its jsonb result. */
export async function changeOk(registrationId, to, expected, opts) {
  const r = await changeCompetition(registrationId, to, expected, opts)
  if (r.error) throw new Error(`change_competition: ${r.error.message}`)
  return r.data
}

export const cancelSurcharge = (orderId, reason = 'organizer_cancelled') =>
  rpc('cancel_surcharge', { p_order_id: orderId, p_reason: reason })

/** change_competition that must create a surcharge → { orderId, grosze, expiresAt }. */
export async function surchargeOk(registrationId, to, expected, opts) {
  const out = await changeOk(registrationId, to, expected, opts)
  if (out.outcome !== 'surcharge') throw new Error(`surchargeOk: ${out.outcome}`)
  return out
}
