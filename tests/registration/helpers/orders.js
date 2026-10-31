// Order RPC helpers for the LOCAL stack (plan 3, task 4). Every call goes
// through PostgREST as service_role, the way the edge functions make it.
import crypto from 'node:crypto'
import { admin, localEnv } from './stack.js'

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
export const totalFor = (price, n = 1) => price * n

export async function consentIds(eventId) {
  const { data, error } = await db().from('event_consents').select('id').eq('event_id', eventId)
  if (error) throw error
  return data.map((c) => c.id)
}

export const rpc = (fn, args) => db().rpc(fn, args)

/** The profile id for an address (created when missing): every order needs an account (P3-R4). */
export async function profileFor(email) {
  const normalized = email.toLowerCase().trim()
  const { data: found, error } = await db().from('profiles').select('id').eq('email', normalized).maybeSingle()
  if (error) throw error
  if (found) return found.id
  // Two concurrent orders of one buyer can both miss the select: the loser re-reads.
  const { data, error: insErr } = await db().from('profiles')
    .insert({ id: crypto.randomUUID(), email: normalized }).select('id').single()
  if (insErr) {
    const again = await db().from('profiles').select('id').eq('email', normalized).single()
    if (again.error) throw insErr
    return again.data.id
  }
  return data.id
}

/**
 * create_order for one competition. The buyer is an account: `profileId`, or
 * by default the profile of `buyerEmail` (the first person's address unless
 * given). `buyerEmail` is sent as p_buyer_email; pass `sendBuyerEmail` to send
 * something else. `profileId: null` sends no account. `displayed` defaults to
 * the right total for `price`.
 */
export async function createOrder(event, {
  categoryId = event.categoryIds[0], people, emails, profileId, buyerEmail, sendBuyerEmail,
  displayed, price = event.prices?.[categoryId] ?? 6000, consents, meta,
} = {}) {
  const list = people ?? (emails ?? [runnerEmail()]).map((e) => person(e))
  const buyer = buyerEmail ?? list[0]?.email ?? runnerEmail('buyer')
  const profile = profileId === undefined ? await profileFor(buyer) : profileId
  return rpc('create_order', {
    p_category_id: categoryId,
    p_people: list,
    p_profile_id: profile,
    p_buyer_email: sendBuyerEmail !== undefined ? sendBuyerEmail : buyer,
    p_displayed_total: displayed ?? totalFor(price, list.length),
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

/**
 * create_order, a dpay attempt and its confirmation → the create_order result. Since P3-R15 an order
 * claims its slot only when paid, so this is how a test fills a competition.
 */
export async function paidOrderOk(event, opts) {
  const out = await orderOk(event, opts)
  if (out.status === 'paid') return out
  const att = await attemptFor(out.orderId, out.total)
  const r = await confirmOk(out.orderId, att.txn, out.total)
  if (r.outcome !== 'confirmed') throw new Error(`paidOrderOk: ${r.outcome}`)
  return out
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
// The slots a competition's confirmed registrations hold, a team counted once. Since P3-R15 only
// confirmed entries (paid, free, 0 zł) hold one: an entry awaiting payment holds nothing.
export async function liveSlots(categoryId) {
  const { data, error } = await db().from('registrations').select('team_id, status').eq('category_id', categoryId)
    .eq('status', 'confirmed')
  if (error) throw error
  const teams = new Set(data.filter((r) => r.team_id).map((r) => r.team_id))
  return data.filter((r) => !r.team_id).length + teams.size
}
