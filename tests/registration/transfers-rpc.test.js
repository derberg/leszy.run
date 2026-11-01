// Plan 7, task 6: handing a package to another person. Scenarios V-40…V-46, V-48 and V-49 in
// docs/registration/scenario-matrix.md; the races are in transfers-concurrency.test.js. A transfer
// keeps the slot and the money: nothing is claimed, freed or paid (P3-R15, ruling 1, D7-14). The
// voucher stays used, the lines follow, and a captain's team never lets go of its name. LOCAL stack
// only.
import { after, afterEach, before, test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import postgres from 'postgres'
import { localEnv, resetThrottle, sessionFor } from './helpers/stack.js'
import { acceptAgreement, createPublishedFreeEvent, createPublishedPaidEvent } from './helpers/registrationFixtures.js'
import {
  attemptFor, competitionOf, confirm, db, minutesFromNow, one, orderOf, profileFor, registrationsOf, rows, rpc,
  runnerEmail, setSettings,
} from './helpers/orders.js'
import { BIEG, DZIECI, adult, minor, orderGroup, orderGroupOk, registerGroup } from './helpers/groups.js'
import { captain, paidTeamEvent, setLegOrder, STAFETA, teamOk } from './helpers/teams.js'
import { makeExtra, makePartner, makeVoucher, setTiers, vouchersMade, warsawDay } from './helpers/cart.js'
import {
  META, accept, consentOf, dayBefore, enableTransfers, freeEntry, hashToken, invite, inviteOk, newToken,
  organizerTransfer, paidEntry,
} from './helpers/transfers.js'
import { assertVoucherInvariant } from './helpers/voucherInvariant.js'
import { assertSlotInvariant } from './helpers/slotInvariant.js'
import { warsawDayAfter, warsawDayStart } from '../../supabase/functions/_shared/registration/dates.js'

const BIEG_5 = (capacity = 50) =>
  ({ name: 'Bieg 5 km', discipline: 'run', distanceLabel: '5 km', startTime: '11:00', capacity })

let owner, ownerId, sqlClient
const sql = () => (sqlClient ??= postgres(localEnv().dbUrl, { max: 1, onnotice: () => {} }))
const competitionsSeen = new Set()
const seen = (event) => { event.categoryIds.forEach((c) => competitionsSeen.add(c)); return event }

before(async () => {
  await resetThrottle()
  await acceptAgreement('zatyrani-test')
  owner = await sessionFor('owner@zatyrani-test.local')
  ownerId = await profileFor('owner@zatyrani-test.local')
})
after(async () => { if (sqlClient) await sqlClient.end() })
afterEach(async () => {
  const competitions = [...competitionsSeen]
  const vouchers = [...vouchersMade]
  competitionsSeen.clear()
  vouchersMade.clear()
  for (const id of competitions) await assertSlotInvariant(id)
  for (const id of vouchers) await assertVoucherInvariant(id)
})

const ok = (r) => { assert.equal(r.error, null, r.error?.message); return r.data }
const refused = (r, message) => { assert.equal(r.data, null); assert.equal(r.error?.message, message) }
const taken = async (categoryId) => (await competitionOf(categoryId)).taken
const reg = (id) => one('registrations', { id })

async function paidEvent(options = {}) {
  const event = seen(await createPublishedPaidEvent(owner, {
    competitions: [BIEG(), DZIECI()], prices: { 'Bieg 9 km': 6000, 'Bieg dzieci 1 km': 2000 }, ...options,
  }))
  await enableTransfers(event)
  return event
}
async function freeEvent(options = {}) {
  const event = seen(await createPublishedFreeEvent(owner, { competitions: [BIEG(), BIEG_5()], ...options }))
  await enableTransfers(event)
  return event
}

// ---------------------------------------------------------------- V-40 same competition

test('V-40 same competition: the package changes hands, the money, voucher, partner, lines and slot stay', async () => {
  const event = await paidEvent()
  const [cat] = event.categoryIds
  const partner = await makePartner(event.eventId)
  const voucher = await makeVoucher(event.eventId, { percent: 15, max_uses: 5, partner_id: partner.id })
  const { variants: { M } } = await makeExtra(event, { variants: [['M', 10]] })
  const a = await paidEntry(event, { voucher, variant: M, displayed: 5100 + 4500 })
  assert.equal(await taken(cat), 1)
  const oldParticipant = a.reg.participant_id
  assert.ok(oldParticipant)

  const t = await inviteOk(a.reg.id, a.profileId)
  assert.ok(new Date(t.expiresAt).getTime() === warsawDayAfter(dayBefore(event.eventDate)).getTime())
  const pending = await one('transfers', { id: t.transferId })
  assert.equal(pending.token_hash, t.hash)
  assert.equal(pending.fee, 0)
  assert.equal(JSON.stringify(pending).includes(t.token), false, 'the token itself is never stored')

  const email = runnerEmail('recipient')
  const out = ok(await accept(event, t.hash, { email, categoryId: cat }))
  assert.equal(out.senderProfileId, a.profileId)
  assert.equal(out.senderEmail, a.email)

  const old = await reg(a.reg.id)
  const fresh = await reg(out.registrationId)
  assert.equal(old.status, 'transferred_out')
  assert.equal(fresh.status, 'confirmed')
  for (const key of ['order_id', 'list_price', 'price', 'voucher_id', 'partner_id', 'category_id']) {
    assert.equal(fresh[key], old[key], key)
  }
  assert.equal(fresh.price, 5100)
  assert.equal(fresh.email, email)
  assert.equal(fresh.consent_state, 'accepted')
  const recipientId = await profileFor(email)
  assert.equal(fresh.profile_id, recipientId)
  assert.equal(fresh.registered_by_profile_id, recipientId)
  assert.equal(fresh.age_group_label, 'K open')

  const lines = await rows('order_lines', { order_id: a.orderId })
  assert.deepEqual(lines.map((l) => l.kind).sort(), ['entry', 'extra'])
  assert.ok(lines.every((l) => l.registration_id === fresh.id))

  assert.equal(await taken(cat), 1, 'the slot stays')
  assert.equal((await one('vouchers', { id: voucher.id })).used, 1)
  assert.equal((await one('extra_variants', { id: M.id })).sold, 1)
  assert.equal((await orderOf(a.orderId)).status, 'paid')

  const before = await one('participants', { id: oldParticipant })
  assert.ok(before.removed_at, 'the old participant left before closes_at')
  const part = await one('participants', { id: fresh.participant_id })
  assert.equal(part.bib_number, null)
  assert.equal(part.email, email)
  assert.equal(part.registration_id, fresh.id)

  const acceptances = await rows('consent_acceptances', { registration_id: fresh.id })
  assert.equal(acceptances.length, (await consentOf(event.eventId)).consentIds.length + 1)
  assert.ok(acceptances.every((c) => c.accepted_as === 'self' && c.accepted_by_profile_id === recipientId))
  assert.ok(acceptances.some((c) => c.consent_kind === 'service_regulamin' && c.ip === META.ip))

  const done = await one('transfers', { id: t.transferId })
  assert.equal(done.status, 'accepted')
  assert.equal(done.new_registration_id, fresh.id)
  assert.equal(done.accepted_by_profile_id, recipientId)
  assert.ok(done.accepted_at)
  assert.equal((await rows('operator_alerts', { order_id: a.orderId })).filter((x) => x.kind === 'host_withdraw').length, 0)

  refused(await accept(event, t.hash, { categoryId: cat }), 'gone')
})

test('V-40 a package can be handed on again: the voucher, the lines and the slot follow to the third holder', async () => {
  const event = await paidEvent()
  const [cat] = event.categoryIds
  const voucher = await makeVoucher(event.eventId, { percent: 15, max_uses: 1 })
  const a = await paidEntry(event, { voucher, displayed: 5100 })
  const t1 = await inviteOk(a.reg.id, a.profileId)
  const bEmail = runnerEmail('second')
  const b = ok(await accept(event, t1.hash, { email: bEmail }))
  const t2 = await inviteOk(b.registrationId, await profileFor(bEmail))
  const c = ok(await accept(event, t2.hash))
  assert.equal(await taken(cat), 1)
  assert.equal((await one('vouchers', { id: voucher.id })).used, 1)
  const [line] = await rows('order_lines', { order_id: a.orderId })
  assert.equal(line.registration_id, c.registrationId)
  assert.equal((await reg(b.registrationId)).status, 'transferred_out')
  assert.equal(c.senderEmail, bEmail)
})

test('V-40 a partly refunded entry: the refunded amount goes with the line, so a rejected refund lands on the new row', async () => {
  const event = await paidEvent()
  const a = await paidEntry(event)
  const [line] = await rows('order_lines', { order_id: a.orderId })
  const res = ok(await rpc('reserve_organizer_refund', {
    p_line_id: line.id, p_grosze: 1000, p_actor: ownerId, p_request_key: crypto.randomUUID(),
  }))
  const t = await inviteOk(a.reg.id, a.profileId)
  const out = ok(await accept(event, t.hash))
  assert.equal((await reg(out.registrationId)).refunded, 1000)
  assert.equal((await reg(a.reg.id)).refunded, 0)
  ok(await rpc('finish_organizer_refund', { p_refund_id: res.refundId, p_outcome: 'rejected' }))
  assert.equal((await reg(out.registrationId)).refunded, 0)
  assert.equal((await reg(out.registrationId)).status, 'confirmed')
})

test('V-40 a free entry with no order: 0 zł to 0 zł, nothing to move', async () => {
  const event = await freeEvent()
  const [a9, c5] = event.categoryIds
  const a = await freeEntry(event)
  const t = await inviteOk(a.reg.id, a.profileId)
  const out = ok(await accept(event, t.hash, { categoryId: c5 }))
  const fresh = await reg(out.registrationId)
  assert.equal(fresh.order_id, null)
  assert.equal(fresh.price, 0)
  assert.equal(fresh.category_id, c5)
  assert.deepEqual([await taken(a9), await taken(c5)], [0, 1])
})

// ---------------------------------------------------------------- V-41 a full target

test('V-41 into a full competition at the same price: accepted past the limit, later payers meet full', async () => {
  const event = await paidEvent({
    competitions: [BIEG(), BIEG_5(1)], prices: { 'Bieg 9 km': 6000, 'Bieg 5 km': 6000 },
  })
  const [c9, c5] = event.categoryIds
  const waiting = await orderGroupOk(event, [adult(c5, 'self')])
  const att = await attemptFor(waiting.orderId, waiting.total) // its payment started before the limit filled
  const a = await paidEntry(event)
  await paidEntry(event, { categoryId: c5 })
  assert.deepEqual([await taken(c9), await taken(c5)], [1, 1])

  const t = await inviteOk(a.reg.id, a.profileId)
  ok(await accept(event, t.hash, { categoryId: c5 }))
  assert.deepEqual([await taken(c9), await taken(c5)], [0, 2], 'taken = capacity + 1, no capacity check (§4.8)')

  const late = await orderGroup(event, [adult(c5, 'self')])
  assert.match(late.error?.message ?? '', /^full/)

  const paid = ok(await confirm(waiting.orderId, att.txn, waiting.total))
  assert.equal(paid.outcome, 'late_refund')
  assert.equal(paid.refund.reason, 'full')
  assert.equal((await orderOf(waiting.orderId)).status, 'cancelled')
  assert.equal(await taken(c5), 2)
})

// ---------------------------------------------------------------- V-42 same price

test('V-42 same price is the frozen tier: 60 zł in tier 1 goes where tier 1 said 60 zł, never to 20 zł', async () => {
  const event = await paidEvent({
    competitions: [BIEG(), BIEG_5(), DZIECI()],
    prices: { 'Bieg 9 km': 6000, 'Bieg 5 km': 6000, 'Bieg dzieci 1 km': 2000 },
  })
  const [c9, c5, cKids] = event.categoryIds
  const [tier1] = await setTiers(event.eventId, [
    { endsOn: warsawDay(0), prices: { [c9]: 6000, [c5]: 6000, [cKids]: 2000 } },
    { endsOn: null, prices: { [c9]: 7000, [c5]: 8000, [cKids]: 6000 } },
  ])
  const a = await paidEntry(event, { displayed: 6000 })
  const b = await paidEntry(event, { displayed: 6000 })
  // D7-3: crossing into tier 2 is tier 1 ending yesterday.
  assert.ifError((await db().from('price_tiers').update({ ends_on: warsawDay(-1) }).eq('id', tier1.id)).error)

  const ta = await inviteOk(a.reg.id, a.profileId)
  const out = ok(await accept(event, ta.hash, { categoryId: c5 }))
  assert.equal((await reg(out.registrationId)).list_price, 6000)

  const tb = await inviteOk(b.reg.id, b.profileId)
  // Tier 2 says 60 zł here, the frozen tier 1 said 20 zł.
  refused(await accept(event, tb.hash, { categoryId: cKids }), 'price_differs')
  assert.equal((await reg(b.reg.id)).status, 'confirmed')
  assert.equal((await one('transfers', { id: tb.transferId })).status, 'pending')
})

test('V-42 a competition with no price in the frozen tier and a hidden one are refused', async () => {
  const event = await paidEvent({
    competitions: [BIEG(), BIEG_5(), DZIECI()],
    prices: { 'Bieg 9 km': 6000, 'Bieg 5 km': 6000, 'Bieg dzieci 1 km': 6000 },
  })
  const [, c5, cKids] = event.categoryIds
  const a = await paidEntry(event)
  assert.ifError((await db().from('competition_prices').delete().eq('category_id', cKids)).error)
  const t = await inviteOk(a.reg.id, a.profileId)
  refused(await accept(event, t.hash, { categoryId: cKids }), 'price_differs')
  assert.ifError((await db().from('competitions').update({ hidden_at: new Date().toISOString() }).eq('category_id', c5)).error)
  refused(await accept(event, t.hash, { categoryId: c5 }), 'unavailable')
  refused(await accept(event, t.hash, { categoryId: '00000000-0000-4000-8000-000000000000' }), 'not_found')
})

// ---------------------------------------------------------------- V-43 the recipient's own entry

test('V-43 a recipient with a confirmed entry → duplicate, nothing changes', async () => {
  const event = await paidEvent()
  const a = await paidEntry(event)
  const b = await paidEntry(event)
  const t = await inviteOk(a.reg.id, a.profileId, b.email)
  refused(await accept(event, t.hash, { email: b.email }), 'duplicate')
  assert.equal((await reg(a.reg.id)).status, 'confirmed')
  assert.equal(await taken(event.categoryIds[0]), 2)
})

test('V-43 an unpaid entry alone in its order is replaced: the order goes, its code and shirt come back, no slot moves', async () => {
  const event = await paidEvent()
  const [cat] = event.categoryIds
  const voucher = await makeVoucher(event.eventId, { percent: 15, max_uses: 1 })
  const { variants: { M } } = await makeExtra(event, { variants: [['M', 1]] })
  const email = runnerEmail('recipient')
  const mine = await orderGroupOk(event, [{
    ...adult(cat, 'self', email), voucherCode: voucher.code, extras: [{ variantId: M.id, qty: 1 }],
  }], { displayed: 5100 + 4500 })
  const a = await paidEntry(event)
  assert.equal(await taken(cat), 1)
  assert.equal((await one('vouchers', { id: voucher.id })).used, 1)

  const t = await inviteOk(a.reg.id, a.profileId, email)
  const out = ok(await accept(event, t.hash, { email }))

  const cancelled = await orderOf(mine.orderId)
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.cancelled_reason, 'transfer_accepted')
  assert.ok((await registrationsOf(mine.orderId)).every((r) => r.status === 'cancelled'))
  assert.equal((await one('vouchers', { id: voucher.id })).used, 0)
  assert.equal((await one('extra_variants', { id: M.id })).sold, 0)
  assert.equal(await taken(cat), 1)
  assert.equal((await reg(out.registrationId)).email, email)
})

