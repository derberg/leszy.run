// The one place that talks to dpay. Plain ESM on fetch + WebCrypto: runs in Deno (edge functions) and
// Node (tests, against tests/registration/helpers/dpayMock.js). Every dpay response shape we rely on is
// read here and nowhere else. Amounts are integer grosze; the dpay string form goes only through
// formatDpayValue / parseDpayAmount.
import { formatDpayValue, parseDpayAmount, MoneyError } from './registration/money.js'
import {
  registerChecksum,
  ipnSignature,
  detailsChecksum,
  refundChecksum,
  safeEqualHex,
} from './registration/dpaySign.js'

export class DpayConfigError extends Error {
  constructor(missing) {
    super(`dpay not configured: ${missing.join(', ')}`)
    this.name = 'DpayConfigError'
    this.missing = missing
  }
}

export class DpayError extends Error {
  /** httpStatus is null when no HTTP answer came back (timeout, network). */
  constructor(httpStatus, message) {
    super(message)
    this.name = 'DpayError'
    this.httpStatus = httpStatus
  }
}

const REQUIRED_ENV = ['DPAY_SERVICE', 'DPAY_SECRET', 'DPAY_API_BASE', 'DPAY_PANEL_BASE', 'DPAY_IPN_URL', 'PUBLIC_SITE_URL']
const URL_ENV = new Set(['DPAY_API_BASE', 'DPAY_PANEL_BASE', 'DPAY_IPN_URL', 'PUBLIC_SITE_URL'])
const TIMEOUT_MS = 10_000
// https://docs.dpay.pl/docs/cykl-platnosci/statusy-transakcji/
const KNOWN_STATUSES = new Set(['created', 'processing', 'paid', 'captured', 'expired'])
// https://docs.dpay.pl/docs/cykl-platnosci/zwroty/ (DigitalPayments-PSP-Message-ID, at most 24 characters)
const MAX_MESSAGE_ID = 24
// dpay's answer of 2026-11-03: /pbl/details is cached for a few seconds, so a refund ordered just now
// may not show yet; they advise waiting about 10 s before reading it to judge a refund.
const REFUND_VERIFY_DELAY_MS = 10_000

function isHttpUrl(v) {
  try {
    const u = new URL(v)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Reads the dpay settings from `env`: a plain object (process.env, a test literal) or anything with
 * `get(key)` (Deno.env). Throws DpayConfigError naming every missing or malformed key; never falls back.
 */
export function dpayConfig(env) {
  const read = (k) => (typeof env?.get === 'function' ? env.get(k) : env?.[k])
  const values = {}
  const bad = []
  for (const key of REQUIRED_ENV) {
    const v = read(key)
    if (typeof v !== 'string' || v.trim() === '' || (URL_ENV.has(key) && !isHttpUrl(v))) bad.push(key)
    else values[key] = v.trim()
  }
  if (bad.length) throw new DpayConfigError(bad)
  // Optional, for the local test stack, whose mock answers at once: how long verifyRefund waits.
  // Anything but a whole number of milliseconds up to a minute keeps dpay's 10 s.
  const delay = read('DPAY_REFUND_VERIFY_DELAY_MS')
  const refundVerifyDelayMs = typeof delay === 'string' && /^\d{1,5}$/.test(delay.trim()) && Number(delay) <= 60_000
    ? Number(delay) : REFUND_VERIFY_DELAY_MS
  const noSlash = (u) => u.replace(/\/+$/, '')
  return {
    service: values.DPAY_SERVICE,
    secret: values.DPAY_SECRET,
    apiBase: noSlash(values.DPAY_API_BASE),
    panelBase: noSlash(values.DPAY_PANEL_BASE),
    ipnUrl: values.DPAY_IPN_URL,
    publicSiteUrl: noSlash(values.PUBLIC_SITE_URL),
    timeoutMs: TIMEOUT_MS,
    refundVerifyDelayMs,
  }
}

// POST JSON; the timeout covers the body read too. Returns { status, text, json } or throws
// DpayError(null, 'timeout' | 'network').
async function postJson(cfg, url, body, headers = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      // dpay may answer plain text (e.g. 404 on refund); callers decide by status.
    }
    return { status: res.status, text, json }
  } catch (err) {
    throw new DpayError(null, ctrl.signal.aborted ? 'timeout' : `network: ${err?.message ?? err}`)
  } finally {
    clearTimeout(timer)
  }
}

