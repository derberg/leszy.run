// dpay checksums and the IPN signature. Pure: WebCrypto only, runs in Deno and Node.
// Every formula is SHA-256 over UTF-8, lowercase hex. cfg is { service, secret }.

const encoder = new TextEncoder()

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

// A JSON scalar as dpay's PHP casts it to a string; anything else (absent, null, object) is ''.
function str(v) {
  if (typeof v === 'string') return v
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (v === true) return '1'
  return ''
}

/**
 * Transaction registration: sha256(service|secret|value|url_success|url_fail|url_ipn).
 * Without url_ipn the separator before the empty last segment stays.
 * `value` must already have two decimals (formatDpayValue): dpay hashes the normalized value.
 * https://docs.dpay.pl/docs/cykl-platnosci/rejestracja-transakcji/
 */
export function registerChecksum(cfg, { value, urlSuccess, urlFail, urlIpn }) {
  return sha256Hex([cfg.service, cfg.secret, value, urlSuccess, urlFail, urlIpn ?? ''].join('|'))
}

/**
 * IPN: sha256(id + secret + amount + email + type + attempt + version + custom), no separator.
 * An absent email or custom contributes ''. For type 'dcb' the email is left out of the formula.
 * https://docs.dpay.pl/docs/cykl-platnosci/obsluga-ipn/ (the absent-custom case is not stated there;
 * the official Node SDK, @dpayglobal/dpay-node-sdk 0.2.0 constructIpnEvent, concatenates '').
 */
export function ipnSignature(secret, ipn) {
  const type = str(ipn.type)
  const parts = [str(ipn.id), secret, str(ipn.amount)]
  if (type !== 'dcb') parts.push(str(ipn.email))
  parts.push(type, str(ipn.attempt), str(ipn.version), str(ipn.custom))
  return sha256Hex(parts.join(''))
}

/**
 * Transaction details: sha256(service|transaction_id|secret).
 * https://docs.dpay.pl/docs/cykl-platnosci/statusy-transakcji/
 */
export function detailsChecksum(cfg, txnId) {
  return sha256Hex([cfg.service, txnId, cfg.secret].join('|'))
}

/**
 * Refund: every body field in JSON order, then the secret: sha256(service|transaction_id[|value]|secret).
 * The body must be sent with exactly these fields in this order.
 * https://docs.dpay.pl/docs/cykl-platnosci/zwroty/
 */
export function refundChecksum(cfg, { transactionId, value }) {
  const parts = [cfg.service, transactionId]
  if (value !== undefined) parts.push(value)
  parts.push(cfg.secret)
  return sha256Hex(parts.join('|'))
}

/** Constant-time comparison of two hex strings (case-insensitive). Different lengths are unequal. */
export function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || a.length === 0) return false
  const x = a.toLowerCase()
  const y = b.toLowerCase()
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i)
  return diff === 0
}