test('V-43 an unpaid entry inside a family order → pending_elsewhere, the order stays', async () => {
  const event = await paidEvent()
  const [cat] = event.categoryIds
  const email = runnerEmail('recipient')
  const family = await orderGroupOk(event, [adult(cat, 'self'), adult(cat, 'adult', email)])
  const a = await paidEntry(event)
  const t = await inviteOk(a.reg.id, a.profileId, email)
  refused(await accept(event, t.hash, { email }), 'pending_elsewhere')
  assert.equal((await orderOf(family.orderId)).status, 'pending')
  assert.equal((await reg(a.reg.id)).status, 'confirmed')
})

// ---------------------------------------------------------------- V-44 who may and when

test('V-44 a recipient under 18 on the race day → recipient_minor', async () => {
  const event = await freeEvent()
  const a = await freeEntry(event)
  const t = await inviteOk(a.reg.id, a.profileId)
  const eighteenth = new Date(`${event.eventDate}T00:00:00Z`)
  eighteenth.setUTCFullYear(eighteenth.getUTCFullYear() - 18)
  const dayOf = eighteenth.toISOString().slice(0, 10)
  const dayAfter = new Date(eighteenth.getTime() + 86_400_000).toISOString().slice(0, 10)
  refused(await accept(event, t.hash, { over: { birthDate: dayAfter } }), 'recipient_minor')
  ok(await accept(event, t.hash, { over: { birthDate: dayOf } }))
})

