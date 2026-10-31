// Plan 5, task 3: create_team_registration, free and paid, and D5-12. Scenarios T-20…T-24, T-26
// and T-27 in docs/registration/scenario-matrix.md. LOCAL stack only.
import { after, afterEach, before, test } from 'node:test'
import assert from 'node:assert/strict'
import postgres from 'postgres'
import { localEnv, sessionFor } from './helpers/stack.js'
import { acceptAgreement, callFn } from './helpers/registrationFixtures.js'
import {
  attemptFor, competitionOf, confirm, confirmOk, consentIds, db, expireNow, minutesFromNow, one, orderOf,
  overdue, person, profileFor, registrationsOf, rows, rpc, runnerEmail, setSettings,
} from './helpers/orders.js'
import { BIEG, adult, groupMeta, minor, orderGroupOk, registerGroup } from './helpers/groups.js'
import { assertSlotInvariant } from './helpers/slotInvariant.js'
import {
  STAFETA, captain, createTeam, freeTeamEvent, paidTeamEvent, setLegOrder, squad, teamName, teamOk,
} from './helpers/teams.js'
import { teamNameKey } from '../../supabase/functions/_shared/registration/team.js'

let owner
let sqlClient
const sql = () => (sqlClient ??= postgres(localEnv().dbUrl, { max: 1, onnotice: () => {} }))
const seen = new Set()
const watch = (event) => { event.categoryIds.forEach((c) => seen.add(c)); return event }

before(async () => {
  await acceptAgreement('zatyrani-test')
  owner = await sessionFor('owner@zatyrani-test.local')
})
after(async () => { if (sqlClient) await sqlClient.end() })
afterEach(async () => {
  for (const categoryId of seen) await assertSlotInvariant(categoryId)
  seen.clear()
})

const free = async (opts) => watch(await freeTeamEvent(owner, opts))
const paid = async (opts) => watch(await paidTeamEvent(owner, opts))
const taken = async (cat) => (await competitionOf(cat)).taken
const teamsIn = (cat) => rows('teams', { category_id: cat })
const regsOfTeam = async (teamId) => {
  const list = await rows('registrations', { team_id: teamId })
  return list.sort((a, b) => a.created_at.localeCompare(b.created_at))
}
const byIndex = (out, regs) => out.registrations.map((r) => regs.find((x) => x.id === r.id))
const participantsOf = async (ids) => {
  const { data, error } = await db().from('participants').select('*').in('registration_id', ids)
  if (error) throw error
  return data
}
const refused = (r, message) => assert.equal(r.error?.message, message, JSON.stringify(r))

// ---------------------------------------------------------------- T-20

