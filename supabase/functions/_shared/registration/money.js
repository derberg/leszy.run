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