function messageOf(json, text) {
  const m = json && (json.msg ?? json.message)
  if (typeof m === 'string' && m) return m
  return typeof text === 'string' && text ? text.slice(0, 200) : 'no message'
}

/**
 * Registers a dpay transaction for an order. No `channel` is ever sent (that would make the payer's
 * names and accept_tos mandatory): the payer picks the method on dpay's page.
 * POST {apiBase}/api/v1_0/payments/register
 * https://docs.dpay.pl/docs/cykl-platnosci/rejestracja-transakcji/
 * Success is only `error === false && status === true` with `msg` an http(s) URL and a
 * `transactionId`. A refused registration can come back as HTTP 200 with `error: true`.
 */
export async function registerTransaction(cfg, { orderId, grosze }) {
  if (typeof orderId !== 'string' || !orderId) throw new TypeError('orderId required')
  if (grosze === 0) throw new MoneyError('invalid_amount:grosze') // a free order never reaches dpay
  const value = formatDpayValue(grosze)
  const returnUrl = `${cfg.publicSiteUrl}/zamowienie/${encodeURIComponent(orderId)}`
  const body = {
    service: cfg.service,
    transactionType: 'transfers',
    value,
    url_success: returnUrl,
    url_fail: returnUrl,
    url_ipn: cfg.ipnUrl,
    custom: orderId,
  }
  body.checksum = await registerChecksum(cfg, { value, urlSuccess: returnUrl, urlFail: returnUrl, urlIpn: cfg.ipnUrl })

  const { status, text, json } = await postJson(cfg, `${cfg.apiBase}/api/v1_0/payments/register`, body)
  const ok =
    status >= 200 && status < 300 &&
    json && json.error === false && json.status === true &&
    typeof json.msg === 'string' && /^https?:\/\//.test(json.msg) &&
    typeof json.transactionId === 'string' && json.transactionId !== ''
  if (!ok) throw new DpayError(status, messageOf(json, text))
  return { transactionId: json.transactionId, redirectUrl: json.msg }
}

const scalar = (v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))

/**
 * Checks an IPN's signature. `body` is the parsed JSON. Required: id, amount, type, attempt, version,
 * signature; email and custom are optional (absent → '' in the formula).
 * https://docs.dpay.pl/docs/cykl-platnosci/obsluga-ipn/
 */
export async function verifyIpn(cfg, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false
  for (const key of ['id', 'amount', 'type', 'attempt', 'version']) if (!scalar(body[key])) return false
  for (const key of ['email', 'custom']) if (body[key] !== undefined && body[key] !== null && !scalar(body[key])) return false
  if (typeof body.signature !== 'string') return false
  return safeEqualHex(await ipnSignature(cfg.secret, body), body.signature)
}

// dpay's answer of 2026-11-03 describes the details response: `transaction.value` is a decimal
// string, `refunded_amount` and `available_refund_amount` are numbers (15.0), and `refunds[]` lists
// every refund of the transaction, from the API and the panel, with a negative `value`. A value
// parseDpayAmount refuses gives null, which must never confirm a payment or settle a refund.
function detailsAmount(value) {
  // A number (refunded_amount) is a float: 10.1 + 5.2 arrives as 15.299999999999999, whose text the
  // decimal pattern refuses. Whole grosze within float noise are read; anything else is refused.
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return null
    const grosze = Math.round(value * 100)
    return Math.abs(value * 100 - grosze) < 1e-6 && Number.isSafeInteger(grosze) ? grosze : null
  }
  if (typeof value !== 'string') return null
  try {
    return parseDpayAmount(value)
  } catch (err) {
    if (err instanceof MoneyError) return null
    throw err
  }
}

/**
 * Current state of a dpay transaction (the poll path when no IPN came).
 * POST {panelBase}/api/v1/pbl/details { service, transaction_id, checksum }
 * https://docs.dpay.pl/docs/cykl-platnosci/statusy-transakcji/
 * Returns { status: one of created|processing|paid|captured|expired, or null when unrecognised,
 *           grosze: int|null, refundedGrosze: int|null, raw }. Throws DpayError on a non-2xx answer,
 *           a timeout or a non-JSON body.
 * refundedGrosze is `transaction.refunded_amount` (seen in the sandbox on 2026-11-01, sandbox README:
 * dpay reports every refund there, also one made in its merchant panel); null when absent or not an
 * amount parseDpayAmount accepts, which must never be read as "nothing refunded". It counts every
 * refund dpay accepted, also one not yet carried out by the payer's bank, and does not drop when the
 * bank later refuses it (dpay, 2026-11-03).
 */
