// A paid order can end without its status changing: the organizer cancels every entry (with or
// without a refund) and the order stays `paid`, because the money did arrive. The order page and
// „Moje zapisy” must not say „Opłacone · Jesteście na liście” then.

/** True when a paid order's entries are all cancelled (order-status marks each line). */
export function paidOrderCancelled(order) {
  const lines = order?.lines ?? []
  return order?.status === 'paid' && lines.length > 0 && lines.every((l) => l.cancelled === true)
}

/** 'full' when dpay paid back the whole total, 'partial' for less, null for nothing. */
export function refundState(total, refunded) {
  if (!(refunded > 0)) return null
  return refunded >= total ? 'full' : 'partial'
}
