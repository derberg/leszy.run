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
const MIN_PAYMENT_FEE = 20
const DPAY_VALUE_RE = /^(0|[1-9]\d{0,5})\.(\d{2})$/

function grosze(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new MoneyError(`invalid_amount:${name}`)
  return value
}

// LESZY.RUN 2% of the entry fees (not extras or donations), rounded half up.
export function supportFee(entryTotal, choice) {
  grosze(entryTotal, 'entryTotal')
  if (typeof choice !== 'boolean') throw new MoneyError('support_choice_required')
  return choice ? Math.floor((2 * entryTotal + 50) / 100) : 0
}

// dpay takes 0.9% of the whole charged amount (min 0.20 zł), so the fee is grossed up:
// the smallest f >= 20 with f * 991 >= 9 * subtotal, i.e. ceil(subtotal * 9 / 991).
export function paymentFee(subtotal) {
  grosze(subtotal, 'subtotal')
  if (subtotal === 0) return 0
  return Math.max(MIN_PAYMENT_FEE, Math.floor((subtotal * 9 + 990) / 991))
}

// The support choice is asked only when entry fees are due; nothing is preselected (Art. 10
// ustawy o prawach konsumenta), so a paid order without a boolean choice is refused.
export function orderAmounts({ entryPrices, extrasTotal = 0, donation = 0, supportChoice } = {}) {
  if (!Array.isArray(entryPrices)) throw new MoneyError('invalid_amount:entryPrices')
  let entryTotal = 0
  for (const price of entryPrices) entryTotal += grosze(price, 'entryPrices')
  grosze(entryTotal, 'entryTotal')
  grosze(extrasTotal, 'extrasTotal')
  grosze(donation, 'donation')

  const supportChoiceShown = entryTotal > 0
  const fee = supportChoiceShown ? supportFee(entryTotal, supportChoice) : 0
  const subtotal = grosze(entryTotal + extrasTotal + donation + fee, 'subtotal')
  const pFee = paymentFee(subtotal)
  return {
    entryTotal,
    extrasTotal,
    donation,
    supportFee: fee,
    subtotal,
    paymentFee: pFee,
    total: subtotal + pFee,
    supportChoiceShown,
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
  grosze(amount, 'amount')
  if (amount > MAX_DPAY_GROSZE) throw new MoneyError('invalid_amount:amount')
  const [zl, gr] = splitZloty(amount)
  return `${zl}.${gr}`
}

// Inverse of formatDpayValue. Anything that is not exactly N.NN (no sign, spaces, exponent,
// comma, leading zero or third decimal) throws.
export function parseDpayAmount(str) {
  const m = typeof str === 'string' ? DPAY_VALUE_RE.exec(str) : null
  if (!m) throw new MoneyError('invalid_dpay_amount')
  return Number(m[1]) * 100 + Number(m[2])
}
