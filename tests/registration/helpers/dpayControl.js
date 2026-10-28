// Test-side control of the mocked dpay (helpers/dpayMock.js) over HTTP, so it works the same whether
// the mock runs in the test process or standalone (CI, `node tests/registration/helpers/dpayMock.js &`).
import { DPAY_MOCK_PORT, startDpayMock } from './dpayMock.js'

export { startDpayMock }
const base = `http://127.0.0.1:${DPAY_MOCK_PORT}/__control`

async function call(method, op, body) {
  const res = await fetch(`${base}/${op}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`dpay mock ${op}: ${res.status} ${json.error ?? ''}`)
  return json
}

/** Clears transactions, IPNs, refunds and every mode. */
export const dpayReset = () => call('POST', 'reset')

/**
 * Merges modes: registerFails, registerErrorBody (HTTP 200 + error:true), ipnDelayMs, dropIpn,
 * corruptSignature, duplicateIpn, ipnAmountOverride, ipnWithoutEmail, detailsStatus,
 * detailsBodyOverride (the whole details answer), refundFails (500), refundInsufficient (406), refundPending (409),
 * refundBodyOverride (HTTP 200 with that body, nothing refunded), refundHang.
 */
export const dpayMode = (modes) => call('POST', 'mode', modes)

/** [{ id, request, grosze, status, refunded, ipn, createdAt }]; `request` is the register body as sent. */
export const dpayTransactions = async () => (await call('GET', 'transactions')).data

/** Every IPN delivery attempt: [{ txnId, body, responseText, at }] (responseText null on no answer). */
export const dpayIpns = async () => (await call('GET', 'ipns')).data

/** Every refund the mock carried out: [{ txnId, grosze, messageId, at }]. */
export const dpayRefunds = async () => (await call('GET', 'refunds')).data

/** Pays ('paid', sends the signed IPN) or declines a transaction, as the payer would on the pay page. */
export const payMock = (txnId, outcome) => call('POST', 'pay', { txnId, outcome })

/** Re-sends the transaction's last IPN `times` times. */
export const replayIpn = (txnId, { times = 1 } = {}) => call('POST', 'replay', { txnId, times })