test('T-20 a free team of 4 → 4 confirmed, one slot, 4 participants, no order', async () => {
  const event = await free({ legOrder: true })
  const cat = event.categoryIds[0]
  const members = squad(cat).map((m, i) => ({ ...m, leg: i + 1, nationality: 'PL' }))
  const name = teamName()
  const out = await teamOk(event, { members, name })

  assert.equal(out.orderId, null)
  assert.equal(out.status, 'confirmed')
  assert.equal(out.total, 0)
  assert.deepEqual(out.amounts, { entryTotal: 0, extrasTotal: 0, donation: 0, total: 0 })
  assert.equal(out.expiresAt, null)
  assert.deepEqual(out.registrations.map((r) => [r.index, r.role]), [[0, 'self'], [1, 'adult'], [2, 'minor'], [3, 'minor']])
  assert.deepEqual(Object.keys(out.registrations[0]).sort(), ['id', 'index', 'role'])

  const team = await one('teams', { id: out.teamId })
  assert.equal(team.name, name)
  assert.equal(team.event_id, event.eventId)
  assert.equal(team.category_id, cat)
  assert.equal(team.captain_registration_id, out.registrations[0].id)
  assert.equal(team.released_at, null)

  assert.equal(await taken(cat), 1)
  const regs = byIndex(out, await regsOfTeam(out.teamId))
  assert.deepEqual(regs.map((r) => r.status), ['confirmed', 'confirmed', 'confirmed', 'confirmed'])
  assert.deepEqual(regs.map((r) => r.consent_state), ['accepted', 'awaiting', 'accepted', 'accepted'])
  assert.deepEqual(regs.map((r) => r.team_leg), [1, 2, 3, 4])
  assert.deepEqual(regs.map((r) => r.price), [0, 0, 0, 0])
  assert.deepEqual(regs.map((r) => r.list_price), [0, 0, 0, 0])
  assert.deepEqual(regs.map((r) => r.order_id), [null, null, null, null])
  assert.deepEqual(regs.map((r) => r.nationality), ['PL', 'PL', 'PL', 'PL'])
  const profile = await profileFor(members[0].email)
  assert.deepEqual(regs.map((r) => r.registered_by_profile_id), Array(4).fill(profile))
  assert.equal(regs[0].profile_id, profile)
  assert.equal(regs[1].profile_id, null)
  for (const child of regs.slice(2)) {
    assert.equal(child.email, null)
    assert.equal(child.guardian_profile_id, profile)
    assert.equal(child.guardian_email, members[0].email)
    assert.equal(child.guardian_name, 'Ola Leśna')
  }
  assert.equal(regs[0].guardian_profile_id, null)

  const parts = await participantsOf(regs.map((r) => r.id))
  assert.equal(parts.length, 4)
  assert.ok(regs.every((r) => r.participant_id))
  assert.ok(parts.every((p) => p.category_id === cat))
})

test('T-20 acceptances: the captain every event consent plus the service regulamin, as self; minors as guardian; the adult none', async () => {
  const event = await free()
  const cat = event.categoryIds[0]
  const out = await teamOk(event, { members: squad(cat) })
  const ids = await consentIds(event.eventId)
  const regs = byIndex(out, await regsOfTeam(out.teamId))
  const acc = await Promise.all(regs.map((r) => rows('consent_acceptances', { registration_id: r.id })))
  assert.equal(acc[0].length, ids.length + 1)
  assert.deepEqual(acc[0].map((a) => a.consent_id).filter(Boolean).sort(), [...ids].sort())
  assert.ok(acc[0].some((a) => a.consent_id === null && a.consent_kind === 'service_regulamin'))
  assert.ok(acc[0].every((a) => a.accepted_as === 'self'))
  assert.equal(acc[1].length, 0)
  for (const child of acc.slice(2)) {
    assert.equal(child.length, ids.length + 1)
    assert.ok(child.every((a) => a.accepted_as === 'guardian'))
  }
})

test('T-20 leg order off: legs sent are not stored', async () => {
  const event = await free()
  const cat = event.categoryIds[0]
  const out = await teamOk(event, { members: squad(cat).map((m, i) => ({ ...m, leg: i + 1 })) })
  assert.deepEqual((await regsOfTeam(out.teamId)).map((r) => r.team_leg), [null, null, null, null])
})

// ---------------------------------------------------------------- T-21

test('T-21 member 2 is live in another competition of the event → duplicate:1, nothing left behind', async () => {
  const event = await free({ competitions: [STAFETA(5), BIEG(50)] })
  const [team, bieg] = event.categoryIds
  const live = runnerEmail('live')
  await registerGroup(event, [adult(bieg, 'self', live)])
  const before = await taken(team)
  const members = squad(team)
  members[1] = adult(team, 'adult', live)
  const name = teamName()
  refused(await createTeam(event, { categoryId: team, members, name }), 'duplicate:1')
  assert.equal(await taken(team), before)
  assert.equal((await teamsIn(team)).length, 0)
  assert.equal((await rows('registrations', { category_id: team })).length, 0)
})

test('T-21 a child already in the event, and a member of another live team → duplicate:<index>', async () => {
  const event = await free()
  const cat = event.categoryIds[0]
  const first = squad(cat)
  await teamOk(event, { members: first })
  const again = squad(cat)
  again[2] = first[3]
  refused(await createTeam(event, { members: again }), 'duplicate:2')
  const third = squad(cat)
  third[1] = adult(cat, 'adult', first[1].email)
  refused(await createTeam(event, { members: third }), 'duplicate:1')
  assert.equal(await taken(cat), 1)
})

