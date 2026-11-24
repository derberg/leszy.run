import { test } from 'node:test'
import assert from 'node:assert/strict'
import { changeQuote, changeKind, changeRefusal } from '../../../supabase/functions/_shared/registration/competitionChange.js'

test('refund when target is cheaper', () => {
  const q = changeQuote({ held: 6000, listPriceTarget: 4000, voucherPercent: null, voucherCoversTarget: false })
  assert.deepEqual(q, { listPrice: 4000, price: 4000, difference: -2000, voucherKept: false })
  assert.equal(changeKind(q.difference), 'refund')
})

test('surcharge with a covering voucher', () => {
  const q = changeQuote({ held: 4000, listPriceTarget: 6000, voucherPercent: 10, voucherCoversTarget: true })
  assert.equal(q.price, 5400)
  assert.equal(q.difference, 1400)
  assert.equal(q.voucherKept, true)
  assert.equal(changeKind(1400), 'surcharge')
})

test('voucher not covering the target is dropped', () => {
  const q = changeQuote({ held: 4000, listPriceTarget: 6000, voucherPercent: 10, voucherCoversTarget: false })
  assert.equal(q.price, 6000)
  assert.equal(q.voucherKept, false)
})

test('free target refunds everything held', () => {
  const q = changeQuote({ held: 5000, listPriceTarget: 0, voucherPercent: 10, voucherCoversTarget: true })
  assert.equal(q.difference, -5000)
  assert.equal(changeKind(q.difference), 'refund')
})

test('equal is same', () => {
  assert.equal(changeKind(changeQuote({ held: 3000, listPriceTarget: 3000 }).difference), 'same')
})

const CODES = ['edits_closed', 'team_competition', 'refund_pending', 'surcharge_open', 'transfer_open', 'unavailable', 'full', 'ineligible', 'role_change', 'no_price', 'no_payer', 'same_competition', 'price_changed', 'race_day', 'offline_paid', 'not_live', 'not_allowed']

test('every refusal has status, Polish error and code', () => {
  for (const c of CODES) {
    const r = changeRefusal(c)
    assert.equal(r.code, c)
    assert.ok([403, 409, 422].includes(r.status))
    assert.ok(r.error.length > 5)
  }
  assert.equal(changeRefusal('not_allowed').status, 403)
})

test('unknown refusal throws', () => {
  assert.throws(() => changeRefusal('nope'))
})
