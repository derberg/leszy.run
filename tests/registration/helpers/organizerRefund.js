// The organizer refund pipeline of Plan 6 (D6-18), run in this process against the local stack and
// the mocked dpay, so organizer-concurrency.test.js can race it before the `organizer-refund` edge
// function exists (Plan 6 Task 4). Every step is the real code the function is to call:
//   reserve_organizer_refund → claimRefundRequest (P3-R10) → refundTransaction → the payment_events
//   row (logPaymentEvent) → finish_organizer_refund → an operator alert for every outcome but
//   accepted (raiseAlert, as executeRefund raises refund_<outcome>).
// Ruling 3: a 410 is passed on as `unknown`, never `rejected`. Ruling 5: a replay or a refund some
// other caller already claimed never calls dpay again.
//
// It answers { status, body } the way Task 4's function must, so the race tests read like the
// edge tests. Task 4: replace `organizerRefund` with a callFn('organizer-refund', …) and the
// tests then check the function itself; the HTTP mapping below is the contract written down.
import { localEnv } from './stack.js'
import { db, one, rpc } from './orders.js'
import { DPAY_MOCK_PORT } from './dpayMock.js'
import { dpayConfig, refundTransaction } from '../../../supabase/functions/_shared/dpay.js'
import { claimRefundRequest, logPaymentEvent, raiseAlert } from '../../../supabase/functions/_shared/registration/orderFlow.js'
import { formatPln } from '../../../supabase/functions/_shared/registration/money.js'

export const UNCONFIRMED = 'Zwrot niepotwierdzony.'
export const INSUFFICIENT = 'Operator płatności odrzucił zwrot: brak środków.'
export const REJECTED = 'Operator płatności odrzucił zwrot.'
export const RACE_DAY = 'Zwroty są zamknięte od dnia zawodów.'
export const exceedsCopy = (grosze) => `Kwota przekracza możliwą do zwrotu: ${formatPln(grosze)}.`

/** The mocked dpay as the functions reach it, from the host. `timeoutMs` shortens the refund wait. */
export const nodeDpay = ({ timeoutMs } = {}) => {
  const cfg = dpayConfig({
    DPAY_SERVICE: 'mock-service', DPAY_SECRET: 'mock-secret',
    DPAY_API_BASE: `http://127.0.0.1:${DPAY_MOCK_PORT}`, DPAY_PANEL_BASE: `http://127.0.0.1:${DPAY_MOCK_PORT}`,
    DPAY_IPN_URL: `${localEnv().url}/functions/v1/dpay-ipn`, PUBLIC_SITE_URL: 'http://localhost:5173',
  })
  return timeoutMs ? { ...cfg, timeoutMs } : cfg
}

/** The answer for a refund row whose dpay call this caller did not make (a replay, a lost claim). */
function answerFor(refund, cancelled = []) {
  const s = refund.dpay_status
  if (s === 'accepted') return { status: 200, body: { data: { status: 'accepted', cancelled, refundId: refund.id } } }
  if (s === 'insufficient_balance') return { status: 409, body: { error: INSUFFICIENT, code: s, refundId: refund.id } }
  if (s === 'rejected') return { status: 409, body: { error: REJECTED, code: s, refundId: refund.id } }
  return { status: 202, body: { data: { status: 'unknown', refundId: refund.id }, message: UNCONFIRMED } }
}

function refusal(message) {
  const exceeds = /^exceeds:(\d+)$/.exec(message ?? '')
  if (exceeds) {
    const remaining = Number(exceeds[1])
    return { status: 409, body: { error: exceedsCopy(remaining), code: 'exceeds', remaining } }
  }
  if (message === 'race_day') return { status: 409, body: { error: RACE_DAY, code: message } }
  if (message === 'not_found') return { status: 404, body: { error: 'Nie znaleziono.' } }
  return { status: 409, body: { error: message, code: message } }
}

/**
 * One organizer refund: { lineId, grosze, requestKey, actor, cfg? } → { status, body }.
 * 200 accepted (body.data.cancelled), 202 unknown/pending, 409 exceeds / race_day /
 * insufficient_balance / rejected / request_key_mismatch.
 */
export async function organizerRefund({ lineId, grosze, requestKey, actor, cfg = nodeDpay() }) {
  const reserved = await rpc('reserve_organizer_refund', {
    p_line_id: lineId, p_grosze: grosze, p_actor: actor, p_request_key: requestKey,
  })
  if (reserved.error) return refusal(reserved.error.message)
  const { refundId, messageId, transactionId } = reserved.data
  const refund = await one('refunds', { id: refundId })
  if (reserved.data.replay || !(await claimRefundRequest(db(), refundId))) return answerFor(refund)

  let result
  try {
    result = await refundTransaction(cfg, { transactionId, grosze, messageId })
  } catch (err) {
    result = { outcome: 'unknown', httpStatus: null, message: String(err?.message ?? err) }
  }
  // Ruling 3: dpay's 410 says the transaction is refunded already, perhaps by an earlier refund
  // that was never confirmed: not a clean refusal.
  const outcome = result.httpStatus === 410 ? 'unknown' : result.outcome
  await logPaymentEvent(db(), {
    kind: 'refund', orderId: refund.order_id, attemptId: refund.payment_attempt_id,
    payload: { refundId, reason: 'organizer', grosze, txn: transactionId, source: 'organizer',
      outcome, httpStatus: result.httpStatus, message: result.message },
  })
  const finished = await rpc('finish_organizer_refund', { p_refund_id: refundId, p_outcome: outcome })
  if (finished.error) throw new Error(`finish_organizer_refund: ${finished.error.message}`)
  if (finished.data.settled === 'already_settled') return answerFor(await one('refunds', { id: refundId }))
  if (outcome !== 'accepted') {
    await raiseAlert(db(), `refund_${outcome}`, refund.order_id, {
      refundId, txn: transactionId, grosze, reason: 'organizer', httpStatus: result.httpStatus,
    })
  }
  return answerFor({ ...refund, dpay_status: outcome }, finished.data.cancelled)
}
