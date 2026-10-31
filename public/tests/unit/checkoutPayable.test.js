import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { checkoutModel, newOrderPayable, payLinkOpen, PAYING_CLOSES_BEFORE_MS } from '../../src/lib/checkout.js'

describe('checkoutModel', () => {
  it('„Zapłać” is enabled at once, the total being the sum of the entry prices (G-76)', () => {
    const m = checkoutModel({ entryPrices: [6000, 2500] })
    assert.equal(m.payDisabled, false)
    assert.equal(m.displayedTotal, 8500)
    assert.equal(m.totalLabel, '85,00 zł')
  })

  it('an entry of 0 zł can be paid at once', () => {
    const m = checkoutModel({ entryPrices: [0] })
    assert.equal(m.payDisabled, false)
    assert.equal(m.displayedTotal, 0)
    assert.equal(m.totalLabel, '0,00 zł')
  })

  it('busy or closed keeps „Zapłać” disabled', () => {
    assert.equal(checkoutModel({ entryPrices: [6000], busy: true }).payDisabled, true)
    assert.equal(checkoutModel({ entryPrices: [6000], closed: true }).payDisabled, true)
  })
})

// Task 9 review M1. Plan ruling 7: a new paid order is refused from one hour
// before closes_at (create_order's paying_closed). User decision: an existing
// order's pay link starts no new payment from closes_at on (pay-order).
describe('when an online payment may start', () => {
  const closesAt = '2026-12-02T23:00:00.000Z'
  const at = (iso) => new Date(iso)

  it('RA4 (a new order): until one hour before closes_at', () => {
    assert.equal(PAYING_CLOSES_BEFORE_MS, 3600 * 1000)
    assert.equal(newOrderPayable(closesAt, at('2026-12-02T21:59:59.000Z')), true)
    assert.equal(newOrderPayable(closesAt, at('2026-12-02T22:00:00.000Z')), false)
    assert.equal(newOrderPayable(closesAt, at('2026-12-03T00:00:00.000Z')), false)
  })

  it('the order page (an existing order): until closes_at', () => {
    assert.equal(payLinkOpen(closesAt, at('2026-12-02T22:59:59.000Z')), true)
    assert.equal(payLinkOpen(closesAt, at('2026-12-02T23:00:00.000Z')), false)
  })

  it('no closesAt known: never block on the client, the server decides', () => {
    assert.equal(newOrderPayable(null, at('2026-12-03T00:00:00.000Z')), true)
    assert.equal(payLinkOpen(undefined, at('2026-12-03T00:00:00.000Z')), true)
  })
})
