// Plan 6, task 2: the organizer's RPCs. Reserved refunds (reserve_organizer_refund,
// finish_organizer_refund, resolve_organizer_refund), cancel (cancel_registration,
// organizer_cancel_order), extend_order_window, organizer_edit_registration, rename_team, and the
// recreated settle_refund / stalled_refunds. Scenarios O-10…O-18 in docs/registration/scenario-matrix.md.
// LOCAL stack only; every event and address is random, so reruns pass.
import { after, afterEach, before, test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import postgres from 'postgres'
import { localEnv, sessionFor } from './helpers/stack.js'
import { acceptAgreement, createPublishedPaidEvent } from './helpers/registrationFixtures.js'
import {
  attemptFor, competitionOf, confirmOk, db, expireNow, minutesFromNow, one, orderOf, orderOk,
  profileFor, rows, rpc, runnerEmail, setSettings,
} from './helpers/orders.js'
import { BIEG, adult, registerGroup } from './helpers/groups.js'
import { assertSlotInvariant } from './helpers/slotInvariant.js'
import { captain, freeTeamEvent, paidTeamEvent, teamOk } from './helpers/teams.js'
import { createPublishedFreeEvent } from './helpers/registrationFixtures.js'
import { warsawDayStart, warsawToday } from '../../supabase/functions/_shared/registration/dates.js'

let owner
let ownerId
let sqlClient
const sql = () => (sqlClient ??= postgres(localEnv().dbUrl, { max: 1, onnotice: () => {} }))
const seen = new Set()
const watch = (event) => { event.categoryIds.forEach((c) => seen.add(c)); return event }

before(async () => {
  await acceptAgreement('zatyrani-test')
  owner = await sessionFor('owner@zatyrani-test.local')
  ownerId = await profileFor('owner@zatyrani-test.local')
})
after(async () => { if (sqlClient) await sqlClient.end() })
afterEach(async () => {
  for (const categoryId of seen) await assertSlotInvariant(categoryId)
  seen.clear()
})

const ok = (r) => { assert.equal(r.error, null, r.error?.message); return r.data }
const refused = (r, message) => assert.equal(r.error?.message, message, JSON.stringify(r))
const taken = async (cat) => (await competitionOf(cat)).taken
const reg = (id) => one('registrations', { id })
const participant = (id) => one('participants', { id })
const key = () => crypto.randomUUID()

const paidEvent = async (opts = {}) => watch(await createPublishedPaidEvent(owner, { prices: { 'Bieg 9 km': 6000 }, ...opts }))

/** One paid, confirmed entry → its order, line, registration and attempt. */
async function paidEntry(event) {
  const out = await orderOk(event)
  const att = await attemptFor(out.orderId, out.total)
  assert.equal((await confirmOk(out.orderId, att.txn, out.total)).outcome, 'confirmed')
  const [line] = await rows('order_lines', { order_id: out.orderId })
  return { orderId: out.orderId, line, registrationId: line.registration_id, attempt: att }
}

const reserve = (lineId, grosze, requestKey = key(), actor = ownerId) =>
  rpc('reserve_organizer_refund', { p_line_id: lineId, p_grosze: grosze, p_actor: actor, p_request_key: requestKey })
const finish = (refundId, outcome) => rpc('finish_organizer_refund', { p_refund_id: refundId, p_outcome: outcome })
const cancel = (registrationId, reason = 'organizer') =>
  rpc('cancel_registration', { p_registration_id: registrationId, p_reason: reason, p_actor: ownerId })
const extend = (orderId, until) => rpc('extend_order_window', { p_order_id: orderId, p_until: until, p_actor: ownerId })
const edit = (registrationId, fields) =>
  rpc('organizer_edit_registration', { p_registration_id: registrationId, p_fields: fields, p_actor: ownerId })

// ---------------------------------------------------------------- O-10

test('O-10 a partial reservation moves the line and the registration; accepted leaves the entry confirmed', async () => {
  const event = await paidEvent()
  const e = await paidEntry(event)
  const r = ok(await reserve(e.line.id, 2000))
  assert.equal(r.replay, false)
  assert.equal(r.transactionId, e.attempt.txn)
  assert.match(r.messageId, /^[0-9a-f]{24}$/)
  assert.equal((await one('order_lines', { id: e.line.id })).refunded, 2000)
  assert.equal((await reg(e.registrationId)).refunded, 2000)
  const f = await one('refunds', { id: r.refundId })
  assert.equal(f.kind, 'organizer')
  assert.equal(f.dpay_status, 'pending')
  assert.equal(f.order_line_id, e.line.id)
  assert.equal(f.requested_by, ownerId)
  assert.equal(f.amount, 2000)

  const done = ok(await finish(r.refundId, 'accepted'))
  assert.deepEqual(done, { status: 'accepted', settled: 'settled', cancelled: [], hostWithdraw: false })
  assert.equal((await reg(e.registrationId)).status, 'confirmed')
  assert.ok((await one('refunds', { id: r.refundId })).responded_at)
  assert.equal((await one('payment_attempts', { id: e.attempt.id })).status, 'paid')
  assert.equal(ok(await finish(r.refundId, 'rejected')).settled, 'already_settled')
})

// ---------------------------------------------------------------- O-11

test('O-11 refusals: another refund of the payment in progress, over the remaining amount, zero, an unpaid order, race day; the cutoff is warsawDayStart', async () => {
  const event = await paidEvent()
  const e = await paidEntry(event)
  const first = ok(await reserve(e.line.id, 2000))
  // A second refund of the payment waits for the first one's answer (dpay: one at a time).
  refused(await reserve(e.line.id, 1000), 'refund_in_progress')
  // A reservation never sent, 15 minutes on (stalled_refunds has alerted it), no longer blocks; nor
  // does a `pending` row with an answer stored (a 409 from before 2026-11-03).
  await db().from('refunds').update({ created_at: new Date(Date.now() - 16 * 60_000).toISOString() }).eq('id', first.refundId)
  const second = ok(await reserve(e.line.id, 500))
  await db().from('refunds').update({ responded_at: new Date().toISOString() }).eq('id', second.refundId)
  const third = ok(await reserve(e.line.id, 500))
  for (const r of [second, third]) ok(await rpc('finish_organizer_refund', { p_refund_id: r.refundId, p_outcome: 'rejected' }))
  ok(await rpc('finish_organizer_refund', { p_refund_id: first.refundId, p_outcome: 'accepted' }))
  refused(await reserve(e.line.id, 4001), 'exceeds:4000')
  refused(await reserve(e.line.id, 0), 'invalid_amount')
  refused(await reserve(e.line.id, -5), 'invalid_amount')

  const pending = await orderOk(event)
  const [pLine] = await rows('order_lines', { order_id: pending.orderId })
  refused(await reserve(pLine.id, 1000), 'not_paid')
  refused(await reserve(crypto.randomUUID(), 1000), 'not_found')

  for (const day of ['2026-11-05', '2026-07-01']) {
    const cutoff = ok(await rpc('registration_refund_cutoff', { p_event_date: day }))
    assert.equal(new Date(cutoff).toISOString(), warsawDayStart(day).toISOString(), day)
  }

  const today = warsawToday(new Date())
  await setSettings(event.eventId, { closes_at: minutesFromNow(-1), event_date: today })
  refused(await reserve(e.line.id, 1000), 'race_day')
  const tomorrow = new Date(Date.parse(`${today}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
  await setSettings(event.eventId, { event_date: tomorrow })
  ok(await reserve(e.line.id, 1000))
})

// ---------------------------------------------------------------- O-12

test('O-12 one request key is one refund: a replay returns it, a different amount is a mismatch', async () => {
  const event = await paidEvent()
  const e = await paidEntry(event)
  const k = key()
  const first = ok(await reserve(e.line.id, 1500, k))
  const again = ok(await reserve(e.line.id, 1500, k))
  assert.equal(again.refundId, first.refundId)
  assert.equal(again.messageId, first.messageId)
  assert.equal(again.replay, true)
  assert.equal((await rows('refunds', { request_key: k })).length, 1)
  assert.equal((await one('order_lines', { id: e.line.id })).refunded, 1500)
  refused(await reserve(e.line.id, 1000, k), 'request_key_mismatch')
})

// ---------------------------------------------------------------- O-13

test('O-13 rejected and 406 release the reservation, no retry for an organizer refund; the attempt is refunded only by the last accepted', async () => {
  const event = await paidEvent()
  const e = await paidEntry(event)

  const a = ok(await reserve(e.line.id, 1000))
  assert.equal(ok(await finish(a.refundId, 'rejected')).status, 'rejected')
  const b = ok(await reserve(e.line.id, 1000))
  assert.equal(ok(await finish(b.refundId, 'insufficient_balance')).status, 'insufficient_balance')
  assert.equal((await one('refunds', { id: b.refundId })).next_retry_at, null)
  assert.equal((await one('order_lines', { id: e.line.id })).refunded, 0)
  assert.equal((await reg(e.registrationId)).refunded, 0)
  // 406 is final for an organizer refund: a later answer changes nothing.
  assert.equal(ok(await finish(b.refundId, 'accepted')).settled, 'already_settled')

  // The released 2000 count toward nothing: the whole 6000 can still be refunded.
  const c = ok(await reserve(e.line.id, 4000))
  const p = ok(await finish(c.refundId, 'pending'))
  assert.equal(p.status, 'pending')
  assert.equal(ok(await finish(c.refundId, 'accepted')).status, 'accepted')
  assert.equal((await one('payment_attempts', { id: e.attempt.id })).status, 'paid')
  const d = ok(await reserve(e.line.id, 2000))
  ok(await finish(d.refundId, 'accepted'))
  assert.equal((await one('payment_attempts', { id: e.attempt.id })).status, 'refunded')

  // An automatic 406 is still scheduled for the retry job.
  const other = await paidEntry(event)
  const auto = ok(await rpc('record_refund', { p_attempt_id: other.attempt.id, p_grosze: 6000, p_kind: 'automatic', p_reason: 'test' }))
  assert.equal(ok(await rpc('settle_refund', { p_refund_id: auto.refundId, p_outcome: 'insufficient_balance' })), 'settled')
  assert.ok((await one('refunds', { id: auto.refundId })).next_retry_at)
  // The automatic 6000 still counts, so the per-attempt cap refuses an organizer reservation.
  const [otherLine] = await rows('order_lines', { order_id: other.orderId })
  refused(await reserve(otherLine.id, 1000), 'exceeds:0')
})

test('O-13b record_refund cap: a reserved organizer refund counts against the attempt', async () => {
  const event = await paidEvent()
  const e = await paidEntry(event)
  ok(await reserve(e.line.id, 5000))
  const r = await rpc('record_refund', { p_attempt_id: e.attempt.id, p_grosze: 2000, p_kind: 'automatic', p_reason: 'x' })
  refused(r, 'invalid_amount')
  // settle_refund on a partial accepted automatic refund leaves the attempt paid.
  const s = ok(await rpc('record_refund', { p_attempt_id: e.attempt.id, p_grosze: 1000, p_kind: 'automatic', p_reason: 'x' }))
  assert.equal(ok(await rpc('settle_refund', { p_refund_id: s.refundId, p_outcome: 'accepted' })), 'settled')
  assert.equal((await one('payment_attempts', { id: e.attempt.id })).status, 'paid')
})

// ---------------------------------------------------------------- O-14

test('O-14 a full accepted refund cancels the entry, releases its slot and removes the participant', async () => {
  const event = await paidEvent()
  const cat = event.categoryIds[0]
  const e = await paidEntry(event)
  const before = await taken(cat)
  const partId = (await reg(e.registrationId)).participant_id
  const r = ok(await reserve(e.line.id, 6000))
  assert.equal((await reg(e.registrationId)).status, 'confirmed', 'a reservation cancels nothing')
  const done = ok(await finish(r.refundId, 'accepted'))
  assert.deepEqual(done.cancelled, [e.registrationId])
  assert.equal(done.hostWithdraw, false)
  const after = await reg(e.registrationId)
  assert.equal(after.status, 'cancelled')
  assert.ok(after.cancelled_at)
  assert.equal(after.cancelled_by, ownerId)
  assert.equal(await taken(cat), before - 1)
  assert.ok((await participant(partId)).removed_at)
  assert.equal((await one('payment_attempts', { id: e.attempt.id })).status, 'refunded')
})

test('O-14 cancel_registration of a free entry (no order) releases one slot and removes the participant', async () => {
  const event = watch(await createPublishedFreeEvent(owner, { competitions: [BIEG(10)] }))
  const cat = event.categoryIds[0]
  const out = ok(await registerGroup(event, [adult(cat, 'self')]))
  const id = out.registrations[0].id
  const before = await taken(cat)
  const done = ok(await cancel(id))
  assert.deepEqual(done, { cancelled: [id], hostWithdraw: false })
  assert.equal(await taken(cat), before - 1)
  assert.ok((await participant((await reg(id)).participant_id)).removed_at)
  refused(await cancel(id), 'already_cancelled')
  assert.equal(await taken(cat), before - 1, 'a second cancel releases nothing')
})

test('O-14 cancel_registration of a pending entry cancels its whole order and releases nothing; not once a payment is in', async () => {
  const event = await paidEvent()
  const cat = event.categoryIds[0]
  const out = await orderOk(event, { emails: [runnerEmail(), runnerEmail()] })
  const regs = await rows('registrations', { order_id: out.orderId })
  const before = await taken(cat)
  const done = ok(await cancel(regs[0].id))
  assert.deepEqual(done.cancelled.sort(), regs.map((r) => r.id).sort())
  assert.equal(done.hostWithdraw, false)
  const o = await orderOf(out.orderId)
  assert.equal(o.status, 'cancelled')
  assert.equal(o.cancelled_reason, 'organizer_cancelled')
  for (const r of regs) {
    const now = await reg(r.id)
    assert.equal(now.status, 'cancelled')
    assert.equal(now.cancelled_by, ownerId)
  }
  assert.equal(await taken(cat), before)

  const second = await orderOk(event)
  const att = await attemptFor(second.orderId, second.total)
  await db().from('payment_attempts').update({ status: 'paid' }).eq('id', att.id)
  const [r2] = await rows('registrations', { order_id: second.orderId })
  refused(await cancel(r2.id), 'payment_received')
  assert.equal((await orderOf(second.orderId)).status, 'pending')
  assert.equal((await reg(r2.id)).status, 'pending_payment')
  assert.equal(ok(await rpc('organizer_cancel_order', { p_order_id: second.orderId, p_actor: ownerId })), 'payment_received')
  assert.equal(ok(await rpc('organizer_cancel_order', { p_order_id: out.orderId, p_actor: ownerId })), 'cancelled_already')
})

// ---------------------------------------------------------------- O-15

test('O-15 a fully refunded captain line cancels the whole team, one slot, the name released', async () => {
  const event = watch(await paidTeamEvent(owner))
  const cat = event.categoryIds[0]
  const out = await teamOk(event)
  const att = await attemptFor(out.orderId, out.total)
  assert.equal((await confirmOk(out.orderId, att.txn, out.total)).outcome, 'confirmed')
  const ids = out.registrations.map((r) => r.id)
  const before = await taken(cat)
  const [line] = await rows('order_lines', { order_id: out.orderId })
  const r = ok(await reserve(line.id, out.total))
  const done = ok(await finish(r.refundId, 'accepted'))
  assert.deepEqual(done.cancelled.sort(), [...ids].sort())
  for (const id of ids) assert.equal((await reg(id)).status, 'cancelled')
  assert.equal(await taken(cat), before - 1)
  assert.ok((await one('teams', { id: out.teamId })).released_at)
})

test('O-15 cancelling one team member keeps the slot; never below team_min', async () => {
  const event = watch(await freeTeamEvent(owner))
  const cat = event.categoryIds[0]
  const out = await teamOk(event, { members: [captain(), adult(cat, 'adult'), adult(cat, 'adult')] })
  const [capId, m1, m2] = out.registrations.map((r) => r.id)
  const before = await taken(cat)
  assert.deepEqual(ok(await cancel(m1)), { cancelled: [m1], hostWithdraw: false })
  assert.equal(await taken(cat), before)
  assert.ok((await participant((await reg(m1)).participant_id)).removed_at)
  assert.equal((await one('teams', { id: out.teamId })).released_at, null)
  refused(await cancel(m2), 'below_team_min')
  assert.equal((await reg(m2)).status, 'confirmed')
  // The captain takes the team with them.
  const done = ok(await cancel(capId))
  assert.deepEqual(done.cancelled.sort(), [capId, m2].sort())
  assert.equal(await taken(cat), before - 1)
  assert.ok((await one('teams', { id: out.teamId })).released_at)
})

test('O-15 cancelling a member of a pending team cancels the whole order', async () => {
  const event = watch(await paidTeamEvent(owner))
  const cat = event.categoryIds[0]
  const out = await teamOk(event, { members: [captain(), adult(cat, 'adult')] })
  const done = ok(await cancel(out.registrations[1].id))
  assert.equal(done.cancelled.length, 2)
  assert.equal((await orderOf(out.orderId)).status, 'cancelled')
  assert.ok((await one('teams', { id: out.teamId })).released_at)
})

// ---------------------------------------------------------------- O-16

test('O-16 extend_order_window: up to 14 days and never past closes_at; an expired order cannot be extended', async () => {
  const event = await paidEvent()
  const cat = event.categoryIds[0]
  const out = await orderOk(event)
  const before = await taken(cat)
  await db().from('orders').update({ expires_at: minutesFromNow(60), reminder_sent_at: new Date().toISOString() }).eq('id', out.orderId)
  const until = minutesFromNow(3 * 24 * 60)
  const got = ok(await extend(out.orderId, until))
  assert.equal(new Date(got).toISOString(), new Date(until).toISOString())
  const o = await orderOf(out.orderId)
  assert.ok(o.extended_at)
  assert.equal(o.extended_by, ownerId)
  assert.equal(o.reminder_sent_at, null)
  assert.equal(await taken(cat), before)

  refused(await extend(out.orderId, minutesFromNow(15 * 24 * 60)), 'invalid_until')
  refused(await extend(out.orderId, minutesFromNow(60)), 'invalid_until', 'never shortens')

  const closes = minutesFromNow(5 * 24 * 60)
  await setSettings(event.eventId, { closes_at: closes })
  refused(await extend(out.orderId, new Date(Date.parse(closes) + 60_000).toISOString()), 'invalid_until')
  ok(await extend(out.orderId, closes))
  refused(await extend(out.orderId, closes), 'invalid_until', 'expires_at = closes_at')

  const gone = await orderOk(event)
  await expireNow(gone.orderId)
  refused(await extend(gone.orderId, minutesFromNow(60)), 'expired')
  assert.equal(await taken(cat), before)
})

// ---------------------------------------------------------------- O-17

test('O-17 after closes_at a full refund cancels and releases, touches no participant, alerts host_withdraw once; edits are closed', async () => {
  const event = await paidEvent()
  const cat = event.categoryIds[0]
  const e = await paidEntry(event)
  const partId = (await reg(e.registrationId)).participant_id
  await setSettings(event.eventId, { closes_at: minutesFromNow(-1) })
  const [{ xmin: before }] = await sql()`SELECT xmin::text FROM public.participants WHERE id = ${partId}`
  const slots = await taken(cat)
  const r = ok(await reserve(e.line.id, 6000))
  const done = ok(await finish(r.refundId, 'accepted'))
  assert.deepEqual(done, { status: 'accepted', settled: 'settled', cancelled: [e.registrationId], hostWithdraw: true })
  assert.equal(await taken(cat), slots - 1)
  const [{ xmin: afterX }] = await sql()`SELECT xmin::text FROM public.participants WHERE id = ${partId}`
  assert.equal(afterX, before)
  const alerts = await rows('operator_alerts', { kind: 'host_withdraw', order_id: e.orderId })
  assert.equal(alerts.length, 1)
  assert.deepEqual(alerts[0].payload.registrationIds, [e.registrationId])
  assert.equal(alerts[0].payload.eventId, event.eventId)
  assert.ok('bibs' in alerts[0].payload)
  assert.equal(JSON.stringify(alerts[0].payload).includes('Leśna'), false, 'no name in the alert (D6-29)')

  const other = await paidEntry(watch(await paidEvent()))
  await setSettings((await reg(other.registrationId)).event_id, { closes_at: minutesFromNow(-1) })
  refused(await edit(other.registrationId, { lastName: 'Nowak' }), 'edits_closed')
})

// ---------------------------------------------------------------- O-18

test('O-18 organizer_edit_registration: allow-list, eligibility, the participant follows before close', async () => {
  const event = await paidEvent()
  const cat = event.categoryIds[0]
  const e = await paidEntry(event)
  await db().from('competitions').update({ max_age: 60 }).eq('category_id', cat)
  refused(await edit(e.registrationId, { birthDate: '1950-01-01' }), 'ineligible')
  refused(await edit(e.registrationId, { email: 'x@y.pl' }), 'invalid_field')
  refused(await edit(e.registrationId, { phone: '' }), 'edit_invalid')
  refused(await edit(e.registrationId, { birthDate: '2015-01-01' }), 'role_change')

  const out = ok(await edit(e.registrationId, { lastName: 'Nowak', birthDate: '1985-03-03', gender: 'M', phone: '+48600700800' }))
  assert.equal(out.changed, true)
  const r = await reg(e.registrationId)
  assert.equal(r.last_name, 'Nowak')
  assert.equal(r.birth_date, '1985-03-03')
  assert.equal(r.age_group_label, 'M open')
  const p = await participant(r.participant_id)
  assert.equal(p.last_name, 'Nowak')
  assert.equal(p.birth_date, '1985-03-03')
  assert.equal(p.gender, 'M')
  assert.equal(p.phone, '+48600700800')
})

test('O-18 a team member who has not given a phone yet (memberDetails.js): the organizer still edits the other fields; a phone is judged only when the edit changes it', async () => {
  const event = await paidEvent()
  const e = await paidEntry(event)
  const { error } = await db().from('registrations').update({ phone: null }).eq('id', e.registrationId)
  assert.ifError(error)
  ok(await edit(e.registrationId, { lastName: 'Bezfonu' }))
  assert.equal((await reg(e.registrationId)).last_name, 'Bezfonu')
  refused(await edit(e.registrationId, { phone: 'abc' }), 'edit_invalid')
  ok(await edit(e.registrationId, { phone: '+48600700801' }))
  refused(await edit(e.registrationId, { phone: '' }), 'edit_invalid')
  assert.equal((await reg(e.registrationId)).phone, '+48600700801')
})

test('O-18 final review M1: the adult or child check reads the age on race day, not today', async () => {
  const event = await paidEvent()
  // 17 today, 18 ten days from now, and the race is 30 days away: an adult, with an e-mail.
  const birthday = new Date(Date.now() + 10 * 86400000)
  birthday.setUTCFullYear(birthday.getUTCFullYear() - 18)
  const birthDate = birthday.toISOString().slice(0, 10)
  const out = await orderOk(event, { people: [{
    firstName: 'Ola', lastName: 'Prawie', birthDate, gender: 'K', email: runnerEmail('osiemnastka'),
    phone: '+48500100200', ageGroupLabel: 'K open',
  }] })
  const [r] = await rows('registrations', { order_id: out.orderId })
  assert.ok(r.email, 'registered as an adult')
  assert.equal(ok(await edit(r.id, { gender: 'M' })).changed, true)
  assert.equal((await reg(r.id)).gender, 'M')
  // A real child's birth date on this adult's entry is still a role change.
  refused(await edit(r.id, { birthDate: '2015-01-01' }), 'role_change')
})

test('O-13d final review M2: stalled_refunds can use refunds_unanswered_idx for organizer refunds too', async () => {
  const [{ indexdef }] = await sql()`SELECT indexdef FROM pg_indexes WHERE indexname = 'refunds_unanswered_idx'`
  assert.doesNotMatch(indexdef, /automatic/, indexdef)
  const plan = await sql().begin(async (tx) => {
    await tx`SET LOCAL enable_seqscan = off`
    return tx.unsafe(`EXPLAIN SELECT f.id FROM public.refunds f
      WHERE f.dpay_status NOT IN ('accepted', 'rejected') AND f.next_retry_at IS NULL
        AND ((f.requested_at IS NULL AND f.created_at < now() - interval '10 minutes')
          OR (f.requested_at < now() - interval '15 minutes'
              AND (f.responded_at IS NULL OR f.responded_at < f.requested_at)))`)
  })
  assert.match(plan.map((p) => p['QUERY PLAN']).join('\n'), /refunds_unanswered_idx/)
})

test('O-18 rename_team: the name rules and the live-name index', async () => {
  const event = watch(await freeTeamEvent(owner))
  const a = await teamOk(event)
  const b = await teamOk(event)
  const name = `Szybkie Łosie ${crypto.randomBytes(3).toString('hex')}`
  assert.equal(ok(await rpc('rename_team', { p_team_id: a.teamId, p_name: `  ${name}  `, p_actor: ownerId })), name)
  assert.equal((await one('teams', { id: a.teamId })).name, name)
  refused(await rpc('rename_team', { p_team_id: b.teamId, p_name: name.toUpperCase(), p_actor: ownerId }), 'team_name_taken')
  refused(await rpc('rename_team', { p_team_id: b.teamId, p_name: 'x', p_actor: ownerId }), 'invalid_team_name')
  refused(await rpc('rename_team', { p_team_id: crypto.randomUUID(), p_name: 'Nowa nazwa', p_actor: ownerId }), 'not_found')
})

// ---------------------------------------------------------------- resolve + stalled

test('O-13c resolve_organizer_refund: only from unknown or pending; accepted applies the effects, rejected releases', async () => {
  const event = await paidEvent()
  const e = await paidEntry(event)
  const r = ok(await reserve(e.line.id, 6000))
  ok(await finish(r.refundId, 'unknown'))
  assert.equal((await one('order_lines', { id: e.line.id })).refunded, 6000, 'unknown keeps the reservation')
  const done = ok(await rpc('resolve_organizer_refund', { p_refund_id: r.refundId, p_outcome: 'accepted', p_note: 'panel dpay: zwrot widoczny' }))
  assert.deepEqual(done.cancelled, [e.registrationId])
  assert.equal((await one('refunds', { id: r.refundId })).resolved_by, 'panel dpay: zwrot widoczny')
  refused(await rpc('resolve_organizer_refund', { p_refund_id: r.refundId, p_outcome: 'rejected', p_note: 'x' }), 'not_unresolved')

  const e2 = await paidEntry(event)
  const r2 = ok(await reserve(e2.line.id, 3000))
  refused(await rpc('resolve_organizer_refund', { p_refund_id: r2.refundId, p_outcome: 'unknown', p_note: 'x' }), 'invalid_outcome')
  ok(await rpc('resolve_organizer_refund', { p_refund_id: r2.refundId, p_outcome: 'rejected', p_note: 'odrzucony' }))
  assert.equal((await one('order_lines', { id: e2.line.id })).refunded, 0)
})

test('O-13d stalled_refunds lists an organizer refund claimed 16 minutes ago with no answer', async () => {
  const event = await paidEvent()
  const e = await paidEntry(event)
  const r = ok(await reserve(e.line.id, 1000))
  await db().from('refunds').update({ requested_at: minutesFromNow(-16) }).eq('id', r.refundId)
  const stalled = ok(await rpc('stalled_refunds', { p_limit: 1000 }))
  const mine = stalled.filter((s) => s.refund_id === r.refundId)
  assert.equal(mine.length, 1)
  assert.equal(mine[0].alert_kind, 'refund_stalled')
})

test('O-10b every new function is service_role only', async () => {
  const fns = ['reserve_organizer_refund', 'finish_organizer_refund', 'resolve_organizer_refund', 'cancel_registration',
    'organizer_cancel_order', 'extend_order_window', 'organizer_edit_registration', 'rename_team', 'registration_refund_cutoff']
  const got = await sql()`
    SELECT p.proname, p.prosecdef, p.proconfig,
           has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
           has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = ANY (${fns})`
  assert.deepEqual(got.map((f) => f.proname).sort(), [...fns].sort())
  for (const f of got) {
    assert.equal(f.anon, false, f.proname)
    assert.equal(f.auth, false, f.proname)
    assert.equal(f.svc, true, f.proname)
    assert.deepEqual(f.proconfig, ['search_path=""'], f.proname)
  }
})
