// Validators for a club's payout details. Pure, no I/O.

/** Uppercase, no whitespace. */
export function normalizeIban(s) {
  return String(s ?? '').replace(/\s+/g, '').toUpperCase()
}

/** Polish IBAN: PL + 26 digits, ISO 7064 mod-97 equals 1. */
export function isValidPolishIban(s) {
  const iban = normalizeIban(s)
  if (!/^PL\d{26}$/.test(iban)) return false
  const rearranged = iban.slice(4) + iban.slice(0, 4)
  const digits = rearranged.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55))
  let rem = 0
  for (const ch of digits) rem = (rem * 10 + Number(ch)) % 97
  return rem === 1
}

/** NIP as 10 digits (dashes and spaces tolerated on input). */
export function normalizeNip(s) {
  return String(s ?? '').replace(/[\s-]/g, '')
}

export function isValidNip(s) {
  const nip = normalizeNip(s)
  if (!/^\d{10}$/.test(nip)) return false
  const weights = [6, 5, 7, 2, 3, 4, 5, 6, 7]
  const sum = weights.reduce((acc, w, i) => acc + w * Number(nip[i]), 0)
  const check = sum % 11
  return check !== 10 && check === Number(nip[9])
}

/** KRS: ten digits, optional (empty or null is valid). */
export function isValidKrs(s) {
  if (s == null || String(s).trim() === '') return true
  return /^\d{10}$/.test(String(s).trim())
}