// ---------------------------------------------------------------- T-22

test('T-22 a case, space or composition variant of a live name → team_name_taken; released, it is free', async () => {
  const event = await paid()
  const cat = event.categoryIds[0]
  const name = `Żółte Łosie ${Date.now()}`
  const out = await teamOk(event, { name })
  for (const variant of [name.toUpperCase(), `  ${name.replaceAll(' ', '   ')} `, name.replaceAll(' ', '\u00a0'), name.normalize('NFD')]) {
    assert.equal(teamNameKey(variant), teamNameKey(name), variant)
    refused(await createTeam(event, { name: variant }), 'team_name_taken')
  }
  assert.equal((await teamsIn(cat)).length, 1)
  await expireNow(out.orderId)
  await teamOk(event, { name })
})

test('T-22 a blank name is refused by the RPC', async () => {
  const event = await free()
  for (const name of ['', '   ', null]) refused(await createTeam(event, { name }), 'invalid_team_name')
})

// ---------------------------------------------------------------- T-23

const paying = async (event, opts) => {
  const out = await teamOk(event, opts)
  return { ...out, att: await attemptFor(out.orderId, out.total) }
}

test('T-23 paid: one order, one line on the captain, members at 0, nothing claimed while pending', async () => {
  const event = await paid({ paymentWindowHours: 72 })
  const cat = event.categoryIds[0]
  const out = await teamOk(event)
  assert.equal(out.status, 'pending')
  assert.equal(out.total, 24000)
  assert.deepEqual(out.amounts, { entryTotal: 24000, extrasTotal: 0, donation: 0, total: 24000 })
  const order = await orderOf(out.orderId)
  assert.equal(order.status, 'pending')
  assert.equal(order.entry_total, 24000)
  assert.equal(order.total, 24000)
  assert.equal(order.tier_id, event.tierId)
  assert.equal(order.buyer_name, 'Ola Leśna')
  const hours = (new Date(order.expires_at) - Date.now()) / 3600e3
  assert.ok(hours > 71.9 && hours <= 72, String(hours))
  assert.equal(new Date(out.expiresAt).getTime(), new Date(order.expires_at).getTime())

  const lines = await rows('order_lines', { order_id: out.orderId })
  assert.equal(lines.length, 1)
  assert.equal(lines[0].kind, 'entry')
  assert.equal(lines[0].amount, 24000)
  assert.equal(lines[0].registration_id, out.registrations[0].id)
  assert.equal(lines[0].tier_label, 'do zamknięcia zapisów')
  assert.equal(lines[0].tier_ends_on, null)

  const regs = byIndex(out, await registrationsOf(out.orderId))
  assert.deepEqual(regs.map((r) => r.status), Array(4).fill('pending_payment'))
  assert.deepEqual(regs.map((r) => r.price), [24000, 0, 0, 0])
  assert.deepEqual(regs.map((r) => r.list_price), [24000, 0, 0, 0])
  assert.equal(await taken(cat), 0)
  assert.equal((await participantsOf(regs.map((r) => r.id))).length, 0)
})

test('T-23 the payment lands → 4 participants, one slot', async () => {
  const event = await paid()
  const cat = event.categoryIds[0]
  const out = await paying(event)
  assert.equal((await confirmOk(out.orderId, out.att.txn, out.total)).outcome, 'confirmed')
  const regs = await registrationsOf(out.orderId)
  assert.deepEqual(regs.map((r) => r.status), Array(4).fill('confirmed'))
  assert.equal((await participantsOf(regs.map((r) => r.id))).length, 4)
  assert.equal(await taken(cat), 1)
})

test('T-23 a pending order expires → taken unchanged, the name free', async () => {
  const event = await paid()
  const cat = event.categoryIds[0]
  const out = await teamOk(event)
  await expireNow(out.orderId)
  assert.equal(await taken(cat), 0)
  assert.ok((await one('teams', { id: out.teamId })).released_at)
})

