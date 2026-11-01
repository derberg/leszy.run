// Plan 7, task 6: V-47, the races around one package. A transfer is decided by one row: every path
// locks the registration, and the gate is an UPDATE of the transfer. Every concurrent call runs on
// its own PostgREST connection. Half the rounds start the calls in the other order, and the call
// with less work before its first lock waits a moment on some rounds, so both orders occur.
// LOCAL stack only.
import { after, afterEach, before, test } from 'node:test'
import postgres from 'postgres'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { localEnv, resetThrottle, sessionFor } from './helpers/stack.js'
import { acceptAgreement, createPublishedFreeEvent, createPublishedPaidEvent } from './helpers/registrationFixtures.js'
import {
  attemptFor, competitionOf, confirm, db, one, orderOf, overdue, person, profileFor, registrationsOf, rows, rpc, runnerEmail,
} from './helpers/orders.js'
import { BIEG, adult, groupMeta, isDeadlock, orderGroupOk, registerGroup } from './helpers/groups.js'
import { makeExtra, makeVoucher, vouchersMade } from './helpers/cart.js'
import { META, acceptCall, consentOf, enableTransfers, freeEntry, inviteOk, paidEntry } from './helpers/transfers.js'
import { assertVoucherInvariant } from './helpers/voucherInvariant.js'
import { assertSlotInvariant } from './helpers/slotInvariant.js'

const BIEG_5 = (capacity = 500) =>
  ({ name: 'Bieg 5 km', discipline: 'run', distanceLabel: '5 km', startTime: '11:00', capacity })

let owner, ownerId, sqlClient
const sql = () => (sqlClient ??= postgres(localEnv().dbUrl, { max: 1, onnotice: () => {} }))
let sqlClient2, sqlClient3
const sql3 = () => (sqlClient3 ??= postgres(localEnv().dbUrl, { max: 1, onnotice: () => {} }))
const sql2 = () => (sqlClient2 ??= postgres(localEnv().dbUrl, { max: 1, onnotice: () => {} }))
after(async () => { if (sqlClient) await sqlClient.end(); if (sqlClient2) await sqlClient2.end(); if (sqlClient3) await sqlClient3.end() })
const seen = new Set()
const watch = (event) => { event.categoryIds.forEach((c) => seen.add(c)); return event }

before(async () => {
  await resetThrottle()
  await acceptAgreement('zatyrani-test')
  owner = await sessionFor('owner@zatyrani-test.local')
  ownerId = await profileFor('owner@zatyrani-test.local')
})
afterEach(async () => {
  for (const id of seen) await assertSlotInvariant(id)
  seen.clear()
  for (const id of vouchersMade) await assertVoucherInvariant(id)
  vouchersMade.clear()
})

const ok = (r) => { assert.equal(r.error, null, r.error?.message); return r.data }
const key = () => crypto.randomUUID()
const reg = (id) => one('registrations', { id })
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })
const noDeadlock = (r, label) => assert.ok(!isDeadlock(r), `${label}: ${r?.error?.message}`)
/** Starts the calls together, in the given order on even rounds and reversed on odd ones. */
const together = async (round, ...calls) => {
  if (round % 2 === 0) return Promise.all(calls.map((c) => c()))
  return (await Promise.all([...calls].reverse().map((c) => c()))).reverse()
}
/** Delays of the two calls: on some rounds the other one starts first, on others the accept. */
const DELAYS = [[0, 0], [0, 5], [5, 0], [0, 20], [20, 0]]
const held = (round, side, call) => async () => { await sleep(DELAYS[round % DELAYS.length][side]); return call() }

async function freeEvent(capacity = 500) {
  const event = watch(await createPublishedFreeEvent(owner, { competitions: [BIEG(capacity), BIEG_5(capacity)] }))
  await enableTransfers(event)
  return event
}
async function paidEvent(capacity = 500) {
  const event = watch(await createPublishedPaidEvent(owner, {
    competitions: [BIEG(capacity), BIEG_5(capacity)], prices: { 'Bieg 9 km': 6000, 'Bieg 5 km': 6000 },
  }))
  await enableTransfers(event)
  return event
}

