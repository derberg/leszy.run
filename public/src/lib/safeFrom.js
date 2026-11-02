// The ?from= a login or onboarding page sends the visitor on to after it.
// It must stay on this site. Browsers strip tab and newline from a URL before
// parsing it, so `/\t/evil.com` passed the old "starts with one /" test and
// still navigated to https://evil.com/. Control characters and whitespace are
// refused outright, and whatever survives the string rules must also resolve to
// this origin. The server applies the same string rules to the `from` it puts
// in the magic link (supabase/functions/_shared/safeFrom.js).
const UNSAFE_CHAR_RE = /[\u0000-\u0020\u007f-\u009f\u00a0\u2028\u2029\ufeff]/

/**
 * @param {unknown} raw
 * @param {string} [origin] the page's origin; defaults to window.location.origin.
 * @returns {string|null} the path when it is a same-site path, else null.
 */
export function safeFromPath(raw, origin = globalThis.window?.location?.origin) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 500) return null
  if (!raw.startsWith('/')) return null
  if (UNSAFE_CHAR_RE.test(raw)) return null
  if (raw.startsWith('//') || raw.includes('\\') || raw.includes('..')) return null
  if (!origin) return null
  try {
    if (new URL(raw, origin).origin !== origin) return null
  } catch {
    return null
  }
  return raw
}
