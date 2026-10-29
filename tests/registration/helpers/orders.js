// Order RPC helpers for the LOCAL stack (plan 3, task 4). Every call goes
// through PostgREST as service_role, the way the edge functions make it.
import crypto from 'node:crypto'
import { admin, localEnv } from './stack.js'
import { paymentFee, supportFee } from '../../../supabase/functions/_shared/registration/money.js'

export const rand = () => crypto.randomBytes(4).toString('hex')
export const runnerEmail = (tag = 'o') => `runner-${tag}-${rand()}@test.local`
export const db = () => { localEnv(); return admin() }

export function person(email, over = {}) {
  return {
    firstName: 'Ola', lastName: 'Leśna', birthDate: '1990-01-01', gender: 'K', email,
    phone: '+48500100200', ageGroupLabel: 'K open', ...over,
  }
}

/** The total the checkout shows for n entries at `price` grosze. */
export function totalFor(price, n = 1, support = false) {
  const entry = price * n
  const s = entry > 0 ? supportFee(entry, support) : 0
  return entry + s + paymentFee(entry + s)
}

export async function consentIds(eventId) {
  const { data, error } = await db().from('event_consents').select('id').eq('event_id', eventId)
  if (error) throw error
  return data.map((c) => c.id)
}

export const rpc = (fn, args) => db().rpc(fn, args)

/**
 * create_order for one competition. `displayed` defaults to the right total for
 * `price`; `buyerEmail` defaults to the first person's address.
 */
export async function createOrder(event, {
  categoryId = event.categoryIds[0], people, emails, profileId = null, buyerEmail, support = false,
  displayed, price = event.prices?.[categoryId] ?? 6000, consents, meta,
} = {}) {
  const list = people ?? (emails ?? [runnerEmail()]).map((e) => person(e))
  return rpc('create_order', {
    p_category_id: categoryId,
    p_people: list,
    p_profile_id: profileId,
    p_buyer_email: buyerEmail ?? list[0]?.email ?? 'kupujacy@test.local',
    p_support_choice: support,
    p_displayed_total: displayed ?? totalFor(price, list.length, support === true),
    p_meta: meta ?? { consentIds: consents ?? await consentIds(event.eventId), ip: '203.0.113.9', userAgent: 'test' },
  })
}

/** create_order that must succeed → its jsonb result. */
export async function orderOk(event, opts) {
  const r = await createOrder(event, opts)
  if (r.error) throw new Error(`create_order: ${r.error.message}`)
  return r.data
}

export const newTxn = () => `TXN-${crypto.randomUUID()}`

/** A dpay transaction for the order → { id, txn }. */
export async function attemptFor(orderId, grosze, txn = newTxn()) {
  const r = await rpc('add_payment_attempt', { p_order_id: orderId, p_txn: txn, p_grosze: grosze })
  if (r.error) throw new Error(`add_payment_attempt: ${r.error.message}`)
  return { id: r.data, txn }
}

export const confirm = (orderId, txn, grosze, source = 'ipn') =>
  rpc('confirm_order', { p_order_id: orderId, p_txn: txn, p_grosze: grosze, p_source: source })

export async function confirmOk(orderId, txn, grosze) {
  const r = await confirm(orderId, txn, grosze)
  if (r.error) throw new Error(`confirm_order: ${r.error.message}`)
  return r.data
}

/** Moves the order's expiry into the past (the job then picks it up). */
export async function overdue(orderId) {
  const { error } = await db().from('orders')
    .update({ expires_at: new Date(Date.now() - 60_000).toISOString() }).eq('id', orderId)
  if (error) throw error
}

export async function expireNow(orderId) {
  await overdue(orderId)
  const r = await rpc('expire_orders', {})
  if (r.error) throw new Error(`expire_orders: ${r.error.message}`)
  return r.data
}

export async function one(table, filter) {
  let q = db().from(table).select('*')
  for (const [k, v] of Object.entries(filter)) q = q.eq(k, v)
  const { data, error } = await q.maybeSingle()
  if (error) throw error
  return data
}

export async function rows(table, filter) {
  let q = db().from(table).select('*')
  for (const [k, v] of Object.entries(filter)) q = q.eq(k, v)
  const { data, error } = await q
  if (error) throw error
  return data
}

export const competitionOf = (categoryId) => one('competitions', { category_id: categoryId })
export const orderOf = (id) => one('orders', { id })
export const registrationsOf = (orderId) => rows('registrations', { order_id: orderId })

/** Sets registration_settings columns directly (local stack only). */
export async function setSettings(eventId, values) {
  const { error } = await db().from('registration_settings').update(values).eq('event_id', eventId)
  if (error) throw error
}

export const minutesFromNow = (m) => new Date(Date.now() + m * 60_000).toISOString()

/** taken must equal the live (pending_payment + confirmed) registrations, teams counted once. */
export async function liveSlots(categoryId) {
  const { data, error } = await db().from('registrations').select('team_id, status').eq('category_id', categoryId)
    .in('status', ['pending_payment', 'confirmed'])
  if (error) throw error
  const teams = new Set(data.filter((r) => r.team_id).map((r) => r.team_id))
  return data.filter((r) => !r.team_id).length + teams.size
}