test('V-44 the sender cannot invite or accept for themself', async () => {
  const event = await freeEvent()
  const a = await freeEntry(event)
  refused((await invite(a.reg.id, a.profileId, `  ${a.email.toUpperCase()} `)).result, 'same_person')
  const t = await inviteOk(a.reg.id, a.profileId)
  refused(await accept(event, t.hash, { email: a.email }), 'same_person')
})

test('V-44 not the holder → not_owner; a child, a team member or a dead entry → not_transferable', async () => {
  const event = await freeEvent()
  const [cat] = event.categoryIds
  const a = await freeEntry(event)
  const stranger = await profileFor(runnerEmail('stranger'))
  refused((await invite(a.reg.id, stranger)).result, 'not_owner')

  const parent = runnerEmail('parent')
  const family = await registerGroup(event, [adult(cat, 'self', parent), minor(cat)])
  const child = family.data.registrations.find((r) => r.role === 'minor')
  refused((await invite(child.id, await profileFor(parent))).result, 'not_transferable')

  const teams = await paidTeamEvent(owner, { capacity: 50 })
  seen(teams)
  await enableTransfers(teams)
  const capEmail = runnerEmail('captain')
  const team = await teamOk(teams, { members: [captain(capEmail), adult(teams.categoryIds[0], 'adult')] })
  const att = await attemptFor(team.orderId, team.total)
  ok(await confirm(team.orderId, att.txn, team.total))
  const { captain_registration_id: capReg } = await one('teams', { id: team.teamId })
  const members = await rows('registrations', { team_id: team.teamId })
  const member = members.find((r) => r.id !== capReg)
  refused((await invite(member.id, await profileFor(capEmail))).result, 'not_transferable')

  const b = await freeEntry(event)
  ok(await rpc('cancel_registration', { p_registration_id: b.reg.id, p_reason: 'organizer', p_actor: ownerId }))
  refused((await invite(b.reg.id, b.profileId)).result, 'not_transferable')

  const pendingOrder = await paidEvent()
  const p = await orderGroupOk(pendingOrder, [adult(pendingOrder.categoryIds[0], 'self', runnerEmail('unpaid'))])
  const [unpaid] = await registrationsOf(p.orderId)
  refused((await invite(unpaid.id, unpaid.profile_id)).result, 'not_transferable')
})

