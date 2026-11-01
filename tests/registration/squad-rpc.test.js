// Plan 5, task 4: team_squad_edit, the captain's reorder, swap and add until registration closes.
// Scenarios T-30…T-34, T-36 and T-37 in docs/registration/scenario-matrix.md. LOCAL stack only.
import { after, afterEach, before, test } from 'node:test'
import assert from 'node:assert/strict'
import postgres from 'postgres'
import { localEnv, sessionFor } from './helpers/stack.js'
import { acceptAgreement } from './helpers/registrationFixtures.js'
import {
  attemptFor, competitionOf, confirm, db, expireNow, minutesFromNow, one, orderOf, profileFor, rows, rpc,
  runnerEmail, setSettings,
} from './helpers/orders.js'
import { adult, groupMeta, minor, registerGroup } from './helpers/groups.js'
import { assertSlotInvariant } from './helpers/slotInvariant.js'
import { STAFETA, captain, freeTeamEvent, paidTeamEvent, squadEdit, teamOk } from './helpers/teams.js'
import { newToken } from '../../supabase/functions/_shared/registration/tokens.js'

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
const refused = (r, message) => assert.equal(r.error?.message, message, JSON.stringify(r))
const ok = (r) => { assert.equal(r.error, null, r.error?.message); return r.data }
const LIVE = ['pending_payment', 'confirmed']
const regsOf = async (teamId) =>
  (await rows('registrations', { team_id: teamId })).sort((a, b) => a.created_at.localeCompare(b.created_at))
const liveOf = async (teamId) => (await regsOf(teamId)).filter((r) => LIVE.includes(r.status))
const reg = (id) => one('registrations', { id })
const participantOf = (id) => one('participants', { registration_id: id })

/** A team of `size` (captain, then adults) in `event` → the ids and the captain's account. */
async function setup(event, { size = 3, legs = false } = {}) {
  const cat = event.categoryIds[0]
  const email = runnerEmail('captain')
  const members = [captain(email), ...Array.from({ length: size - 1 }, () => adult(cat, 'adult'))]
    .map((m, i) => (legs ? { ...m, leg: i + 1 } : m))
  const out = await teamOk(event, { members })
  const ids = out.registrations.map((r) => r.id)
  return { cat, out, teamId: out.teamId, ids, actor: await profileFor(email), members }
}
const newAdult = (cat, over) => adult(cat, 'adult', runnerEmail('new'), { firstName: 'Nowa', ...over })

/** Everything an edit could have written, for „nothing written” checks. */
const snapshot = async (teamId, cat) => ({
  regs: (await regsOf(teamId)).map((r) => [r.id, r.status, r.team_leg]).sort(),
  taken: await taken(cat),
})

// ---------------------------------------------------------------- T-30 reorder

test('T-30 reorder → the legs follow the list, a repeat works, the unique index never trips', async () => {
  const event = await free({ legOrder: true })
  const { teamId, ids, actor, cat } = await setup(event, { size: 4, legs: true })
  const before = await taken(cat)
  const out = ok(await squadEdit(event, teamId, actor, { op: 'reorder', legs: [ids[2], ids[0], ids[3], ids[1]] }))
  assert.deepEqual(out, { added: [], removed: [] })
  const legOf = async () => Object.fromEntries((await regsOf(teamId)).map((r) => [r.id, r.team_leg]))
  assert.deepEqual(await legOf(), { [ids[2]]: 1, [ids[0]]: 2, [ids[3]]: 3, [ids[1]]: 4 })
  ok(await squadEdit(event, teamId, actor, { op: 'reorder', legs: [ids[1], ids[3], ids[0], ids[2]] }))
  assert.deepEqual(await legOf(), { [ids[1]]: 1, [ids[3]]: 2, [ids[0]]: 3, [ids[2]]: 4 })
  assert.equal(await taken(cat), before)
})

test('T-30 reorder with leg order off → leg_order_off, a non-captain → not_captain, nothing written', async () => {
  const off = await free()
  const a = await setup(off)
  refused(await squadEdit(off, a.teamId, a.actor, { op: 'reorder', legs: a.ids }), 'leg_order_off')
  assert.deepEqual((await regsOf(a.teamId)).map((r) => r.team_leg), [null, null, null])

  const on = await free({ legOrder: true })
  const b = await setup(on, { legs: true })
  const stranger = await profileFor(runnerEmail('stranger'))
  const member = await profileFor(b.members[1].email)
  const was = await snapshot(b.teamId, b.cat)
  for (const actor of [stranger, member, null]) {
    refused(await squadEdit(on, b.teamId, actor, { op: 'reorder', legs: [...b.ids].reverse() }), 'not_captain')
  }
  assert.deepEqual(await snapshot(b.teamId, b.cat), was)
})

