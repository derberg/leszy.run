// The shape of an address we send a login code to: the registration rule
// (_shared/registration/emailAddress.js), so an address the forms accept can log
// in and one they refuse cannot. Permissive on purpose (plus-addressing, dots,
// hyphens, IDN), but it refuses the characters no real address needs and that
// change meaning once an address is interpolated into a PostgREST filter or a
// mail header: `,` `(` `)` `"` `\` `<` `>`, whitespace and control characters,
// and a dot out of place (`a..b`, `x@gmail..com`). An address that fails is
// refused, never cleaned.
import { isValidEmail } from './registration/emailAddress.js'

/** @returns {boolean} */
export function isLoginEmail(email) {
  return isValidEmail(email)
}
