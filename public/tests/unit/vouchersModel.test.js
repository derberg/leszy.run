import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { voucherRequest, voucherView } from '../../src/lib/vouchersModel.js'

// Płatności „Kody rabatowe” (A6, Plan 7 task 9b): one row of organizer-vouchers' list as the table
// shows it, and the form as the request organizer-vouchers takes.

const voucher = (over = {}) => ({
  id: 'v', code: 'BIEGACZ15', percent: 15, used: 3, maxUses: 50, validUntil: '2027-11-30',
  partner: { id: 'p', name: 'Sklep Biegacz' }, categoryIds: [], note: null, disabled: false, ...over,
})

describe('voucherView', () => {
  const today = '2027-11-01'
  it('Rabat, Użycia, Partner and Ważny do as the columns show them', () => {
    assert.deepEqual(voucherView(voucher(), { today }), {
      id: 'v', code: 'BIEGACZ15', discount: '−15%', uses: '3 / 50', partner: 'Sklep Biegacz', validUntil: '30.11.2027',
      state: null, canDisable: true, canDelete: false,
    })
  })
  it('no partner and no end date read „—”; an unused code can be deleted', () => {
    const v = voucherView(voucher({ partner: null, validUntil: null, used: 0 }), { today })
    assert.deepEqual([v.partner, v.validUntil, v.canDelete], ['—', '—', true])
  })
  it('the state of a code nobody can use any more', () => {
    assert.equal(voucherView(voucher({ disabled: true }), { today }).state, 'WYŁĄCZONY')
    assert.equal(voucherView(voucher({ disabled: true }), { today }).canDisable, false)
    assert.equal(voucherView(voucher({ used: 50 }), { today }).state, 'WYKORZYSTANY')
    assert.equal(voucherView(voucher({ validUntil: '2027-10-31' }), { today }).state, 'WYGASŁ')
    assert.equal(voucherView(voucher({ validUntil: today }), { today }).state, null, 'valid through the whole day')
  })
})

describe('voucherRequest', () => {
  it('„+ Kod”: numbers as numbers, blanks as null, the code as typed (the server normalizes it)', () => {
    assert.deepEqual(voucherRequest({ code: ' biegacz15 ', percent: '15', maxUses: '50', validUntil: '', partnerId: '', categoryIds: [] }), {
      code: 'biegacz15', percent: 15, maxUses: 50, validUntil: null, partnerId: null, categoryIds: [],
    })
  })
  it('an empty code is left out, so the server generates one', () => {
    assert.ok(!('code' in voucherRequest({ code: '', percent: '10', maxUses: '1' })))
  })
  it('a value that is not a whole number goes as typed, so the server names the field', () => {
    assert.equal(voucherRequest({ percent: '12,5', maxUses: '1' }).percent, '12,5')
  })
  it('„Wygeneruj kody”: n and the prefix; no code and no limit (generated codes are single-use)', () => {
    assert.deepEqual(voucherRequest({ n: '20', prefix: 'radio', percent: '10', validUntil: '2027-11-30', partnerId: 'p', categoryIds: ['c'] }, { generate: true }), {
      n: 20, prefix: 'radio', percent: 10, validUntil: '2027-11-30', partnerId: 'p', categoryIds: ['c'],
    })
  })
})
