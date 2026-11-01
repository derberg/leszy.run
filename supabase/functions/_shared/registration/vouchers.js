// Voucher codes (Plan 7). A code is stored upper case and matched case-insensitively by normalising
// it here first. Generated codes use an alphabet without 0/O and 1/I, so a code printed on a flyer
// is typed back right. Plain ESM, Web Crypto only: runs in Deno and Node.

import { isIsoDate } from './pricing.js'

export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // 32 symbols: byte & 31 is unbiased
export const MAX_GENERATED_CODES = 200
export const MAX_VOUCHER_USES = 100_000
const CODE_RE = /^[A-Z0-9-]{4,32}$/
const PREFIX_RE = /^[A-Z0-9-]{1,23}$/ // PREFIX + '-' + 8 stays within 32
const GENERATED_LENGTH = 8
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Trimmed and upper-cased, or null when it is not 4–32 of A–Z, 0–9 and '-'. */
export function normalizeCode(s) {
  if (typeof s !== 'string') return null
  const code = s.trim().toUpperCase()
  return CODE_RE.test(code) ? code : null
}

function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(GENERATED_LENGTH))
  let out = ''
  for (const b of bytes) out += CODE_ALPHABET[b & 31]
  return out
}

/** n (1–200) codes unique within the batch, each 8 random symbols, optionally 'PREFIX-'. */
export function generateCodes(n, { prefix } = {}) {
  if (!Number.isInteger(n) || n < 1 || n > MAX_GENERATED_CODES) throw new RangeError('invalid_count')
  let head = ''
  if (prefix != null) {
    const p = String(prefix).trim().toUpperCase()
    if (!PREFIX_RE.test(p)) throw new RangeError('invalid_prefix')
    head = `${p}-`
  }
  const codes = new Set()
  while (codes.size < n) codes.add(head + randomCode())
  return [...codes]
}

function intIn(value, lo, hi) {
  const n = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value
  return Number.isInteger(n) && n >= lo && n <= hi ? n : null
}

/**
 * An organizer's code form. `code` may be omitted (generated codes come from generateCodes);
 * `categoryIds` empty means every competition. The value is snake_case, as stored.
 * @returns {{ ok: true, value: object, errors: {} } | { ok: false, errors: Record<string, string> }}
 */
export function validateVoucherInput(input) {
  if (input == null || typeof input !== 'object') return { ok: false, errors: { voucher: 'Nieprawidłowe dane.' } }
  const { code, percent, maxUses, validUntil, categoryIds, partnerId } = input
  const errors = {}
  const value = {}

  if (code == null || code === '') value.code = null
  else if ((value.code = normalizeCode(code)) == null) errors.code = 'Kod: 4–32 znaki, litery A–Z, cyfry i „-”.'

  value.percent = intIn(percent, 1, 100)
  if (value.percent == null) errors.percent = 'Rabat od 1 do 100%.'

  value.max_uses = intIn(maxUses, 1, MAX_VOUCHER_USES)
  if (value.max_uses == null) errors.maxUses = 'Liczba użyć od 1 do 100 000.'

  if (validUntil == null || validUntil === '') value.valid_until = null
  else if (isIsoDate(validUntil)) value.valid_until = validUntil
  else errors.validUntil = 'Nieprawidłowa data.'

  if (categoryIds == null) value.category_ids = []
  else if (Array.isArray(categoryIds) && categoryIds.every((id) => typeof id === 'string' && UUID_RE.test(id))) {
    value.category_ids = [...new Set(categoryIds.map((id) => id.toLowerCase()))]
  } else errors.categoryIds = 'Nieprawidłowe konkurencje.'

  if (partnerId == null || partnerId === '') value.partner_id = null
  else if (typeof partnerId === 'string' && UUID_RE.test(partnerId)) value.partner_id = partnerId.toLowerCase()
  else errors.partnerId = 'Nieprawidłowy partner.'

  if (Object.keys(errors).length) return { ok: false, errors }
  return { ok: true, value, errors: {} }
}
