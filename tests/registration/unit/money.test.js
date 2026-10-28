import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MoneyError,
  supportFee,
  paymentFee,
  orderAmounts,
  formatPln,
  formatDpayValue,
  parseDpayAmount,
} from '../../../supabase/functions/_shared/registration/money.js'
import { PAYMENT_CHANNEL_PRESELECT } from '../../../supabase/functions/_shared/registration/flags.js'

const N = 100_000

test('P-01 RA4 mockup amounts', () => {
  assert.deepEqual(orderAmounts({ entryPrices: [6000, 2000], donation: 2000, supportChoice: false }), {
    entryTotal: 8000,
    extrasTotal: 0,
    donation: 2000,
    supportFee: 0,
    subtotal: 10000,
    paymentFee: 91,
    total: 10091,
    supportChoiceShown: true,
  })
  const withSupport = orderAmounts({ entryPrices: [6000, 2000], donation: 2000, supportChoice: true })
  assert.equal(withSupport.supportFee, 160)
  assert.equal(withSupport.subtotal, 10160)
  assert.equal(withSupport.total, withSupport.subtotal + withSupport.paymentFee)
})

test('P-01 extras count in the subtotal but not in the support fee', () => {
  const a = orderAmounts({ entryPrices: [5000], extrasTotal: 3000, supportChoice: true })
  assert.equal(a.entryTotal, 5000)
  assert.equal(a.extrasTotal, 3000)
  assert.equal(a.supportFee, 100)
  assert.equal(a.subtotal, 8100)
  assert.equal(a.total, 8100 + paymentFee(8100))
})

test('P-02 paymentFee covers 0.9% of the charged amount, min 20, minimal, for every subtotal 1..100000', () => {
  assert.equal(paymentFee(0), 0)
  for (let s = 1; s <= N; s++) {
    const f = paymentFee(s)
    if (!Number.isInteger(f) || f < 20 || f * 991 < 9 * s || !(f === 20 || (f - 1) * 991 < 9 * s)) {
      assert.fail(`paymentFee(${s}) = ${f}`)
    }
  }
})

test('P-02 paymentFee rejects non-integer and negative subtotals', () => {
  for (const bad of [-1, 1.5, NaN, Infinity, '100', null, undefined]) {
    assert.throws(() => paymentFee(bad), MoneyError, String(bad))
  }
})

test('P-03 supportFee is 2% rounded half up, total = subtotal + paymentFee, for every entry total 0..100000', () => {
  for (let e = 0; e <= N; e++) {
    const yes = supportFee(e, true)
    if (!Number.isInteger(yes) || yes !== Math.floor((2 * e + 50) / 100)) assert.fail(`supportFee(${e}, true) = ${yes}`)
    if (supportFee(e, false) !== 0) assert.fail(`supportFee(${e}, false) != 0`)
    const a = orderAmounts({ entryPrices: [e], supportChoice: e > 0 ? true : null })
    if (a.total !== a.subtotal + a.paymentFee || a.subtotal !== e + yes) assert.fail(`orderAmounts(${e})`)
  }
})

test('P-03 supportFee half-up boundaries', () => {
  assert.equal(supportFee(25, true), 1) // 0.5 -> 1
  assert.equal(supportFee(24, true), 0) // 0.48 -> 0
  assert.equal(supportFee(75, true), 2) // 1.5 -> 2
  assert.equal(supportFee(8000, true), 160)
})

test('P-03 supportFee demands a boolean choice and an integer entry total', () => {
  assert.throws(() => supportFee(100, null), MoneyError)
  assert.throws(() => supportFee(100, 'true'), MoneyError)
  assert.throws(() => supportFee(1.5, true), MoneyError)
  assert.throws(() => supportFee(-1, false), MoneyError)
})

test('P-04 dpay value round-trips for every amount 1..100000 and 99999999', () => {
  for (let g = 1; g <= N; g++) {
    if (parseDpayAmount(formatDpayValue(g)) !== g) assert.fail(`round-trip ${g}`)
  }
  assert.equal(formatDpayValue(99999999), '999999.99')
  assert.equal(parseDpayAmount(formatDpayValue(99999999)), 99999999)
})

