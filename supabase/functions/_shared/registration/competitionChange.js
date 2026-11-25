// Moving a registration to another competition: the quote and the refusal table.
// Pure, integer grosze, no I/O. Plain ESM: runs in Deno and Node.

import { discountedPrice } from './pricing.js'

/**
 * What the entry costs in the target competition and how it differs from what the holder paid.
 * A voucher is kept only when it is offered in the target (voucherCoversTarget); a free target
 * (list 0) is 0 whatever the voucher.
 * @returns {{ listPrice: number, price: number, difference: number, voucherKept: boolean }}
 */
export function changeQuote({ held, listPriceTarget, voucherPercent = null, voucherCoversTarget = false }) {
  const keep = Boolean(voucherCoversTarget) && voucherPercent != null && listPriceTarget > 0
  const price = keep ? discountedPrice(listPriceTarget, voucherPercent) : listPriceTarget
  return { listPrice: listPriceTarget, price, difference: price - held, voucherKept: keep }
}

/** @returns {'same' | 'refund' | 'surcharge'} */
export function changeKind(difference) {
  if (difference < 0) return 'refund'
  if (difference > 0) return 'surcharge'
  return 'same'
}

// Online payment stops an hour before closes_at (spec 14.10; create_order's and change_competition's
// paying_closed). The one JS copy of that rule.
export const PAYING_CLOSES_BEFORE_MS = 3600_000

const REFUSALS = {
  edits_closed: [409, 'Zmiana konkurencji jest już niemożliwa.'],
  team_competition: [422, 'Zgłoszenia drużynowego nie można przenieść do innej konkurencji.'],
  refund_pending: [409, 'Trwa zwrot wpłaty za to zgłoszenie — zmiana konkurencji jest niemożliwa.'],
  surcharge_open: [409, 'Ta zmiana czeka już na dopłatę.'],
  transfer_open: [409, 'Pakiet jest w trakcie przekazania — zmiana konkurencji jest niemożliwa.'],
  unavailable: [409, 'Ta konkurencja jest niedostępna.'],
  full: [409, 'Brak wolnych miejsc w tej konkurencji.'],
  ineligible: [422, 'Zawodnik nie spełnia warunków tej konkurencji.'],
  role_change: [422, 'Zmiana nie może zamienić zgłoszenia osoby dorosłej w zgłoszenie dziecka ani odwrotnie.'],
  no_price: [422, 'Ta konkurencja nie ma ceny w obecnym progu.'],
  no_payer: [422, 'Nie ma płatnika, któremu można zwrócić pieniądze.'],
  same_competition: [422, 'Zgłoszenie jest już w tej konkurencji.'],
  price_changed: [409, 'Cena się zmieniła — odśwież i spróbuj ponownie.'],
  race_day: [409, 'W dniu zawodów zmiana konkurencji jest już niemożliwa.'],
  offline_paid: [409, 'To zgłoszenie opłacono poza systemem — zmiana konkurencji jest niemożliwa.'],
  not_live: [409, 'To zgłoszenie nie jest aktywne.'],
  // The runner's own change or edit (my-entry-action), refused by the club's switch.
  not_allowed: [403, 'Organizator nie zezwala na tę zmianę.'],
  // runner_edit_registration's own: a name or the e-mail, a key it does not know, a team member
  // who is not the captain (my-entry-action answers 404 for that before the RPC).
  field_not_allowed: [422, 'Imię, nazwisko i adres e-mail zmienia tylko organizator.'],
  invalid_field: [422, 'Popraw zaznaczone pola.'],
  team_member: [404, 'Nie znaleźliśmy tego zgłoszenia albo konkurencji.'],
  // change_competition's own, and what it passes on from reserve_organizer_refund (task 7).
  paying_closed: [409, 'Płatność online jest już zamknięta: kończy się godzinę przed zamknięciem zapisów. Dopłaty nie można już utworzyć.'],
  request_key_mismatch: [409, 'To żądanie dotyczy innej zmiany. Otwórz okno zmiany konkurencji jeszcze raz.'],
  refund_in_progress: [409, 'Trwa inny zwrot z tej wpłaty. Spróbuj ponownie za kilka minut.'],
  exceeds: [409, 'Różnica przekracza kwotę możliwą do zwrotu.'],
  invalid_kind: [400, 'Nieprawidłowe żądanie.'],
  invalid_request_key: [400, 'Nieprawidłowe żądanie.'],
  invalid_amount: [422, 'Nieprawidłowa kwota zwrotu.'],
  not_paid: [409, 'To zgłoszenie nie jest opłacone.'],
  entry_changed: [409, 'Zgłoszenie zmieniło się — odśwież listę.'],
  not_found: [404, 'Nie znaleźliśmy tego zgłoszenia albo konkurencji.'],
  change_retry: [409, 'Zgłoszenie zmieniło się w trakcie — spróbuj ponownie.'],
  // organizer_mark_paid_offline on a surcharge order, cancel_surcharge on any other order.
  surcharge: [409, 'To dopłata za zmianę konkurencji: płaci się ją online, nie można jej oznaczyć jako opłaconej poza systemem.'],
  not_surcharge: [409, 'To zamówienie nie jest dopłatą za zmianę konkurencji.'],
  dpay_not_configured: [503, 'Płatności online są chwilowo niedostępne.'],
}

// The runner's own wording where the club's would tell them to do what only the club can.
const RUNNER_REFUSALS = {
  offline_paid: [409, 'To zgłoszenie opłacono u organizatora: o zmianę na tańszą konkurencję poproś organizatora.'],
}

/**
 * @param {string} code
 * @param {{ runner?: boolean }} [opts] the runner's own copy (my-entry-action) where it differs
 * @returns {{ status: number, error: string, code: string }}
 */
export function changeRefusal(code, { runner = false } = {}) {
  const r = runner && Object.hasOwn(RUNNER_REFUSALS, code) ? RUNNER_REFUSALS[code]
    : Object.hasOwn(REFUSALS, code) ? REFUSALS[code] : null
  if (!r) throw new Error(`unknown change refusal: ${code}`)
  return { status: r[0], error: r[1], code }
}
