import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { paidOrderCancelled, refundState, surchargeEndedText, SURCHARGE_LATE_REFUND } from '../../src/lib/orderOutcome.js'

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

describe('surchargeEndedText', () => {
  it('an expired surcharge with no payment: the money never came, the entry stays', () => {
    assert.equal(surchargeEndedText({ status: 'expired', fromCompetition: '10 km', lateRefund: false }),
      'Nie dostaliśmy dopłaty w terminie. Zgłoszenie zostaje w konkurencji 10 km.')
  })
  it('a late payment refunded in full never reads as „nie dostaliśmy”', () => {
    assert.equal(SURCHARGE_LATE_REFUND, 'Wpłata wpłynęła po terminie — zwracamy ją w całości.')
    assert.equal(surchargeEndedText({ status: 'expired', fromCompetition: '10 km', lateRefund: true }), SURCHARGE_LATE_REFUND)
    assert.equal(surchargeEndedText({ status: 'cancelled', cancelledReason: 'buyer_cancelled', lateRefund: true }), SURCHARGE_LATE_REFUND)
    assert.equal(surchargeEndedText({ status: 'cancelled', cancelledReason: 'entry_cancelled', lateRefund: true }), SURCHARGE_LATE_REFUND)
  })
  it('a reason that already says the money goes back keeps its own text', () => {
    assert.match(surchargeEndedText({ status: 'cancelled', cancelledReason: 'full', lateRefund: true }), /^Zanim wpłata dotarła/)
    assert.equal(surchargeEndedText({ status: 'cancelled', cancelledReason: 'organizer_cancelled' }),
      'Organizator anulował tę dopłatę. Zgłoszenie zostaje w dotychczasowej konkurencji.')
  })
})