test('T-30 reorder that is no permutation of the live members → invalid_legs', async () => {
  const event = await free({ legOrder: true })
  const { teamId, ids, actor, cat } = await setup(event, { legs: true })
  const swapped = ok(await squadEdit(event, teamId, actor, { op: 'swap', registrationId: ids[1], person: newAdult(cat) }))
  const fresh = swapped.added[0].id
  const was = await snapshot(teamId, cat)
  for (const legs of [
    [ids[0], fresh], [ids[0], fresh, fresh], [ids[0], fresh, ids[2], ids[1]],
    [ids[0], ids[1], ids[2]], ['x', ids[0], fresh], 'x', null,
  ]) {
    refused(await squadEdit(event, teamId, actor, { op: 'reorder', legs }), 'invalid_legs')
  }
  assert.deepEqual(await snapshot(teamId, cat), was)
})

// ---------------------------------------------------------------- T-31 add

test('T-31 a 5th member on a confirmed team → confirmed, a participant, taken unchanged; a 6th → team_full', async () => {
  const event = await free({ competitions: [STAFETA(50, { teamMax: 5 })] })
  const { cat, teamId, actor } = await setup(event, { size: 4 })
  const before = await taken(cat)
  const person = newAdult(cat)
  const out = ok(await squadEdit(event, teamId, actor, { op: 'add', person }))
  assert.equal(out.added.length, 1)
  assert.equal(out.added[0].role, 'adult')
  assert.deepEqual(out.removed, [])
  const r = await reg(out.added[0].id)
  assert.equal(r.status, 'confirmed')
  assert.equal(r.team_id, teamId)
  assert.equal(r.team_leg, null)
  assert.equal(r.consent_state, 'awaiting')
  assert.equal(r.price, 0)
  assert.equal(r.registered_by_profile_id, actor)
  const p = await participantOf(r.id)
  assert.equal(p.id, r.participant_id)
  assert.equal(p.email, person.email)
  assert.equal(await taken(cat), before)

  refused(await squadEdit(event, teamId, actor, { op: 'add', person: newAdult(cat) }), 'team_full')
  assert.equal((await liveOf(teamId)).length, 5)
  assert.equal(await taken(cat), before)
})

test('T-31 with leg order on the new member takes leg n + 1; a leg sent changes nothing', async () => {
  const event = await free({ legOrder: true })
  const { teamId, actor, cat } = await setup(event, { size: 3, legs: true })
  const out = ok(await squadEdit(event, teamId, actor, { op: 'add', person: newAdult(cat), leg: 1 }))
  assert.equal((await reg(out.added[0].id)).team_leg, 4)
})

test('T-31 an add on a pending team → pending_payment, no participant, the fee and the lines unchanged', async () => {
  const event = await paid()
  const { cat, teamId, actor, out } = await setup(event)
  const edit = ok(await squadEdit(event, teamId, actor, { op: 'add', person: newAdult(cat) }))
  const r = await reg(edit.added[0].id)
  assert.equal(r.status, 'pending_payment')
  assert.equal(r.order_id, out.orderId)
  assert.equal(r.price, 0)
  assert.equal(r.participant_id, null)
  assert.equal((await orderOf(out.orderId)).total, out.total)
  assert.equal((await rows('order_lines', { order_id: out.orderId })).length, 1)
  assert.equal(await taken(cat), 0)
})

test('T-31 a minor is added under the captain: guardian fields, acceptances as guardian, no e-mail', async () => {
  const event = await free()
  const { cat, teamId, actor } = await setup(event)
  const meta = await groupMeta(event.eventId, { buyerName: 'Ola Kapitan' })
  const out = ok(await squadEdit(event, teamId, actor, { op: 'add', person: minor(cat) }, meta))
  assert.equal(out.added[0].role, 'minor')
  const r = await reg(out.added[0].id)
  assert.equal(r.email, null)
  assert.equal(r.guardian_profile_id, actor)
  assert.equal(r.guardian_name, 'Ola Kapitan')
  assert.equal(r.consent_state, 'accepted')
  const acc = await rows('consent_acceptances', { registration_id: r.id })
  assert.equal(acc.length, meta.consentIds.length + 1)
  assert.ok(acc.every((a) => a.accepted_as === 'guardian' && a.accepted_by_profile_id === actor))
})

