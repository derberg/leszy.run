import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  entryMoney, entryStatusKey, pendingSurcharge, statusLabel, unconfirmedRefundGrosze,
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

// Competition change (CC readers): the entry's money is its own order's lines plus every PAID
// surcharge line (each in its own order); registrations.price/refunded hold the whole of it.
describe('entryMoney (CC readers)', () => {
  const orders = new Map([
    ['o1', { id: 'o1', status: 'paid', kind: 'registration' }],
    ['s-paid', { id: 's-paid', status: 'paid', kind: 'surcharge' }],
    ['s-open', { id: 's-open', status: 'pending', kind: 'surcharge' }],
    ['s-gone', { id: 's-gone', status: 'expired', kind: 'surcharge' }],
  ])
  const line = (id, order_id, kind, amount, refunded = 0) => ({ id, order_id, kind, amount, refunded })

  it('counts a surcharge line only when its own order is paid', () => {
    const m = entryMoney({ order_id: 'o1', price: 8000, refunded: 0 }, {
      orderOf: orders,
      lines: [line('l1', 'o1', 'entry', 6000), line('l2', 'o1', 'extra', 1500), line('l3', 's-paid', 'surcharge', 2000),
        line('l4', 's-open', 'surcharge', 1000), line('l5', 's-gone', 'surcharge', 500)],
    })
    assert.deepEqual(m.lines, [
      { id: 'l1', kind: 'entry', amount: 6000, refunded: 0 },
      { id: 'l2', kind: 'extra', amount: 1500, refunded: 0 },
      { id: 'l3', kind: 'surcharge', amount: 2000, refunded: 0 },
    ])
    assert.equal(m.paidAmount, 9500)
    assert.equal(m.refunded, 0)
    assert.equal(m.entryRefunded, 0)
  })

  it('a pending entry order pays nothing; its lines are listed as before', () => {
    const m = entryMoney({ order_id: 'o9', price: 6000, refunded: 0 }, {
      orderOf: new Map([['o9', { id: 'o9', status: 'pending', kind: 'registration' }]]),
      lines: [line('l1', 'o9', 'entry', 6000)],
    })
    assert.equal(m.paidAmount, 0)
    assert.equal(m.lines.length, 1)
  })

  it('takes the entry’s refunded money from the registration (an offline difference has no line)', () => {
    const m = entryMoney({ order_id: 'o1', price: 6000, refunded: 2000 }, {
      orderOf: orders, lines: [line('l1', 'o1', 'entry', 6000), line('l2', 'o1', 'extra', 1500, 500)],
    })
    assert.equal(m.entryRefunded, 2000)
    assert.equal(m.refunded, 2500, 'the extra’s refund plus the entry’s')
  })

  it('never reads less than the lines say', () => {
    const m = entryMoney({ order_id: 'o1', price: 8000, refunded: 0 }, {
      orderOf: orders, lines: [line('l1', 'o1', 'entry', 6000, 1000), line('l3', 's-paid', 'surcharge', 2000, 2000)],
    })
    assert.equal(m.entryRefunded, 3000)
    assert.equal(m.refunded, 3000)
  })
})

describe('pendingSurcharge (CC readers)', () => {
  const names = new Map([['c2', 'Bieg 10 km']])
  const s = (over) => ({ id: 's1', kind: 'surcharge', status: 'pending', surcharge_registration_id: 'r1', surcharge_to_category_id: 'c2', total: 2000, expires_at: LATER, ...over })
  it('the live pending surcharge of the entry', () => {
    assert.deepEqual(pendingSurcharge('r1', [s({})], names, NOW), { orderId: 's1', toCompetition: 'Bieg 10 km', grosze: 2000, expiresAt: LATER })
  })
  it('null for another entry, a paid, expired or due one, or a registration order', () => {
    assert.equal(pendingSurcharge('r2', [s({})], names, NOW), null)
    assert.equal(pendingSurcharge('r1', [s({ status: 'paid' })], names, NOW), null)
    assert.equal(pendingSurcharge('r1', [s({ status: 'expired' })], names, NOW), null)
    assert.equal(pendingSurcharge('r1', [s({ expires_at: EARLIER })], names, NOW), null)
    assert.equal(pendingSurcharge('r1', [s({ kind: 'registration' })], names, NOW), null)
  })
})
