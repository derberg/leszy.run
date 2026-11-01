// Transfer RPC helpers for the LOCAL stack (plan 7, task 6). A token is random, only its SHA-256
// reaches the database (Plan 4's pattern), and every call goes through PostgREST as service_role,
// the way the edge functions will make it.
import crypto from 'node:crypto'
import {
  attemptFor, confirmOk, consentIds, person, profileFor, registrationsOf, rpc, runnerEmail, setSettings,
} from './orders.js'
import { adult, orderGroupOk, registerGroup } from './groups.js'

export const newToken = () => crypto.randomBytes(32).toString('base64url')
export const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex')

/** The day before an ISO day. */
export const dayBefore = (iso) => new Date(Date.parse(`${iso}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)

/** Transfers on, until the day before the race unless `until` says otherwise. */
export const enableTransfers = (event, until = dayBefore(event.eventDate)) =>
  setSettings(event.eventId, { transfer_enabled: true, transfer_until: until })

/** A paid, confirmed entry → the create_order result plus { reg, email, profileId, attemptId, txn }. */
export async function paidEntry(event, {
  email = runnerEmail('holder'), categoryId = event.categoryIds[0], voucher, variant, displayed,
} = {}) {
  const p = {
    ...adult(categoryId, 'self', email),
    ...(voucher ? { voucherCode: voucher.code } : {}),
    ...(variant ? { extras: [{ variantId: variant.id, qty: 1 }] } : {}),
  }
  const out = await orderGroupOk(event, [p], displayed === undefined ? undefined : { displayed })
  const att = await attemptFor(out.orderId, out.total)
  const done = await confirmOk(out.orderId, att.txn, out.total)
  if (done.outcome !== 'confirmed') throw new Error(`paidEntry: ${done.outcome}`)
  const [reg] = await registrationsOf(out.orderId)
  return { ...out, reg, email, profileId: await profileFor(email), attemptId: att.id, txn: att.txn }
}

/** A free, confirmed entry → { reg, email, profileId }. */
export async function freeEntry(event, { email = runnerEmail('holder'), categoryId = event.categoryIds[0] } = {}) {
  const r = await registerGroup(event, [adult(categoryId, 'self', email)])
  if (r.error) throw new Error(`register_free: ${r.error.message}`)
  return { reg: { id: r.data.registrations[0].id, category_id: categoryId }, email, profileId: await profileFor(email) }
}

/** create_transfer → { result, token, hash } with the RPC's raw { data, error } in `result`. */
export async function invite(registrationId, actor, toEmail = runnerEmail('recipient'), { now } = {}) {
  const token = newToken()
  const hash = hashToken(token)
  const result = await rpc('create_transfer', {
    p_registration_id: registrationId, p_actor: actor, p_to_email: toEmail, p_token_hash: hash,
    ...(now ? { p_now: now } : {}),
  })
  return { result, token, hash, toEmail }
}

/** invite that must succeed → { transferId, expiresAt, token, hash, toEmail }. */
export async function inviteOk(registrationId, actor, toEmail, opts) {
  const { result, ...rest } = await invite(registrationId, actor, toEmail, opts)
  if (result.error) throw new Error(`create_transfer: ${result.error.message}`)
  return { ...result.data, ...rest }
}

export const consentOf = async (eventId) => ({ consentIds: await consentIds(eventId), serviceRegulamin: true })
export const META = { ip: '203.0.113.9', userAgent: 'test' }

/**
 * accept_transfer as `email`, prepared: every read is done, so the returned function is one call to
 * the RPC (a race starts there). An account is made when missing.
 */
export async function acceptCall(event, hash, {
  email = runnerEmail('recipient'), categoryId = event.categoryIds[0], over = {}, consent, profileId,
} = {}) {
  const args = {
    p_token_hash: hash, p_person: person(email, over), p_category_id: categoryId,
    p_profile_id: profileId ?? await profileFor(email), p_consent: consent ?? await consentOf(event.eventId), p_meta: META,
  }
  return () => rpc('accept_transfer', args)
}

export const accept = async (event, hash, opts) => (await acceptCall(event, hash, opts))()

export async function organizerTransfer(event, registrationId, actor, {
  email = runnerEmail('recipient'), categoryId = event.categoryIds[0], over = {}, now,
} = {}) {
  return rpc('organizer_transfer', {
    p_registration_id: registrationId, p_person: person(email, over), p_category_id: categoryId, p_actor: actor,
    ...(now ? { p_now: now } : {}),
  })
}
