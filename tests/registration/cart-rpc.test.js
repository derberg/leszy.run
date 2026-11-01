// Plan 7, task 4a: vouchers, extras and a donation in create_order and create_team_registration.
// Scenarios V-21…V-24 in docs/registration/scenario-matrix.md. No runner fee exists (ruling T4-F,
// 2026-10-31): total = entry_total + extras_total + donation. LOCAL stack only.
import { test, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import postgres from 'postgres'
import { localEnv, sessionFor, resetThrottle } from './helpers/stack.js'
import { acceptAgreement, callFn, createPublishedPaidEvent, createPublishedFreeEvent } from './helpers/registrationFixtures.js'
import {
  profileFor, rpc, attemptFor, competitionOf, confirmOk, db, one, orderOf, registrationsOf, rows, runnerEmail,
} from './helpers/orders.js'
import { BIEG, DZIECI, adult, groupMeta, minor, orderGroup, orderGroupOk, registerGroup } from './helpers/groups.js'
import { captain, createTeam, freeTeamEvent, paidTeamEvent } from './helpers/teams.js'
import { makeExtra, makePartner, makeVoucher, setCharity, setTiers, vouchersMade, warsawDay } from './helpers/cart.js'
import { assertVoucherInvariant } from './helpers/voucherInvariant.js'
import { assertSlotInvariant } from './helpers/slotInvariant.js'
import { dpayReset, dpayTransactions, startDpayMock } from './helpers/dpayControl.js'
import { cartAmounts } from '../../supabase/functions/_shared/registration/pricing.js'

let owner, stopMock, sqlClient
const sql = () => (sqlClient ??= postgres(localEnv().dbUrl, { max: 1, onnotice: () => {} }))
const competitionsSeen = new Set()
before(async () => {
  stopMock = await startDpayMock()
  await resetThrottle()
  await acceptAgreement('zatyrani-test')
  owner = await sessionFor('owner@zatyrani-test.local')
})
after(async () => {
  if (stopMock) await stopMock()
  if (sqlClient) await sqlClient.end()
})
afterEach(async () => {
  for (const id of competitionsSeen) await assertSlotInvariant(id)
  for (const id of vouchersMade) await assertVoucherInvariant(id)
  competitionsSeen.clear()
  vouchersMade.clear()
})

async function paid2({ c1 = 50, c2 = 50 } = {}) {
  const event = await createPublishedPaidEvent(owner, {
    prices: { 'Bieg 9 km': 6000, 'Bieg dzieci 1 km': 2000 }, competitions: [BIEG(c1), DZIECI(c2)],
  })
  for (const id of event.categoryIds) competitionsSeen.add(id)
  return event
}
const linesOf = (orderId) => rows('order_lines', { order_id: orderId })
const usedOf = async (voucherId) => (await one('vouchers', { id: voucherId })).used
const soldOf = async (variantId) => (await one('extra_variants', { id: variantId })).sold

// ---------------------------------------------------------------- V-21

test('V-21 a family: 15 % code on the adult, a 45 zł shirt for the child, a 20 zł donation', async () => {
  const event = await paid2()
  const [c9, kids] = event.categoryIds
  await setCharity(event.eventId)
  const partner = await makePartner(event.eventId)
  const voucher = await makeVoucher(event.eventId, { percent: 15, partner_id: partner.id })
  const { variants: { M } } = await makeExtra(event, { variants: [['M', 10], ['L', 10]] })

  const me = runnerEmail('family')
  const people = [
    { ...adult(c9, 'self', me), voucherCode: ` ${voucher.code.toLowerCase()} ` },
    { ...minor(kids), extras: [{ variantId: M.id, qty: 1 }] },
  ]
  const want = cartAmounts({
    people: [{ listPrice: 6000, voucherPercent: 15 }, { listPrice: 2000, extras: [{ price: 4500, qty: 1 }] }],
    donation: 2000,
  })
  assert.deepEqual([want.entryTotal, want.extrasTotal, want.donation], [7100, 4500, 2000])

  const out = await orderGroupOk(event, people, {
    displayed: want.total, meta: await groupMeta(event.eventId, { donation: 2000 }),
  })
  assert.equal(out.status, 'pending')
  assert.equal(out.total, want.total)
  assert.deepEqual(out.amounts, { entryTotal: 7100, extrasTotal: 4500, donation: 2000, total: want.total })

  const order = await orderOf(out.orderId)
  assert.deepEqual([order.entry_total, order.extras_total, order.donation, order.total], [7100, 4500, 2000, want.total])

  const regs = await registrationsOf(out.orderId)
  const self = regs.find((r) => r.id === out.registrations[0].id)
  const child = regs.find((r) => r.id === out.registrations[1].id)
  assert.deepEqual([self.list_price, self.price, self.voucher_id, self.partner_id], [6000, 5100, voucher.id, partner.id])
  assert.deepEqual([child.list_price, child.price, child.voucher_id, child.partner_id], [2000, 2000, null, null])
  assert.ok(regs.every((r) => r.status === 'pending_payment'))

  const lines = await linesOf(out.orderId)
  const kinds = (k) => lines.filter((l) => l.kind === k)
  assert.equal(kinds('entry').length, 2)
  assert.deepEqual(kinds('entry').map((l) => l.amount).sort((a, b) => a - b), [2000, 5100])
  assert.deepEqual(kinds('extra').map((l) => [l.registration_id, l.extra_variant_id, l.qty, l.amount]),
    [[child.id, M.id, 1, 4500]])
  assert.deepEqual(kinds('donation').map((l) => [l.registration_id, l.qty, l.amount]), [[null, 1, 2000]])
  assert.equal(lines.reduce((s, l) => s + l.amount, 0), want.total, 'the lines add up to the total')

  assert.equal(await usedOf(voucher.id), 1)
  assert.equal(await soldOf(M.id), 1)
  assert.equal((await competitionOf(c9)).taken, 0, 'an unpaid order holds no slot (P3-R15)')

  // Paid, the order keeps its amounts and the voucher and shirt stay claimed.
  const att = await attemptFor(out.orderId, out.total)
  assert.equal((await confirmOk(out.orderId, att.txn, out.total)).outcome, 'confirmed')
  assert.equal(await usedOf(voucher.id), 1)
  assert.equal(await soldOf(M.id), 1)
})

test('V-21 extras: two of one variant, a variant past its order_until or not offered → extra_unavailable:<index>', async () => {
  const event = await paid2()
  const [c9, kids] = event.categoryIds
  const { variants: { M } } = await makeExtra(event, { price: 3000 })
  const past = await makeExtra(event, { name: 'Medal', orderUntil: warsawDay(-1) })
  const adultsOnly = await makeExtra(event, { name: 'Buff', price: 2500, categoryIds: [c9] })

  const two = await orderGroupOk(event, [{ ...adult(c9, 'self'), extras: [{ variantId: M.id, qty: 2 }] }], {
    displayed: 6000 + 6000,
  })
  assert.equal((await orderOf(two.orderId)).extras_total, 6000)
  assert.deepEqual((await linesOf(two.orderId)).filter((l) => l.kind === 'extra').map((l) => [l.qty, l.amount]), [[2, 6000]])
  assert.equal(await soldOf(M.id), 2)

  const late = await orderGroup(event, [adult(c9, 'self'), { ...minor(kids), extras: [{ variantId: past.variants.M.id, qty: 1 }] }],
    { displayed: 6000 + 2000 + 4500 })
  assert.equal(late.error?.message, 'extra_unavailable:1')
  const notOffered = await orderGroup(event, [{ ...minor(kids), extras: [{ variantId: adultsOnly.variants.M.id, qty: 1 }] }],
    { buyerEmail: runnerEmail('guardian'), displayed: 2000 + 2500 })
  assert.equal(notOffered.error?.message, 'extra_unavailable:0')
  const offered = await orderGroupOk(event, [{ ...adult(c9, 'self'), extras: [{ variantId: adultsOnly.variants.M.id, qty: 1 }] }],
    { displayed: 6000 + 2500 })
  assert.equal(offered.total, 8500)
  const other = await paid2()
  const foreign = await orderGroup(other, [{ ...adult(other.categoryIds[0], 'self'), extras: [{ variantId: M.id, qty: 1 }] }],
    { displayed: 6000 + 3000 })
  assert.equal(foreign.error?.message, 'extra_unavailable:0', "another event's variant")
  for (const extras of [[{ variantId: M.id, qty: 'abc' }], [{ variantId: M.id, qty: 11 }], [{ variantId: M.id, qty: 1.5 }],
    [{ variantId: 'nie-uuid', qty: 1 }], [{ variantId: M.id, qty: 1 }, { variantId: M.id, qty: 1 }], { variantId: M.id }]) {
    const bad = await orderGroup(event, [{ ...adult(c9, 'self'), extras }], { displayed: 6000 + 3000 })
    assert.equal(bad.error?.message, 'invalid_people', JSON.stringify(extras))
  }
  assert.equal(await soldOf(M.id), 2, 'nothing more claimed')
})

test('V-21 a team: the team line takes the code, a member takes a shirt, plus a donation', async () => {
  const event = await paidTeamEvent(owner, { price: 24000 })
  const cat = event.categoryIds[0]
  competitionsSeen.add(cat)
  await setCharity(event.eventId)
  const partner = await makePartner(event.eventId)
  const voucher = await makeVoucher(event.eventId, { percent: 10, partner_id: partner.id, categoryIds: [cat] })
  const { variants: { M } } = await makeExtra(event)
  const members = [captain(), { ...adult(cat, 'adult'), extras: [{ variantId: M.id, qty: 1 }] }]
  const meta = await groupMeta(event.eventId, { voucherCode: voucher.code, donation: 5000 })
  const r = await createTeam(event, { members, meta, displayed: 21600 + 4500 + 5000 })
  assert.equal(r.error, null, r.error?.message)
  assert.deepEqual(r.data.amounts, { entryTotal: 21600, extrasTotal: 4500, donation: 5000, total: 31100 })
  const regs = await registrationsOf(r.data.orderId)
  const cap = regs.find((x) => x.id === r.data.registrations[0].id)
  const mate = regs.find((x) => x.id === r.data.registrations[1].id)
  assert.deepEqual([cap.list_price, cap.price, cap.voucher_id, cap.partner_id], [24000, 21600, voucher.id, partner.id])
  assert.deepEqual([mate.price, mate.voucher_id], [0, null])
  const lines = await linesOf(r.data.orderId)
  assert.deepEqual(lines.filter((l) => l.kind === 'entry').map((l) => [l.registration_id, l.amount]), [[cap.id, 21600]])
  assert.deepEqual(lines.filter((l) => l.kind === 'extra').map((l) => [l.registration_id, l.amount]), [[mate.id, 4500]])
  assert.deepEqual(lines.filter((l) => l.kind === 'donation').map((l) => l.amount), [5000])
  assert.equal(await usedOf(voucher.id), 1)
  assert.equal(await soldOf(M.id), 1)

  // The code is used up: a second team is refused on its team line, with nothing held.
  const again = await createTeam(event, {
    members: [captain(), { ...adult(cat, 'adult'), extras: [{ variantId: M.id, qty: 1 }] }],
    meta, displayed: 21600 + 4500 + 5000,
  })
  assert.equal(again.error?.message, 'voucher_used_up:0')
  assert.equal(await soldOf(M.id), 1)
})

test('V-21 a free event takes an order for a shirt and a donation (ruling 7); register_free refuses them', async () => {
  const event = await createPublishedFreeEvent(owner, { competitions: [BIEG()] })
  const cat = event.categoryIds[0]
  competitionsSeen.add(cat)
  await setCharity(event.eventId)
  const { variants: { M } } = await makeExtra(event, { price: 3000 })
  const meta = await groupMeta(event.eventId, { donation: 1000 })
  const out = await orderGroupOk(event, [{ ...adult(cat, 'self'), extras: [{ variantId: M.id, qty: 1 }] }],
    { displayed: 4000, meta })
  assert.equal(out.status, 'pending')
  assert.deepEqual(out.amounts, { entryTotal: 0, extrasTotal: 3000, donation: 1000, total: 4000 })
  const plain = await orderGroup(event, [adult(cat, 'self')], { displayed: 0 })
  assert.equal(plain.error?.message, 'free_event', 'nothing to pay for: register_free')
  for (const donation of [50, 500001, -100, 20.5, '2000']) {
    const bad = await orderGroup(event, [adult(cat, 'self')],
      { displayed: 2000, meta: await groupMeta(event.eventId, { donation }) })
    assert.equal(bad.error?.message, 'invalid_amount:donation', String(donation))
  }

  const shirt = await registerGroup(event, [{ ...adult(cat, 'self'), extras: [{ variantId: M.id, qty: 1 }] }])
  assert.equal(shirt.error?.message, 'not_free')
  const gift = await registerGroup(event, [adult(cat, 'self')], { meta: await groupMeta(event.eventId, { donation: 1000 }) })
  assert.equal(gift.error?.message, 'not_free')
  const voucher = await makeVoucher(event.eventId)
  const coded = await registerGroup(event, [{ ...adult(cat, 'self'), voucherCode: voucher.code }])
  assert.equal(coded.error?.message, 'not_free')
  assert.equal((await competitionOf(cat)).taken, 0)
})

// ---------------------------------------------------------------- V-22

test('V-22 two people of one group type one single-use code → voucher_used_up:1, nothing held', async () => {
  const event = await paid2()
  const [c9] = event.categoryIds
  const voucher = await makeVoucher(event.eventId, { percent: 15, max_uses: 1 })
  const { variants: { M } } = await makeExtra(event)
  const me = runnerEmail('same-code')
  const people = [
    { ...adult(c9, 'self', me), voucherCode: voucher.code, extras: [{ variantId: M.id, qty: 1 }] },
    { ...adult(c9, 'adult'), voucherCode: voucher.code },
  ]
  const r = await orderGroup(event, people, { displayed: 5100 + 5100 + 4500 })
  assert.equal(r.error?.message, 'voucher_used_up:1')
  assert.equal(await usedOf(voucher.id), 0)
  assert.equal(await soldOf(M.id), 0)
  assert.equal((await rows('orders', { event_id: event.eventId })).length, 0)
  assert.equal((await rows('registrations', { event_id: event.eventId })).length, 0)

  // The same buyer, one code: accepted, and the code is now used.
  const ok = await orderGroupOk(event, [people[0]], { displayed: 5100 + 4500 })
  assert.equal(ok.total, 9600)
  assert.equal(await usedOf(voucher.id), 1)
})

test('V-22 an expired, a disabled, an unknown and a wrong-competition code are refused by person index', async () => {
  const event = await paid2()
  const [c9, kids] = event.categoryIds
  const expired = await makeVoucher(event.eventId, { valid_until: new Date(Date.now() - 60_000).toISOString() })
  const disabled = await makeVoucher(event.eventId, { disabled_at: new Date().toISOString() })
  const adultsOnly = await makeVoucher(event.eventId, { categoryIds: [c9] })
  const ask = (code, i = 0) => {
    const people = [adult(c9, 'self'), { ...minor(kids) }]
    people[i] = { ...people[i], voucherCode: code }
    return orderGroup(event, people, { displayed: 5100 + 2000 })
  }
  assert.equal((await ask(expired.code)).error?.message, 'voucher_expired:0')
  assert.equal((await ask(disabled.code)).error?.message, 'voucher_invalid:0')
  assert.equal((await ask('NIE-MA-TAKIEGO')).error?.message, 'voucher_invalid:0')
  assert.equal((await ask('ab')).error?.message, 'voucher_invalid:0')
  assert.equal((await ask(adultsOnly.code, 1)).error?.message, 'voucher_category:1')
  const other = await paid2()
  const foreign = await orderGroup(other, [{ ...adult(other.categoryIds[0], 'self'), voucherCode: adultsOnly.code }],
    { displayed: 5100 })
  assert.equal(foreign.error?.message, 'voucher_invalid:0', "another event's code")
  for (const v of [expired, disabled, adultsOnly]) assert.equal(await usedOf(v.id), 0)
})

// ---------------------------------------------------------------- V-23

test('V-23 a 100 % code on the only entry → paid at once, no attempt, the slot claimed; full → nothing created', async () => {
  const event = await paid2({ c1: 1 })
  const [c9] = event.categoryIds
  const voucher = await makeVoucher(event.eventId, { percent: 100, max_uses: 5 })
  const out = await orderGroupOk(event, [{ ...adult(c9, 'self'), voucherCode: voucher.code }], { displayed: 0 })
  assert.equal(out.status, 'paid')
  assert.equal(out.total, 0)
  const order = await orderOf(out.orderId)
  assert.equal(order.status, 'paid')
  assert.equal(order.total, 0)
  assert.equal((await rows('payment_attempts', { order_id: out.orderId })).length, 0, 'no dpay attempt')
  const [reg] = await registrationsOf(out.orderId)
  assert.deepEqual([reg.status, reg.list_price, reg.price, reg.voucher_id], ['confirmed', 6000, 0, voucher.id])
  assert.ok(out.registrations[0].participantId)
  assert.equal((await competitionOf(c9)).taken, 1)
  assert.equal(await usedOf(voucher.id), 1)

  const second = await orderGroup(event, [{ ...adult(c9, 'self'), voucherCode: voucher.code }], { displayed: 0 })
  assert.equal(second.error?.message, `full:${c9}`)
  assert.equal(await usedOf(voucher.id), 1, 'no use claimed for a full competition')
  assert.equal((await rows('orders', { event_id: event.eventId })).length, 1)
})

test('V-23 the same code with a 45 zł extra → pending, total 4500, entry 0; no fee and no support choice', async () => {
  const event = await paid2()
  const [c9] = event.categoryIds
  const voucher = await makeVoucher(event.eventId, { percent: 100 })
  const { variants: { M } } = await makeExtra(event)
  const out = await orderGroupOk(event, [{ ...adult(c9, 'self'), voucherCode: voucher.code, extras: [{ variantId: M.id, qty: 1 }] }],
    { displayed: 4500 })
  assert.equal(out.status, 'pending')
  assert.deepEqual(out.amounts, { entryTotal: 0, extrasTotal: 4500, donation: 0, total: 4500 })
  const order = await orderOf(out.orderId)
  assert.deepEqual([order.status, order.entry_total, order.extras_total, order.total], ['pending', 0, 4500, 4500])
  assert.ok(!('support_choice' in order) && !('payment_fee' in order) && !('support_fee' in order))
  assert.equal((await competitionOf(c9)).taken, 0)
  assert.equal(await usedOf(voucher.id), 1)
  assert.equal(await soldOf(M.id), 1)
})

// ---------------------------------------------------------------- V-24

test('V-24 an order made on the last day of tier 1 keeps 6000 after midnight; a new order sees 7000', async () => {
  const event = await paid2()
  const [c9, kids] = event.categoryIds
  const [tier1] = await setTiers(event.eventId, [
    { endsOn: warsawDay(0), prices: { [c9]: 6000, [kids]: 2000 } },
    { endsOn: null, prices: { [c9]: 7000, [kids]: 2500 } },
  ])
  const first = runnerEmail('before-midnight')
  const second = runnerEmail('reminder')
  const a = await orderGroupOk(event, [adult(c9, 'self', first)], { displayed: 6000 })
  const b = await orderGroupOk(event, [adult(c9, 'self', second)], { displayed: 6000 })
  assert.equal((await orderOf(a.orderId)).tier_id, tier1.id)

  // Midnight in Warsaw: tier 1 ended yesterday (D7-3).
  const { error } = await db().from('price_tiers')
    .update({ ends_on: warsawDay(-1) }).eq('id', tier1.id)
  if (error) throw error

  const att = await attemptFor(a.orderId, 6000)
  const confirmed = await confirmOk(a.orderId, att.txn, 6000)
  assert.equal(confirmed.outcome, 'confirmed')
  const paidOrder = await orderOf(a.orderId)
  assert.deepEqual([paidOrder.status, paidOrder.total, paidOrder.tier_id], ['paid', 6000, tier1.id])
  assert.equal((await registrationsOf(a.orderId))[0].price, 6000)

  const late = await orderGroup(event, [adult(c9, 'self')], { displayed: 6000 })
  assert.equal(late.error?.message, 'price_changed:7000')

  // „Zapłać” from the reminder: a new dpay transaction at the frozen total.
  await dpayReset()
  const pay = await callFn('pay-order', await sessionFor(second), { orderId: b.orderId })
  assert.equal(pay.status, 200, JSON.stringify(pay.body))
  const [attempt] = await rows('payment_attempts', { order_id: b.orderId })
  assert.equal(attempt.grosze, 6000)
  const txn = (await dpayTransactions()).find((t) => t.id === attempt.dpay_transaction_id)
  assert.ok(txn, 'dpay registered the transaction')
  assert.equal(txn.grosze, 6000)
  assert.equal((await orderOf(b.orderId)).total, 6000)
})

// ---------------------------------------------------------------- grants

test('V-21 the claim and release helpers are service_role only; the internals nobody\'s; all search_path=\'\'', async () => {
  const can = (role, fn) => sql()`select has_function_privilege(${role}, ${fn}, 'EXECUTE') as ok`.then(([r]) => r.ok)
  const helpers = [
    'public.claim_registration_voucher(uuid, text, uuid, uuid)', 'public.claim_extra_stock(uuid, integer)',
    'public.release_registration_vouchers(uuid[])', 'public.release_order_stock(uuid)',
  ]
  const internals = [
    'public.registration_normalize_code(text)', 'public.registration_voucher_refusal(public.vouchers, uuid)',
    'public.registration_donation(public.registration_settings, jsonb)',
    'public.registration_extra_items(public.registration_settings, jsonb)', 'public.registration_claim_extras(jsonb)',
    'public.registration_claim_voucher_at(uuid, uuid, text, uuid, integer)',
    'public.registration_zero_amount(jsonb)',
  ]
  for (const fn of helpers) {
    assert.deepEqual([await can('anon', fn), await can('authenticated', fn), await can('service_role', fn)], [false, false, true], fn)
  }
  for (const fn of internals) {
    assert.deepEqual([await can('anon', fn), await can('authenticated', fn), await can('service_role', fn)], [false, false, false], fn)
  }
  for (const fn of ['public.create_order(jsonb, uuid, text, integer, jsonb)', 'public.register_free(jsonb, uuid, jsonb)',
    'public.create_team_registration(uuid, text, jsonb, uuid, text, integer, jsonb)']) {
    assert.deepEqual([await can('anon', fn), await can('authenticated', fn), await can('service_role', fn)], [false, false, true], fn)
  }
  const [bad] = await sql()`
    select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('claim_registration_voucher', 'claim_extra_stock', 'release_registration_vouchers', 'release_order_stock',
                         'registration_normalize_code', 'registration_voucher_refusal', 'registration_donation',
                         'registration_extra_items', 'registration_claim_extras', 'registration_claim_voucher_at',
                         'registration_zero_amount')
       and not (coalesce(p.proconfig, '{}') @> array['search_path=""'])`
  assert.equal(bad.n, 0)
})

// ---------------------------------------------------------------- fix round 1

test('V-21 I-1 a free event: all-zero extras and a zero donation still register through register_free', async () => {
  const event = await createPublishedFreeEvent(owner, { competitions: [BIEG()] })
  const cat = event.categoryIds[0]
  competitionsSeen.add(cat)
  await setCharity(event.eventId)
  const { variants: { M, L } } = await makeExtra(event, { price: 3000, variants: [['M', 10], ['L', 10]] })
  const zero = [{ variantId: M.id, qty: 0 }, { variantId: L.id, qty: 0 }]
  for (const donation of [0, '0', undefined]) {
    const meta = await groupMeta(event.eventId, donation === undefined ? {} : { donation })
    const r = await registerGroup(event, [{ ...adult(cat, 'self'), extras: zero, voucherCode: '' }], { meta })
    assert.equal(r.error, null, `${JSON.stringify(donation)}: ${r.error?.message}`)
  }
  // 0.0 cannot leave JavaScript as 0.0, so this one goes in as SQL.
  const me = adult(cat, 'self')
  const meta = JSON.stringify(await groupMeta(event.eventId, { donation: '__ZERO__' })).replace('"__ZERO__"', '0.0')
  const [row] = await sql()`select public.register_free(${JSON.stringify([{ ...me, extras: zero }])}::text::jsonb,
    ${await profileFor(me.email)}::uuid, ${meta}::text::jsonb) as out`
  assert.equal(row.out.registrations.length, 1)
  assert.equal(await soldOf(M.id), 0)
  assert.equal((await competitionOf(cat)).taken, 4)

  for (const [extras, donation] of [[[{ variantId: M.id, qty: 1 }], 0], [zero, 100], [zero, '100'], [[{ variantId: M.id, qty: '1' }], 0]]) {
    const r = await registerGroup(event, [{ ...adult(cat, 'self'), extras }], { meta: await groupMeta(event.eventId, { donation }) })
    assert.equal(r.error?.message, 'not_free', JSON.stringify([extras, donation]))
  }
})

test('V-21 M-2 a code on an entry whose list price is 0 → voucher_not_applicable:<index>, nothing claimed', async () => {
  const free = await createPublishedFreeEvent(owner, { competitions: [BIEG()] })
  const cat = free.categoryIds[0]
  competitionsSeen.add(cat)
  const fv = await makeVoucher(free.eventId, { percent: 15 })
  const { variants: { M } } = await makeExtra(free, { price: 3000 })
  const r = await orderGroup(free, [{ ...adult(cat, 'self'), voucherCode: fv.code, extras: [{ variantId: M.id, qty: 1 }] }],
    { displayed: 3000 })
  assert.equal(r.error?.message, 'voucher_not_applicable:0')
  assert.equal(await usedOf(fv.id), 0)
  assert.equal(await soldOf(M.id), 0)

  const event = await createPublishedPaidEvent(owner, {
    prices: { 'Bieg 9 km': 6000, 'Bieg dzieci 1 km': 0 }, competitions: [BIEG(), DZIECI()],
  })
  for (const id of event.categoryIds) competitionsSeen.add(id)
  const [c9, kids] = event.categoryIds
  const pv = await makeVoucher(event.eventId, { percent: 15, max_uses: 5 })
  const kid = await orderGroup(event, [{ ...adult(c9, 'self'), voucherCode: pv.code }, { ...minor(kids), voucherCode: pv.code }],
    { displayed: 5100 })
  assert.equal(kid.error?.message, 'voucher_not_applicable:1')
  assert.equal(await usedOf(pv.id), 0)

  const team = await freeTeamEvent(owner)
  competitionsSeen.add(team.categoryIds[0])
  await setCharity(team.eventId)
  const tv = await makeVoucher(team.eventId)
  const t = await createTeam(team, { members: [captain(), adult(team.categoryIds[0], 'adult')],
    meta: await groupMeta(team.eventId, { voucherCode: tv.code, donation: 1000 }), displayed: 1000 })
  assert.equal(t.error?.message, 'voucher_not_applicable:0')
  assert.equal(await usedOf(tv.id), 0)
})

test('V-22 M-3 a claimed code is given back when a later step refuses: a sold-out extra, a duplicate address', async () => {
  const event = await paid2()
  const [c9] = event.categoryIds
  const voucher = await makeVoucher(event.eventId, { percent: 15, max_uses: 5 })
  const { variants: { M } } = await makeExtra(event, { variants: [['M', 0]] })
  const soldOut = await orderGroup(event, [{ ...adult(c9, 'self'), voucherCode: voucher.code, extras: [{ variantId: M.id, qty: 1 }] }],
    { displayed: 5100 + 4500 })
  assert.equal(soldOut.error?.message, 'extra_sold_out:0')
  assert.equal(await usedOf(voucher.id), 0)

  const free = await makeVoucher(event.eventId, { percent: 100, max_uses: 5 })
  const twice = runnerEmail('twice')
  const dup = await orderGroup(event, [
    { ...adult(c9, 'self', twice), voucherCode: free.code }, { ...adult(c9, 'adult', twice.toUpperCase()), voucherCode: free.code },
  ], { displayed: 0 })
  assert.equal(dup.error?.message, 'duplicate:1')
  assert.equal(await usedOf(free.id), 0)
  assert.equal((await competitionOf(c9)).taken, 0, 'the 0 zł slot claim rolled back too')
  assert.equal((await rows('orders', { event_id: event.eventId })).length, 0)
})

test('V-23 M-4 a team with a 100 % code → paid at once, confirmed, one slot, participants', async () => {
  const event = await paidTeamEvent(owner, { price: 24000 })
  const cat = event.categoryIds[0]
  competitionsSeen.add(cat)
  const voucher = await makeVoucher(event.eventId, { percent: 100 })
  const r = await createTeam(event, { members: [captain(), adult(cat, 'adult')],
    meta: await groupMeta(event.eventId, { voucherCode: voucher.code }), displayed: 0 })
  assert.equal(r.error, null, r.error?.message)
  assert.equal(r.data.status, 'confirmed')
  const order = await orderOf(r.data.orderId)
  assert.deepEqual([order.status, order.total, order.entry_total], ['paid', 0, 0])
  assert.equal((await rows('payment_attempts', { order_id: r.data.orderId })).length, 0)
  const regs = await registrationsOf(r.data.orderId)
  assert.ok(regs.every((x) => x.status === 'confirmed' && x.participant_id), 'confirmed with participants')
  const cap = regs.find((x) => x.id === r.data.registrations[0].id)
  assert.deepEqual([cap.list_price, cap.price, cap.voucher_id], [24000, 0, voucher.id])
  assert.equal((await competitionOf(cat)).taken, 1)
  assert.equal(await usedOf(voucher.id), 1)
})

test('V-22 M-1 the claim follows the voucher id the read resolved, not the code', async () => {
  const event = await paid2()
  const voucher = await makeVoucher(event.eventId, { percent: 20, max_uses: 3 })
  vouchersMade.delete(voucher.id) // claimed directly, without a registration
  const { error } = await db().from('vouchers').update({ code: `${voucher.code}-NEW` }).eq('id', voucher.id)
  if (error) throw error
  const r = await rpc('claim_registration_voucher', {
    p_event_id: event.eventId, p_voucher_id: voucher.id, p_code: voucher.code, p_category_id: event.categoryIds[0],
  })
  assert.equal(r.error, null, r.error?.message)
  assert.deepEqual([r.data.o_id ?? r.data[0]?.o_id, r.data.o_percent ?? r.data[0]?.o_percent], [voucher.id, 20])
  assert.equal(await usedOf(voucher.id), 1)
})
