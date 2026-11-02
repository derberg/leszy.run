import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { paidOrderCancelled, refundState } from '../../src/lib/orderOutcome.js'

describe('paidOrderCancelled', () => {
  it('is true for a paid order whose every entry is cancelled (an organizer refund)', () => {
    assert.equal(paidOrderCancelled({ status: 'paid', lines: [{ cancelled: true }, { cancelled: true }] }), true)
  })
  it('is false while one entry is live, for an order with no lines, and for other statuses', () => {
    assert.equal(paidOrderCancelled({ status: 'paid', lines: [{ cancelled: true }, { cancelled: false }] }), false)
    assert.equal(paidOrderCancelled({ status: 'paid', lines: [] }), false)
    assert.equal(paidOrderCancelled({ status: 'pending', lines: [{ cancelled: true }] }), false)
    assert.equal(paidOrderCancelled(null), false)
  })
})

describe('refundState', () => {
  it('reads the accepted refunds against the total', () => {
    assert.equal(refundState(2000, 2000), 'full')
    assert.equal(refundState(2000, 500), 'partial')
    assert.equal(refundState(2000, 0), null)
    assert.equal(refundState(2000, undefined), null)
  })
})
