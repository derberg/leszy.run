// Order amounts for online registration. Integer grosze only: no float ever enters a money path,
// and the dpay string format is produced and parsed digit by digit, never via toFixed or parseFloat.
// Plain ESM, no runtime APIs: runs in Deno and Node.

export class MoneyError extends Error {
  constructor(message) {
    super(message)
    this.name = 'MoneyError'
  }
}

// dpay rejects 1000000.00 and above; the largest amount it takes is 999999.99 zł.
export const MAX_DPAY_GROSZE = 99_999_999
const DPAY_VALUE_RE = /^(0|[1-9]\d{0,5})(?:\.(\d{1,2}))?$/

// Every amount is capped at dpay's limit, which also keeps 2e+50 and 9s+990 far below 2^53.
function grosze(value, name) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_DPAY_GROSZE) throw new MoneyError(`invalid_amount:${name}`)
  return value
}

// What a runner pays: the entry prices, plus optional extras and a donation (Plan 7). Nothing in
// it is payable to LESZY.RUN, which invoices the organizer afterwards (legal decision, 2026-10-31).
export function orderAmounts({ entryPrices, extrasTotal = 0, donation = 0 } = {}) {
  if (!Array.isArray(entryPrices)) throw new MoneyError('invalid_amount:entryPrices')
  let entryTotal = 0
  for (const price of entryPrices) entryTotal += grosze(price, 'entryPrices')
  grosze(entryTotal, 'entryTotal')
  grosze(extrasTotal, 'extrasTotal')
  grosze(donation, 'donation')
  return {
    entryTotal,
    extrasTotal,
    donation,
    total: grosze(entryTotal + extrasTotal + donation, 'total'), // the amount dpay charges, so the same cap
  }
}

// dpay's commission on one transaction, a payment or a refund alike: 0.9%, rounded up to the
// grosz, at least 0.20 zł. LESZY.RUN bears it and invoices the organizer (§8 of the organizer
// agreement); it is never taken from the runner's money, so this only informs the organizer.
export function dpayFee(amount) {
  grosze(amount, 'amount')
  return amount === 0 ? 0 : Math.max(20, Math.ceil((amount * 9) / 1000))
}

// dpay's commission on an event so far: one fee per payment dpay took (an attempt `paid`, or
// `refunded` after it was paid) and one per refund dpay accepted, on that refund's own amount. The
// organizer panel shows it beside the club's income, which stays gross: LESZY.RUN pays the
// commission and invoices the club for it (§8), so it is never deducted from what runners paid.
// A refund made in the dpay panel (reason 'external') is recorded as one row per order line it
// covered (record-external-refund.js), so the external rows of one payment count as one refund on
// their sum: per row, the 0,20 zł minimum would be charged once per line. Two separate panel
// refunds of one payment then come out one minimum short, the rarer case. „Zwróć wpłatę” makes one
// dpay refund per row, so each of those is its own fee.
export function dpayCommission({ attempts = [], refunds = [] } = {}) {
  const paid = attempts.filter((a) => a.status === 'paid' || a.status === 'refunded')
    .reduce((n, a) => n + dpayFee(a.grosze), 0)
  const accepted = refunds.filter((f) => f.dpay_status === 'accepted')
  const external = new Map()
  let refunded = 0
  for (const f of accepted) {
    if (f.reason === 'external') external.set(f.payment_attempt_id, (external.get(f.payment_attempt_id) ?? 0) + f.amount)
    else refunded += dpayFee(f.amount)
  }
  for (const amount of external.values()) refunded += dpayFee(amount)
  return paid + refunded
}

function splitZloty(amount) {
  return [Math.floor(amount / 100), String(amount % 100).padStart(2, '0')]
}

// '100,91 zł'
export function formatPln(amount) {
  const [zl, gr] = splitZloty(grosze(amount, 'amount'))
  return `${zl},${gr} zł`
}

// '100.91', the value format dpay expects.
export function formatDpayValue(amount) {
  const [zl, gr] = splitZloty(grosze(amount, 'amount'))
  return `${zl}.${gr}`
}

// Inverse of formatDpayValue. dpay may send '60', '60.5' or '60.50': zero, one or two decimals.
// Sign, spaces, exponent, comma, leading zero, a third decimal or 1000000 and above throw.
export function parseDpayAmount(str) {
  const m = typeof str === 'string' ? DPAY_VALUE_RE.exec(str) : null
  if (!m) throw new MoneyError('invalid_dpay_amount')
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'))
}
