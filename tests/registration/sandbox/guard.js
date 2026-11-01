// Keeps the sandbox suite off the production dpay service. Pure: unit-tested in guard.test.js, used by
// the spec and by write-functions-env.js. Mirrored in README.md ("Test mode").
//
// dpay has no sandbox host: test mode is a switch on a service, on the production hosts
// (api-payments.dpay.pl, panel.dpay.pl). So the host cannot tell test from live. What protects
// production is that only a dedicated test-mode service is ever configured here; the name rule below
// is the part a machine can check.

/** A test service's identifier must say so. Refuses e.g. `LESZY.RUN` or `leszyrun`. */
export const TEST_SERVICE_PATTERN = /sandbox|test/i

export const SANDBOX_ENV_KEYS = [
  'DPAY_SANDBOX_SERVICE', 'DPAY_SANDBOX_SECRET', 'DPAY_SANDBOX_API_BASE', 'DPAY_SANDBOX_PANEL_BASE',
  'DPAY_SANDBOX_BLIK_CODE', 'DPAY_SANDBOX_CARD_NUMBER', 'DPAY_SANDBOX_CARD_EXPIRY', 'DPAY_SANDBOX_CARD_CVC',
  'SANDBOX_PUBLIC_IPN_URL',
]

/** True when the service identifier names a test service. */
export function isTestService(service) {
  return TEST_SERVICE_PATTERN.test(String(service ?? ''))
}

/** True when `url` parses as an https URL on dpay.pl or a subdomain of it. */
export function isDpayHttpsUrl(url) {
  let parsed
  try { parsed = new URL(url) } catch { return false }
  const host = parsed.hostname.toLowerCase()
  return parsed.protocol === 'https:' && (host === 'dpay.pl' || host.endsWith('.dpay.pl'))
}

/**
 * Throws when the env is incomplete, the service is not named as a test service, or a base URL is
 * not https on a dpay.pl host. Returns the config.
 */
export function sandboxConfig(env = process.env) {
  const missing = SANDBOX_ENV_KEYS.filter((k) => !env[k]?.trim())
  if (missing.length) throw new Error(`sandbox suite: missing ${missing.join(', ')}`)
  if (!isTestService(env.DPAY_SANDBOX_SERVICE.trim())) {
    throw new Error('sandbox suite refuses to run: DPAY_SANDBOX_SERVICE does not contain "sandbox" or "test" (use a dedicated test-mode service)')
  }
  for (const key of ['DPAY_SANDBOX_API_BASE', 'DPAY_SANDBOX_PANEL_BASE']) {
    if (!isDpayHttpsUrl(env[key].trim())) {
      throw new Error(`sandbox suite refuses to run: ${key} is not an https URL on a dpay.pl host`)
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
