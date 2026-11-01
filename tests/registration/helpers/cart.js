// Plan 7 cart fixtures for the LOCAL stack: vouchers, partners, extras, tiers and charity settings,
// inserted directly as service_role (the organizer functions arrive in task 5). Every voucher made
// here is remembered, so a suite's afterEach can run assertVoucherInvariant on each.
import crypto from 'node:crypto'
import { db } from './orders.js'

export const vouchersMade = new Set()

async function insert(table, row) {
  const { data, error } = await db().from(table).insert(row).select().single()
  if (error) throw new Error(`${table}: ${error.message}`)
  return data
}

export const code = (prefix = 'LESZY') => `${prefix}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`

/** A voucher row; `categoryIds` link it to those competitions only. */
export async function makeVoucher(eventId, { categoryIds = [], ...over } = {}) {
  const v = await insert('vouchers', { event_id: eventId, code: code(), percent: 15, max_uses: 1, ...over })
  for (const categoryId of categoryIds) await insert('voucher_competitions', { voucher_id: v.id, category_id: categoryId })
  vouchersMade.add(v.id)
  return v
}

export const makePartner = (eventId, name = `Sklep ${crypto.randomBytes(3).toString('hex')}`) =>
  insert('registration_partners', { event_id: eventId, name })

/**
 * An extra with variants → { extra, variants: { [label]: row } }. `orderUntil` defaults to the
 * event's date; `categoryIds` offer it in those competitions only.
 */
export async function makeExtra(event, {
  name = 'Koszulka', price = 4500, orderUntil = event.eventDate, variants = [['M', 10]], categoryIds = [],
} = {}) {
  const extra = await insert('extras', { event_id: event.eventId, name, price, order_until: orderUntil })
  const out = {}
  for (const [i, [label, stock]] of variants.entries()) {
    out[label] = await insert('extra_variants', { extra_id: extra.id, label, stock, sort_order: i })
  }
  for (const categoryId of categoryIds) await insert('extra_competitions', { extra_id: extra.id, category_id: categoryId })
  return { extra, variants: out }
}

export async function setCharity(eventId, on = true) {
  const { error } = await db().from('registration_settings')
    .update({ is_charity: on, donations_enabled: on }).eq('event_id', eventId)
  if (error) throw error
}

/**
 * Replaces the event's tiers: [{ endsOn, prices: { [categoryId]: grosze } }], the last open
 * (endsOn null). pricing_mode becomes 'tiered'. → the tier rows in order.
 */
export async function setTiers(eventId, tiers) {
  const { error: pErr } = await db().from('competition_prices').delete()
    .in('tier_id', (await db().from('price_tiers').select('id').eq('event_id', eventId)).data.map((t) => t.id))
  if (pErr) throw pErr
  const { error: dErr } = await db().from('price_tiers').delete().eq('event_id', eventId)
  if (dErr) throw dErr
  const rows = []
  for (const [i, t] of tiers.entries()) {
    const tier = await insert('price_tiers', { event_id: eventId, ends_on: t.endsOn, sort_order: i })
    const { error } = await db().from('competition_prices').insert(
      Object.entries(t.prices).map(([categoryId, amount]) => ({ category_id: categoryId, tier_id: tier.id, amount })))
    if (error) throw error
    rows.push(tier)
  }
  const { error: sErr } = await db().from('registration_settings').update({ pricing_mode: 'tiered' }).eq('event_id', eventId)
  if (sErr) throw sErr
  return rows
}

/** The Warsaw calendar day of `date`, shifted by `days`, as YYYY-MM-DD. */
export function warsawDay(days = 0, date = new Date()) {
  const d = new Date(date.getTime() + days * 86_400_000)
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(d)
}
