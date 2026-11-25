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

// Why a surcharge ended unpaid or could not move the entry (a payment that arrived then is refunded in full).
const SURCHARGE_ENDED = {
  organizer_cancelled: 'Organizator anulował tę dopłatę. Zgłoszenie zostaje w dotychczasowej konkurencji.',
  buyer_cancelled: 'Zrezygnowano ze zmiany. Zgłoszenie zostaje w dotychczasowej konkurencji.',
  entry_cancelled: 'Zgłoszenie zostało anulowane, więc dopłata nie jest już potrzebna.',
  full: 'Zanim wpłata dotarła, zabrakło miejsc w nowej konkurencji. Zwracamy całą wpłatę; zgłoszenie zostaje w dotychczasowej konkurencji.',
  unavailable: 'Nowa konkurencja nie jest już dostępna. Zwracamy całą wpłatę; zgłoszenie zostaje w dotychczasowej konkurencji.',
  closed: 'Wpłata dotarła po zamknięciu zapisów. Zwracamy całą wpłatę; zgłoszenie zostaje w dotychczasowej konkurencji.',
  entry_changed: 'Zgłoszenie zmieniło się, zanim wpłata dotarła. Zwracamy całą wpłatę.',
}
export const SURCHARGE_LATE_REFUND = 'Wpłata wpłynęła po terminie — zwracamy ją w całości.'

/**
 * The order page's sentence for an expired or cancelled surcharge. A payment that arrived too late
 * (order-status `lateRefund`) is refunded in full, so the page never says it did not arrive; a reason
 * whose own text already says the payment goes back keeps that text.
 */
export function surchargeEndedText(order) {
  const reasonText = order?.status === 'expired' ? null : SURCHARGE_ENDED[order?.cancelledReason]
  if (order?.lateRefund === true && !(reasonText && reasonText.includes('Zwracamy'))) return SURCHARGE_LATE_REFUND
  if (order?.status === 'expired') return `Nie dostaliśmy dopłaty w terminie. Zgłoszenie zostaje w konkurencji ${order.fromCompetition}.`
  return reasonText ?? `Ta dopłata nie jest już ważna. Zgłoszenie zostaje w konkurencji ${order?.fromCompetition}.`
}
