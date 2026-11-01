// Plan 7 Task 1: pure pricing. Warsaw-day tiers, percent vouchers rounded in the runner's favour by
// at most 1 grosz, and one cart of entries, extras and a donation. No fee to LESZY.RUN anywhere.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  currentTier,
  nextTier,
  validateTiers,
  discountedPrice,
  cartAmounts,
  voucherLineLabel,
  TIERS_ORDER_MESSAGE,
} from '../../../supabase/functions/_shared/registration/pricing.js'
import { MoneyError } from '../../../supabase/functions/_shared/registration/money.js'

// mulberry32: a fixed seed makes every run check the same 100 000 carts.
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1))

test('V-01 discountedPrice for every list 0..100000 and every percent 1..100', () => {
  const started = Date.now()
  for (let list = 0; list <= 100_000; list++) {
    let prev = list
    for (let p = 1; p <= 100; p++) {
      const d = discountedPrice(list, p)
      if (d < 0 || d > list) assert.fail(`range (${list},${p}) → ${d}`)
      if (d !== list - Math.floor((list * p) / 100)) assert.fail(`formula (${list},${p}) → ${d}`)
      if (d > prev) assert.fail(`not non-increasing at (${list},${p})`)
      prev = d
    }
    if (prev !== 0) assert.fail(`p=100 (${list}) → ${prev}`)
  }
  assert.ok(Date.now() - started < 10_000, 'V-01 must run in under 10 s')
})

test('V-01 named rounding cases: the discount rounds down, never half-up', () => {
  assert.equal(discountedPrice(4999, 15), 4250)
  assert.equal(discountedPrice(6000, 15), 5100)
  assert.equal(discountedPrice(1, 50), 1)
  assert.equal(discountedPrice(3, 33), 3)
  assert.equal(discountedPrice(199, 50), 100)
  assert.equal(discountedPrice(6000, null), 6000)
  assert.equal(discountedPrice(0, 100), 0)
})

test('V-02 RA4 mockup: two entries and a donation, no fee', () => {
  const a = cartAmounts({
    people: [
      { listPrice: 6000, voucherPercent: null, extras: [] },
      { listPrice: 2000, voucherPercent: null, extras: [] },
    ],
    donation: 2000,
  })
  assert.deepEqual(a, {
    lines: [
      { listPrice: 6000, discount: 0, price: 6000, extrasTotal: 0 },
      { listPrice: 2000, discount: 0, price: 2000, extrasTotal: 0 },
    ],
    entryTotal: 8000,
    extrasTotal: 0,
    donation: 2000,
    total: 10000,
  })
})

test('V-02 a 15% code on 60 zł: price 51 zł and the exact RA4 line', () => {
  const a = cartAmounts({ people: [{ listPrice: 6000, voucherPercent: 15, extras: [{ price: 4500, qty: 1 }] }] })
  assert.deepEqual(a.lines[0], { listPrice: 6000, discount: 900, price: 5100, extrasTotal: 4500 })
  assert.equal(a.total, 9600)
  assert.equal(
    voucherLineLabel({ listPrice: 6000, percent: 15, code: 'KOD', price: 5100 }),
    '60,00 zł − 15% (KOD) = 51,00 zł',
  )
})

const at = (iso) => new Date(iso)

test('V-03 a tier ending 2026-11-15 lasts through 23:59:59.999 Warsaw (UTC+1)', () => {
  const tiers = [
    { id: 't1', endsOn: '2026-11-15', sortOrder: 0 },
    { id: 't2', endsOn: '2026-11-25', sortOrder: 1 },
    { id: 't3', endsOn: null, sortOrder: 2 },
  ]
  assert.equal(currentTier(tiers, at('2026-11-15T22:59:59.999Z')).id, 't1')
  assert.equal(currentTier(tiers, at('2026-11-15T23:00:00.000Z')).id, 't2')
  assert.equal(currentTier(tiers, at('2026-11-25T23:00:00.000Z')).id, 't3')
  assert.equal(currentTier(tiers, at('2030-01-01T00:00:00.000Z')).id, 't3')
})