test('T-23 a payment on a still-pending team, the competition full → late_refund full, nobody confirmed, no participant', async () => {
  const event = await paid({ capacity: 1 })
  const cat = event.categoryIds[0]
  const winner = await paying(event)
  const loser = await paying(event)
  assert.equal((await confirmOk(winner.orderId, winner.att.txn, winner.total)).outcome, 'confirmed')
  assert.equal(await taken(cat), 1)

  const r = await confirmOk(loser.orderId, loser.att.txn, loser.total)
  assert.equal(r.outcome, 'late_refund')
  assert.equal(r.refund.reason, 'full')
  assert.equal(await taken(cat), 1)
  const regs = await registrationsOf(loser.orderId)
  assert.deepEqual(regs.map((x) => x.status), Array(4).fill('cancelled'))
  assert.equal((await participantsOf(regs.map((x) => x.id))).length, 0)
  assert.equal((await orderOf(loser.orderId)).status, 'cancelled')
  assert.ok((await one('teams', { id: loser.teamId })).released_at, 'the name is free')
  const refunds = await rows('refunds', { order_id: loser.orderId })
  assert.equal(refunds.length, 1)
  assert.equal(refunds[0].amount, 24000)
})

test('T-23 a late payment with a free slot → late_confirmed, one slot, the name back', async () => {
  const event = await paid()
  const cat = event.categoryIds[0]
  const out = await paying(event)
  await expireNow(out.orderId)
  assert.equal((await confirmOk(out.orderId, out.att.txn, out.total)).outcome, 'late_confirmed')
  assert.equal(await taken(cat), 1)
  assert.equal((await one('teams', { id: out.teamId })).released_at, null)
  assert.equal((await participantsOf((await registrationsOf(out.orderId)).map((r) => r.id))).length, 4)
})

test('T-23 a late payment with the slot gone → late_refund full, taken unchanged', async () => {
  const event = await paid({ capacity: 1 })
  const cat = event.categoryIds[0]
  const late = await paying(event)
  await expireNow(late.orderId)
  const other = await paying(event)
  await confirmOk(other.orderId, other.att.txn, other.total)
  const r = await confirmOk(late.orderId, late.att.txn, late.total)
  assert.equal(r.outcome, 'late_refund')
  assert.equal(r.refund.reason, 'full')
  assert.equal(await taken(cat), 1)
  assert.equal((await participantsOf((await registrationsOf(late.orderId)).map((x) => x.id))).length, 0)
  assert.equal((await orderOf(late.orderId)).status, 'expired')
})

const editCompetition = async (cat, values) => {
  const { error } = await db().from('competitions').update(values).eq('category_id', cat)
  assert.ifError(error)
}

/** The order expires, the organizer edits a competition no longer in use, then the money lands. */
async function latePaymentAfter(values, opts) {
  const event = await paid()
  const cat = event.categoryIds[0]
  const out = await paying(event, opts)
  await expireNow(out.orderId)
  await editCompetition(cat, values)
  const r = await confirmOk(out.orderId, out.att.txn, out.total)
  assert.equal(r.outcome, 'late_refund', JSON.stringify(r))
  assert.equal(r.refund.reason, 'unavailable')
  assert.equal(await taken(cat), 0)
  const regs = await registrationsOf(out.orderId)
  assert.ok(regs.every((x) => x.status === 'expired'), JSON.stringify(regs.map((x) => x.status)))
  assert.equal((await participantsOf(regs.map((x) => x.id))).length, 0)
  assert.equal((await orderOf(out.orderId)).status, 'expired')
  assert.ok((await one('teams', { id: out.teamId })).released_at)
  assert.equal((await rows('refunds', { order_id: out.orderId })).length, 1)
}

test('T-23 a late payment on a team whose competition became individual → refunded, not confirmed', async () => {
  await latePaymentAfter({ kind: 'individual', team_min: null, team_max: null })
})

