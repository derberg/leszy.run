// Pricing for online registration (Plan 7): Warsaw-day price tiers, percent vouchers and one cart of
// entries, extras and a donation. Integer grosze only, and nothing in a cart is payable to LESZY.RUN
// (legal decision, 2026-10-31): the total is entries + extras + donation, through orderAmounts.
// Plain ESM, no runtime APIs beyond Intl: runs in Deno and Node.

import { MoneyError, orderAmounts, formatPln } from './money.js'
import { warsawToday } from './dates.js'

export const MAX_TIERS = 5
// The highest list or extra price, 100 000 zł: the same cap as MAX_PRICE_GROSZE in sections.js,
// so list × percent stays below 1e9 and exact in a double. The SQL mirror
// (registration_discounted_price, Task 2) must compute in bigint: in int4, list × percent overflows
// above 21 474 836 grosze, and the cap is checked there too.
export const MAX_LIST_PRICE = 10_000_000
export const TIERS_ORDER_MESSAGE = 'Daty progów muszą rosnąć i kończyć się przed zamknięciem zapisów.'
const TIERS_COUNT_MESSAGE = 'Od 1 do 5 progów cenowych.'
const TIERS_OPEN_MESSAGE = 'Ostatni próg trwa do końca zapisów, i tylko on.'

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/** A real calendar date in YYYY-MM-DD (2026-02-30 is not). */
export function isIsoDate(s) {
  const m = typeof s === 'string' ? ISO_DATE_RE.exec(s) : null
  if (!m) return false
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return d.toISOString().slice(0, 10) === s
}

function dayAfter(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10)
}

// Plan 2's registration_raw order: ends_on nulls last, sort_order, id.
function sortTiers(tiers) {
  return [...tiers].sort((a, b) => {
    const ae = a.endsOn ?? null
    const be = b.endsOn ?? null
    if (ae !== be) {
      if (ae === null) return 1
      if (be === null) return -1
      return ae < be ? -1 : 1
    }
    const so = (a.sortOrder ?? 0) - (b.sortOrder ?? 0)
    if (so) return so
    return String(a.id ?? '') < String(b.id ?? '') ? -1 : String(a.id ?? '') > String(b.id ?? '') ? 1 : 0
  })
}

function currentIndex(sorted, now) {
  const today = warsawToday(now)
  return sorted.findIndex((t) => t.endsOn == null || t.endsOn >= today)
}

/**
 * The tier in force at `now`: a tier with endsOn = D is current through 23:59:59.999 Europe/Warsaw
 * on D. Null when there are no tiers, or every tier has ended and none is open-ended.
 */
export function currentTier(tiers, now = new Date()) {
  const sorted = sortTiers(tiers ?? [])
  const i = currentIndex(sorted, now)
  return i < 0 ? null : sorted[i]
}

/** The tier after the current one and the Warsaw day it starts, or null in the last tier. */
export function nextTier(tiers, now = new Date()) {
  const sorted = sortTiers(tiers ?? [])
  const i = currentIndex(sorted, now)
  if (i < 0 || sorted[i].endsOn == null || i + 1 >= sorted.length) return null
  return { tier: sorted[i + 1], from: dayAfter(sorted[i].endsOn) }
}

/**
 * 1–5 tiers in the order given; only the last is open-ended (endsOn null). The dated ones strictly
 * increase, start no earlier than opensOn and end before closesOn.
 * Every date here, `endsOn`, `opensOn` and `closesOn`, is a Warsaw calendar day as 'YYYY-MM-DD'
 * (the wizard's „Zapisy online od/do” fields). Compared as strings, so a caller holding
 * opens_at / closes_at timestamps converts them first: opensOn = warsawToday(opens_at), closesOn =
 * warsawToday(closes_at - 1 ms), the last open day. A timestamp passed here is refused.
 * @returns {{ ok: boolean, errors: Record<string, string> }}
 */
export function validateTiers(tiers, { opensOn, closesOn } = {}) {
  const fail = (message) => ({ ok: false, errors: { tiers: message } })
  for (const day of [opensOn, closesOn]) {
    if (day != null && !isIsoDate(day)) return fail(TIERS_ORDER_MESSAGE)
  }
  if (!Array.isArray(tiers) || tiers.length < 1 || tiers.length > MAX_TIERS) return fail(TIERS_COUNT_MESSAGE)
  const last = tiers.length - 1
  for (let i = 0; i < tiers.length; i++) {
    const endsOn = tiers[i]?.endsOn ?? null
    if ((endsOn == null) !== (i === last)) return fail(TIERS_OPEN_MESSAGE)
    if (endsOn == null) continue
    if (!isIsoDate(endsOn)) return fail(TIERS_ORDER_MESSAGE)
    if (i > 0 && !(endsOn > tiers[i - 1].endsOn)) return fail(TIERS_ORDER_MESSAGE)
    if (opensOn && endsOn < opensOn) return fail(TIERS_ORDER_MESSAGE)
    if (closesOn && !(endsOn < closesOn)) return fail(TIERS_ORDER_MESSAGE)
  }
  return { ok: true, errors: {} }
}

function grosze(value, name, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new MoneyError(`invalid_amount:${name}`)
  return value
}

/**
 * list − floor(list × percent / 100): the discount rounds down, so the price rounds up by at most
 * 1 grosz (4999 at 15% → 4250). A null percent is no voucher.
 */
export function discountedPrice(list, percent) {
  grosze(list, 'list', MAX_LIST_PRICE)
  if (percent === null) return list
  if (!Number.isInteger(percent) || percent < 1 || percent > 100) throw new MoneyError('invalid_percent')
  return list - Math.floor((list * percent) / 100)
}

/**
 * One order: per person the (discounted) entry and their extras, plus one donation.
 * @returns {{ lines: { listPrice, discount, price, extrasTotal }[], entryTotal, extrasTotal, donation, total }}
 */
export function cartAmounts({ people, donation = 0 } = {}) {
  if (!Array.isArray(people) || people.length === 0) throw new MoneyError('invalid_amount:people')
  let extrasTotal = 0
  const lines = people.map((person) => {
    const listPrice = grosze(person?.listPrice, 'listPrice', MAX_LIST_PRICE)
    const price = discountedPrice(listPrice, person.voucherPercent ?? null)
    let lineExtras = 0
    for (const extra of person.extras ?? []) {
      lineExtras += grosze(extra?.price, 'extraPrice', MAX_LIST_PRICE) * grosze(extra?.qty, 'extraQty')
      grosze(lineExtras, 'extrasTotal') // past 2^53 the sum is no longer exact: refuse it there
    }
    extrasTotal += lineExtras
    return { listPrice, discount: listPrice - price, price, extrasTotal: lineExtras }
  })
  return { lines, ...orderAmounts({ entryPrices: lines.map((l) => l.price), extrasTotal, donation }) }
}

/** RA4's voucher line: '60,00 zł − 15% (KOD) = 51,00 zł'. Throws if the price does not follow. */
export function voucherLineLabel({ listPrice, percent, code, price }) {
  if (discountedPrice(listPrice, percent) !== price) throw new MoneyError('invalid_amount:price')
  return `${formatPln(listPrice)} − ${percent}% (${code}) = ${formatPln(price)}`
}
