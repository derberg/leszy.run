// Refuses to point the sandbox suite at real dpay. Pure: unit-tested in guard.test.js, used by the
// spec and by write-functions-env.js. The host list is mirrored in README.md ("Production hosts").

/** dpay's live hosts. A sandbox host never equals one of these. */
export const PRODUCTION_DPAY_HOSTS = ['dpay.pl', 'www.dpay.pl', 'secure.dpay.pl', 'panel.dpay.pl', 'api.dpay.pl']

export const SANDBOX_ENV_KEYS = [
  'DPAY_SANDBOX_SERVICE', 'DPAY_SANDBOX_SECRET', 'DPAY_SANDBOX_API_BASE', 'DPAY_SANDBOX_PANEL_BASE',
  'DPAY_SANDBOX_BLIK_CODE', 'DPAY_SANDBOX_CARD_NUMBER', 'DPAY_SANDBOX_CARD_EXPIRY', 'DPAY_SANDBOX_CARD_CVC',
  'SANDBOX_PUBLIC_IPN_URL',
]

export function isProductionDpayHost(url) {
  let host
  try { host = new URL(url).hostname.toLowerCase() } catch { return true } // unparsable: refuse
  return PRODUCTION_DPAY_HOSTS.includes(host)
}

/** Throws when a base URL is a production dpay host, or the env is incomplete. Returns the config. */
export function sandboxConfig(env = process.env) {
  const missing = SANDBOX_ENV_KEYS.filter((k) => !env[k]?.trim())
  if (missing.length) throw new Error(`sandbox suite: missing ${missing.join(', ')}`)
  for (const key of ['DPAY_SANDBOX_API_BASE', 'DPAY_SANDBOX_PANEL_BASE']) {
    if (isProductionDpayHost(env[key])) {
      throw new Error(`sandbox suite refuses to run: ${key} is a production dpay host (${new URL(env[key]).hostname})`)
    }
  }
  return {
    service: env.DPAY_SANDBOX_SERVICE.trim(),
    secret: env.DPAY_SANDBOX_SECRET.trim(),
    apiBase: env.DPAY_SANDBOX_API_BASE.trim().replace(/\/+$/, ''),
    panelBase: env.DPAY_SANDBOX_PANEL_BASE.trim().replace(/\/+$/, ''),
    blikCode: env.DPAY_SANDBOX_BLIK_CODE.trim(),
    card: { number: env.DPAY_SANDBOX_CARD_NUMBER.trim(), expiry: env.DPAY_SANDBOX_CARD_EXPIRY.trim(), cvc: env.DPAY_SANDBOX_CARD_CVC.trim() },
    declineCard: env.DPAY_SANDBOX_DECLINE_CARD_NUMBER?.trim() || null, // optional: S-03 is skipped without it
    ipnUrl: env.SANDBOX_PUBLIC_IPN_URL.trim(),
  }
}

/**
 * The shape of a JSON value with every value redacted: keys kept, strings become "<string:n>",
 * numbers "<number>". For the S-06 run log, which must never carry a secret or a payer's data.
 */
export function shapeOf(value) {
  if (Array.isArray(value)) return value.length ? [shapeOf(value[0]), `... x${value.length}`] : []
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shapeOf(v)]))
  if (typeof value === 'string') return `<string:${value.length}>`
  if (typeof value === 'number') return '<number>'
  return value === null ? null : `<${typeof value}>`
}