// ---------------------------------------------------------------- T-32, T-33 swap

test('T-32 swap an awaiting adult → the old row cancelled, its participant removed, the old link gone', async () => {
  const event = await free({ legOrder: true })
  const { cat, teamId, ids, actor, members } = await setup(event, { legs: true })
  const t = await newToken()
  ok(await rpc('issue_consent_request', { p_registration_id: ids[1], p_token_hash: t.hash }))
  const before = await taken(cat)
  const old = await reg(ids[1])
  const out = ok(await squadEdit(event, teamId, actor, {
    op: 'swap', registrationId: ids[1], person: newAdult(cat),
  }))
  assert.deepEqual(out.removed, [{ id: ids[1], email: members[1].email, firstName: old.first_name }])
  assert.equal(out.added.length, 1)
  assert.equal((await reg(ids[1])).status, 'cancelled')
  assert.ok((await participantOf(ids[1])).removed_at)
  const fresh = await reg(out.added[0].id)
  assert.equal(fresh.status, 'confirmed')
  assert.equal(fresh.team_leg, old.team_leg)
  assert.ok(fresh.participant_id)
  assert.equal((await participantOf(fresh.id)).removed_at, null)
  assert.equal(await taken(cat), before)

  const accepted = await rpc('accept_consent_request', {
    p_token_hash: t.hash, p_profile_id: await profileFor(members[1].email), p_edits: null,
    p_meta: await groupMeta(event.eventId),
  })
  refused(accepted, 'gone')
})

test('T-32 the captain cannot be swapped, and only a live member of this team can', async () => {
  const event = await free()
  const { cat, teamId, ids, actor } = await setup(event)
  const other = await setup(event)
  const was = await snapshot(teamId, cat)
  refused(await squadEdit(event, teamId, actor, { op: 'swap', registrationId: ids[0], person: newAdult(cat) }), 'captain_fixed')
  for (const registrationId of [other.ids[1], 'x', null]) {
    refused(await squadEdit(event, teamId, actor, { op: 'swap', registrationId, person: newAdult(cat) }), 'not_member')
  }
  const swapped = ok(await squadEdit(event, teamId, actor, { op: 'swap', registrationId: ids[1], person: newAdult(cat) }))
  refused(await squadEdit(event, teamId, actor, { op: 'swap', registrationId: ids[1], person: newAdult(cat) }), 'not_member')
  assert.equal(swapped.removed.length, 1)
  assert.equal((await liveOf(teamId)).length, was.regs.length)
})

test('T-33 swap on a pending team → pending_payment with no participant; the payment confirms the new member', async () => {
  const event = await paid()
  const { cat, teamId, ids, actor, out } = await setup(event)
  const edit = ok(await squadEdit(event, teamId, actor, { op: 'swap', registrationId: ids[1], person: newAdult(cat) }))
  const fresh = await reg(edit.added[0].id)
  assert.equal(fresh.status, 'pending_payment')
  assert.equal(fresh.order_id, out.orderId)
  assert.equal(fresh.participant_id, null)
  assert.equal(fresh.price, 0)
  assert.equal(await participantOf(ids[1]), null)
  assert.equal((await orderOf(out.orderId)).total, out.total)
  assert.equal(await taken(cat), 0)

  const att = await attemptFor(out.orderId, out.total)
  assert.equal(ok(await confirm(out.orderId, att.txn, out.total)).outcome, 'confirmed')
  assert.equal((await reg(fresh.id)).status, 'confirmed')
  assert.ok((await reg(fresh.id)).participant_id)
  const gone = await reg(ids[1])
  assert.equal(gone.status, 'cancelled')
  assert.equal(gone.participant_id, null)
  assert.equal(await taken(cat), 1)
})