test('V-44 transfers off, or past the last Warsaw day (the DST-safe instants of V-03) → transfer_off', async () => {
  const event = await freeEvent()
  const a = await freeEntry(event)
  await setSettings(event.eventId, { transfer_enabled: false })
  refused((await invite(a.reg.id, a.profileId)).result, 'transfer_off')
  await setSettings(event.eventId, { transfer_enabled: true, transfer_until: null })
  refused((await invite(a.reg.id, a.profileId)).result, 'transfer_off')

  // 2026-10-25 is the 25-hour day: its Warsaw day ends at 23:00 UTC.
  await setSettings(event.eventId, { transfer_until: '2026-10-25' })
  const last = '2026-10-25T22:59:59.999Z'
  const first = '2026-10-25T23:00:00.000Z'
  refused((await invite(a.reg.id, a.profileId, undefined, { now: first })).result, 'transfer_off')
  const t = await inviteOk(a.reg.id, a.profileId, undefined, { now: last })
  assert.equal(new Date(t.expiresAt).toISOString(), first)
})

test('V-44 the link dies at expires_at: 1 ms before it works, at it → gone', async () => {
  const event = await freeEvent()
  const consent = await consentOf(event.eventId)
  const a = await freeEntry(event)
  const person = (email) => ({ firstName: 'Ala', lastName: 'Bór', birthDate: '1990-01-01', gender: 'K', email, phone: '+48500100200' })

  const atExpiry = await inviteOk(a.reg.id, a.profileId)
  const email = runnerEmail('recipient')
  const profile = await profileFor(email)
  await assert.rejects(sql().begin(async (tx) => {
    await tx`update public.transfers set expires_at = now() where id = ${atExpiry.transferId}`
    await tx`select public.accept_transfer(${atExpiry.hash}, ${tx.json(person(email))}, ${event.categoryIds[0]},
      ${profile}, ${tx.json(consent)}, ${tx.json(META)})`
  }), /gone/)
  assert.equal((await reg(a.reg.id)).status, 'confirmed')

  // A rolled-back transaction left it pending, so the same invite is the one that succeeds.
  await sql().begin(async (tx) => {
    await tx`update public.transfers set expires_at = now() + interval '1 millisecond' where id = ${atExpiry.transferId}`
    await tx`select public.accept_transfer(${atExpiry.hash}, ${tx.json(person(email))}, ${event.categoryIds[0]},
      ${profile}, ${tx.json(consent)}, ${tx.json(META)})`
  })
  assert.equal((await reg(a.reg.id)).status, 'transferred_out')
})