for (const [endsOn, last, first, note] of [
  ['2026-10-24', '2026-10-24T21:59:59.999Z', '2026-10-24T22:00:00.000Z', 'still UTC+2'],
  ['2026-10-25', '2026-10-25T22:59:59.999Z', '2026-10-25T23:00:00.000Z', 'the 25-hour day'],
  ['2026-03-28', '2026-03-28T22:59:59.999Z', '2026-03-28T23:00:00.000Z', 'UTC+1 before the switch'],
  ['2026-03-29', '2026-03-29T21:59:59.999Z', '2026-03-29T22:00:00.000Z', 'the 23-hour day'],
]) {
  test(`V-03 DST: a tier ending ${endsOn} (${note}) flips at Warsaw midnight`, () => {
    const tiers = [{ id: 't1', endsOn, sortOrder: 0 }, { id: 't2', endsOn: null, sortOrder: 1 }]
    assert.equal(currentTier(tiers, at(last)).id, 't1')
    assert.equal(currentTier(tiers, at(first)).id, 't2')
  })
}

test('V-03 nextTier names the tier after the current one and its first Warsaw day', () => {
  const tiers = [
    { id: 't1', endsOn: '2026-11-15', sortOrder: 0 },
    { id: 't2', endsOn: '2026-11-25', sortOrder: 1 },
    { id: 't3', endsOn: null, sortOrder: 2 },
  ]
  assert.deepEqual(nextTier(tiers, at('2026-11-10T12:00:00Z')), { tier: tiers[1], from: '2026-11-16' })
  assert.deepEqual(nextTier(tiers, at('2026-11-20T12:00:00Z')), { tier: tiers[2], from: '2026-11-26' })
  assert.equal(nextTier(tiers, at('2026-11-30T12:00:00Z')), null)
  // Month and year boundaries.
  const edge = [{ id: 'a', endsOn: '2026-12-31', sortOrder: 0 }, { id: 'b', endsOn: null, sortOrder: 1 }]
  assert.equal(nextTier(edge, at('2026-12-01T12:00:00Z')).from, '2027-01-01')
})

test('V-03 tiers are ordered by endsOn nulls last, then sortOrder, then id, as registration_raw', () => {
  const tiers = [
    { id: 't3', endsOn: null, sortOrder: 0 },
    { id: 't2', endsOn: '2026-11-25', sortOrder: 5 },
    { id: 't1', endsOn: '2026-11-15', sortOrder: 9 },
  ]
  assert.equal(currentTier(tiers, at('2026-11-01T12:00:00Z')).id, 't1')
  assert.equal(nextTier(tiers, at('2026-11-01T12:00:00Z')).tier.id, 't2')
  assert.equal(currentTier([], at('2026-11-01T12:00:00Z')), null)
  assert.equal(nextTier([], at('2026-11-01T12:00:00Z')), null)
  // All tiers past and no open-ended one: nothing is current.
  assert.equal(currentTier([{ id: 'x', endsOn: '2026-01-01', sortOrder: 0 }], at('2026-11-01T12:00:00Z')), null)
})

test('V-04 100 000 seeded random carts add up', () => {
  const r = rng(20261028)
  for (let i = 0; i < 100_000; i++) {
    const people = Array.from({ length: int(r, 1, 10) }, () => ({
      listPrice: int(r, 0, 100_000),
      voucherPercent: r() < 0.5 ? null : int(r, 1, 100),
      extras: Array.from({ length: int(r, 0, 3) }, () => ({ price: int(r, 0, 20_000), qty: int(r, 0, 10) })),
    }))
    const donation = int(r, 0, 500_000)
    const a = cartAmounts({ people, donation })
    let entryTotal = 0
    let extrasTotal = 0
    people.forEach((p, k) => {
      const line = a.lines[k]
      const price = p.voucherPercent == null ? p.listPrice : p.listPrice - Math.floor((p.listPrice * p.voucherPercent) / 100)
      const ex = p.extras.reduce((s, e) => s + e.price * e.qty, 0)
      if (line.price !== price || line.discount !== p.listPrice - price || line.extrasTotal !== ex || line.listPrice !== p.listPrice) {
        assert.fail(`cart ${i} line ${k}`)
      }
      entryTotal += line.price
      extrasTotal += ex
    })
    if (a.entryTotal !== entryTotal || a.extrasTotal !== extrasTotal || a.donation !== donation
      || a.total !== entryTotal + extrasTotal + donation || a.lines.length !== people.length) {
      assert.fail(`cart ${i} totals`)
    }
  }
})

test('V-04 a whole cart at 0 → total 0', () => {
  const a = cartAmounts({
    people: [
      { listPrice: 0, voucherPercent: null, extras: [{ price: 0, qty: 3 }] },
      { listPrice: 5000, voucherPercent: 100, extras: [{ price: 2000, qty: 0 }] },
    ],
  })
  assert.equal(a.total, 0)
  assert.equal(a.entryTotal, 0)
  assert.equal(a.extrasTotal, 0)
  assert.equal(a.donation, 0)
})

