// RA2/RB1's „Sprawdź” (Plan 7): check-voucher's answer for one code, as the card's voucher state.
// A refusal of the code itself is 'error' and stays on the field. A 429, a server failure or no
// connection is 'unchecked': the form goes on, and create-order (behind the e-mail code) decides
// the code (task 8a review I-1: a guesser can exhaust an event's check budget, and that must not
// lock honest runners out of „Dalej”).
import { callFunction } from './auth.js'

export const NO_CONNECTION = 'Nie udało się połączyć. Spróbuj ponownie.'

/**
 * → { state: 'ok', percent, price } | { state: 'error', error } | { state: 'unchecked', note }
 */
export async function checkVoucherCode({ slug, categoryId, code }, call = callFunction) {
  try {
    const r = await call('check-voucher', { slug, categoryId, code })
    return { state: 'ok', percent: r.data.percent, price: r.data.price }
  } catch (err) {
    if (err.status == null) return { state: 'unchecked', note: NO_CONNECTION }
    if (err.status === 429 || err.status >= 500) return { state: 'unchecked', note: err.message }
    return { state: 'error', error: err.message }
  }
}
