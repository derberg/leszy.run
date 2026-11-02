// What dpay has actually paid back per order: the accepted refunds, automatic and organizer alike.
// A refund still pending or unknown has moved no money yet, so it is not counted. Plain ESM.
import { allRows } from './allRows.js'

const CHUNK = 100

/**
 * @param {object} admin a service-role client
 * @param {string[]} orderIds
 * @returns {Promise<Map<string, number>>} order id → refunded grosze (orders with none are absent)
 */
export async function acceptedRefundTotals(admin, orderIds) {
  const out = new Map()
  for (let i = 0; i < orderIds.length; i += CHUNK) {
    const ids = orderIds.slice(i, i + CHUNK)
    const rows = await allRows(() => admin.from('refunds').select('id, order_id, amount')
      .in('order_id', ids).eq('dpay_status', 'accepted').order('id'))
    for (const r of rows) out.set(r.order_id, (out.get(r.order_id) ?? 0) + r.amount)
  }
  return out
}
