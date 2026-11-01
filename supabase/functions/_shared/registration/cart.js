// The cart fields of a sign-up body (Plan 7, ruling C-1), read once for register-free, create-order
// and register-team: each person's `voucherCode` and `extras: [{ variantId, qty }]`, the team's
// `voucherCode` (the team line), and one `donation` in grosze. Only the shape is checked here; the
// RPCs decide everything else (a code's validity, an extra's availability, the donation's range and
// whether the event takes one). Plain JS: runs in the edge functions and the unit tests.

export const DONATION_MESSAGE = 'Popraw kwotę darowizny.'
export const EXTRAS_MESSAGE = 'Popraw wybrane dodatki.'
export const VOUCHER_CODE_MESSAGE = 'Nieprawidłowy kod.'

/**
 * A donation in grosze. Absent, null, '' and any form of zero ("0", 0.0) are 0; anything else must
 * be a whole, non-negative number of grosze, as a number or a string of digits.
 * → { ok: true, value } | { ok: false }
 */
export function normalizeDonation(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: 0 }
  if (typeof raw === 'number') {
    if (raw === 0) return { ok: true, value: 0 } // 0.0 and -0 too
    return Number.isSafeInteger(raw) && raw > 0 ? { ok: true, value: raw } : { ok: false }
  }
  if (typeof raw === 'string') {
    const s = raw.trim()
    if (s === '') return { ok: true, value: 0 }
    if (!/^\d{1,15}$/.test(s)) return { ok: false }
    const value = Number(s)
    return Number.isSafeInteger(value) ? { ok: true, value } : { ok: false }
  }
  return { ok: false }
}

/**
 * A person's extras: absent or null is none; otherwise an array of { variantId: string, qty: whole
 * number ≥ 0 }. An extra without a qty is refused: the page always sends one.
 * → { ok: true, value: [{ variantId, qty }] } | { ok: false }
 */
export function normalizeExtras(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: [] }
  if (!Array.isArray(raw)) return { ok: false }
  const value = []
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { ok: false }
    if (typeof item.variantId !== 'string' || item.variantId.trim() === '') return { ok: false }
    if (!Number.isSafeInteger(item.qty) || item.qty < 0) return { ok: false }
    value.push({ variantId: item.variantId.trim(), qty: item.qty })
  }
  return { ok: true, value }
}

/** A typed code: absent, null or blank is none; otherwise a string (the RPC normalises it). */
export function normalizeVoucherCode(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: null }
  if (typeof raw !== 'string') return { ok: false }
  const s = raw.trim()
  return { ok: true, value: s === '' ? null : s }
}

const failure = (field, index = null) => ({ ok: false, field, ...(index === null ? {} : { index }) })

/**
 * The cart of a request body. `team: true` reads register-team's body (members[].extras and the
 * team's own voucherCode); otherwise a group's people[] or Plan 2's single { categoryId, person }.
 * → { ok: true, people: [{ voucherCode, extras }] (request order), voucherCode (team), donation }
 *   | { ok: false, field: 'donation'|'extras'|'voucherCode', index? }
 */
export function cartOfRequest(body, { team = false } = {}) {
  const b = body && typeof body === 'object' ? body : {}
  const donation = normalizeDonation(b.donation)
  if (!donation.ok) return failure('donation')
  let items
  if (team) items = Array.isArray(b.members) ? b.members : []
  else if (Array.isArray(b.people)) items = b.people
  else items = [b] // the legacy body is a group of one, its fields at the top
  const people = []
  for (const [index, raw] of items.entries()) {
    const it = raw && typeof raw === 'object' ? raw : {}
    const extras = normalizeExtras(it.extras)
    if (!extras.ok) return failure('extras', index)
    // A team's code is the team line's, never a member's.
    const code = team ? { ok: true, value: null } : normalizeVoucherCode(it.voucherCode)
    if (!code.ok) return failure('voucherCode', index)
    people.push({ voucherCode: code.value, extras: extras.value })
  }
  const teamCode = team ? normalizeVoucherCode(b.voucherCode) : { ok: true, value: null }
  if (!teamCode.ok) return failure('voucherCode', 0)
  return { ok: true, people, voucherCode: teamCode.value, donation: donation.value }
}

/** Whether the cart carries money beyond the entries: an extra with qty above 0, or a donation. */
export function cartMakesMoney(cart) {
  if (!cart) return false
  return cart.donation > 0 || cart.people.some((p) => p.extras.some((e) => e.qty > 0))
}

/** Whether the cart carries anything a free registration cannot take: a code, an extra or a donation. */
export function cartIsEmpty(cart) {
  if (!cart) return true
  return !cartMakesMoney(cart) && !cart.voucherCode && cart.people.every((p) => !p.voucherCode)
}

/** The person as the RPC takes it, with their code and extras added only when there are any. */
export function withCart(person, cartPerson) {
  if (!cartPerson) return person
  return {
    ...person,
    ...(cartPerson.voucherCode ? { voucherCode: cartPerson.voucherCode } : {}),
    ...(cartPerson.extras.length ? { extras: cartPerson.extras } : {}),
  }
}