test('V-44 consents: a stale list, no service regulamin or another account are refused', async () => {
  const event = await freeEvent()
  const a = await freeEntry(event)
  const t = await inviteOk(a.reg.id, a.profileId)
  const consent = await consentOf(event.eventId)
  refused(await accept(event, t.hash, { consent: { ...consent, consentIds: consent.consentIds.slice(1) } }), 'consents_changed')
  refused(await accept(event, t.hash, { consent: { consentIds: consent.consentIds } }), 'consents_required')
  refused(await accept(event, t.hash, { profileId: a.profileId }), 'profile_mismatch')
  refused(await accept(event, t.hash, { over: { firstName: '  ' } }), 'invalid_person')
  assert.equal((await reg(a.reg.id)).status, 'confirmed')
})

test('V-44 one pending invite per entry; a used hash never matches another', async () => {
  const event = await freeEvent()
  const a = await freeEntry(event)
  const t = await inviteOk(a.reg.id, a.profileId)
  refused((await invite(a.reg.id, a.profileId)).result, 'pending_exists')
  ok(await rpc('cancel_transfer', { p_transfer_id: t.transferId, p_actor: a.profileId }))
  await inviteOk(a.reg.id, a.profileId)
  refused(await accept(event, hashToken(newToken())), 'gone')
  refused((await rpc('create_transfer', {
    p_registration_id: a.reg.id, p_actor: a.profileId, p_to_email: runnerEmail('x'), p_token_hash: 'short',
  })), 'invalid_token')
})

