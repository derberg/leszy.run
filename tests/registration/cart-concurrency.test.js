// Plan 7, task 4a: concurrency of voucher uses and extra stock (V-27 a–c in
// docs/registration/scenario-matrix.md). Every call runs on its own PostgREST connection (its own
// transaction) at the same time.
//
// The orders are spread over 8 competitions that share one unrestricted voucher and one variant:
// create_order locks only its own competition, so creates in different competitions pass the plain
// read together and meet at the voucher and variant rows, where only the one-statement claim decides.
// The helpers are also called directly in parallel. Invariants: a voucher's used = the live
// registrations holding it and never passes max_uses; a variant's sold never passes its stock and
// equals the qty on the order lines; every refusal is the named one (never 23514 or 40P01).
// LOCAL stack only.
import { test, before, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { sessionFor } from './helpers/stack.js'
import { acceptAgreement, createPublishedPaidEvent } from './helpers/registrationFixtures.js'
import { db, one, rows, rpc, runnerEmail } from './helpers/orders.js'
import { adult, isDeadlock, orderGroup } from './helpers/groups.js'
import { code, makeExtra, makeVoucher, vouchersMade } from './helpers/cart.js'
import { assertVoucherInvariant } from './helpers/voucherInvariant.js'
import { assertSlotInvariant } from './helpers/slotInvariant.js'

const COMPETITIONS = 8

let owner
const competitionsSeen = new Set()
before(async () => {
  await acceptAgreement('zatyrani-test')
  owner = await sessionFor('owner@zatyrani-test.local')
})
afterEach(async () => {
  for (const id of competitionsSeen) await assertSlotInvariant(id)
  for (const id of vouchersMade) await assertVoucherInvariant(id)
  competitionsSeen.clear()
  vouchersMade.clear()
})

/** A paid event with COMPETITIONS competitions at 60 zł each. */
async function paidEvent() {
  const competitions = Array.from({ length: COMPETITIONS }, (_, i) =>
    ({ name: `Bieg ${i + 1}`, discipline: 'run', distanceLabel: `${i + 1} km`, startTime: '10:00', capacity: 100 }))
  const event = await createPublishedPaidEvent(owner, {
    competitions, prices: Object.fromEntries(competitions.map((c) => [c.name, 6000])),
  })
  for (const id of event.categoryIds) competitionsSeen.add(id)
  return event
}

function outcomes(rs) {
  assert.deepEqual(rs.filter(isDeadlock).map((r) => r.error.message), [], 'no deadlock')
  assert.deepEqual(rs.filter((r) => r.error?.code === '23514').map((r) => r.error.message), [], 'no CHECK violation')
  return { ok: rs.filter((r) => !r.error), errors: rs.filter((r) => r.error).map((r) => r.error.message) }
}

async function soldMatchesLines(variantId) {
  const v = await one('extra_variants', { id: variantId })
  const lines = await rows('order_lines', { extra_variant_id: variantId })
  assert.ok(v.sold <= v.stock, `sold ${v.sold} <= stock ${v.stock}`)
  assert.equal(v.sold, lines.reduce((s, l) => s + l.qty, 0), 'sold = the qty on the order lines')
  return v.sold
}

const spread = (event, n, make) => Promise.all(Array.from({ length: n }, (_, i) => make(event.categoryIds[i % COMPETITIONS], i)))

// ---------------------------------------------------------------- (a), (b)

for (const [label, maxUses] of [['a', 1], ['b', 5]]) {
  test(`V-27${label} max_uses ${maxUses}: 20 parallel create_order over ${COMPETITIONS} competitions → exactly ${maxUses} hold it`, async () => {
    const event = await paidEvent()
    const voucher = await makeVoucher(event.eventId, { percent: 15, max_uses: maxUses })
    const rs = await spread(event, 20, (cat) =>
      orderGroup(event, [{ ...adult(cat, 'self'), voucherCode: voucher.code }], { displayed: 5100 }))
    const { ok, errors } = outcomes(rs)
    assert.equal(ok.length, maxUses, JSON.stringify(errors))
    assert.deepEqual([...new Set(errors)], ['voucher_used_up:0'])
    assert.equal((await one('vouchers', { id: voucher.id })).used, maxUses)
    const holders = (await rows('registrations', { event_id: event.eventId })).filter((r) => r.voucher_id === voucher.id)
    assert.equal(holders.length, maxUses)
    assert.ok(holders.every((r) => r.price === 5100 && r.list_price === 6000))
  })
}

test('V-27a/b the claim itself: 20 parallel claim_registration_voucher calls → exactly max_uses succeed', async () => {
  const event = await paidEvent()
  for (const maxUses of [1, 5]) {
    // Claimed without registrations, so outside the voucher invariant.
    const { data: v, error } = await db().from('vouchers')
      .insert({ event_id: event.eventId, code: code('RACE'), percent: 10, max_uses: maxUses }).select().single()
    if (error) throw error
    const rs = await spread(event, 20, (cat) => rpc('claim_registration_voucher', {
      p_event_id: event.eventId, p_voucher_id: v.id, p_code: v.code, p_category_id: cat,
    }))
    const { ok, errors } = outcomes(rs)
    assert.equal(ok.length, maxUses, JSON.stringify(errors))
    assert.deepEqual([...new Set(errors)], ['voucher_used_up'])
    assert.equal((await one('vouchers', { id: v.id })).used, maxUses)
  }
})

// ---------------------------------------------------------------- (c)

test('V-27c stock 3: 10 parallel create_order over the competitions → 3 sold; the plentiful variant (claimed first) rolled back', async () => {
  const event = await paidEvent()
  const { variants } = await makeExtra(event, { variants: [['M', 100], ['L', 100]] })
  // Variants are claimed in id order: the scarce one is the later id, so every loser has already
  // claimed the other one and must give it back.
  const [first, scarce] = Object.values(variants).sort((a, b) => (a.id < b.id ? -1 : 1))
  const { error } = await db().from('extra_variants').update({ stock: 3 }).eq('id', scarce.id)
  if (error) throw error
  const rs = await spread(event, 10, (cat) =>
    orderGroup(event, [{ ...adult(cat, 'self'), extras: [{ variantId: scarce.id, qty: 1 }, { variantId: first.id, qty: 1 }] }],
      { displayed: 6000 + 4500 + 4500 }))
  const { ok, errors } = outcomes(rs)
  assert.equal(ok.length, 3, JSON.stringify(errors))
  assert.deepEqual([...new Set(errors)], ['extra_sold_out:0'])
  assert.equal(await soldMatchesLines(scarce.id), 3)
  assert.equal(await soldMatchesLines(first.id), 3, 'the losers gave the first variant back')
  assert.equal((await rows('orders', { event_id: event.eventId })).length, 3)
})

test('V-27c the claim itself: 10 parallel claim_extra_stock(qty 1) on stock 3 → exactly 3 true', async () => {
  const event = await paidEvent()
  const { variants: { M } } = await makeExtra(event, { variants: [['M', 3]] })
  const rs = await spread(event, 10, () => rpc('claim_extra_stock', { p_variant_id: M.id, p_qty: 1 }))
  const { ok } = outcomes(rs)
  assert.equal(ok.length, 10)
  assert.equal(ok.filter((r) => r.data === true).length, 3)
  assert.equal((await one('extra_variants', { id: M.id })).sold, 3)
})

// ---------------------------------------------------------------- (d), (e): task 4b, the releases racing a claim

/** sold = the qty on the extra lines of orders still holding stock (pending or paid). */
async function soldMatchesLiveLines(variantId) {
  const v = await one('extra_variants', { id: variantId })
  const lines = await rows('order_lines', { extra_variant_id: variantId })
  let held = 0
  for (const l of lines) {
    const o = await one('orders', { id: l.order_id })
    if (o.status === 'pending' || o.status === 'paid') held += l.qty
  }
  assert.ok(v.sold <= v.stock, `sold ${v.sold} <= stock ${v.stock}`)
  assert.equal(v.sold, held, 'sold = the qty on live orders')
}

const ROUNDS = 100
// A random start within a few ms on each side, so the two calls overlap in both orders.
const jitter = (fn) => new Promise((resolve) => setTimeout(resolve, Math.random() * 12)).then(fn)
const pastExpiry = (orderId) => db().from('orders').update({ expires_at: new Date(Date.now() - 60_000).toISOString() }).eq('id', orderId)

for (const [label, sameEmail] of [['', false], [' (one e-mail)', true]]) {
  // max_uses 2 and stock 2, the expiring order holding one of each: the create's plain read passes,
  // so it claims the last use and shirt while the expiry releases the other, on the same two rows.
  test(`V-27d ${ROUNDS} rounds: expire_orders racing a create_order for the last use and the last shirt${label} → invariants, no 40P01`, async () => {
    const event = await paidEvent()
    const seen = new Map()
    for (let round = 0; round < ROUNDS; round++) {
      const cat = event.categoryIds[round % COMPETITIONS]
      const voucher = await makeVoucher(event.eventId, { percent: 15, max_uses: 2 })
      const { variants: { M } } = await makeExtra(event, { variants: [['M', 2]] })
      const cart = { voucherCode: voucher.code, extras: [{ variantId: M.id, qty: 1 }] }
      const emailA = runnerEmail('race')
      const a = await orderGroup(event, [{ ...adult(cat, 'self', emailA), ...cart }], { displayed: 5100 + 4500 })
      assert.equal(a.error, null, a.error?.message)
      const { error } = await pastExpiry(a.data.orderId)
      if (error) throw error
      const email = sameEmail ? emailA : undefined
      const [expired, b] = await Promise.all([
        jitter(() => rpc('expire_orders', {})),
        jitter(() => orderGroup(event, [{ ...adult(cat, 'self', email), ...cart }], { displayed: 5100 + 4500 })),
      ])
      const { errors } = outcomes([expired, b])
      for (const e of errors) seen.set(e, (seen.get(e) ?? 0) + 1)
      assert.ok(errors.every((e) => ['voucher_used_up:0', 'extra_sold_out:0', 'duplicate:0'].includes(e)), JSON.stringify(errors))
      assert.equal((await one('orders', { id: a.data.orderId })).status, 'expired')
      await assertVoucherInvariant(voucher.id)
      await soldMatchesLiveLines(M.id)
    }
    console.log(`V-27d${label}: create refusals ${JSON.stringify(Object.fromEntries(seen))} of ${ROUNDS}`)
  })
}

test('V-27e 20 rounds: a late confirm_order racing a create_order for the last use → exactly one holds it', async () => {
  const event = await paidEvent()
  let late = 0
  for (let round = 0; round < 20; round++) {
    const voucher = await makeVoucher(event.eventId, { percent: 15, max_uses: 1 })
    const catA = event.categoryIds[round % COMPETITIONS]
    const catB = event.categoryIds[(round + 1) % COMPETITIONS]
    const a = await orderGroup(event, [{ ...adult(catA, 'self'), voucherCode: voucher.code }], { displayed: 5100 })
    assert.equal(a.error, null, a.error?.message)
    const att = await rpc('add_payment_attempt', { p_order_id: a.data.orderId, p_txn: `TXN-${round}-${voucher.id}`, p_grosze: 5100 })
    assert.equal(att.error, null, att.error?.message)
    const { error } = await pastExpiry(a.data.orderId)
    if (error) throw error
    assert.ok((await rpc('expire_orders', {})).data >= 1)
    assert.equal((await one('vouchers', { id: voucher.id })).used, 0)

    const [confirmed, b] = await Promise.all([
      jitter(() => rpc('confirm_order', { p_order_id: a.data.orderId, p_txn: `TXN-${round}-${voucher.id}`, p_grosze: 5100, p_source: 'ipn' })),
      jitter(() => orderGroup(event, [{ ...adult(catB, 'self'), voucherCode: voucher.code }], { displayed: 5100 })),
    ])
    outcomes([confirmed, b])
    assert.equal(confirmed.error, null, confirmed.error?.message)
    const outcome = confirmed.data.outcome
    if (outcome === 'late_confirmed') {
      late += 1
      assert.equal(b.error?.message, 'voucher_used_up:0')
    } else {
      assert.deepEqual([outcome, confirmed.data.refund.reason], ['late_refund', 'voucher'])
      assert.equal(b.error, null, b.error?.message)
    }
    assert.equal((await one('vouchers', { id: voucher.id })).used, 1, 'exactly one holds it')
    await assertVoucherInvariant(voucher.id)
  }
  console.log(`V-27e: late payment won ${late} of 20`)
})
