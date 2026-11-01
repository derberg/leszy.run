// The voucher invariant of plan 7: a voucher's `used` equals the live registrations
// (pending_payment or confirmed) holding it. A use is released when its registration leaves live as
// cancelled or expired, never on transferred_out (the recipient's new registration takes the voucher
// over) or a partial refund. Every DB test that touches a voucher calls it in afterEach.
import { db, one } from './orders.js'

const LIVE = ['pending_payment', 'confirmed']

/** The live registrations holding the voucher. */
export async function liveVoucherUses(voucherId) {
  const { count, error } = await db().from('registrations').select('id', { count: 'exact', head: true })
    .eq('voucher_id', voucherId).in('status', LIVE)
  if (error) throw error
  return count
}

/** Throws with both numbers when vouchers.used and the live registrations holding it disagree. */
export async function assertVoucherInvariant(voucherId) {
  const voucher = await one('vouchers', { id: voucherId })
  if (!voucher) throw new Error(`Voucher invariant: no voucher ${voucherId}`)
  const live = await liveVoucherUses(voucherId)
  if (voucher.used !== live) {
    throw new Error(`Voucher invariant broken for ${voucher.code} (${voucherId}): used ${voucher.used}, live registrations ${live}`)
  }
}