test('V-44 cancel_transfer: the sender only, true once, then the link is gone', async () => {
  const event = await freeEvent()
  const a = await freeEntry(event)
  const t = await inviteOk(a.reg.id, a.profileId)
  refused(await rpc('cancel_transfer', { p_transfer_id: t.transferId, p_actor: await profileFor(runnerEmail('x')) }), 'not_owner')
  assert.equal(ok(await rpc('cancel_transfer', { p_transfer_id: t.transferId, p_actor: a.profileId })), true)
  assert.equal(ok(await rpc('cancel_transfer', { p_transfer_id: t.transferId, p_actor: a.profileId })), false)
  const row = await one('transfers', { id: t.transferId })
  assert.equal(row.status, 'cancelled')
  assert.ok(row.cancelled_at)
  refused(await accept(event, t.hash), 'gone')
  assert.equal((await reg(a.reg.id)).status, 'confirmed')
})

// ---------------------------------------------------------------- V-45 a team captain

test('V-45 a captain hands over: the team stays live, the captain role and the fee line move, leg and place too', async () => {
  const event = seen(await paidTeamEvent(owner, { capacity: 50, legOrder: true }))
  await enableTransfers(event)
  const [cat] = event.categoryIds
  const capEmail = runnerEmail('captain')
  const team = await teamOk(event, { members: [{ ...captain(capEmail), leg: 1 }, { ...adult(cat, 'adult'), leg: 2 }] })
  const att = await attemptFor(team.orderId, team.total)
  ok(await confirm(team.orderId, att.txn, team.total))
  const before = await one('teams', { id: team.teamId })
  const oldCaptain = await reg(before.captain_registration_id)
  assert.equal(oldCaptain.team_leg, 1)

  const t = await inviteOk(before.captain_registration_id, await profileFor(capEmail))
  const out = ok(await accept(event, t.hash, { categoryId: cat }))

  const after = await one('teams', { id: team.teamId })
  assert.equal(after.released_at, null)
  assert.equal(after.captain_registration_id, out.registrationId)
  assert.equal(after.name, before.name)
  const fresh = await reg(out.registrationId)
  assert.equal(fresh.team_id, team.teamId)
  assert.equal(fresh.team_leg, 1)
  assert.equal(fresh.team_position, oldCaptain.team_position)
  assert.equal((await reg(oldCaptain.id)).status, 'transferred_out')
  const [line] = (await rows('order_lines', { order_id: team.orderId })).filter((l) => l.kind === 'entry')
  assert.equal(line.registration_id, fresh.id)
  assert.equal(await taken(cat), 1)
})

