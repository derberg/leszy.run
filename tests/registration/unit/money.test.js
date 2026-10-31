import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MoneyError,
  orderAmounts,
  formatPln,
  formatDpayValue,
  parseDpayAmount,
} from '../../../supabase/functions/_shared/registration/money.js'
import { PAYMENT_CHANNEL_PRESELECT } from '../../../supabase/functions/_shared/registration/flags.js'

const N = 100_000

test('P-01 RA4 mockup amounts: the entries, the donation and nothing else', () => {
  assert.deepEqual(orderAmounts({ entryPrices: [6000, 2000], donation: 2000 }), {
    entryTotal: 8000,
    extrasTotal: 0,
    donation: 2000,
    total: 10000,
  })
})

test('P-01 extras count in the total', () => {
  assert.equal(orderAmounts({ entryPrices: [6000, 2000], extrasTotal: 100 }).total, 8100)
})

test('P-03 total = the sum of the entry prices for every entry total 0..100000', () => {
  for (let e = 0; e <= N; e++) {
    const a = orderAmounts({ entryPrices: [e] })
    if (a.total !== e || a.entryTotal !== e) assert.fail(`orderAmounts(${e})`)
  }
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
  assert.throws(() => formatPln(big), MoneyError)
  assert.throws(() => formatDpayValue(big), MoneyError)
  assert.throws(() => orderAmounts({ entryPrices: [big] }), MoneyError)
  assert.throws(() => orderAmounts({ entryPrices: [99_999_999, 1] }), MoneyError)
  assert.throws(() => orderAmounts({ entryPrices: [99_999_999], donation: 1 }), MoneyError) // the total passes the cap
  assert.equal(orderAmounts({ entryPrices: [99_999_999] }).total, 99_999_999)
})

test('formatPln', () => {
  assert.equal(formatPln(10091), '100,91 zł')
  assert.equal(formatPln(0), '0,00 zł')
  assert.equal(formatPln(5), '0,05 zł')
  assert.equal(formatPln(160), '1,60 zł')
  assert.throws(() => formatPln(1.5), MoneyError)
  assert.throws(() => formatPln(-1), MoneyError)
})

test('P-05 a free order costs nothing; a free entry with a paid extra costs the extra', () => {
  assert.equal(orderAmounts({ entryPrices: [0] }).total, 0)
  assert.equal(orderAmounts({ entryPrices: [0], extrasTotal: 1000 }).total, 1000)
})

test('P-05 floats, negatives and non-arrays throw', () => {
  const bad = [
    { entryPrices: [60.5] },
    { entryPrices: [-100] },
    { entryPrices: [6000], extrasTotal: 0.5 },
    { entryPrices: [6000], donation: -1 },
    { entryPrices: ['6000'] },
    { entryPrices: 6000 },
    {},
  ]
  for (const input of bad) assert.throws(() => orderAmounts(input), MoneyError, JSON.stringify(input))
})

test('PAYMENT_CHANNEL_PRESELECT is off', () => {
  assert.equal(PAYMENT_CHANNEL_PRESELECT, false)
})