test('T-23 a late payment on a team the new size no longer allows → refunded, not confirmed', async () => {
  await latePaymentAfter({ team_max: 3 })
  await latePaymentAfter({ team_min: 5, team_max: 6 })
})

test('T-23 a late payment with the size unchanged, or changed but still allowing the squad, confirms', async () => {
  const event = await paid()
  const cat = event.categoryIds[0]
  const out = await paying(event)
  await expireNow(out.orderId)
  await editCompetition(cat, { team_min: 3, team_max: 4 })
  assert.equal((await confirmOk(out.orderId, out.att.txn, out.total)).outcome, 'late_confirmed')
  assert.equal(await taken(cat), 1)
})

test('T-23 past its window but not yet expired, the same refusal, and the order is cancelled', async () => {
  const event = await paid()
  const cat = event.categoryIds[0]
  const out = await paying(event)
  await overdue(out.orderId)
  await editCompetition(cat, { team_max: 3 })
  const r = await confirmOk(out.orderId, out.att.txn, out.total)
  assert.equal(r.outcome, 'late_refund')
  assert.equal(r.refund.reason, 'unavailable')
  assert.equal((await orderOf(out.orderId)).status, 'cancelled')
  assert.equal(await taken(cat), 0)
})

test('T-23 a late individual payment into a competition that became a team one → refunded', async () => {
  const event = await paid({ competitions: [BIEG(50)], prices: { 'Bieg 9 km': 6000 } })
  const cat = event.categoryIds[0]
  const out = await orderGroupOk(event, [adult(cat, 'self')])
  const att = await attemptFor(out.orderId, out.total)
  await expireNow(out.orderId)
  await editCompetition(cat, { kind: 'team', team_min: 2, team_max: 6 })
  const r = await confirmOk(out.orderId, att.txn, out.total)
  assert.equal(r.outcome, 'late_refund', JSON.stringify(r))
  assert.equal(r.refund.reason, 'unavailable')
  assert.equal(await taken(cat), 0)
})

test('T-23 a paid team into a competition the confirmed teams fill → full, no team', async () => {
  const event = await paid({ capacity: 1 })
  const cat = event.categoryIds[0]
  const first = await paying(event)
  await confirmOk(first.orderId, first.att.txn, first.total)
  refused(await createTeam(event), 'full')
  assert.equal((await teamsIn(cat)).length, 1)
})

test('T-23 a 0 zł fee on a paid event → a paid order with its line, confirmed, one slot (D5-23)', async () => {
  const event = await paid({ price: 0 })
  const cat = event.categoryIds[0]
  const out = await teamOk(event, { displayed: 0 })
  assert.equal(out.status, 'confirmed')
  assert.ok(out.orderId)
  assert.equal(out.total, 0)
  const order = await orderOf(out.orderId)
  assert.equal(order.status, 'paid')
  assert.ok(order.paid_at)
  assert.equal((await rows('order_lines', { order_id: out.orderId })).length, 1)
  assert.equal(await taken(cat), 1)
  const regs = await registrationsOf(out.orderId)
  assert.deepEqual(regs.map((r) => r.status), Array(4).fill('confirmed'))
  assert.equal((await participantsOf(regs.map((r) => r.id))).length, 4)
})

// ---------------------------------------------------------------- T-24

test('T-24 the displayed total must be the fee', async () => {
  const event = await paid()
  refused(await createTeam(event, { displayed: 23999 }), 'price_changed:24000')
  assert.equal((await teamsIn(event.categoryIds[0])).length, 0)
  const freeEvent = await free()
  refused(await createTeam(freeEvent, { displayed: 100 }), 'price_changed:0')
})

test('T-24 an individual competition → not_team, even while it is closed', async () => {
  const event = await free({ competitions: [BIEG(50)] })
  refused(await createTeam(event), 'not_team')
  await setSettings(event.eventId, { closes_at: minutesFromNow(-1) })
  refused(await createTeam(event), 'not_team')
})

