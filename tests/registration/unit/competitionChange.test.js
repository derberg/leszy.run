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

const CODES = ['edits_closed', 'team_competition', 'refund_pending', 'surcharge_open', 'transfer_open', 'unavailable', 'full', 'ineligible', 'role_change', 'no_price', 'no_payer', 'same_competition', 'price_changed', 'race_day', 'offline_paid', 'not_live', 'not_allowed',
  // Raised by change_competition / reserve_organizer_refund / organizer_mark_paid_offline (task 7).
  'paying_closed', 'request_key_mismatch', 'refund_in_progress', 'exceeds', 'invalid_kind', 'not_found',
  'change_retry', 'surcharge', 'not_paid', 'invalid_amount', 'invalid_request_key', 'entry_changed',
  'not_surcharge', 'dpay_not_configured',
  // runner_edit_registration's own (task 13).
  'field_not_allowed', 'team_member', 'invalid_field']

test('every refusal has status, Polish error and code', () => {
  for (const c of CODES) {
    const r = changeRefusal(c)
    assert.equal(r.code, c)
    assert.ok([400, 403, 404, 409, 422, 503].includes(r.status), `${c}: ${r.status}`)
    assert.match(r.error, /[ąćęłńóśźż]|[a-z]/i)
    assert.ok(r.error.length > 5)
  }
  assert.equal(changeRefusal('not_allowed').status, 403)
  assert.equal(changeRefusal('not_found').status, 404)
  assert.equal(changeRefusal('dpay_not_configured').status, 503)
  assert.equal(changeRefusal('change_retry').status, 409)
})

test('the runner reads the club\'s refusal and its own copy for an offline-paid entry', () => {
  assert.equal(changeRefusal('not_allowed').error, 'Organizator nie zezwala na tę zmianę.')
  assert.equal(changeRefusal('field_not_allowed').status, 422)
  assert.equal(changeRefusal('team_member').status, 404)
  assert.equal(changeRefusal('offline_paid', { runner: true }).status, 409)
  assert.match(changeRefusal('offline_paid', { runner: true }).error, /organizator/i)
  assert.notEqual(changeRefusal('offline_paid', { runner: true }).error, changeRefusal('offline_paid').error)
  assert.equal(changeRefusal('full', { runner: true }).error, changeRefusal('full').error)
})

test('unknown refusal throws', () => {
  assert.throws(() => changeRefusal('nope'))
})
