// The organizer panel's status of one entry (B3). The server derives it, the panel and the CSV
// show it. Plain ESM, no runtime APIs beyond Intl: runs in Deno, Node and the browser.
import { warsawToday } from './dates.js'
import { formatDpayValue } from './money.js'

const FINAL_STATUS = { expired: 'expired', cancelled: 'cancelled', transferred_out: 'transferred' }
const UNCONFIRMED = new Set(['pending', 'unknown'])

const LABELS = {
  free: 'NA LIŚCIE',
  paid: 'OPŁACONE',
  awaiting: 'CZEKA NA WPŁATĘ',
  expired: 'WYGASŁO',
  cancelled: 'ANULOWANE',
  transferred: 'PRZEPISANY',
  refund_unconfirmed: 'ZWROT NIEPOTWIERDZONY',
  withdraw_on_host: 'WYCOFAJ W PANELU POMIARU',
}

const unconfirmed = (refund) => refund.kind === 'organizer' && UNCONFIRMED.has(refund.dpay_status)

/**
 * Grosze reserved by organizer refunds dpay has not confirmed. They sit in `refunded` on the line
 * and the registration from the moment of reservation, so subtract them to get what really left.
 * @param {{ refunds?: { kind: string, dpay_status: string, amount: number }[] }} row
 */
export function unconfirmedRefundGrosze(row) {
  return (row.refunds ?? []).filter(unconfirmed).reduce((sum, refund) => sum + refund.amount, 0)
}

/**
 * @param {object} row  `status`, `paymentStatus` (paymentStatusOf), `expiresAt`, the row's `refunds`
 *   ({ kind, dpay_status }) and its `participant` ({ removed_at, withdrawn_at }, null when it has none)
 * @param {Date} now
 * @returns {'free'|'paid'|'awaiting'|'expired'|'cancelled'|'transferred'|'refund_unconfirmed'|'withdraw_on_host'}
 */
export function entryStatusKey(row, now) {
  if (row.refunds?.some(unconfirmed)) return 'refund_unconfirmed'
  const { participant } = row
  // A cancelled entry, or one whose package was handed on after closes_at (D7-24): the host owns the
  // participant from then on, so its runner must be withdrawn there by hand.
  const left = row.status === 'cancelled' || row.status === 'transferred_out'
  if (left && participant && !participant.removed_at && !participant.withdrawn_at) return 'withdraw_on_host'
  if (row.status === 'confirmed') {
    // A missing paymentStatus must not quietly turn a paid entry into a free one.
    if (row.paymentStatus !== 'paid' && row.paymentStatus !== 'free') throw new Error('missing_payment_status')
    return row.paymentStatus
  }
  if (row.status === 'pending_payment') {
    // A lapsed order stays pending until the next job run, but nobody can pay it any more.
    return row.expiresAt && new Date(row.expiresAt) <= now ? 'expired' : 'awaiting'
  }
  return FINAL_STATUS[row.status]
}

// '4.11': the Warsaw day of the instant, month always two digits.
function warsawDayMonth(instant) {
  const [, month, day] = warsawToday(new Date(instant)).split('-')
  return `${Number(day)}.${month}`
}

// '20' or '20,50'.
function wholeZloty(amount) {
  return formatDpayValue(amount).replace('.00', '').replace('.', ',')
}

/**
 * The status as the panel and the CSV print it.
 * @param {string} key  from entryStatusKey
 * @param {{ expiresAt?: string, refunded?: number, paidAmount?: number, autoRefundReason?: string|null }} [row]
 */
export function statusLabel(key, row = {}) {
  let label = LABELS[key]
  if (key === 'awaiting' && row.expiresAt) label += ` · DO ${warsawDayMonth(row.expiresAt)}`
  // An unconfirmed refund sits in `refunded` too, and its label already says what is known.
  const partial = key !== 'refund_unconfirmed' && row.refunded > 0 && row.refunded < row.paidAmount
  if (partial) label += ` · ZWROT ${wholeZloty(row.refunded)} ZŁ`
  if (row.autoRefundReason === 'full') label += ' · ZWROT: BRAK MIEJSC'
  return label
}