test('T-24 consents must be the event\'s exactly, the image acceptance included', async () => {
  const event = await free()
  const { data } = await db().from('event_consents').select('id, kind').eq('event_id', event.eventId)
  const noImage = data.filter((c) => c.kind !== 'image').map((c) => c.id)
  assert.equal(noImage.length, data.length - 1)
  refused(await createTeam(event, { meta: await groupMeta(event.eventId, { consentIds: noImage }) }), 'consents_changed')
  assert.equal(await taken(event.categoryIds[0]), 0)
})

test('T-24 size outside team_min / team_max → team_size', async () => {
  const event = await free({ competitions: [STAFETA(5, { teamMin: 3, teamMax: 4 })] })
  const cat = event.categoryIds[0]
  const of = (n) => [captain(), ...Array.from({ length: n - 1 }, () => adult(cat, 'adult'))]
  refused(await createTeam(event, { members: of(2) }), 'team_size')
  refused(await createTeam(event, { members: of(5) }), 'team_size')
  await teamOk(event, { members: of(3) })
  await teamOk(event, { members: of(4) })
})

test('T-24 the event checks: not open, closed, hidden, paying_closed, not_found', async () => {
  const closed = await free()
  await setSettings(closed.eventId, { opens_at: minutesFromNow(60) })
  refused(await createTeam(closed), 'not_open')
  await setSettings(closed.eventId, { opens_at: minutesFromNow(-60), closes_at: minutesFromNow(-1) })
  refused(await createTeam(closed), 'closed')

  const hidden = await free()
  await db().from('competitions').update({ hidden_at: new Date().toISOString() }).eq('category_id', hidden.categoryIds[0])
  refused(await createTeam(hidden), 'closed')

  const late = await paid()
  await setSettings(late.eventId, { closes_at: minutesFromNow(30) })
  refused(await createTeam(late), 'paying_closed')
  // A free event pays nothing, so the last hour stays open.
  const lateFree = await free()
  await setSettings(lateFree.eventId, { closes_at: minutesFromNow(30) })
  await teamOk(lateFree)

  refused(await createTeam(closed, { categoryId: '00000000-0000-4000-8000-00000000dead' }), 'not_found')
})

test('T-24 the buyer is the account: session_required, invalid_buyer_email, invalid_people', async () => {
  const event = await paid()
  const cat = event.categoryIds[0]
  refused(await createTeam(event, { profileId: null }), 'session_required')
  refused(await createTeam(event, { buyerEmail: 'ktos-inny@test.local', profileId: await profileFor(runnerEmail('other')) }), 'invalid_buyer_email')
  // Member 0 is the captain, and the captain is the account.
  const notFirst = squad(cat)
  refused(await createTeam(event, { members: [notFirst[1], notFirst[0], notFirst[2]], buyerEmail: notFirst[0].email }), 'invalid_people')
  refused(await createTeam(event, { members: [captain(), captain()], buyerEmail: undefined }), 'invalid_people')
  const someone = captain()
  refused(await createTeam(event, { members: [someone, adult(cat, 'adult')], buyerEmail: runnerEmail('b') }), 'invalid_people')
  for (const members of [[], 'x']) {
    refused(await createTeam(event, { members, buyerEmail: runnerEmail('b') }), 'invalid_people')
  }
})

test('T-24 with leg order on, the legs must be 1…n', async () => {
  const event = await free({ legOrder: true })
  const cat = event.categoryIds[0]
  const withLegs = (legs) => squad(cat).slice(0, legs.length).map((m, i) => ({ ...m, leg: legs[i] }))
  for (const legs of [[1, 1, 3], [1, 2, 4], [0, 1, 2], [1, 2, null]]) {
    refused(await createTeam(event, { members: withLegs(legs) }), 'invalid_people')
  }
  await teamOk(event, { members: withLegs([3, 1, 2]) })
})

test('T-24 no price, an amount over the limit', async () => {
  const noPrice = await paid()
  await db().from('competition_prices').delete().eq('category_id', noPrice.categoryIds[0])
  refused(await createTeam(noPrice), 'no_price')
  const huge = await paid({ price: 100000000 })
  refused(await createTeam(huge), 'invalid_amount:total')
})

