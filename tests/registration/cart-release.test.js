// Plan 7, task 4b: what a cart gives back when an order or an entry leaves live, and what a late
// payment takes again. Scenarios V-25, V-26 and V-28 in docs/registration/scenario-matrix.md.
// An unpaid order holds voucher uses and stock but never a slot (P3-R15, D7-13, D7-15): every exit
// of one (expiry, cancel_order and the paths through it, the orphan job, confirm_order's refusals)
// gives the uses and the stock back and touches no slot (D7-18). A confirmed entry that is cancelled
// gives back its slot and its voucher use; the extra stays sold (§14.11). A late payment re-claims
// (ruling 8, D7-19). LOCAL stack only.
import { test, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import postgres from 'postgres'
import { localEnv, resetThrottle, sessionFor } from './helpers/stack.js'
import { acceptAgreement, callFn, createPublishedFreeEvent, createPublishedPaidEvent } from './helpers/registrationFixtures.js'
import {
  attemptFor, competitionOf, confirm, confirmOk, db, expireNow, one, orderOf, profileFor, registrationsOf, rows, rpc,
  runnerEmail,
} from './helpers/orders.js'
import { BIEG, DZIECI, adult, groupMeta, orderGroup, orderGroupOk, registerGroup } from './helpers/groups.js'
import { createTeam, paidTeamEvent } from './helpers/teams.js'
import { makeExtra, makeVoucher, vouchersMade } from './helpers/cart.js'
import { assertVoucherInvariant } from './helpers/voucherInvariant.js'
import { assertSlotInvariant } from './helpers/slotInvariant.js'
import { startDpayMock } from './helpers/dpayControl.js'

let owner, ownerId, stopMock, sqlClient
const sql = () => (sqlClient ??= postgres(localEnv().dbUrl, { max: 1, onnotice: () => {} }))
const competitionsSeen = new Set()
before(async () => {
  stopMock = await startDpayMock()
  await resetThrottle()
  await acceptAgreement('zatyrani-test')
  owner = await sessionFor('owner@zatyrani-test.local')
  ownerId = await profileFor('owner@zatyrani-test.local')
})
after(async () => {
  if (stopMock) await stopMock()
  if (sqlClient) await sqlClient.end()
})
afterEach(async () => {
  const competitions = [...competitionsSeen]
  const vouchers = [...vouchersMade]
  competitionsSeen.clear()
  vouchersMade.clear()
  for (const id of competitions) await assertSlotInvariant(id)
  for (const id of vouchers) await assertVoucherInvariant(id)
})

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex')
const ok = (r) => { assert.equal(r.error, null, r.error?.message); return r.data }
const usedOf = async (voucherId) => (await one('vouchers', { id: voucherId })).used
const soldOf = async (variantId) => (await one('extra_variants', { id: variantId })).sold
const takenOf = async (categoryId) => (await competitionOf(categoryId)).taken

async function paidEvent({ capacity = 50 } = {}) {
  const event = await createPublishedPaidEvent(owner, {
    prices: { 'Bieg 9 km': 6000, 'Bieg dzieci 1 km': 2000 }, competitions: [BIEG(capacity), DZIECI(50)],
  })
  for (const id of event.categoryIds) competitionsSeen.add(id)
  return event
}

/** One person, a 15 % code (5100) and one shirt M (4500) → 9600, pending. */
async function cartOrder(event, { voucher, variant, email = runnerEmail('cart'), categoryId = event.categoryIds[0] } = {}) {
  const person = {
    ...adult(categoryId, 'self', email),
    ...(voucher ? { voucherCode: voucher.code } : {}),
    ...(variant ? { extras: [{ variantId: variant.id, qty: 1 }] } : {}),
  }
  const total = (voucher ? 5100 : 6000) + (variant ? 4500 : 0)
  const out = await orderGroupOk(event, [person], { displayed: total })
  assert.equal(out.total, total)
  return { ...out, email }
}

async function cartFixtures(event, { maxUses = 1, stock = 10 } = {}) {
  const voucher = await makeVoucher(event.eventId, { percent: 15, max_uses: maxUses })
  const { variants: { M } } = await makeExtra(event, { variants: [['M', stock]] })
  return { voucher, M }
}

// ---------------------------------------------------------------- V-25 unpaid exits

test('V-25 expire_orders gives the code and the shirt back and touches no slot; the code works again', async () => {
  const event = await paidEvent()
  const [c9] = event.categoryIds
  const { voucher, M } = await cartFixtures(event)
  const a = await cartOrder(event, { voucher, variant: M })
  assert.deepEqual([await usedOf(voucher.id), await soldOf(M.id), await takenOf(c9)], [1, 1, 0])

  await expireNow(a.orderId)
  assert.equal((await orderOf(a.orderId)).status, 'expired')
  assert.ok((await registrationsOf(a.orderId)).every((r) => r.status === 'expired'))
  assert.deepEqual([await usedOf(voucher.id), await soldOf(M.id), await takenOf(c9)], [0, 0, 0])

  const b = await cartOrder(event, { voucher, variant: M })
  assert.equal(b.status, 'pending')
  assert.deepEqual([await usedOf(voucher.id), await soldOf(M.id)], [1, 1])
})

test('V-25 expire_orders releases several orders at once, uses and stock summed per row', async () => {
  const event = await paidEvent()
  const { voucher, M } = await cartFixtures(event, { maxUses: 5 })
  const orders = []
  for (let i = 0; i < 3; i++) orders.push(await cartOrder(event, { voucher, variant: M }))
  assert.deepEqual([await usedOf(voucher.id), await soldOf(M.id)], [3, 3])
  const past = new Date(Date.now() - 60_000).toISOString()
  const { error } = await db().from('orders').update({ expires_at: past }).in('id', orders.map((o) => o.orderId))
  assert.ifError(error)
  assert.ok(ok(await rpc('expire_orders', {})) >= 3)
  assert.deepEqual([await usedOf(voucher.id), await soldOf(M.id)], [0, 0])
})

test('V-25 cancel_order, buyer_cancel_order and the orphan job give the code and the shirt back (D7-18)', async () => {
  const event = await paidEvent()
  const [c9] = event.categoryIds

  const { voucher: v1, M: m1 } = await cartFixtures(event)
  const a = await cartOrder(event, { voucher: v1, variant: m1 })
  assert.equal(ok(await rpc('cancel_order', { p_order_id: a.orderId, p_reason: 'test' })), true)
  assert.deepEqual([await usedOf(v1.id), await soldOf(m1.id), await takenOf(c9)], [0, 0, 0])
  assert.ok((await registrationsOf(a.orderId)).every((r) => r.status === 'cancelled'))
  assert.equal(ok(await rpc('cancel_order', { p_order_id: a.orderId, p_reason: 'test' })), false)
  assert.deepEqual([await usedOf(v1.id), await soldOf(m1.id)], [0, 0], 'a second cancel releases nothing')

  const { voucher: v2, M: m2 } = await cartFixtures(event)
  const b = await cartOrder(event, { voucher: v2, variant: m2 })
  assert.equal(ok(await rpc('buyer_cancel_order', { p_order_id: b.orderId, p_profile_id: await profileFor(b.email) })), 'cancelled')
  assert.deepEqual([await usedOf(v2.id), await soldOf(m2.id)], [0, 0])

  const { voucher: v3, M: m3 } = await cartFixtures(event)
  const c = await cartOrder(event, { voucher: v3, variant: m3 })
  const { error } = await db().from('orders').update({ created_at: new Date(Date.now() - 20 * 60_000).toISOString() })
    .eq('id', c.orderId)
  assert.ifError(error)
  assert.ok(ok(await rpc('release_orphan_orders', {})) >= 1)
  const orphan = await orderOf(c.orderId)
  assert.deepEqual([orphan.status, orphan.cancelled_reason], ['cancelled', 'no_payment_attempt'])
  assert.deepEqual([await usedOf(v3.id), await soldOf(m3.id), await takenOf(c9)], [0, 0, 0])

  const { voucher: v4, M: m4 } = await cartFixtures(event)
  const d = await cartOrder(event, { voucher: v4, variant: m4 })
  assert.equal(ok(await rpc('organizer_cancel_order', { p_order_id: d.orderId, p_actor: ownerId })), 'cancelled')
  assert.deepEqual([await usedOf(v4.id), await soldOf(m4.id)], [0, 0])
})

test("V-25 delete-my-account's account_deleted cancel gives the code and the shirt back", async () => {
  const event = await paidEvent()
  const { voucher, M } = await cartFixtures(event)
  const a = await cartOrder(event, { voucher, variant: M })
  const session = await sessionFor(a.email)
  const { error } = await db().from('auth_codes').insert({
    email: a.email, code_hash: sha256('123456'), purpose: 'delete_account', expires_at: new Date(Date.now() + 600000).toISOString(),
  })
  assert.ifError(error)
  const r = await callFn('delete-my-account', session, { action: 'confirm', code: '123456' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const order = await orderOf(a.orderId)
  assert.deepEqual([order.status, order.cancelled_reason], ['cancelled', 'account_deleted'])
  assert.deepEqual([await usedOf(voucher.id), await soldOf(M.id)], [0, 0])
})

// ---------------------------------------------------------------- V-25 confirmed entries

/** A paid, confirmed cart order → its order, the entry line and attempt. */
async function paidCart(event, fixtures) {
  const out = await cartOrder(event, fixtures)
  const att = await attemptFor(out.orderId, out.total)
  assert.equal((await confirmOk(out.orderId, att.txn, out.total)).outcome, 'confirmed')
  const lines = await rows('order_lines', { order_id: out.orderId })
  const entry = lines.find((l) => l.kind === 'entry')
  return { ...out, entry, registrationId: entry.registration_id }
}
const reserve = (lineId, grosze) =>
  rpc('reserve_organizer_refund', { p_line_id: lineId, p_grosze: grosze, p_actor: ownerId, p_request_key: crypto.randomUUID() })
const finish = (refundId, outcome) => rpc('finish_organizer_refund', { p_refund_id: refundId, p_outcome: outcome })

test('V-25 a full organizer refund of a confirmed voucher entry gives the use and the slot back; the shirt stays sold', async () => {
  const event = await paidEvent()
  const [c9] = event.categoryIds
  const { voucher, M } = await cartFixtures(event)
  const p = await paidCart(event, { voucher, variant: M })
  assert.deepEqual([await usedOf(voucher.id), await soldOf(M.id), await takenOf(c9)], [1, 1, 1])
  assert.equal(p.entry.amount, 5100)

  const r = ok(await reserve(p.entry.id, 5100))
  const done = ok(await finish(r.refundId, 'accepted'))
  assert.deepEqual(done.cancelled, [p.registrationId])
  assert.equal((await one('registrations', { id: p.registrationId })).status, 'cancelled')
  assert.deepEqual([await usedOf(voucher.id), await takenOf(c9), await soldOf(M.id)], [0, 0, 1])
})

test('V-25 a partial organizer refund changes nothing; an organizer cancel of a confirmed entry releases the use', async () => {
  const event = await paidEvent()
  const [c9] = event.categoryIds
  const { voucher, M } = await cartFixtures(event, { maxUses: 2 })
  const p = await paidCart(event, { voucher, variant: M })
  const r = ok(await reserve(p.entry.id, 2000))
  assert.deepEqual(ok(await finish(r.refundId, 'accepted')).cancelled, [])
  assert.equal((await one('registrations', { id: p.registrationId })).status, 'confirmed')
  assert.deepEqual([await usedOf(voucher.id), await takenOf(c9), await soldOf(M.id)], [1, 1, 1])

  const q = await paidCart(event, { voucher, variant: M })
  assert.deepEqual([await usedOf(voucher.id), await takenOf(c9), await soldOf(M.id)], [2, 2, 2])
  ok(await rpc('cancel_registration', { p_registration_id: q.registrationId, p_reason: 'organizer', p_actor: ownerId }))
  assert.deepEqual([await usedOf(voucher.id), await takenOf(c9), await soldOf(M.id)], [1, 1, 2])
})

test("V-25 cancel_registration of a pending entry cancels the whole order and gives its code and shirt back", async () => {
  const event = await paidEvent()
  const { voucher, M } = await cartFixtures(event)
  const a = await cartOrder(event, { voucher, variant: M })
  const [reg] = await registrationsOf(a.orderId)
  ok(await rpc('cancel_registration', { p_registration_id: reg.id, p_reason: 'organizer', p_actor: ownerId }))
  assert.deepEqual([await usedOf(voucher.id), await soldOf(M.id)], [0, 0])
})

test("V-25 cancelling a paid team's captain gives the team line's code back with the slot", async () => {
  const event = await paidTeamEvent(owner)
  competitionsSeen.add(event.categoryIds[0])
  const voucher = await makeVoucher(event.eventId, { percent: 10 })
  const team = await createTeam(event, { displayed: 21600, meta: await groupMeta(event.eventId, { voucherCode: voucher.code }) })
  assert.equal(team.error, null, team.error?.message)
  const att = await attemptFor(team.data.orderId, team.data.total)
  assert.equal((await confirmOk(team.data.orderId, att.txn, team.data.total)).outcome, 'confirmed')
  assert.deepEqual([await usedOf(voucher.id), await takenOf(event.categoryIds[0])], [1, 1])
  const captainReg = (await registrationsOf(team.data.orderId)).find((r) => r.voucher_id === voucher.id)
  ok(await rpc('cancel_registration', { p_registration_id: captainReg.id, p_reason: 'organizer', p_actor: ownerId }))
  assert.deepEqual([await usedOf(voucher.id), await takenOf(event.categoryIds[0])], [0, 0])
})

// ---------------------------------------------------------------- V-26 late payment

/** An order with an attempt, then expired (its use and stock released). */
async function expiredWithAttempt(event, fixtures) {
  const out = await cartOrder(event, fixtures)
  const att = await attemptFor(out.orderId, out.total)
  await expireNow(out.orderId)
  return { ...out, att }
}
const refundOf = async (orderId) => (await rows('refunds', { order_id: orderId }))

test('V-26 a late payment re-claims the use and the stock → late_confirmed, even on a code disabled or past its date', async () => {
  const event = await paidEvent()
  const [c9] = event.categoryIds
  const { voucher, M } = await cartFixtures(event)
  const a = await expiredWithAttempt(event, { voucher, variant: M })
  assert.deepEqual([await usedOf(voucher.id), await soldOf(M.id)], [0, 0])
  // Ruling 8: the re-claim ignores valid_until and disabled_at, respects max_uses.
  const { error } = await db().from('vouchers')
    .update({ disabled_at: new Date().toISOString(), valid_until: new Date(Date.now() - 1000).toISOString() }).eq('id', voucher.id)
  assert.ifError(error)
  const r = await confirmOk(a.orderId, a.att.txn, a.total)
  assert.equal(r.outcome, 'late_confirmed')
  assert.deepEqual([await usedOf(voucher.id), await soldOf(M.id), await takenOf(c9)], [1, 1, 1])
  assert.ok((await registrationsOf(a.orderId)).every((x) => x.status === 'confirmed'))
})

test('V-26 the code used up meanwhile → late_refund voucher, the whole order refunded; the stock sold out → stock', async () => {
  const event = await paidEvent()
  const [c9] = event.categoryIds
  const { voucher, M } = await cartFixtures(event, { stock: 1 })

  const a = await expiredWithAttempt(event, { voucher })
  await cartOrder(event, { voucher }) // takes the last use
  const r = await confirmOk(a.orderId, a.att.txn, a.total)
  assert.equal(r.outcome, 'late_refund')
  assert.equal(r.refund.reason, 'voucher')
  const [refund] = await refundOf(a.orderId)
  assert.deepEqual([refund.reason, refund.amount], ['voucher', a.total])
  assert.equal((await orderOf(a.orderId)).status, 'expired')
  assert.deepEqual([await usedOf(voucher.id), await takenOf(c9)], [1, 0])

  const b = await expiredWithAttempt(event, { variant: M })
  await cartOrder(event, { variant: M }) // takes the last shirt
  const s = await confirmOk(b.orderId, b.att.txn, b.total)
  assert.equal(s.outcome, 'late_refund')
  assert.equal(s.refund.reason, 'stock')
  assert.deepEqual([await soldOf(M.id), await takenOf(c9)], [1, 0])
  assert.ok((await registrationsOf(b.orderId)).every((x) => x.status === 'expired'))
})

test('V-26 the voucher re-claimed before the stock fails is undone too (one subtransaction)', async () => {
  const event = await paidEvent()
  const { voucher, M } = await cartFixtures(event, { maxUses: 2, stock: 1 })
  const a = await expiredWithAttempt(event, { voucher, variant: M })
  await cartOrder(event, { variant: M })
  const r = await confirmOk(a.orderId, a.att.txn, a.total)
  assert.equal(r.refund.reason, 'stock')
  assert.deepEqual([await usedOf(voucher.id), await soldOf(M.id)], [0, 1])
})

test('V-26 the competition full when the payment lands: full, and what the order held is released (pending and expired)', async () => {
  const event = await paidEvent({ capacity: 1 })
  const [c9] = event.categoryIds
  const { voucher, M } = await cartFixtures(event, { maxUses: 3 })

  const pending = await cartOrder(event, { voucher, variant: M })
  const pAtt = await attemptFor(pending.orderId, pending.total)
  const expired = await expiredWithAttempt(event, { voucher, variant: M })
  await paidCart(event, {}) // fills the only place
  assert.deepEqual([await usedOf(voucher.id), await soldOf(M.id), await takenOf(c9)], [1, 1, 1])

  const r = await confirmOk(pending.orderId, pAtt.txn, pending.total)
  assert.deepEqual([r.outcome, r.refund.reason], ['late_refund', 'full'])
  const o = await orderOf(pending.orderId)
  assert.deepEqual([o.status, o.cancelled_reason], ['cancelled', 'full'])
  assert.deepEqual([await usedOf(voucher.id), await soldOf(M.id), await takenOf(c9)], [0, 0, 1])

  const e = await confirmOk(expired.orderId, expired.att.txn, expired.total)
  assert.deepEqual([e.outcome, e.refund.reason], ['late_refund', 'full'])
  assert.deepEqual([await usedOf(voucher.id), await soldOf(M.id), await takenOf(c9)], [0, 0, 1], 'nothing re-claimed')
})

test('V-26 a pending order paid in time re-claims nothing: it holds its use and its stock', async () => {
  const event = await paidEvent()
  const { voucher, M } = await cartFixtures(event)
  await paidCart(event, { voucher, variant: M })
  assert.deepEqual([await usedOf(voucher.id), await soldOf(M.id)], [1, 1])
})

test('V-26 confirm_order on a closed or hidden competition releases a pending order\'s use and stock', async () => {
  const event = await paidEvent()
  const { voucher, M } = await cartFixtures(event)
  const a = await cartOrder(event, { voucher, variant: M })
  const att = await attemptFor(a.orderId, a.total)
  const { error } = await db().from('registration_settings')
    .update({ closes_at: new Date(Date.now() - 3600_000).toISOString() }).eq('event_id', event.eventId)
  assert.ifError(error)
  const r = await confirm(a.orderId, att.txn, a.total)
  assert.equal(r.error, null, r.error?.message)
  assert.deepEqual([r.data.outcome, r.data.refund.reason], ['late_refund', 'closed'])
  assert.deepEqual([await usedOf(voucher.id), await soldOf(M.id)], [0, 0])
})

// ---------------------------------------------------------------- V-28

test('V-28 a donation on an event that is not a charity → donation_not_allowed; register_free with a code → not_free', async () => {
  const event = await paidEvent()
  const r = await orderGroup(event, [adult(event.categoryIds[0], 'self')], {
    displayed: 6000 + 2000, meta: await groupMeta(event.eventId, { donation: 2000 }),
  })
  assert.equal(r.error?.message, 'donation_not_allowed')

  const free = await createPublishedFreeEvent(owner, { competitions: [BIEG(50)] })
  competitionsSeen.add(free.categoryIds[0])
  const voucher = await makeVoucher(free.eventId)
  const f = await registerGroup(free, [{ ...adult(free.categoryIds[0], 'self'), voucherCode: voucher.code }])
  assert.equal(f.error?.message, 'not_free')
  assert.equal(await usedOf(voucher.id), 0)
})

test('V-25 the recreated release paths keep their grants; the new internal is nobody\'s; all search_path=\'\'', async () => {
  const can = (role, fn) => sql()`select has_function_privilege(${role}, ${fn}, 'EXECUTE') as ok`.then(([r]) => r.ok)
  for (const fn of ['public.expire_orders(timestamptz)', 'public.release_orphan_orders(timestamptz)',
    'public.cancel_order(uuid, text)', 'public.confirm_order(uuid, text, integer, text)',
    'public.cancel_registration(uuid, text, uuid)', 'public.finish_organizer_refund(uuid, text)']) {
    assert.deepEqual([await can('anon', fn), await can('authenticated', fn), await can('service_role', fn)], [false, false, true], fn)
  }
  for (const fn of ['public.registration_drop_unpaid_order(uuid, text, text)', 'public.registration_release_unpaid(uuid[])',
    'public.registration_reclaim_cart(uuid)', 'public.registration_lock_unpaid_cart(uuid[])']) {
    assert.deepEqual([await can('anon', fn), await can('authenticated', fn), await can('service_role', fn)], [false, false, false], fn)
  }
  const [bad] = await sql()`
    select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('expire_orders', 'release_orphan_orders', 'cancel_order', 'confirm_order', 'cancel_registration',
                         'registration_drop_unpaid_order', 'registration_release_unpaid', 'registration_reclaim_cart',
                         'registration_lock_unpaid_cart')
       and not (coalesce(p.proconfig, '{}') @> array['search_path=""'])`
  assert.equal(bad.n, 0)
})
