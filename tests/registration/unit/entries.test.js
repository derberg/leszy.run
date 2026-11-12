import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  entryStatusKey, statusLabel, unconfirmedRefundGrosze,
} from '../../../supabase/functions/_shared/registration/entries.js'

const NOW = new Date('2026-11-01T12:00:00Z')
const LATER = '2026-11-04T22:59:00Z'
const EARLIER = '2026-10-30T10:00:00Z'
const onHost = { removed_at: null, withdrawn_at: null }
const organizerRefund = (dpay_status, amount = 2000) => ({ kind: 'organizer', dpay_status, amount })

describe('entryStatusKey (O-01)', () => {
  const table = [
    ['free entry', { status: 'confirmed', paymentStatus: 'free' }, 'free'],
    ['paid entry', { status: 'confirmed', paymentStatus: 'paid' }, 'paid'],
    ['paid outside the system', { status: 'confirmed', paymentStatus: 'paid', paidOffline: true }, 'paid_offline'],
    ['a free entry is never offline-paid', { status: 'confirmed', paymentStatus: 'free', paidOffline: true }, 'free'],
    ['awaiting, deadline ahead', { status: 'pending_payment', paymentStatus: 'awaiting', expiresAt: LATER }, 'awaiting'],
    ['awaiting, no deadline known', { status: 'pending_payment', paymentStatus: 'awaiting', expiresAt: null }, 'awaiting'],
    ['deadline passed, job not run yet', { status: 'pending_payment', paymentStatus: 'awaiting', expiresAt: EARLIER }, 'expired'],
    ['deadline is this instant', { status: 'pending_payment', expiresAt: NOW.toISOString() }, 'expired'],
    ['expired', { status: 'expired' }, 'expired'],
    ['cancelled, no participant', { status: 'cancelled', participant: null }, 'cancelled'],
    ['cancelled, participant removed', { status: 'cancelled', participant: { removed_at: EARLIER, withdrawn_at: null } }, 'cancelled'],
    ['cancelled, host withdrew', { status: 'cancelled', participant: { removed_at: null, withdrawn_at: EARLIER } }, 'cancelled'],
    ['transferred', { status: 'transferred_out' }, 'transferred'],
    ['cancelled, participant still on the host', { status: 'cancelled', participant: onHost }, 'withdraw_on_host'],
    ['confirmed, participant on the host', { status: 'confirmed', paymentStatus: 'paid', participant: onHost }, 'paid'],
    ['organizer refund pending', { status: 'confirmed', paymentStatus: 'paid', refunds: [organizerRefund('pending')] }, 'refund_unconfirmed'],
    ['organizer refund unknown', { status: 'confirmed', paymentStatus: 'paid', refunds: [organizerRefund('unknown')] }, 'refund_unconfirmed'],
    ['automatic refund pending is not the organizer\'s', { status: 'confirmed', paymentStatus: 'paid', refunds: [{ kind: 'automatic', dpay_status: 'pending' }] }, 'paid'],
    ['settled refunds', { status: 'confirmed', paymentStatus: 'paid', refunds: [organizerRefund('accepted'), organizerRefund('rejected'), organizerRefund('insufficient_balance')] }, 'paid'],
    ['precedence: unconfirmed over withdraw', { status: 'cancelled', participant: onHost, refunds: [organizerRefund('unknown')] }, 'refund_unconfirmed'],
    ['precedence: withdraw over cancelled', { status: 'cancelled', participant: onHost, refunds: [organizerRefund('accepted')] }, 'withdraw_on_host'],
  ]
  for (const [name, row, key] of table) {
    it(`${name} → ${key}`, () => assert.equal(entryStatusKey(row, NOW), key))
  }
})