test('T-24 two pending orders per account and event, across team and individual orders', async () => {
  const event = await paid({
    competitions: [STAFETA(10), BIEG(10)], prices: { Sztafeta: 24000, 'Bieg 9 km': 6000 },
  })
  const team = event.categoryIds.find((c) => event.prices[c] === 24000)
  const bieg = event.categoryIds.find((c) => event.prices[c] === 6000)
  const buyer = runnerEmail('captain')
  const members = () => [captain(buyer), adult(team, 'adult')]
  await orderGroupOk(event, [adult(bieg, 'adult')], { buyerEmail: buyer })
  await teamOk(event, { categoryId: team, members: members() })
  await orderGroupOk(event, [adult(bieg, 'adult')], { buyerEmail: buyer }).then(
    () => assert.fail('a third order'), (e) => assert.match(e.message, /too_many_pending/))
  const extra = await createTeam(event, { categoryId: team, members: [captain(buyer), adult(team, 'adult')] })
  refused(extra, 'too_many_pending')
})

test('T-24 a tiered event: the fee and the snapshot are the current tier\'s', async () => {
  const event = await paid()
  const cat = event.categoryIds[0]
  const endsOn = new Date(Date.now() + 7 * 86400e3).toISOString().slice(0, 10)
  const { data: early, error } = await db().from('price_tiers')
    .insert({ event_id: event.eventId, ends_on: endsOn, sort_order: 0 }).select('id').single()
  assert.ifError(error)
  await db().from('competition_prices').insert({ category_id: cat, tier_id: early.id, amount: 18000 })
  refused(await createTeam(event), 'price_changed:18000')
  const out = await teamOk(event, { displayed: 18000 })
  assert.equal((await orderOf(out.orderId)).tier_id, early.id)
  const [line] = await rows('order_lines', { order_id: out.orderId })
  assert.equal(line.amount, 18000)
  assert.equal(line.tier_ends_on, endsOn)
  assert.match(line.tier_label, /^do \d\d\.\d\d\.\d{4}$/)
})

test('T-24 payment_window_until_close: the order runs to closes_at', async () => {
  const event = await paid()
  const closes = minutesFromNow(240)
  await setSettings(event.eventId, { payment_window_until_close: true, closes_at: closes })
  const out = await teamOk(event)
  assert.equal(new Date(out.expiresAt).getTime(), new Date(closes).getTime())
})

test('T-24 nobody but service_role runs it; the price helpers run for nobody', async () => {
  const fn = 'public.create_team_registration(uuid, text, jsonb, uuid, text, integer, jsonb)'
  for (const role of ['anon', 'authenticated']) {
    const [{ allowed }] = await sql()`SELECT has_function_privilege(${role}, ${fn}, 'EXECUTE') AS allowed`
    assert.equal(allowed, false, `${role} may execute it`)
  }
  const [{ allowed }] = await sql()`SELECT has_function_privilege('service_role', ${fn}, 'EXECUTE') AS allowed`
  assert.equal(allowed, true)
  const [def] = await sql()`SELECT prosecdef, proconfig FROM pg_proc WHERE oid = ${fn}::regprocedure`
  assert.equal(def.prosecdef, true)
  assert.deepEqual(def.proconfig, ['search_path=""'])
  for (const helper of ['public.registration_current_tier(uuid)', 'public.registration_current_price(uuid)']) {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      const [{ can }] = await sql()`SELECT has_function_privilege(${role}, ${helper}, 'EXECUTE') AS can`
      assert.equal(can, false, `${role} may execute ${helper}`)
    }
  }
})

// ---------------------------------------------------------------- T-26 (D5-12)

const individual = (cat, email = runnerEmail('solo')) => ({ categoryId: cat, role: 'self', ...person(email) })

