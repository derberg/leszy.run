// The shape of an address we send a login code to. Permissive on purpose
// (plus-addressing, dots, hyphens, IDN), but it refuses the characters no real
// address needs and that change meaning once an address is interpolated into a
// PostgREST filter or a mail header: `,` `(` `)` `"` `\` `<` `>`, whitespace
// and control characters. An address with any of them is refused, never cleaned.
export const LOGIN_EMAIL_RE = /^[^\s@,()"\\<>\u0000-\u001f\u007f]+@[^\s@,()"\\<>\u0000-\u001f\u007f]+\.[^\s@,()"\\<>\u0000-\u001f\u007f]+$/

/** @returns {boolean} */
export function isLoginEmail(email) {
  return typeof email === 'string' && email.length <= 254 && LOGIN_EMAIL_RE.test(email)
}