describe('V-56 a package handed on after closes_at, with the runner still on the host', () => {
  it('transferred_out with a live participant → withdraw_on_host', () => {
    assert.equal(entryStatusKey({ status: 'transferred_out', participant: onHost }, NOW), 'withdraw_on_host')
  })
  it('transferred_out whose participant was removed or withdrawn → transferred', () => {
    assert.equal(entryStatusKey({ status: 'transferred_out', participant: { removed_at: EARLIER, withdrawn_at: null } }, NOW), 'transferred')
    assert.equal(entryStatusKey({ status: 'transferred_out', participant: { removed_at: null, withdrawn_at: EARLIER } }, NOW), 'transferred')
  })
})

describe('entryStatusKey contract (F5)', () => {
  it('a confirmed row without paymentStatus throws instead of reading free', () => {
    assert.throws(() => entryStatusKey({ status: 'confirmed' }, NOW), /missing_payment_status/)
    assert.throws(() => entryStatusKey({ status: 'confirmed', paymentStatus: 'awaiting' }, NOW), /missing_payment_status/)
  })
})

describe('unconfirmedRefundGrosze', () => {
  it('sums the organizer reservations nobody has confirmed', () => {
    assert.equal(unconfirmedRefundGrosze({
      refunds: [organizerRefund('pending', 1000), organizerRefund('unknown', 500), organizerRefund('accepted', 2000),
        { kind: 'automatic', dpay_status: 'pending', amount: 7000 }],
    }), 1500)
    assert.equal(unconfirmedRefundGrosze({}), 0)
  })
})

describe('statusLabel (O-02)', () => {
  it('reads the payment deadline as a Warsaw day', () => {
    assert.equal(statusLabel('awaiting', { expiresAt: '2026-11-04T22:59:00Z' }), 'CZEKA NA WPŁATĘ · DO 4.11')
    assert.equal(statusLabel('awaiting', { expiresAt: '2026-03-04T23:30:00Z' }), 'CZEKA NA WPŁATĘ · DO 5.03')
    assert.equal(statusLabel('awaiting', {}), 'CZEKA NA WPŁATĘ')
  })

  const plain = [
    ['free', 'NA LIŚCIE'], ['paid', 'OPŁACONE'], ['expired', 'WYGASŁO'], ['cancelled', 'ANULOWANE'],
    ['transferred', 'PRZEPISANY'], ['refund_unconfirmed', 'ZWROT NIEPOTWIERDZONY'],
    ['withdraw_on_host', 'WYCOFAJ W PANELU POMIARU'],
  ]
  for (const [key, label] of plain) it(`${key} → ${label}`, () => assert.equal(statusLabel(key), label))

  it('appends a partial refund, in whole złoty when it can', () => {
    assert.equal(statusLabel('paid', { refunded: 2000, paidAmount: 6000 }), 'OPŁACONE · ZWROT 20 ZŁ')
    assert.equal(statusLabel('paid', { refunded: 2050, paidAmount: 6000 }), 'OPŁACONE · ZWROT 20,50 ZŁ')
    assert.equal(statusLabel('cancelled', { refunded: 2000, paidAmount: 6000 }), 'ANULOWANE · ZWROT 20 ZŁ')
  })

  it('says nothing of a refund that is not partial or not confirmed', () => {
    assert.equal(statusLabel('cancelled', { refunded: 6000, paidAmount: 6000 }), 'ANULOWANE')
    assert.equal(statusLabel('paid', { refunded: 0, paidAmount: 6000 }), 'OPŁACONE')
    assert.equal(statusLabel('refund_unconfirmed', { refunded: 2000, paidAmount: 6000 }), 'ZWROT NIEPOTWIERDZONY')
  })

  it('names an automatic refund for a full competition (D6-15)', () => {
    assert.equal(statusLabel('expired', { autoRefundReason: 'full' }), 'WYGASŁO · ZWROT: BRAK MIEJSC')
    assert.equal(statusLabel('cancelled', { autoRefundReason: 'duplicate' }), 'ANULOWANE')
  })
})

describe('statusLabel of an entry paid outside the system (OP-9)', () => {
  it('reads POZA SYSTEMEM', () => assert.equal(statusLabel('paid_offline', { paidAmount: 6000, refunded: 0 }), 'POZA SYSTEMEM'))
})
