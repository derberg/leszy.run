// RA4 (Podsumowanie) as display values, from money.js (the same integer module the edge functions
// use). Pure, so the page and the unit tests call the same function. A runner pays the entry
// prices and nothing to LESZY.RUN, so „Zapłać” depends only on the page being busy or closed.
import { formatPln, orderAmounts } from '../../../supabase/functions/_shared/registration/money.js'

/**
 * @param {{ entryPrices: number[], busy?: boolean, closed?: boolean }} p
 */
export function checkoutModel({ entryPrices, busy = false, closed = false }) {
  const shown = orderAmounts({ entryPrices })
  return {
    amounts: shown,
    totalLabel: formatPln(shown.total),
    displayedTotal: shown.total,
    payDisabled: busy || closed,
  }
}

// When an online payment may start (both mirror the server, which decides):
// plan ruling 7, a new paid order stops one hour before closes_at (create_order
// raises paying_closed); the user decision, an existing order's pay link starts
// no new payment from closes_at on (pay-order answers „Zapisy są zamknięte.”).
export const PAYING_CLOSES_BEFORE_MS = 60 * 60 * 1000
export const PAYING_CLOSED_TEXT = 'Zapisy z płatnością online kończą się godzinę przed zamknięciem zapisów.'

const closesMs = (closesAt) => (closesAt ? Date.parse(closesAt) : NaN)

/** RA4: may a new paid order start now? Unknown closesAt → yes (the server still refuses). */
export function newOrderPayable(closesAt, now = new Date()) {
  const t = closesMs(closesAt)
  return Number.isNaN(t) || now.getTime() < t - PAYING_CLOSES_BEFORE_MS
}

/** The order page: may „Zapłać” start a new dpay transaction now? */
export function payLinkOpen(closesAt, now = new Date()) {
  const t = closesMs(closesAt)
  return Number.isNaN(t) || now.getTime() < t
}

/**
 * RA4 after a 409 price_changed: every line at the server's new price, or null when the
 * answer cannot price each line (the page then starts again from a fresh event page, so a
 * new total never sits beside stale line amounts). create-order answers `entryPrices` in
 * request order, one per person; a single person's line may also take `entryTotal` alone.
 * @param {Array<{ priceGrosze: number }>} lines @param {object|null} amounts
 */
export function repriceLines(lines, amounts) {
  if (!amounts || !Array.isArray(lines) || lines.length === 0) return null
  const { entryPrices, entryTotal } = amounts
  if (Array.isArray(entryPrices)) {
    if (entryPrices.length !== lines.length || !entryPrices.every(grosze)) return null
    if (entryTotal != null && entryPrices.reduce((s, p) => s + p, 0) !== entryTotal) return null
    return lines.map((l, i) => ({ ...l, priceGrosze: entryPrices[i] }))
  }
  if (lines.length === 1 && grosze(entryTotal)) return [{ ...lines[0], priceGrosze: entryTotal }]
  return null
}

const grosze = (n) => Number.isSafeInteger(n) && n >= 0

/** Re-priced lines as { categoryId: price }, so „Wróć” keeps the server's prices on the form. */
export function repricedByCategory(lines) {
  const out = {}
  for (const l of lines ?? []) if (l.categoryId && grosze(l.priceGrosze)) out[l.categoryId] = l.priceGrosze
  return out
}

// Refusals that belong to the form's cards or the code step (ZapisView's groupFailure routes
// them: `index` to that person's card, `full` to the competition select of the added cards in
// that competition, `refused` as the form's message). `full` goes back only when an added card
// can change its competition there: for a single runner, or when only card 1 is in it, the form
// has nothing to change, so it stays Plan 3's RA4 message. Everything else is about the payment
// and stays on RA4.
const BACK_TO_FORM = new Set(['invalid_person', 'email_retired', 'duplicate', 'consents_required', 'consents_changed', 'refused'])

/**
 * Does this create-order refusal send the payer back to the form?
 * @param {Error & { status?, code?, categoryId? }} err
 * @param {string[]} addedCategoryIds the competitions of the added cards (card 2 on)
 */
export function backToForm(err, addedCategoryIds = []) {
  if (!err || err.status == null) return false
  if (err.status === 401) return true
  if (err.code === 'full') {
    const id = typeof err.categoryId === 'string' ? err.categoryId.toLowerCase() : ''
    return id !== '' && addedCategoryIds.some((c) => String(c).toLowerCase() === id)
  }
  return BACK_TO_FORM.has(err.code)
}