test('V-04 cartAmounts refuses broken input', () => {
  assert.throws(() => cartAmounts({ people: [] }), MoneyError)
  assert.throws(() => cartAmounts({}), MoneyError)
  assert.throws(() => cartAmounts({ people: [{ listPrice: 100, voucherPercent: null, extras: [{ price: 1.5, qty: 1 }] }] }), MoneyError)
  assert.throws(() => cartAmounts({ people: [{ listPrice: 100, voucherPercent: null, extras: [{ price: 100, qty: -1 }] }] }), MoneyError)
  assert.throws(() => cartAmounts({ people: [{ listPrice: 100, voucherPercent: null, extras: [] }], donation: -1 }), MoneyError)
  assert.throws(() => cartAmounts({ people: [{ listPrice: 100, voucherPercent: 0, extras: [] }] }), MoneyError)
  // A missing extras list is no extras.
  assert.equal(cartAmounts({ people: [{ listPrice: 100, voucherPercent: null }] }).total, 100)
})

const WINDOW = { opensOn: '2026-11-01', closesOn: '2026-12-31' }
const tier = (endsOn) => ({ endsOn })

test('V-05 validateTiers accepts 1 to 5 increasing tiers ending with the open one', () => {
  assert.deepEqual(validateTiers([tier(null)], WINDOW), { ok: true, errors: {} })
  assert.equal(validateTiers([tier('2026-11-01'), tier('2026-11-15'), tier(null)], WINDOW).ok, true)
  assert.equal(validateTiers([tier('2026-11-10'), tier('2026-11-20'), tier('2026-11-30'), tier('2026-12-10'), tier(null)], WINDOW).ok, true)
  // The last day before closesOn is allowed.
  assert.equal(validateTiers([tier('2026-12-30'), tier(null)], WINDOW).ok, true)
})

test('V-05 validateTiers rejects equal dates, a date at or after closesOn, two nulls, a null not last, 6 tiers', () => {
  const bad = [
    [tier('2026-11-15'), tier('2026-11-15'), tier(null)],
    [tier('2026-11-20'), tier('2026-11-15'), tier(null)],
    [tier('2026-12-31'), tier(null)],
    [tier('2027-01-05'), tier(null)],
    [tier('2026-10-31'), tier(null)],
    [tier('2026-11-15'), tier(null), tier(null)],
    [tier(null), tier('2026-11-15')],
    [tier('2026-11-10'), tier('2026-11-20'), tier('2026-11-30'), tier('2026-12-10'), tier('2026-12-20'), tier(null)],
    [],
    [tier('2026-11-15')],
    [tier('15.11.2026'), tier(null)],
    [tier('2026-02-30'), tier(null)],
  ]
  for (const tiers of bad) {
    const v = validateTiers(tiers, WINDOW)
    assert.equal(v.ok, false, JSON.stringify(tiers))
    assert.equal(typeof v.errors.tiers, 'string')
  }
  assert.equal(validateTiers([tier('2026-11-15'), tier('2026-11-15'), tier(null)], WINDOW).errors.tiers, TIERS_ORDER_MESSAGE)
  assert.equal(TIERS_ORDER_MESSAGE, 'Daty progów muszą rosnąć i kończyć się przed zamknięciem zapisów.')
  assert.equal(validateTiers('nope', WINDOW).ok, false)
})

test('V-08 discountedPrice throws on a non-integer, a negative list, or a percent outside 1..100', () => {
  for (const [list, p] of [[60.5, 10], [6000, 0], [6000, 101], [-1, 10], [6000, 15.5], ['6000', 15], [6000, '15'], [NaN, 10], [6000, undefined]]) {
    assert.throws(() => discountedPrice(list, p), MoneyError, `${list},${p}`)
  }
})

test('voucherLineLabel refuses a price that does not follow from the list and percent', () => {
  assert.throws(() => voucherLineLabel({ listPrice: 6000, percent: 15, code: 'KOD', price: 5000 }), MoneyError)
  assert.equal(
    voucherLineLabel({ listPrice: 4999, percent: 15, code: 'LESZY-15', price: 4250 }),
    '49,99 zł − 15% (LESZY-15) = 42,50 zł',
  )
})