test('V-45 a team stays in its competition; an individual entry cannot enter a team competition', async () => {
  const event = seen(await paidTeamEvent(owner, {
    competitions: [STAFETA(50), STAFETA(50, { name: 'Sztafeta B' }), BIEG()],
    prices: { Sztafeta: 6000, 'Sztafeta B': 6000, 'Bieg 9 km': 6000 },
  }))
  await enableTransfers(event)
  const [cat, other, solo] = event.categoryIds
  const capEmail = runnerEmail('captain')
  const team = await teamOk(event, { members: [captain(capEmail), adult(cat, 'adult')] })
  const att = await attemptFor(team.orderId, team.total)
  ok(await confirm(team.orderId, att.txn, team.total))
  const { captain_registration_id: capReg } = await one('teams', { id: team.teamId })
  const t = await inviteOk(capReg, await profileFor(capEmail))
  refused(await accept(event, t.hash, { categoryId: other }), 'team_competition')

  const a = await paidEntry(event, { categoryId: solo })
  const ta = await inviteOk(a.reg.id, a.profileId)
  refused(await accept(event, ta.hash, { categoryId: other }), 'team_competition')
})

test('V-45 a leg-order team whose member legs are unchanged keeps one live row per leg', async () => {
  const event = seen(await paidTeamEvent(owner, { capacity: 50 }))
  await setLegOrder(event.categoryIds[0])
  await enableTransfers(event)
  const [cat] = event.categoryIds
  const capEmail = runnerEmail('captain')
  const team = await teamOk(event, { members: [{ ...captain(capEmail), leg: 2 }, { ...adult(cat, 'adult'), leg: 1 }] })
  const att = await attemptFor(team.orderId, team.total)
  ok(await confirm(team.orderId, att.txn, team.total))
  const { captain_registration_id: capReg } = await one('teams', { id: team.teamId })
  const t = await inviteOk(capReg, await profileFor(capEmail))
  ok(await accept(event, t.hash, { categoryId: cat }))
  const live = (await rows('registrations', { team_id: team.teamId })).filter((r) => r.status === 'confirmed')
  assert.deepEqual(live.map((r) => r.team_leg).sort(), [1, 2])
})

// ---------------------------------------------------------------- V-46 after closes_at

test('V-46 after closes_at: the host keeps the old row untouched, one alert names the bib, the new runner arrives with none', async () => {
  const event = await paidEvent()
  const a = await paidEntry(event)
  const t = await inviteOk(a.reg.id, a.profileId)
  assert.ifError((await db().from('participants').update({ bib_number: 77 }).eq('id', a.reg.participant_id)).error)
  await setSettings(event.eventId, { closes_at: minutesFromNow(-1) })
  const xmin = async () => (await sql()`select xmin::text from public.participants where id = ${a.reg.participant_id}`)[0].xmin
  const before = await xmin()

  const out = ok(await accept(event, t.hash))

  assert.equal(await xmin(), before)
  const old = await one('participants', { id: a.reg.participant_id })
  assert.equal(old.removed_at, null)
  assert.equal(old.bib_number, 77)
  const alerts = (await rows('operator_alerts', { order_id: a.orderId })).filter((x) => x.kind === 'host_withdraw')
  assert.equal(alerts.length, 1)
  assert.deepEqual(alerts[0].payload, { reason: 'transfer', registrationId: a.reg.id, eventId: event.eventId, bib: 77 })
  const fresh = await reg(out.registrationId)
  const part = await one('participants', { id: fresh.participant_id })
  assert.equal(part.bib_number, null)
})

// ---------------------------------------------------------------- V-48 the organizer

test('V-48 organizer_transfer: refused from the first instant of the race day, the instant before it works', async () => {
  const event = await freeEvent()
  const a = await freeEntry(event)
  const start = warsawDayStart(event.eventDate)
  refused(await organizerTransfer(event, a.reg.id, ownerId, { now: start.toISOString() }), 'race_day')
  const before = new Date(start.getTime() - 1).toISOString()
  ok(await organizerTransfer(event, a.reg.id, ownerId, { now: before }))
  assert.equal((await reg(a.reg.id)).status, 'transferred_out')
})