test('V-47a 100 rounds: accept vs cancel_transfer → exactly one wins', async (t) => {
  const event = await freeEvent()
  const counts = { accepted: 0, cancelled: 0 }
  for (let round = 0; round < 100; round++) {
    const a = await freeEntry(event)
    const inv = await inviteOk(a.reg.id, a.profileId)
    const go = await acceptCall(event, inv.hash)
    const [acc, can] = await together(round,
      held(round, 0, go),
      held(round, 1, () => rpc('cancel_transfer', { p_transfer_id: inv.transferId, p_actor: a.profileId })))
    noDeadlock(acc, `round ${round}`)
    noDeadlock(can, `round ${round}`)
    const row = await one('transfers', { id: inv.transferId })
    const cancelled = ok(can)
    if (acc.error) {
      assert.equal(acc.error.message, 'gone', `round ${round}`)
      assert.equal(cancelled, true, `round ${round}`)
      assert.equal(row.status, 'cancelled')
      assert.equal((await reg(a.reg.id)).status, 'confirmed')
      counts.cancelled++
    } else {
      assert.equal(cancelled, false, `round ${round}`)
      assert.equal(row.status, 'accepted')
      assert.equal((await reg(a.reg.id)).status, 'transferred_out')
      counts.accepted++
    }
  }
  t.diagnostic(`outcomes ${JSON.stringify(counts)}`)
})

test('V-47b 50 rounds: two recipients accept one token → one registration, one gone', async () => {
  const event = await freeEvent()
  for (let round = 0; round < 50; round++) {
    const a = await freeEntry(event)
    const inv = await inviteOk(a.reg.id, a.profileId)
    const results = await together(round, await acceptCall(event, inv.hash), await acceptCall(event, inv.hash))
    results.forEach((r) => noDeadlock(r, `round ${round}`))
    const won = results.filter((r) => !r.error)
    assert.equal(won.length, 1, `round ${round}: ${results.map((r) => r.error?.message)}`)
    assert.equal(results.find((r) => r.error).error.message, 'gone')
    const row = await one('transfers', { id: inv.transferId })
    assert.equal(row.new_registration_id, won[0].data.registrationId)
    assert.equal((await reg(a.reg.id)).status, 'transferred_out')
  }
})

test('V-47c 50 rounds: accept vs finish_organizer_refund(accepted) on the same line → never two live rows', async (t) => {
  const event = await paidEvent()
  const [cat] = event.categoryIds
  const counts = { refundFirst: 0, transferFirst: 0 }
  for (let round = 0; round < 50; round++) {
    const a = await paidEntry(event)
    const inv = await inviteOk(a.reg.id, a.profileId)
    const [line] = (await rows('order_lines', { order_id: a.orderId })).filter((l) => l.kind === 'entry')
    const res = ok(await rpc('reserve_organizer_refund', {
      p_line_id: line.id, p_grosze: a.total, p_actor: ownerId, p_request_key: key(),
    }))
    const before = (await competitionOf(cat)).taken

    const go = await acceptCall(event, inv.hash, { categoryId: cat })
    const [acc, fin] = await together(round,
      held(round, 0, go),
      held(round, 1, () => rpc('finish_organizer_refund', { p_refund_id: res.refundId, p_outcome: 'accepted' })))
    noDeadlock(acc, `round ${round}`)
    noDeadlock(fin, `round ${round}`)
    const done = ok(fin)
    assert.equal(done.settled, 'settled')
    const row = await one('transfers', { id: inv.transferId })
    if (acc.error) {
      assert.equal(acc.error.message, 'gone', `round ${round}`)
      assert.equal(row.status, 'cancelled')
      assert.equal((await reg(a.reg.id)).status, 'cancelled')
      assert.deepEqual(done.cancelled, [a.reg.id])
      counts.refundFirst++
    } else {
      assert.equal(row.status, 'accepted')
      assert.equal((await reg(a.reg.id)).status, 'transferred_out')
      assert.equal((await reg(acc.data.registrationId)).status, 'cancelled')
      assert.deepEqual(done.cancelled, [acc.data.registrationId])
      assert.equal((await reg(acc.data.registrationId)).refunded, a.total)
      counts.transferFirst++
    }
    assert.equal((await competitionOf(cat)).taken, before - 1)
  }
  t.diagnostic(`outcomes ${JSON.stringify(counts)}`)
})

test('V-47d 50 rounds: a cross-competition accept vs register_free for the last slot → no 40P01, register_free never past the limit', async (t) => {
  const event = await freeEvent(1000)
  const [from, into] = event.categoryIds
  const counts = { both: 0, full: 0 }
  for (let round = 0; round < 50; round++) {
    const a = await freeEntry(event)
    const inv = await inviteOk(a.reg.id, a.profileId)
    const { taken } = await competitionOf(into)
    assert.ifError((await db().from('competitions').update({ capacity: taken + 1 }).eq('category_id', into)).error)

    const go = await acceptCall(event, inv.hash, { categoryId: into })
    const person = adult(into, 'self')
    const buyer = await profileFor(person.email)
    const meta = await groupMeta(event.eventId)
    const [acc, free] = await together(round,
      held(round, 0, go),
      held(round, 1, () => registerGroup(event, [person], { profileId: buyer, meta })))
    noDeadlock(acc, `round ${round}`)
    noDeadlock(free, `round ${round}`)
    ok(acc)
    const after = (await competitionOf(into)).taken
    if (free.error) {
      assert.match(free.error.message, /^full/, `round ${round}`)
      assert.equal(after, taken + 1)
      counts.full++
    } else {
      assert.equal(after, taken + 2, `round ${round}: the transfer may pass the limit, register_free never did`)
      counts.both++
    }
    assert.ifError((await db().from('competitions').update({ capacity: 1000 }).eq('category_id', into)).error)
  }
  await assertSlotInvariant(from)
  await assertSlotInvariant(into)
  t.diagnostic(`outcomes ${JSON.stringify(counts)}`)
})

