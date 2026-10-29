import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { checkoutModel, SUPPORT_HINT, SUPPORT_QUESTION, SUPPORT_REASON } from '../../src/lib/checkout.js'
import { formatPln, orderAmounts } from '../../../supabase/functions/_shared/registration/money.js'

// P-44: the LESZY.RUN support choice in RA4 (Art. 10 ustawy o prawach
// konsumenta): both buttons unpressed, nothing preselected, „Zapłać” disabled
// until one is chosen, and the total shown is money.js's for that choice.

describe('checkoutModel: the support choice (P-44)', () => {
  it('nothing is preselected: both buttons unpressed and „Zapłać” disabled, with the hint', () => {
    const m = checkoutModel({ entryPrices: [6000], choice: null })
    assert.equal(m.askSupport, true)
    assert.deepEqual(m.options, [
      { value: true, label: 'Wspieram · 1,20 zł', pressed: false },
      { value: false, label: 'Nie tym razem', pressed: false },
    ])
    assert.equal(m.payDisabled, true)
    assert.equal(m.hint, SUPPORT_HINT)
    assert.equal(SUPPORT_HINT, '* wybierz, czy wspierasz LESZY.RUN')
    assert.equal(SUPPORT_QUESTION, 'Wesprzesz LESZY.RUN 2%?')
    assert.equal(SUPPORT_REASON, 'Z tego utrzymujemy stronę, zapisy i kalendarz.')
    assert.equal(m.supportChoice, null, 'nothing to send yet')
  })

  it('„Nie tym razem”: pressed, „Zapłać” enabled, Razem 60,55 zł for a 60 zł entry', () => {
    const m = checkoutModel({ entryPrices: [6000], choice: false })
    assert.deepEqual(m.options.map((o) => o.pressed), [false, true])
    assert.equal(m.payDisabled, false)
    assert.equal(m.hint, null)
    assert.equal(m.supportChoice, false)
    assert.equal(m.amounts.supportFee, 0)
    assert.equal(m.amounts.paymentFee, 55)
    assert.equal(m.amounts.total, 6055)
    assert.equal(m.totalLabel, '60,55 zł')
    assert.equal(m.displayedTotal, 6055)
  })

  it('„Wspieram”: pressed, Razem 61,76 zł (support 1,20 zł, dpay 0,56 zł)', () => {
    const m = checkoutModel({ entryPrices: [6000], choice: true })
    assert.deepEqual(m.options.map((o) => o.pressed), [true, false])
    assert.equal(m.supportChoice, true)
    assert.equal(m.amounts.supportFee, 120)
    assert.equal(m.amounts.paymentFee, 56)
    assert.equal(m.totalLabel, '61,76 zł')
    assert.equal(m.supportLabel, '1,20 zł')
    assert.equal(m.paymentFeeLabel, '0,56 zł')
    assert.equal(m.entryLabel, '60,00 zł')
  })

  it('the displayed total is orderAmounts’ for every choice and many prices', () => {
    for (const price of [1, 99, 100, 2550, 6000, 9999, 12345, 49900]) {
      for (const choice of [true, false]) {
        const m = checkoutModel({ entryPrices: [price], choice })
        const a = orderAmounts({ entryPrices: [price], supportChoice: choice })
        assert.equal(m.displayedTotal, a.total, `${price} ${choice}`)
        assert.equal(m.totalLabel, formatPln(a.total))
      }
    }
  })

  it('before a choice the total shown is the one without support, never a preselected support', () => {
    const m = checkoutModel({ entryPrices: [6000], choice: null })
    assert.equal(m.amounts.supportFee, 0)
    assert.equal(m.totalLabel, '60,55 zł')
  })

  it('an entry of 0 zł asks nothing, can be paid at once and sends supportChoice false', () => {
    const m = checkoutModel({ entryPrices: [0], choice: null })
    assert.equal(m.askSupport, false)
    assert.equal(m.payDisabled, false)
    assert.equal(m.supportChoice, false)
    assert.equal(m.displayedTotal, 0)
    assert.equal(m.totalLabel, '0,00 zł')
  })

  it('busy or closed keeps „Zapłać” disabled whatever the choice', () => {
    assert.equal(checkoutModel({ entryPrices: [6000], choice: true, busy: true }).payDisabled, true)
    assert.equal(checkoutModel({ entryPrices: [6000], choice: true, closed: true }).payDisabled, true)
  })
})
