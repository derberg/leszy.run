import { test } from 'node:test'
import assert from 'node:assert/strict'
import { voucherAnswer, voucherRefusal } from '../../../supabase/functions/_shared/registration/voucherCheck.js'

// Plan 7, task 8a (V-67): check-voucher decides as create_order's registration_voucher_refusal,
// in the same order, then voucher_not_applicable on a 0 zł entry.
const C9 = '11111111-1111-4111-8111-111111111111'
const C1 = '22222222-2222-4222-8222-222222222222'
const now = new Date('2026-11-10T12:00:00Z')
const v = (over = {}) => ({ percent: 15, used: 0, max_uses: 1, valid_until: null, disabled_at: null, ...over })

test('V-67 voucherRefusal: the reasons and their order', () => {
  const at = (voucher, extra = {}) => voucherRefusal({ voucher, categoryId: C9, listPrice: 6000, now, ...extra })
  assert.equal(at(v()), null)
  assert.equal(at(null), 'voucher_invalid')
  assert.equal(at(v({ disabled_at: '2026-11-01T00:00:00Z', valid_until: '2026-01-01T00:00:00Z' })), 'voucher_invalid')
  assert.equal(at(v({ valid_until: now.toISOString() })), 'voucher_expired')
  assert.equal(at(v({ valid_until: new Date(now.getTime() + 1).toISOString() })), null)
  assert.equal(at(v({ used: 1, valid_until: '2026-01-01T00:00:00Z' })), 'voucher_expired')
  assert.equal(at(v({ used: 1 }), { linkedCategoryIds: [C1] }), 'voucher_category')
  assert.equal(at(v(), { linkedCategoryIds: [C9.toUpperCase()] }), null)
  assert.equal(at(v({ used: 1 })), 'voucher_used_up')
  assert.equal(at(v({ used: 1 }), { listPrice: 0 }), 'voucher_used_up')
  assert.equal(at(v(), { listPrice: 0 }), 'voucher_not_applicable')
})

test('V-67 voucherAnswer: percent and the discounted price, nothing else', () => {
  assert.deepEqual(voucherAnswer({ percent: 15, listPrice: 6000 }), { percent: 15, price: 5100 })
  assert.deepEqual(voucherAnswer({ percent: 15, listPrice: 4999 }), { percent: 15, price: 4250 })
  assert.deepEqual(voucherAnswer({ percent: 100, listPrice: 6000 }), { percent: 100, price: 0 })
})
