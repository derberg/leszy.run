// Constant-time comparison of a request header against a configured secret. Both sides are hashed
// first, so the comparison never depends on the length of either value. Used by the functions only
// pg_cron (and the watchdog backstop) may call: registration-jobs, registration-watchdog.
const encoder = new TextEncoder()

/** → true when given equals expected. An empty or missing expected secret never matches. */
export async function sameSecret(given, expected) {
  if (typeof expected !== 'string' || expected === '') return false
  const [a, b] = await Promise.all([String(given ?? ''), expected]
    .map((s) => crypto.subtle.digest('SHA-256', encoder.encode(s))))
  const x = new Uint8Array(a)
  const y = new Uint8Array(b)
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i]
  return diff === 0
}