test('T-33 a swap on a confirmed paid team keeps the order and the fee', async () => {
  const event = await paid()
  const { cat, teamId, ids, actor, out } = await setup(event)
  const att = await attemptFor(out.orderId, out.total)
  ok(await confirm(out.orderId, att.txn, out.total))
  const edit = ok(await squadEdit(event, teamId, actor, { op: 'swap', registrationId: ids[2], person: newAdult(cat) }))
  const fresh = await reg(edit.added[0].id)
  assert.equal(fresh.status, 'confirmed')
  assert.equal(fresh.order_id, out.orderId)
  assert.ok(fresh.participant_id)
  assert.ok((await participantOf(ids[2])).removed_at)
  assert.equal((await orderOf(out.orderId)).total, out.total)
  assert.equal(await taken(cat), 1)
})

// ---------------------------------------------------------------- T-34 closed, inactive

test('T-34 an edit after closes_at → squad_closed, nothing written', async () => {
  const event = await free({ legOrder: true })
  const { cat, teamId, ids, actor } = await setup(event, { legs: true })
  await setSettings(event.eventId, { closes_at: minutesFromNow(-1) })
  const was = await snapshot(teamId, cat)
  const participants = (await rows('participants', { event_id: event.eventId })).length
  for (const op of [
    { op: 'reorder', legs: [...ids].reverse() },
    { op: 'swap', registrationId: ids[1], person: newAdult(cat) },
    { op: 'add', person: newAdult(cat) },
  ]) {
    refused(await squadEdit(event, teamId, actor, op), 'squad_closed')
  }
  assert.deepEqual(await snapshot(teamId, cat), was)
  const after = await rows('participants', { event_id: event.eventId })
  assert.equal(after.length, participants)
  assert.ok(after.every((p) => p.removed_at === null))
})

test('T-34 not the captain comes before the closed message, and a closed window before a full squad', async () => {
  const event = await free({ competitions: [STAFETA(50, { teamMax: 3 })] })
  const { cat, teamId, actor } = await setup(event)
  await setSettings(event.eventId, { closes_at: minutesFromNow(-1) })
  const stranger = await profileFor(runnerEmail('stranger'))
  refused(await squadEdit(event, teamId, stranger, { op: 'add', person: newAdult(cat) }), 'not_captain')
  refused(await squadEdit(event, teamId, actor, { op: 'add', person: newAdult(cat) }), 'squad_closed')
})

test('T-34 a released team → team_inactive: an expired order, also past closes_at; an unknown team → not_found', async () => {
  const event = await paid()
  const { cat, teamId, actor, out } = await setup(event)
  await expireNow(out.orderId)
  assert.ok((await one('teams', { id: teamId })).released_at)
  refused(await squadEdit(event, teamId, actor, { op: 'add', person: newAdult(cat) }), 'team_inactive')
  await setSettings(event.eventId, { closes_at: minutesFromNow(-1) })
  refused(await squadEdit(event, teamId, actor, { op: 'add', person: newAdult(cat) }), 'team_inactive')
  refused(await squadEdit(event, crypto.randomUUID(), actor, { op: 'add', person: newAdult(cat) }), 'not_found')
})

test('T-34 a pending order past its window, not expired yet: the add lands, and the job expires it with the team', async () => {
  const event = await paid()
  const { cat, teamId, actor, out } = await setup(event)
  const { error } = await db().from('orders').update({ expires_at: minutesFromNow(-1) }).eq('id', out.orderId)
  assert.ifError(error)
  const edit = ok(await squadEdit(event, teamId, actor, { op: 'add', person: newAdult(cat) }))
  await rpc('expire_orders', {})
  assert.equal((await reg(edit.added[0].id)).status, 'expired')
  assert.equal(await taken(cat), 0)
})

// ---------------------------------------------------------------- T-36 duplicate

test('T-36 the swapped-in email is live elsewhere in the event → duplicate, and the old member stays', async () => {
  const event = await free({
    competitions: [STAFETA(50), { name: 'Bieg', discipline: 'run', distanceLabel: '9 km', startTime: '11:00', capacity: 50 }],
  })
  const { cat, teamId, ids, actor } = await setup(event)
  const elsewhere = runnerEmail('elsewhere')
  ok(await registerGroup(event, [adult(event.categoryIds[1], 'self', elsewhere)]))
  const was = await snapshot(teamId, cat)
  refused(await squadEdit(event, teamId, actor, {
    op: 'swap', registrationId: ids[1], person: adult(cat, 'adult', elsewhere.toUpperCase()),
  }), 'duplicate')
  refused(await squadEdit(event, teamId, actor, { op: 'add', person: adult(cat, 'adult', elsewhere) }), 'duplicate')
  assert.deepEqual(await snapshot(teamId, cat), was)
  assert.equal((await reg(ids[1])).status, 'confirmed')
  assert.equal((await participantOf(ids[1])).removed_at, null)
})

