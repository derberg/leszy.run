// RA4 (Podsumowanie) as display values: the entry fees, the LESZY.RUN support
// choice, the dpay fee and the total, from money.js (the same integer module
// the edge functions and the SQL mirror use). Pure, so the page and the unit
// tests call the same function.
//
// The support choice (Art. 10 ustawy o prawach konsumenta) is asked only when
// entry fees are due, and nothing is preselected: `choice` starts null and
// „Zapłać” stays disabled until the runner presses one of the two buttons.
// Before that the total shown is the one without support, never one with a
// support the runner did not pick.
import { formatPln, orderAmounts } from '../../../supabase/functions/_shared/registration/money.js'

export const SUPPORT_QUESTION = 'Wesprzesz LESZY.RUN 2%?'
export const SUPPORT_REASON = 'Z tego utrzymujemy stronę, zapisy i kalendarz.'
export const SUPPORT_HINT = '* wybierz, czy wspierasz LESZY.RUN'

/**
 * @param {{ entryPrices: number[], choice: boolean|null, busy?: boolean, closed?: boolean }} p
 */
export function checkoutModel({ entryPrices, choice, busy = false, closed = false }) {
  const shown = orderAmounts({ entryPrices, supportChoice: choice === true })
  const askSupport = shown.supportChoiceShown
  const ifSupported = askSupport ? orderAmounts({ entryPrices, supportChoice: true }).supportFee : 0
  const chosen = !askSupport || typeof choice === 'boolean'
  return {
    askSupport,
    options: askSupport
      ? [
        { value: true, label: `Wspieram · ${formatPln(ifSupported)}`, pressed: choice === true },
        { value: false, label: 'Nie tym razem', pressed: choice === false },
      ]
      : [],
    // What create-order gets: a boolean always (the server refuses anything else,
    // also for a 0 zł entry), null while the runner has not chosen.
    supportChoice: askSupport ? (chosen ? choice : null) : false,
    amounts: shown,
    entryLabel: formatPln(shown.entryTotal),
    supportLabel: formatPln(shown.supportFee),
    paymentFeeLabel: formatPln(shown.paymentFee),
    totalLabel: formatPln(shown.total),
    displayedTotal: shown.total,
    payDisabled: !chosen || busy || closed,
    hint: chosen ? null : SUPPORT_HINT,
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