test('V-47d 50 rounds: a cross-competition accept vs confirm_order for the last slot → no 40P01, confirm_order never past the limit', async (t) => {
  const event = await paidEvent(1000)
  const [, into] = event.categoryIds
  const counts = { paidFirst: 0, refunded: 0 }
  for (let round = 0; round < 50; round++) {
    const a = await paidEntry(event)
    const inv = await inviteOk(a.reg.id, a.profileId)
    const waiting = await orderGroupOk(event, [adult(into, 'self')])
    const att = await attemptFor(waiting.orderId, waiting.total)
    const { taken } = await competitionOf(into)
    assert.ifError((await db().from('competitions').update({ capacity: taken + 1 }).eq('category_id', into)).error)

    const go = await acceptCall(event, inv.hash, { categoryId: into })
    const [acc, conf] = await together(round,
      held(round, 0, go),
      held(round, 1, () => confirm(waiting.orderId, att.txn, waiting.total)))
    noDeadlock(acc, `round ${round}`)
    noDeadlock(conf, `round ${round}`)
    ok(acc)
    const outcome = ok(conf).outcome
    const after = (await competitionOf(into)).taken
    if (outcome === 'confirmed') {
      assert.equal(after, taken + 2, `round ${round}`)
      counts.paidFirst++
    } else {
      assert.equal(outcome, 'late_refund', `round ${round}`)
      assert.equal(conf.data.refund.reason, 'full')
      assert.equal(after, taken + 1)
      assert.equal((await orderOf(waiting.orderId)).status, 'cancelled')
      counts.refunded++
    }
    assert.ifError((await db().from('competitions').update({ capacity: 1000 }).eq('category_id', into)).error)
  }
  t.diagnostic(`outcomes ${JSON.stringify(counts)}`)
})

test('V-47e 50 rounds: accept vs cancel_registration of the old entry → cancelled and gone, or transferred and transferred', async (t) => {
  const event = await freeEvent()
  const [cat] = event.categoryIds
  const counts = { cancelled: 0, transferred: 0 }
  for (let round = 0; round < 50; round++) {
    const a = await freeEntry(event)
    const inv = await inviteOk(a.reg.id, a.profileId)
    const before = (await competitionOf(cat)).taken
    const go = await acceptCall(event, inv.hash)
    const [acc, can] = await together(round,
      held(round, 0, go),
      held(round, 1, () => rpc('cancel_registration', { p_registration_id: a.reg.id, p_reason: 'organizer', p_actor: ownerId })))
    noDeadlock(acc, `round ${round}`)
    noDeadlock(can, `round ${round}`)
    const row = await one('transfers', { id: inv.transferId })
    if (acc.error) {
      assert.equal(acc.error.message, 'gone', `round ${round}: ${can.error?.message}`)
      assert.equal(can.error, null)
      assert.equal(row.status, 'cancelled')
      assert.equal((await reg(a.reg.id)).status, 'cancelled')
      assert.equal((await competitionOf(cat)).taken, before - 1)
      counts.cancelled++
    } else {
      assert.equal(can.error?.message, 'transferred', `round ${round}`)
      assert.equal(row.status, 'accepted')
      assert.equal((await reg(a.reg.id)).status, 'transferred_out')
      assert.equal((await reg(acc.data.registrationId)).status, 'confirmed')
      assert.equal((await competitionOf(cat)).taken, before)
      counts.transferred++
    }
  }
  t.diagnostic(`outcomes ${JSON.stringify(counts)}`)
})