test('P-04 formatDpayValue shape', () => {
  assert.equal(formatDpayValue(10091), '100.91')
  assert.equal(formatDpayValue(5), '0.05')
  assert.equal(formatDpayValue(100), '1.00')
  assert.equal(formatDpayValue(0), '0.00')
  for (const bad of [-1, 1.5, 100000000, '100', null]) {
    assert.throws(() => formatDpayValue(bad), MoneyError, String(bad))
  }
})

test('P-04 parseDpayAmount accepts zero, one or two decimals', () => {
  assert.equal(parseDpayAmount('1'), 100)
  assert.equal(parseDpayAmount('1.0'), 100)
  assert.equal(parseDpayAmount('1.5'), 150)
  assert.equal(parseDpayAmount('60'), 6000)
  assert.equal(parseDpayAmount('60.5'), 6050)
  assert.equal(parseDpayAmount('60.05'), 6005)
  assert.equal(parseDpayAmount('999999'), 99999900)
  assert.equal(parseDpayAmount('999999.99'), 99999999)
})

test('P-04 parseDpayAmount rejects anything else', () => {
  for (const bad of ['1,00', '1.001', '-1.00', '1e3', '', ' 1.00', '1.00 ', '1000000.00', '1000000', '1.', '.50', '01.00', '+1.00', 'abc', null, undefined, 100]) {
    assert.throws(() => parseDpayAmount(bad), MoneyError, JSON.stringify(bad))
  }
  assert.equal(parseDpayAmount('0.00'), 0)
  assert.equal(parseDpayAmount('100.91'), 10091)
})

test('amounts above 99 999 999 grosze throw everywhere', () => {
  const big = 100_000_000
  assert.throws(() => paymentFee(big), MoneyError)
  assert.throws(() => supportFee(big, true), MoneyError)
  assert.throws(() => formatPln(big), MoneyError)
  assert.throws(() => formatDpayValue(big), MoneyError)
  assert.throws(() => orderAmounts({ entryPrices: [big], supportChoice: false }), MoneyError)
  assert.throws(() => orderAmounts({ entryPrices: [99_999_999, 1], supportChoice: false }), MoneyError)
  assert.throws(() => orderAmounts({ entryPrices: [0], donation: 99_999_999, supportChoice: null }), MoneyError) // total = subtotal + fee passes the cap
  assert.equal(paymentFee(99_999_999), Math.floor((99_999_999 * 9 + 990) / 991))
})

test('formatPln', () => {
  assert.equal(formatPln(10091), '100,91 zł')
  assert.equal(formatPln(0), '0,00 zł')
  assert.equal(formatPln(5), '0,05 zł')
  assert.equal(formatPln(160), '1,60 zł')
  assert.throws(() => formatPln(1.5), MoneyError)
  assert.throws(() => formatPln(-1), MoneyError)
})

test('P-05 a paid order without a support choice throws support_choice_required', () => {
  for (const choice of [null, undefined, 'false', 0]) {
    assert.throws(
      () => orderAmounts({ entryPrices: [6000], supportChoice: choice }),
      (err) => err instanceof MoneyError && err.message === 'support_choice_required',
    )
  }
})

test('P-05 a free order needs no choice and costs nothing', () => {
  const a = orderAmounts({ entryPrices: [0], supportChoice: null })
  assert.equal(a.supportChoiceShown, false)
  assert.equal(a.supportFee, 0)
  assert.equal(a.paymentFee, 0)
  assert.equal(a.total, 0)
  // A free entry with a paid extra: no support line (entry fees only), but dpay still charges.
  const b = orderAmounts({ entryPrices: [0], extrasTotal: 1000, supportChoice: null })
  assert.equal(b.supportChoiceShown, false)
  assert.equal(b.supportFee, 0)
  assert.equal(b.total, 1000 + paymentFee(1000))
})

test('P-05 floats, negatives and non-arrays throw', () => {
  const bad = [
    { entryPrices: [60.5], supportChoice: false },
    { entryPrices: [-100], supportChoice: false },
    { entryPrices: [6000], extrasTotal: 0.5, supportChoice: false },
    { entryPrices: [6000], donation: -1, supportChoice: false },
    { entryPrices: ['6000'], supportChoice: false },
    { entryPrices: 6000, supportChoice: false },
    { supportChoice: false },
  ]
  for (const input of bad) assert.throws(() => orderAmounts(input), MoneyError, JSON.stringify(input))
})

test('PAYMENT_CHANNEL_PRESELECT is off', () => {
  assert.equal(PAYMENT_CHANNEL_PRESELECT, false)
})