test('T-36 a member of the same team, or the same child twice → duplicate', async () => {
  const event = await free()
  const { cat, teamId, ids, actor, members } = await setup(event, { size: 3 })
  refused(await squadEdit(event, teamId, actor, {
    op: 'swap', registrationId: ids[1], person: adult(cat, 'adult', members[2].email),
  }), 'duplicate')
  const child = minor(cat)
  ok(await squadEdit(event, teamId, actor, { op: 'add', person: child }))
  refused(await squadEdit(event, teamId, actor, { op: 'add', person: child }), 'duplicate')
})

// ---------------------------------------------------------------- T-37 the call itself

test('T-37 a malformed op or person → refused, nothing written', async () => {
  const event = await free()
  const { cat, teamId, ids, actor } = await setup(event)
  const was = await snapshot(teamId, cat)
  for (const op of [null, 'add', [], {}, { op: 'remove', registrationId: ids[1] }]) {
    refused(await squadEdit(event, teamId, actor, op), 'invalid_op')
  }
  for (const person of [
    null, 'x',
    { ...newAdult(cat), role: 'self' },
    { ...newAdult(cat), role: undefined },
    { ...newAdult(cat), firstName: ' ' },
    { ...newAdult(cat), email: '' },
    { ...minor(cat), birthDate: '' },
  ]) {
    refused(await squadEdit(event, teamId, actor, { op: 'add', person }), 'invalid_people')
    refused(await squadEdit(event, teamId, actor, { op: 'swap', registrationId: ids[1], person }), 'invalid_people')
  }
  assert.deepEqual(await snapshot(teamId, cat), was)
})

test('T-37 a child needs the consents the captain was shown; an adult accepts for themself', async () => {
  const event = await free()
  const { cat, teamId, actor } = await setup(event, { size: 2 })
  for (const consentIds of [[], ['x'], (await groupMeta(event.eventId)).consentIds.slice(1)]) {
    refused(await squadEdit(event, teamId, actor, { op: 'add', person: minor(cat) },
      await groupMeta(event.eventId, { consentIds })), 'consents_changed')
  }
  ok(await squadEdit(event, teamId, actor, { op: 'add', person: newAdult(cat) }, { ip: 'x' }))
})

test('T-37 EXECUTE: service_role only, SECURITY DEFINER with an empty search_path; the insert helper for nobody', async () => {
  const [fn] = await sql()`
    select p.prosecdef, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'team_squad_edit'`
  assert.equal(fn.prosecdef, true)
  assert.ok(fn.proconfig.some((c) => /^search_path=("")?$/.test(c)), JSON.stringify(fn.proconfig))
  const [grants] = await sql()`
    select has_function_privilege('anon', f, 'execute') as anon,
           has_function_privilege('authenticated', f, 'execute') as authed,
           has_function_privilege('service_role', f, 'execute') as service
      from (select 'public.team_squad_edit(uuid, uuid, jsonb, jsonb, boolean)'::regprocedure as f) t`
  assert.deepEqual({ ...grants }, { anon: false, authed: false, service: true })
  const [helper] = await sql()`
    select has_function_privilege('anon', p.oid, 'execute') as anon,
           has_function_privilege('authenticated', p.oid, 'execute') as authed,
           has_function_privilege('service_role', p.oid, 'execute') as service
      from pg_proc p where p.proname = 'team_squad_insert'`
  assert.deepEqual({ ...helper }, { anon: false, authed: false, service: false })
})

// ---------------------------------------------------------------- final review M-2: team_position

test('T-38 M-2 team_position: the request\'s order at sign-up, an added member last, a swapped-in member in the old place', async () => {
  const event = await free()
  const { cat, teamId, ids, actor } = await setup(event, { size: 4 })
  const position = async (id) => (await reg(id)).team_position
  assert.deepEqual(await Promise.all(ids.map(position)), [1, 2, 3, 4])
  const added = ok(await squadEdit(event, teamId, actor, { op: 'add', person: newAdult(cat) })).added[0].id
  assert.equal(await position(added), 5)
  const swapped = ok(await squadEdit(event, teamId, actor, { op: 'swap', registrationId: ids[2], person: newAdult(cat) })).added[0].id
  assert.equal(await position(swapped), 3)
})