test('V-48 organizer_transfer after transfer_until: awaiting consent, a pending invite dies, the record stays', async () => {
  const event = await paidEvent()
  const a = await paidEntry(event)
  const t = await inviteOk(a.reg.id, a.profileId)
  await setSettings(event.eventId, { transfer_until: warsawDay(-1) })
  const email = runnerEmail('typed')
  const out = ok(await organizerTransfer(event, a.reg.id, ownerId, { email }))
  assert.equal(out.consentState, 'awaiting')

  const fresh = await reg(out.registrationId)
  assert.equal(fresh.consent_state, 'awaiting')
  assert.equal(fresh.status, 'confirmed')
  assert.equal(fresh.registered_by_profile_id, ownerId)
  assert.equal(fresh.profile_id, null)
  assert.deepEqual(await rows('consent_acceptances', { registration_id: fresh.id }), [])
  assert.equal((await one('participants', { id: a.reg.participant_id })).removed_at !== null, true)

  const invite1 = await one('transfers', { id: t.transferId })
  assert.equal(invite1.status, 'cancelled')
  refused(await accept(event, t.hash), 'gone')
  const record = await one('transfers', { id: out.transferId })
  assert.equal(record.kind, 'organizer')
  assert.equal(record.status, 'accepted')
  assert.equal(record.to_email, email)
  assert.equal(record.token_hash, null)
  assert.equal(record.new_registration_id, fresh.id)
})

test('V-48 organizer_transfer keeps every recipient rule', async () => {
  const event = await paidEvent()
  const [cat, kids] = event.categoryIds
  const a = await paidEntry(event)
  const b = await paidEntry(event)
  refused(await organizerTransfer(event, a.reg.id, ownerId, { email: b.email }), 'duplicate')
  refused(await organizerTransfer(event, a.reg.id, ownerId, { categoryId: kids }), 'price_differs')
  refused(await organizerTransfer(event, a.reg.id, ownerId, { over: { birthDate: warsawDay(-3650) } }), 'recipient_minor')
  refused(await organizerTransfer(event, a.reg.id, ownerId, { email: a.email }), 'same_person')
  assert.equal(await taken(cat), 2)
})

// ---------------------------------------------------------------- V-49 cancel, and the grants

test('V-49 cancel_registration of an entry with a pending invite cancels the invite: the link is gone', async () => {
  const event = await freeEvent()
  const a = await freeEntry(event)
  const t = await inviteOk(a.reg.id, a.profileId)
  ok(await rpc('cancel_registration', { p_registration_id: a.reg.id, p_reason: 'organizer', p_actor: ownerId }))
  const row = await one('transfers', { id: t.transferId })
  assert.equal(row.status, 'cancelled')
  assert.ok(row.cancelled_at)
  refused(await accept(event, t.hash), 'gone')
})

test('V-49 after closes_at too, cancel_registration cancels the invite', async () => {
  const event = await freeEvent()
  const a = await freeEntry(event)
  const t = await inviteOk(a.reg.id, a.profileId)
  await setSettings(event.eventId, { closes_at: minutesFromNow(-1) })
  ok(await rpc('cancel_registration', { p_registration_id: a.reg.id, p_reason: 'organizer', p_actor: ownerId }))
  assert.equal((await one('transfers', { id: t.transferId })).status, 'cancelled')
})

test('V-49 a transferred entry cannot be cancelled: the holder is the new row', async () => {
  const event = await freeEvent()
  const a = await freeEntry(event)
  const t = await inviteOk(a.reg.id, a.profileId)
  const out = ok(await accept(event, t.hash))
  refused(await rpc('cancel_registration', { p_registration_id: a.reg.id, p_reason: 'organizer', p_actor: ownerId }), 'already_cancelled')
  assert.equal((await reg(out.registrationId)).status, 'confirmed')
})

test('V-49 service_role only, internals nobody, search_path empty', async () => {
  const fns = await sql()`
    select p.proname, p.oid::regprocedure::text as sig, p.prosecdef, p.proconfig,
           has_function_privilege('anon', p.oid, 'execute') as anon,
           has_function_privilege('authenticated', p.oid, 'execute') as auth,
           has_function_privilege('service_role', p.oid, 'execute') as service
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('create_transfer', 'cancel_transfer', 'accept_transfer', 'organizer_transfer', 'apply_transfer')`
  assert.equal(fns.length, 5)
  for (const f of fns) {
    assert.deepEqual(f.proconfig, ['search_path=""'], f.sig)
    assert.equal(f.anon, false, f.sig)
    assert.equal(f.auth, false, f.sig)
    const internal = f.proname === 'apply_transfer'
    assert.equal(f.prosecdef, !internal, f.sig)
    assert.equal(f.service, !internal, f.sig)
  }
})
