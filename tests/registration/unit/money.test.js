import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MoneyError,
  orderAmounts,
  formatPln,
  formatDpayValue,
  parseDpayAmount,
  dpayFee,
  dpayCommission,
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

test('dpayFee: 0.9% rounded up, at least 0.20 zł, nothing on 0', () => {
  assert.equal(dpayFee(0), 0)
  assert.equal(dpayFee(1), 20)
  assert.equal(dpayFee(2000), 20) // 0.18 zł is under the 0.20 zł minimum
  assert.equal(dpayFee(2223), 21) // 20.007 → 21
  assert.equal(dpayFee(6000), 54)
  assert.equal(dpayFee(10000), 90)
  assert.throws(() => dpayFee(1.5), MoneyError)
  assert.throws(() => dpayFee(-1), MoneyError)
})

test('O-50 dpayCommission: one fee per payment dpay took and per refund it accepted', () => {
  assert.equal(dpayCommission(), 0)
  // The Wataha case: three paid payments of 200 zł, 1,80 zł each.
  const paid = [20000, 20000, 20000].map((grosze) => ({ grosze, status: 'paid' }))
  assert.equal(dpayCommission({ attempts: paid }), 540)
  // A payment refunded afterwards was still taken; one never paid costs nothing.
  assert.equal(dpayCommission({ attempts: [{ grosze: 6000, status: 'refunded' }, { grosze: 6000, status: 'created' }] }), 54)
  // Only an accepted refund was made at dpay, each on its own amount (5 zł → the 0,20 zł minimum).
  const refunds = [
    { amount: 500, dpay_status: 'accepted' },
    { amount: 20000, dpay_status: 'accepted' },
    { amount: 20000, dpay_status: 'rejected' },
    { amount: 20000, dpay_status: 'pending' },
    { amount: 20000, dpay_status: 'unknown' },
  ]
  assert.equal(dpayCommission({ attempts: paid, refunds }), 540 + 20 + 180)
})

test('O-50 dpayCommission: one dpay-panel refund recorded per line is one fee, a panel refund per payment', () => {
  // A 10 zł payment refunded in the dpay panel, recorded as two 5 zł line shares: one 0,20 zł fee.
  const attempts = [{ grosze: 1000, status: 'refunded' }]
  const split = [
    { payment_attempt_id: 'a', amount: 500, dpay_status: 'accepted', reason: 'external' },
    { payment_attempt_id: 'a', amount: 500, dpay_status: 'accepted', reason: 'external' },
  ]
  assert.equal(dpayCommission({ attempts, refunds: split }), 20 + 20)
  // Panel refunds of different payments stay separate fees.
  const two = [{ ...split[0] }, { ...split[1], payment_attempt_id: 'b' }]
  assert.equal(dpayCommission({ attempts: [], refunds: two }), 40)
  // „Zwróć wpłatę” calls dpay once per line: two organizer refunds of one payment are two fees.
  const organizer = split.map((f) => ({ ...f, reason: null }))
  assert.equal(dpayCommission({ attempts: [], refunds: organizer }), 40)
})
