// Plan 7, task 4b (ruling C-1): the cart fields of a sign-up body, read before any RPC.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  cartIsEmpty, cartMakesMoney, cartOfRequest, normalizeDonation, normalizeExtras, normalizeVoucherCode, withCart,
} from '../../../supabase/functions/_shared/registration/cart.js'

const V = '0b6c1d2e-3f40-4a5b-8c6d-7e8f90a1b2c3'

test('V-28 a donation: every form of zero is 0, a whole number of grosze passes, anything else is refused', () => {
  for (const zero of [undefined, null, 0, 0.0, -0, '0', ' 0 ', '', '00']) {
    assert.deepEqual(normalizeDonation(zero), { ok: true, value: 0 }, JSON.stringify(zero))
  }
  assert.deepEqual(normalizeDonation(2000), { ok: true, value: 2000 })
  assert.deepEqual(normalizeDonation('2000'), { ok: true, value: 2000 })
  for (const bad of [12.5, -100, '12.5', '1e3', 'abc', '-5', true, {}, [], Number.NaN, Infinity, 2 ** 53]) {
    assert.equal(normalizeDonation(bad).ok, false, String(bad))
  }
})

test('V-28 extras: absent or null is none; each needs a variant and a whole qty ≥ 0, never a missing one', () => {
  assert.deepEqual(normalizeExtras(undefined), { ok: true, value: [] })
  assert.deepEqual(normalizeExtras(null), { ok: true, value: [] })
  assert.deepEqual(normalizeExtras([{ variantId: V, qty: 2 }, { variantId: ` ${V} `, qty: 0 }]),
    { ok: true, value: [{ variantId: V, qty: 2 }, { variantId: V, qty: 0 }] })
  for (const bad of [{}, 'x', [{ variantId: V }], [{ variantId: V, qty: null }], [{ variantId: V, qty: '1' }],
    [{ variantId: V, qty: 1.5 }], [{ variantId: V, qty: -1 }], [{ qty: 1 }], [{ variantId: '', qty: 1 }], [null], [[V, 1]]]) {
    assert.equal(normalizeExtras(bad).ok, false, JSON.stringify(bad))
  }
})

test('V-28 a code: blank is none, a string is trimmed, anything else is refused', () => {
  assert.deepEqual(normalizeVoucherCode(undefined), { ok: true, value: null })
  assert.deepEqual(normalizeVoucherCode('  '), { ok: true, value: null })
  assert.deepEqual(normalizeVoucherCode(' leszy-1 '), { ok: true, value: 'leszy-1' })
  assert.equal(normalizeVoucherCode(1234).ok, false)
})

test('V-28 cartOfRequest reads a group, the legacy body and a team, and names the field that is wrong', () => {
  const group = cartOfRequest({
    people: [{ voucherCode: ' KOD1 ', person: {} }, { extras: [{ variantId: V, qty: 1 }] }], donation: '2000',
  })
  assert.deepEqual(group, {
    ok: true, voucherCode: null, donation: 2000,
    people: [{ voucherCode: 'KOD1', extras: [] }, { voucherCode: null, extras: [{ variantId: V, qty: 1 }] }],
  })
  assert.deepEqual(cartOfRequest({ categoryId: 'x', person: {}, voucherCode: 'KOD1' }).people, [{ voucherCode: 'KOD1', extras: [] }])
  const team = cartOfRequest({ members: [{ voucherCode: 'IGNORED' }, { extras: [{ variantId: V, qty: 1 }] }], voucherCode: 'TEAM' }, { team: true })
  assert.deepEqual(team.people, [{ voucherCode: null, extras: [] }, { voucherCode: null, extras: [{ variantId: V, qty: 1 }] }])
  assert.equal(team.voucherCode, 'TEAM')

  assert.deepEqual(cartOfRequest({ people: [{}], donation: 'x' }), { ok: false, field: 'donation' })
  assert.deepEqual(cartOfRequest({ people: [{}, { extras: [{ variantId: V }] }] }), { ok: false, field: 'extras', index: 1 })
  assert.deepEqual(cartOfRequest({ people: [{ voucherCode: 7 }] }), { ok: false, field: 'voucherCode', index: 0 })
  assert.deepEqual(cartOfRequest({ members: [{}], voucherCode: 7 }, { team: true }), { ok: false, field: 'voucherCode', index: 0 })
})

test('V-28 cartMakesMoney: an extra with qty above 0 or a donation; cartIsEmpty also counts a code', () => {
  const cart = (people, donation = 0, voucherCode = null) => ({ ok: true, people, donation, voucherCode })
  assert.equal(cartMakesMoney(cart([{ voucherCode: 'K', extras: [] }])), false)
  assert.equal(cartMakesMoney(cart([{ voucherCode: null, extras: [{ variantId: V, qty: 0 }] }])), false)
  assert.equal(cartMakesMoney(cart([{ voucherCode: null, extras: [{ variantId: V, qty: 1 }] }])), true)
  assert.equal(cartMakesMoney(cart([{ voucherCode: null, extras: [] }], 100)), true)
  assert.equal(cartIsEmpty(cart([{ voucherCode: null, extras: [{ variantId: V, qty: 0 }] }])), true)
  assert.equal(cartIsEmpty(cart([{ voucherCode: 'K', extras: [] }])), false)
  assert.equal(cartIsEmpty(cart([{ voucherCode: null, extras: [] }], 0, 'TEAM')), false)
})

test('V-28 withCart adds a code and extras only when there are any', () => {
  assert.deepEqual(withCart({ a: 1 }, { voucherCode: null, extras: [] }), { a: 1 })
  assert.deepEqual(withCart({ a: 1 }, { voucherCode: 'K', extras: [{ variantId: V, qty: 1 }] }),
    { a: 1, voucherCode: 'K', extras: [{ variantId: V, qty: 1 }] })
})
