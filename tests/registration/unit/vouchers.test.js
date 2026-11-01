// Plan 7 Task 1: voucher codes. Normalised to upper case, generated from an alphabet with no 0/O,
// 1/I, so a code read off a printed flyer is typed back right.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeCode,
  generateCodes,
  validateVoucherInput,
  CODE_ALPHABET,
  MAX_GENERATED_CODES,
} from '../../../supabase/functions/_shared/registration/vouchers.js'

test('V-06 normalizeCode trims and upper-cases', () => {
  assert.equal(normalizeCode(' leszy-15 '), 'LESZY-15')
  assert.equal(normalizeCode('ABCD'), 'ABCD')
  assert.equal(normalizeCode('A'.repeat(32)), 'A'.repeat(32))
})

test('V-06 normalizeCode rejects short, non-ASCII, too long and non-string codes', () => {
  for (const s of ['ab', 'ŁOŚ1', 'A'.repeat(33), '', '   ', 'AB CD', 'AB_CD', 'ABC!', null, undefined, 1234, {}]) {
    assert.equal(normalizeCode(s), null, String(s))
  }
})

test('V-07 generateCodes(200) gives 200 unique 8-character codes from the alphabet', () => {
  assert.equal(CODE_ALPHABET, 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789')
  assert.equal(MAX_GENERATED_CODES, 200)
  const codes = generateCodes(200)
  assert.equal(codes.length, 200)
  assert.equal(new Set(codes).size, 200)
  for (const c of codes) {
    assert.match(c, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/)
    assert.equal(normalizeCode(c), c)
  }
})

test('V-07 generateCodes refuses 0, 201 and a non-integer', () => {
  for (const n of [0, 201, 1.5, -1, '5', undefined]) assert.throws(() => generateCodes(n), RangeError, String(n))
})

test('V-07 generateCodes with a prefix: PREFIX-XXXXXXXX, still a valid code', () => {
  const codes = generateCodes(50, { prefix: ' biegam ' })
  assert.equal(new Set(codes).size, 50)
  for (const c of codes) {
    assert.match(c, /^BIEGAM-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/)
    assert.equal(normalizeCode(c), c)
  }
  assert.equal(generateCodes(1, { prefix: 'A'.repeat(23) })[0].length, 32)
  for (const prefix of ['A'.repeat(24), 'ŁOŚ', 'A B', '']) {
    assert.throws(() => generateCodes(1, { prefix }), RangeError, prefix)
  }
})

test('V-07 every alphabet character appears over many codes (no truncated range)', () => {
  const seen = new Set(generateCodes(200).join(''))
  for (const ch of CODE_ALPHABET) assert.ok(seen.has(ch), ch)
})

const UUID = '11111111-2222-4333-8444-555555555555'
const UUID2 = '66666666-7777-4888-8999-aaaaaaaaaaaa'

test('validateVoucherInput accepts a full voucher and returns it normalised in snake_case', () => {
  const v = validateVoucherInput({
    code: ' leszy-15 ', percent: 15, maxUses: 30, validUntil: '2026-12-31',
    categoryIds: [UUID, UUID2, UUID], partnerId: UUID,
  })
  assert.deepEqual(v, {
    ok: true,
    errors: {},
    value: { code: 'LESZY-15', percent: 15, max_uses: 30, valid_until: '2026-12-31', category_ids: [UUID, UUID2], partner_id: UUID },
  })
})

test('validateVoucherInput: code, date, competitions and partner are optional', () => {
  const v = validateVoucherInput({ percent: '100', maxUses: '1' })
  assert.deepEqual(v.value, { code: null, percent: 100, max_uses: 1, valid_until: null, category_ids: [], partner_id: null })
  assert.equal(v.ok, true)
})

test('validateVoucherInput rejects each bad field under its own key', () => {
  const cases = [
    [{ code: 'ab' }, 'code'],
    [{ percent: 0 }, 'percent'],
    [{ percent: 101 }, 'percent'],
    [{ percent: 15.5 }, 'percent'],
    [{ percent: null }, 'percent'],
    [{ maxUses: 0 }, 'maxUses'],
    [{ maxUses: 100001 }, 'maxUses'],
    [{ maxUses: 2.5 }, 'maxUses'],
    [{ validUntil: '31.12.2026' }, 'validUntil'],
    [{ validUntil: '2026-02-30' }, 'validUntil'],
    [{ categoryIds: 'x' }, 'categoryIds'],
    [{ categoryIds: ['not-a-uuid'] }, 'categoryIds'],
    [{ partnerId: 'nope' }, 'partnerId'],
  ]
  for (const [patch, field] of cases) {
    const v = validateVoucherInput({ percent: 15, maxUses: 10, ...patch })
    assert.equal(v.ok, false, JSON.stringify(patch))
    assert.deepEqual(Object.keys(v.errors), [field], JSON.stringify(patch))
    assert.equal(v.value, undefined)
  }
  assert.equal(validateVoucherInput(null).ok, false)
})

test('V-06 normalizeCode refuses non-ASCII that upper-cases into ASCII (ß, ſ, ı, ﬀ)', () => {
  assert.equal('ßßß'.toUpperCase(), 'SSSSSS') // what the old code stored
  for (const s of ['ßßß', 'ſſſſ', 'ıııı', 'ﬀﬀ', 'LESZYß', 'ABCD\u0307']) {
    assert.equal(normalizeCode(s), null, s)
  }
})

test('V-06 normalizeCode refuses a code with no letter or digit', () => {
  for (const s of ['----', '-'.repeat(32), ' ---- ']) assert.equal(normalizeCode(s), null, s)
  assert.equal(normalizeCode('-AB-'), '-AB-')
  assert.equal(normalizeCode('a-1-'), 'A-1-')
})

test('V-07 generateCodes refuses a hyphen-only or non-ASCII prefix', () => {
  for (const prefix of ['-', '---', 'ß', 'ſ']) assert.throws(() => generateCodes(1, { prefix }), RangeError, prefix)
})

test('validateVoucherInput refuses a folded or hyphen-only code', () => {
  for (const code of ['ßßß', '----']) {
    const v = validateVoucherInput({ code, percent: 15, maxUses: 10 })
    assert.equal(v.ok, false, code)
    assert.deepEqual(Object.keys(v.errors), ['code'])
  }
})