test('V-47f 50 rounds: accept by a recipient whose unpaid order is expiring → no 40P01, the use, the stock and the slot stay true', async (t) => {
  const event = await paidEvent()
  const [cat] = event.categoryIds
  const { variants: { M } } = await makeExtra(event, { variants: [['M', 1000]] })
  const counts = { expiredFirst: 0, acceptFirst: 0 }
  for (let round = 0; round < 50; round++) {
    const voucher = await makeVoucher(event.eventId, { percent: 15, max_uses: 1 })
    const email = runnerEmail('recipient')
    const mine = await orderGroupOk(event, [{
      ...adult(cat, 'self', email), voucherCode: voucher.code, extras: [{ variantId: M.id, qty: 1 }],
    }], { displayed: 5100 + 4500 })
    const a = await paidEntry(event)
    const inv = await inviteOk(a.reg.id, a.profileId, email)
    await overdue(mine.orderId)
    const taken = (await competitionOf(cat)).taken

    const go = await acceptCall(event, inv.hash, { email })
    const [acc, exp] = await together(round,
      held(round, 0, go),
      held(round, 1, () => rpc('expire_orders', {})))
    noDeadlock(acc, `round ${round}`)
    noDeadlock(exp, `round ${round}`)
    ok(acc)
    ok(exp)
    const order = await orderOf(mine.orderId)
    if (order.status === 'expired') counts.expiredFirst++
    else {
      assert.equal(order.status, 'cancelled', `round ${round}`)
      assert.equal(order.cancelled_reason, 'transfer_accepted', `round ${round}`)
      counts.acceptFirst++
    }
    assert.ok((await registrationsOf(mine.orderId)).every((r) => ['expired', 'cancelled'].includes(r.status)))
    assert.equal((await one('vouchers', { id: voucher.id })).used, 0, `round ${round}`)
    assert.equal((await competitionOf(cat)).taken, taken)
    await assertVoucherInvariant(voucher.id)
    await assertSlotInvariant(cat)
  }
  const sold = (await one('extra_variants', { id: M.id })).sold
  assert.equal(sold, 0, 'every shirt of a replaced or expired order came back')
  t.diagnostic(`outcomes ${JSON.stringify(counts)}`)
  assert.ok(counts.expiredFirst > 0 && counts.acceptFirst > 0, `both orders must occur: ${JSON.stringify(counts)}`)
})

// I-2: the recipient opens another unpaid order between the accept's plain read and its locks. The
// accept cannot lock that order without breaking the lock order, so it answers 40001 transfer_retry
// and changes nothing. The call goes straight to PostgreSQL: through PostgREST the same race came back
// 200, the order replaced, so the API answered a retry itself (observed on this stack); Task 7 retries
// once either way.
test('V-47g transfer_retry: an unpaid order opened between the plain read and the locks → 40001, nothing changes', async () => {
  const event = await paidEvent()
  const [c9, c5] = event.categoryIds
  const a = await paidEntry(event, { categoryId: c9 })
  const email = runnerEmail('recipient')
  const inv = await inviteOk(a.reg.id, a.profileId, email)
  const profile = await profileFor(email)
  const consent = await consentOf(event.eventId)
  let release
  const released = new Promise((resolve) => { release = resolve })
  let held
  const holding = new Promise((resolve) => { held = resolve })
  const blocker = sql().begin(async (tx) => {
    await tx`select 1 from public.orders where id = ${a.orderId} for update`
    held()
    await released
  })
  await holding
  let pending
  let mine
  try {
    pending = sql3()`select public.accept_transfer(${inv.hash}, ${sql3().json(person(email))}, ${c9}, ${profile},
      ${sql3().json(consent)}, ${sql3().json(META)}) as out`.then((rows) => ({ data: rows[0].out }), (error) => ({ error }))
    // Until the accept has read "no unpaid order" and waits on the old order's lock.
    const waiting = async () => (await sql2()`select count(*)::int as n from pg_stat_activity
      where wait_event_type = 'Lock' and query like '%accept_transfer%' and pid <> pg_backend_pid()`)[0].n
    for (let i = 0; i < 100 && (await waiting()) === 0; i++) await sleep(50)
    assert.equal(await waiting(), 1, 'the accept waits on the old order')
    mine = await orderGroupOk(event, [adult(c5, 'self', email)])
  } finally {
    release()
    await blocker
  }
  const r = await pending
  assert.equal(r.error?.code, '40001', String(r.error ?? JSON.stringify(r.data)))
  assert.equal(r.error?.message, 'transfer_retry')
  assert.equal((await reg(a.reg.id)).status, 'confirmed')
  assert.equal((await one('transfers', { id: inv.transferId })).status, 'pending')
  assert.equal((await orderOf(mine.orderId)).status, 'pending')
  // The retry: the unpaid order is alone in its order, so it is replaced.
  ok(await (await acceptCall(event, inv.hash, { email, categoryId: c9 }))())
  assert.equal((await orderOf(mine.orderId)).status, 'cancelled')
})
