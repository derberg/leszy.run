// The `from` a login carries to the page it returns to. It ends up in the
// magic link and then in a client-side navigation, so it must stay on our site.
//
// Control characters and whitespace are refused outright: browsers strip tab
// and newline from a URL before parsing it, so `/\t/evil.com` passed the
// "no //" test here and still navigated to https://evil.com/. A percent-encoded
// `/%09/evil.com` is harmless (the parser never decodes it back into a
// scheme-relative URL), so only the raw characters are refused.
const UNSAFE_CHAR_RE = /[\u0000-\u0020\u007f-\u009f\u00a0\u2028\u2029\ufeff]/

/** @returns {string|null} the path when it is a same-site path, else null. */
export function sanitizeFrom(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 500) return null
  if (!raw.startsWith('/')) return null
  if (UNSAFE_CHAR_RE.test(raw)) return null
  if (raw.startsWith('//') || raw.includes('\\') || raw.includes('..')) return null
  return raw
}