test('T-26 an individual registration in a team competition is refused by register_free, nothing claimed', async () => {
  const event = await free()
  const cat = event.categoryIds[0]
  const email = runnerEmail('solo')
  refused(await registerGroup(event, [adult(cat, 'self', email)]), 'team_competition')
  const legacy = await rpc('register_free', {
    p_category_id: cat, p_people: [person(email)], p_profile_id: await profileFor(email), p_meta: await groupMeta(event.eventId),
  })
  refused(legacy, 'team_competition')
  assert.equal(await taken(cat), 0)
  assert.equal((await rows('registrations', { category_id: cat })).length, 0)
})

test('T-26 an individual order in a team competition is refused by create_order, nothing written', async () => {
  const event = await paid()
  const cat = event.categoryIds[0]
  const email = runnerEmail('solo')
  const r = await rpc('create_order', {
    p_people: [individual(cat, email)], p_profile_id: await profileFor(email), p_buyer_email: email,
    p_displayed_total: 24000, p_meta: await groupMeta(event.eventId),
  })
  refused(r, 'team_competition')
  const legacy = await rpc('create_order', {
    p_category_id: cat, p_people: [person(email)], p_profile_id: await profileFor(email), p_buyer_email: email,
    p_displayed_total: 24000, p_meta: await groupMeta(event.eventId),
  })
  refused(legacy, 'team_competition')
  assert.equal((await rows('orders', { event_id: event.eventId })).length, 0)
})

test('T-26 register-free and create-order answer 409 team_competition', async () => {
  const email = runnerEmail('solo')
  const session = await sessionFor(email)
  const freeEvent = await free()
  const body = async (event) => ({
    people: [{ categoryId: event.categoryIds[0], person: { ...person(email), phone: '600100200', ageGroupLabel: undefined } }],
    acceptedConsentIds: await consentIds(event.eventId), serviceRegulamin: true,
  })
  const a = await callFn('register-free', session, await body(freeEvent))
  assert.equal(a.status, 409, JSON.stringify(a.body))
  assert.equal(a.body.code, 'team_competition')
  assert.equal(a.body.error, 'W tej konkurencji startują tylko drużyny.')
  assert.equal(await taken(freeEvent.categoryIds[0]), 0)

  const paidEvent = await paid()
  const b = await callFn('create-order', session, { ...await body(paidEvent), displayedTotal: 24000 })
  assert.equal(b.status, 409, JSON.stringify(b.body))
  assert.equal(b.body.code, 'team_competition')
  assert.equal((await rows('orders', { event_id: paidEvent.eventId })).length, 0)
})

// ---------------------------------------------------------------- T-27

test('T-27 the team name index agrees with teamNameKey on composed and decomposed text', async () => {
  const event = await free()
  const cat = event.categoryIds[0]
  const insert = (name) => db().from('teams').insert({ event_id: event.eventId, category_id: cat, name })
  const nfc = 'Zażółć Gęślą Jaźń'
  assert.equal(teamNameKey(nfc), teamNameKey(nfc.normalize('NFD')))
  assert.equal((await insert(nfc)).error, null)
  assert.equal((await insert(nfc.normalize('NFD'))).error?.code, '23505')
  assert.equal((await insert(`${nfc} 2`.normalize('NFD'))).error, null)
  assert.equal((await insert(`${nfc} 2`)).error?.code, '23505')
  // The whitespace class survives the rebuild.
  assert.equal((await insert('Rysie Górskie')).error, null)
  assert.equal((await insert('\u00a0rysie\u3000górskie\ufeff')).error?.code, '23505')
})

test('T-23 past its window but not yet expired, a team still confirms; a replay changes nothing', async () => {
  const event = await paid()
  const out = await paying(event)
  await overdue(out.orderId)
  const first = await confirm(out.orderId, out.att.txn, out.total)
  assert.equal(first.error, null)
  assert.equal(first.data.outcome, 'confirmed')
  const replay = await confirm(out.orderId, out.att.txn, out.total)
  assert.equal(replay.data.outcome, 'already_confirmed')
  assert.equal(await taken(event.categoryIds[0]), 1)
})
