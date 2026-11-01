// check-voucher's decision (Plan 7, task 8a), pure so the unit tests and the function share it.
// The same reasons, in the same order, as the SQL that create_order uses
// (registration_voucher_refusal, then voucher_not_applicable on a 0 zł entry), so a code the field
// accepts is a code the order accepts, unless something changes in between. Plain ESM.

import { discountedPrice } from './pricing.js'

/**
 * Why `voucher` cannot discount an entry in `categoryId` at `now`, or null when it can.
 * `voucher`: the event's row for the normalised code ({ percent, used, max_uses, valid_until,
 * disabled_at }), or null when the event has no such code (or the code is malformed).
 * `linkedCategoryIds`: the voucher's competitions (none = every competition).
 * `listPrice`: the competition's current list price in grosze (0 on a free event).
 * → 'voucher_invalid' | 'voucher_expired' | 'voucher_category' | 'voucher_used_up'
 *   | 'voucher_not_applicable' | null
 */
export function voucherRefusal({ voucher, linkedCategoryIds = [], categoryId, listPrice, now = new Date() }) {
  if (!voucher || voucher.disabled_at) return 'voucher_invalid'
  if (voucher.valid_until && Date.parse(voucher.valid_until) <= now.getTime()) return 'voucher_expired'
  const linked = linkedCategoryIds.map((id) => String(id).toLowerCase())
  if (linked.length && !linked.includes(String(categoryId).toLowerCase())) return 'voucher_category'
  if (voucher.used >= voucher.max_uses) return 'voucher_used_up'
  if (listPrice === 0) return 'voucher_not_applicable'
  return null
}

/** The answer of an accepted code: its percent and the entry's price after it. Nothing else. */
export function voucherAnswer({ percent, listPrice }) {
  return { percent, price: discountedPrice(listPrice, percent) }
}