export async function transactionDetails(cfg, txnId) {
  const body = { service: cfg.service, transaction_id: txnId }
  body.checksum = await detailsChecksum(cfg, txnId)
  const { status, text, json } = await postJson(cfg, `${cfg.panelBase}/api/v1/pbl/details`, body)
  if (status < 200 || status >= 300) throw new DpayError(status, messageOf(json, text))
  if (!json || typeof json !== 'object') throw new DpayError(status, 'invalid_response')

  const t = json.transaction && typeof json.transaction === 'object' ? json.transaction : {}
  return {
    status: KNOWN_STATUSES.has(t.status) ? t.status : null,
    grosze: detailsAmount(t.value),
    refundedGrosze: detailsAmount(t.refunded_amount),
    raw: json,
  }
}

/**
 * Orders a refund, full when `grosze` is omitted. `messageId` (≤ 24 characters) is sent as
 * DigitalPayments-PSP-Message-ID; it labels the transfer and is NOT an idempotency key (dpay,
 * 2026-11-03: every valid request is a new refund), so the caller must never send the same refund twice.
 * POST {panelBase}/api/v1/pbl/refund { service, transaction_id, value?, checksum }
 * https://docs.dpay.pl/docs/cykl-platnosci/zwroty/
 * Outcome:
 *   accepted              HTTP 200 with status 'success' and refund: true: dpay took the order. The
 *                         payer's bank may still refuse it later (dpay then retries a BLIK refund itself)
 *   insufficient_balance  406: the merchant balance is too low; the only outcome worth retrying later
 *   failed                400 („Refund failed”, or a refusal such as an amount over what is left). dpay:
 *                         the order may already have reached the payment operator, so it is never read
 *                         as "no money moved" before /pbl/details says so (verifyRefund)
 *   blocked               409 „Transaction already has a refund form submitted!”: a withdrawn refund form
 *                         blocks API refunds of this transaction until dpay clears it. No money moved,
 *                         nothing is in progress, and it does not clear by itself: the operator writes
 *                         to dpay with the transaction id
 *   rejected              any other 4xx (401 checksum, 402 unpaid, 404 unknown, 410 already refunded)
 *   unknown               timeout, network error, 5xx, 3xx, or a 200 without the success body
 * Only `accepted` is known to have moved money. Callers must NOT read failed, rejected or unknown as
 * "no money moved": a 410 means an earlier refund went through, and a 400 or an unknown may have been
 * carried out. None of them may be retried automatically or offered again without a check.
 */
export async function refundTransaction(cfg, { transactionId, grosze, messageId }) {
  if (messageId !== undefined && (typeof messageId !== 'string' || messageId.length > MAX_MESSAGE_ID)) {
    throw new TypeError(`messageId must be a string of at most ${MAX_MESSAGE_ID} characters`)
  }
  if (grosze === 0) throw new MoneyError('invalid_amount:grosze') // a zero refund is never sent
  const value = grosze === undefined ? undefined : formatDpayValue(grosze)
  const body = { service: cfg.service, transaction_id: transactionId }
  if (value !== undefined) body.value = value
  body.checksum = await refundChecksum(cfg, { transactionId, value })
  const headers = messageId ? { 'DigitalPayments-PSP-Message-ID': messageId } : {}

  let res
  try {
    res = await postJson(cfg, `${cfg.panelBase}/api/v1/pbl/refund`, body, headers)
  } catch (err) {
    if (err instanceof DpayError) return { outcome: 'unknown', httpStatus: null, message: err.message }
    throw err
  }
  const { status, text, json } = res
  const message = messageOf(json, text)
  let outcome
  if (status === 200) outcome = json?.status === 'success' && json?.refund === true ? 'accepted' : 'unknown'
  else if (status === 406) outcome = 'insufficient_balance'
  else if (status === 409) outcome = 'blocked'
  else if (status === 400) outcome = 'failed'
  else if (status >= 400 && status < 500) outcome = 'rejected'
  else outcome = 'unknown'
  return { outcome, httpStatus: status, message }
}
