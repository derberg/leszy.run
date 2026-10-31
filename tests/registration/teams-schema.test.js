// Plan 5, task 2: the teams table, released_at following the captain, and the locks on a team's
// size and leg order. Scenarios T-10…T-14 in docs/registration/scenario-matrix.md. LOCAL stack only.
//
// A team here is built from admin() rows on top of a group order: the competition turns into a
// team one only after the order exists, because create_team_registration comes in task 3 and an
// individual order into a team competition is refused from then on (D5-12).
import { after, afterEach, before, test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import postgres from 'postgres'
import { createClient } from '@supabase/supabase-js'
import { admin, authenticatedClient, localEnv, sessionFor } from './helpers/stack.js'
import { acceptAgreement, callFn, createPublishedPaidEvent } from './helpers/registrationFixtures.js'
import {
  attemptFor, competitionOf, confirm, db, expireNow, one, orderOf, orderOk, paidOrderOk, person, registrationsOf,
  rows, rpc, runnerEmail,
} from './helpers/orders.js'
import { assertSlotInvariant } from './helpers/slotInvariant.js'
import { teamNameKey } from '../../supabase/functions/_shared/registration/team.js'

const ZT_CLUB = '00000000-0000-4000-8000-0000000000c1'
const NBSP = ' '

let owner
let sqlClient
const sql = () => (sqlClient ??= postgres(localEnv().dbUrl, { max: 1, onnotice: () => {} }))
const seen = new Set()

before(async () => {
  await acceptAgreement('zatyrani-test')
  owner = await sessionFor('owner@zatyrani-test.local')
})
after(async () => { if (sqlClient) await sqlClient.end() })
afterEach(async () => {
  for (const categoryId of seen) await assertSlotInvariant(categoryId)
  seen.clear()
})

const unwrap = ({ data, error }, what) => {
  if (error) throw new Error(`${what}: ${error.message}`)
  return data
}

const paidEvent = async (capacity = 10) => {
  const event = await createPublishedPaidEvent(owner, {
    prices: { 'Sztafeta': 6000 },
    competitions: [{ name: 'Sztafeta', discipline: 'run', distanceLabel: '4 x 5 km', startTime: '10:00', capacity }],
  })
  seen.add(event.categoryIds[0])
  return event
}

const asTeamCompetition = async (categoryId, over = {}) => unwrap(await db().from('competitions')
  .update({ kind: 'team', team_min: 2, team_max: 5, ...over }).eq('category_id', categoryId).select().single(), 'team competition')

const insertTeam = async (event, categoryId, name) => unwrap(await db().from('teams')
  .insert({ event_id: event.eventId, category_id: categoryId, name }).select().single(), 'insert team')

const teamOf = (id) => one('teams', { id })

/** A pending order of n adults, tied up as one team: the first registration is the captain. */
async function teamOrder(event, { name = `Wilcze Stado ${crypto.randomBytes(3).toString('hex')}`, n = 4, buyer = runnerEmail('captain') } = {}) {
  const categoryId = event.categoryIds[0]
  const people = [person(buyer), ...Array.from({ length: n - 1 }, () => person(runnerEmail('member')))]
  const profileId = (await sessionFor(buyer)).profileId
  const order = await orderOk(event, { people, profileId, buyerEmail: buyer })
  await asTeamCompetition(categoryId)
  const regs = await registrationsOf(order.orderId)
  assert.equal(regs.length, n)
  const captain = regs.find((r) => r.email === buyer)
  const team = await insertTeam(event, categoryId, name)
  unwrap(await db().from('registrations').update({ team_id: team.id }).eq('order_id', order.orderId).select(), 'tie members')
  unwrap(await db().from('teams').update({ captain_registration_id: captain.id }).eq('id', team.id).select(), 'captain')
  return { order, team, captain, regs, profileId, categoryId, buyer, name }
}

const participantsOf = async (registrationIds) => unwrap(await db().from('participants').select('id')
  .in('registration_id', registrationIds), 'participants')

// ---------------------------------------------------------------- T-10

function anon() {
  const { url, anonKey } = localEnv()
  return createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
}

test('T-10 anon and authenticated cannot read or write teams, and hold no privilege on it', async () => {
  for (const [role, client] of [['anon', anon()], ['authenticated', authenticatedClient()]]) {
    const read = await client.from('teams').select('id').limit(1)
    assert.ok(read.error, `${role} read teams`)
    assert.equal(read.error.code, '42501', read.error.message)
    const write = await client.from('teams').insert({ name: 'Włamanie' })
    assert.equal(write.error?.code, '42501', `${role} wrote teams`)
  }
  for (const role of ['anon', 'authenticated']) {
    for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
      const [{ allowed }] = await sql()`SELECT has_table_privilege(${role}, 'public.teams', ${priv}) AS allowed`
      assert.equal(allowed, false, `${role} holds ${priv} on teams`)
    }
  }
  const [{ relrowsecurity }] = await sql()`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.teams'::regclass`
  assert.equal(relrowsecurity, true)
})

test('T-10 nobody can execute the new function, and the recreated helpers stay internal', async () => {
  const fns = ['public.teams_follow_captain()', 'public.apply_registration_section(uuid, text, jsonb, boolean)',
    'public.registration_check_locks(uuid, text, jsonb)']
  for (const fn of fns) {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      const [{ allowed }] = await sql()`SELECT has_function_privilege(${role}, ${fn}, 'EXECUTE') AS allowed`
      assert.equal(allowed, false, `${role} may execute ${fn}`)
    }
  }
  const [trigger] = await sql()`SELECT prosecdef, proconfig FROM pg_proc WHERE oid = 'public.teams_follow_captain'::regproc`
  assert.equal(trigger.prosecdef, true)
  assert.deepEqual(trigger.proconfig, ['search_path=""'])
})

test('T-10 every foreign key of a team refuses a delete and is indexed', async () => {
  const fks = await sql()`
    SELECT c.conname, c.confdeltype, c.conrelid::regclass::text AS tbl, c.conkey
      FROM pg_constraint c
     WHERE c.contype = 'f' AND (c.conrelid = 'public.teams'::regclass
        OR (c.conrelid = 'public.registrations'::regclass AND c.confrelid = 'public.teams'::regclass))`
  assert.equal(fks.length, 4, JSON.stringify(fks))
  for (const fk of fks) {
    assert.equal(fk.confdeltype, 'r', `${fk.conname} is not ON DELETE RESTRICT`)
    const [{ n }] = await sql()`
      SELECT count(*)::int AS n FROM pg_index i
       WHERE i.indrelid = ${fk.tbl}::text::regclass AND i.indkey[0]::int = ${fk.conkey[0]}::int AND i.indpred IS NULL`
    assert.equal(n > 0, true, `${fk.conname} has no index`)
  }
})

test('T-10 competitions refuse a squad outside 2…10 from a raw write (D5-13)', async () => {
  const event = await paidEvent()
  const id = event.categoryIds[0]
  for (const bad of [{ team_min: 1 }, { team_max: 11 }, { team_min: 4, team_max: 3 }]) {
    const r = await db().from('competitions').update({ kind: 'team', team_min: 2, team_max: 5, ...bad }).eq('category_id', id)
    assert.equal(r.error?.code, '23514', `${JSON.stringify(bad)}: ${r.error?.message}`)
  }
  await asTeamCompetition(id, { team_min: 2, team_max: 10 })
})

// ---------------------------------------------------------------- T-11

test('T-11 the same name with other case or spacing is refused; released, it can be used again', async () => {
  const event = await paidEvent()
  const cat = event.categoryIds[0]
  await asTeamCompetition(cat)
  const first = await insertTeam(event, cat, 'Wilcze Stado')
  const clash = await db().from('teams').insert({ event_id: event.eventId, category_id: cat, name: 'wilcze  stado' })
  assert.equal(clash.error?.code, '23505', clash.error?.message)

  unwrap(await db().from('teams').update({ released_at: new Date().toISOString() }).eq('id', first.id).select(), 'release')
  await insertTeam(event, cat, 'wilcze  stado')
})

test('T-11 the name index agrees with teamNameKey on NBSP, tabs, CJK space and Polish capitals', async () => {
  const event = await paidEvent()
  const cat = event.categoryIds[0]
  await asTeamCompetition(cat)
  const same = [
    ['ŁOSIE Z ŻYWCA', 'łosie z żywca'],
    ['Ćmy Ąę Śń Óź', 'ćmy ąę śń óź'],
    [`Dziki${NBSP}Biegacze`, 'dziki biegacze'],
    [`${NBSP}Rysie${NBSP}`, 'rysie'],
    [` ${NBSP} Sowy \t\n${NBSP}Nocne${NBSP} `, 'sowy nocne'],
    ['Lisy　Polne', 'lisy polne'],
    ['Żbiki Leśne﻿', 'żbiki leśne'],
  ]
  for (const [a, b] of same) {
    assert.equal(teamNameKey(a), teamNameKey(b), `the JS key must make ${JSON.stringify(a)} = ${JSON.stringify(b)}`)
    await insertTeam(event, cat, a)
    const r = await db().from('teams').insert({ event_id: event.eventId, category_id: cat, name: b })
    assert.equal(r.error?.code, '23505', `${JSON.stringify(a)} vs ${JSON.stringify(b)}: ${r.error?.message ?? 'no conflict'}`)
  }
  // Letters that differ stay different on both sides; so does a name split by a zero-width space.
  const different = [['Żubry', 'Zubry'], ['Łania', 'Lania'], ['A​B', 'A B']]
  for (const [a, b] of different) {
    assert.notEqual(teamNameKey(a), teamNameKey(b))
    await insertTeam(event, cat, a)
    await insertTeam(event, cat, b)
  }
})

test('T-11 every code point JavaScript calls whitespace is whitespace to the index, and only those', async () => {
  const event = await paidEvent()
  const cat = event.categoryIds[0]
  await asTeamCompetition(cat)
  const spaces = []
  for (let cp = 0; cp <= 0xffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue
    if (/\s/.test(String.fromCodePoint(cp))) spaces.push(cp)
  }
  assert.equal(spaces.length, 25, spaces.map((c) => c.toString(16)).join())
  for (const cp of spaces) {
    const hex = cp.toString(16)
    const c = String.fromCodePoint(cp)
    for (const [i, typed] of [`Rysie${c}${hex}`, `${c}Rysie ${hex}b${c}`].entries()) {
      const plain = i === 0 ? `rysie ${hex}` : `rysie ${hex}b`
      assert.equal(teamNameKey(typed), plain, `U+${hex}`)
      await insertTeam(event, cat, typed)
      const r = await db().from('teams').insert({ event_id: event.eventId, category_id: cat, name: plain })
      assert.equal(r.error?.code, '23505', `U+${hex}: ${r.error?.message ?? 'no conflict'}`)
    }
  }
  // Not whitespace to JavaScript, so not to the index either.
  for (const cp of [0x85, 0x180e]) {
    const c = String.fromCodePoint(cp)
    const hex = cp.toString(16)
    assert.notEqual(teamNameKey(`Sowy${c}${hex}`), teamNameKey(`Sowy ${hex}`))
    await insertTeam(event, cat, `Sowy${c}${hex}`)
    await insertTeam(event, cat, `Sowy ${hex}`)
  }
})

test('T-11 an NFD paste is the same name as the composed one', async () => {
  const event = await paidEvent()
  const cat = event.categoryIds[0]
  await asTeamCompetition(cat)
  const name = 'Zażółć Gęślą Jaźń'
  assert.notEqual(name.normalize('NFD'), name)
  assert.equal(teamNameKey(name.normalize('NFD')), teamNameKey(name))
  await insertTeam(event, cat, name)
  const r = await db().from('teams').insert({ event_id: event.eventId, category_id: cat, name: name.normalize('NFD') })
  assert.equal(r.error?.code, '23505', r.error?.message)
})

test('T-11 the key is compared bytewise: lower() runs under ICU, the index under "C"', async () => {
  const [{ def }] = await sql()`SELECT pg_get_indexdef('public.teams_category_name_live_key'::regclass) AS def`
  assert.match(def, /normalize\(name, NFC\)/i)
  assert.match(def, /COLLATE "C"/)
  assert.match(def, /COLLATE "und-x-icu"/)
})

test('T-11 one name in two competitions of an event is fine; a live leg is unique in a team', async () => {
  const event = await paidEvent()
  const cat = event.categoryIds[0]
  const { team, regs } = await teamOrder(event, { name: 'Rysie' })
  const other = await createPublishedPaidEvent(owner, {
    competitions: [{ name: 'Sztafeta', discipline: 'run', distanceLabel: '4 x 5 km', startTime: '10:00', capacity: 5 }],
  })
  await asTeamCompetition(other.categoryIds[0])
  await insertTeam(other, other.categoryIds[0], 'Rysie')

  unwrap(await db().from('registrations').update({ team_leg: 1 }).eq('id', regs[0].id).select(), 'leg')
  const clash = await db().from('registrations').update({ team_leg: 1 }).eq('id', regs[1].id)
  assert.equal(clash.error?.code, '23505', clash.error?.message)
  // A swapped-out member gives the leg back.
  unwrap(await db().from('registrations').update({ status: 'cancelled' }).eq('id', regs[0].id).select(), 'swap out')
  unwrap(await db().from('registrations').update({ team_leg: 1 }).eq('id', regs[1].id).select(), 'leg again')
  assert.equal((await teamOf(team.id)).id, team.id)
  assert.equal((await competitionOf(cat)).taken, 0)
})

// ---------------------------------------------------------------- T-12

test('T-12 expire_orders: a pending team holds no slot, the name is freed', async () => {
  const event = await paidEvent()
  const t = await teamOrder(event)
  assert.equal((await competitionOf(t.categoryId)).taken, 0)
  await expireNow(t.order.orderId)
  assert.deepEqual((await registrationsOf(t.order.orderId)).map((r) => r.status), ['expired', 'expired', 'expired', 'expired'])
  assert.ok((await teamOf(t.team.id)).released_at, 'released_at set')
  assert.equal((await competitionOf(t.categoryId)).taken, 0)
  await insertTeam(event, t.categoryId, t.name.toUpperCase())
})

test('T-12 cancel_order frees the name and changes no slot', async () => {
  const event = await paidEvent()
  const t = await teamOrder(event)
  assert.equal(unwrap(await rpc('cancel_order', { p_order_id: t.order.orderId, p_reason: 'test' }), 'cancel'), true)
  assert.ok((await teamOf(t.team.id)).released_at)
  assert.equal((await competitionOf(t.categoryId)).taken, 0)
})

test('T-12 buyer_cancel_order frees the name and changes no slot', async () => {
  const event = await paidEvent()
  const t = await teamOrder(event)
  assert.equal(unwrap(await rpc('buyer_cancel_order', { p_order_id: t.order.orderId, p_profile_id: t.profileId }), 'cancel'), 'cancelled')
  assert.deepEqual((await registrationsOf(t.order.orderId)).map((r) => r.status), ['cancelled', 'cancelled', 'cancelled', 'cancelled'])
  assert.ok((await teamOf(t.team.id)).released_at)
  assert.equal((await competitionOf(t.categoryId)).taken, 0)
})

test('T-12 delete-my-account cancels the captain\'s pending team: members cancelled, name free, taken unchanged', async () => {
  const event = await paidEvent()
  const t = await teamOrder(event)
  const session = await sessionFor(t.buyer)
  unwrap(await db().from('auth_codes').insert({
    email: t.buyer, code_hash: crypto.createHash('sha256').update('123456').digest('hex'),
    purpose: 'delete_account', expires_at: new Date(Date.now() + 600000).toISOString(),
  }).select(), 'auth code')
  const r = await callFn('delete-my-account', session, { action: 'confirm', code: '123456' })
  assert.equal(r.status, 200, JSON.stringify(r.body))

  assert.equal((await orderOf(t.order.orderId)).cancelled_reason, 'account_deleted')
  assert.deepEqual((await registrationsOf(t.order.orderId)).map((x) => x.status), ['cancelled', 'cancelled', 'cancelled', 'cancelled'])
  assert.ok((await teamOf(t.team.id)).released_at)
  assert.equal((await competitionOf(t.categoryId)).taken, 0)
})

test('T-12 a member\'s own cancel (a swap) never touches the team', async () => {
  const event = await paidEvent()
  const t = await teamOrder(event)
  const member = t.regs.find((r) => r.id !== t.captain.id)
  unwrap(await db().from('registrations').update({ status: 'cancelled' }).eq('id', member.id).select(), 'swap out')
  assert.equal((await teamOf(t.team.id)).released_at, null)
})

test('T-12 a payment on a pending team confirms all four and takes one slot', async () => {
  const event = await paidEvent()
  const t = await teamOrder(event)
  const att = await attemptFor(t.order.orderId, t.order.total)
  const r = unwrap(await confirm(t.order.orderId, att.txn, t.order.total), 'confirm')
  assert.equal(r.outcome, 'confirmed')
  assert.equal((await competitionOf(t.categoryId)).taken, 1)
  assert.equal((await teamOf(t.team.id)).released_at, null)
  assert.equal((await participantsOf(t.regs.map((x) => x.id))).length, 4)
})

test('T-12 a late confirm clears released_at and claims one slot', async () => {
  const event = await paidEvent()
  const t = await teamOrder(event)
  const att = await attemptFor(t.order.orderId, t.order.total)
  await expireNow(t.order.orderId)
  assert.ok((await teamOf(t.team.id)).released_at)

  const r = unwrap(await confirm(t.order.orderId, att.txn, t.order.total), 'confirm')
  assert.equal(r.outcome, 'late_confirmed')
  assert.equal((await teamOf(t.team.id)).released_at, null)
  assert.equal((await competitionOf(t.categoryId)).taken, 1)
  assert.deepEqual((await registrationsOf(t.order.orderId)).map((x) => x.status), ['confirmed', 'confirmed', 'confirmed', 'confirmed'])
})

test('T-12 a late confirm with the name taken meanwhile: late_refund duplicate, nothing confirmed, taken unchanged', async () => {
  const event = await paidEvent()
  const t = await teamOrder(event, { name: 'Łosie Północy' })
  const att = await attemptFor(t.order.orderId, t.order.total)
  await expireNow(t.order.orderId)
  await insertTeam(event, t.categoryId, `  ŁOSIE${NBSP}północy `)

  const r = unwrap(await confirm(t.order.orderId, att.txn, t.order.total), 'confirm')
  assert.equal(r.outcome, 'late_refund')
  assert.equal(r.refund.reason, 'duplicate')
  assert.equal(r.refund.grosze, t.order.total)
  assert.ok((await teamOf(t.team.id)).released_at, 'stays released')
  assert.equal((await competitionOf(t.categoryId)).taken, 0)
  assert.deepEqual((await registrationsOf(t.order.orderId)).map((x) => x.status), ['expired', 'expired', 'expired', 'expired'])
  assert.equal((await participantsOf(t.regs.map((x) => x.id))).length, 0)
})

test('T-12 a late confirm into a full competition: late_refund full, nothing confirmed, taken unchanged', async () => {
  const event = await paidEvent()
  const cat = event.categoryIds[0]
  await paidOrderOk(event) // one confirmed entry, before the competition is a team one
  const t = await teamOrder(event)
  const att = await attemptFor(t.order.orderId, t.order.total)
  await expireNow(t.order.orderId)
  unwrap(await db().from('competitions').update({ capacity: 1 }).eq('category_id', cat).select(), 'capacity')

  const r = unwrap(await confirm(t.order.orderId, att.txn, t.order.total), 'confirm')
  assert.equal(r.outcome, 'late_refund')
  assert.equal(r.refund.reason, 'full')
  assert.equal((await competitionOf(cat)).taken, 1)
  assert.ok((await teamOf(t.team.id)).released_at)
  assert.equal((await participantsOf(t.regs.map((x) => x.id))).length, 0)
})

test('T-12 the expiry of an individual order is unchanged', async () => {
  const event = await paidEvent()
  const cat = event.categoryIds[0]
  const order = await orderOk(event)
  await expireNow(order.orderId)
  assert.equal((await orderOf(order.orderId)).status, 'expired')
  assert.deepEqual((await registrationsOf(order.orderId)).map((r) => [r.status, r.team_id]), [['expired', null]])
  assert.equal((await competitionOf(cat)).taken, 0)
})

// ---------------------------------------------------------------- T-13

const ITEM = (categoryId, over = {}) => ({
  category_id: categoryId, name: 'Sztafeta', kind: 'team', discipline: 'run', distance_label: '4 x 5 km',
  start_time: '10:00', capacity: 10, min_age: null, max_age: null, is_kids: false, timed: true,
  gpx_upload_id: null, price: 6000, team_min: 2, team_max: 5, ...over,
})
const stage = (event, section, value) => rpc('stage_registration_section', {
  p_event_id: event.eventId, p_section: section, p_actor: owner.profileId, p_value: value,
})
const stageItem = (event, over) => stage(event, 'competitions', { pricing_mode: 'fixed', items: [ITEM(event.categoryIds[0], over)] })
const publishChanges = (event) => rpc('publish_registration_changes', {
  p_event_id: event.eventId, p_actor: owner.profileId, p_expected_updated_at: null,
})
const discard = (event) => db().from('registration_pending_changes').delete().eq('event_id', event.eventId)
const locked = (r, what) => assert.equal(r.error?.message, 'competition_locked', `${what}: ${JSON.stringify(r)}`)

/** Every staged change that must refuse while the competition is in use. */
const CHANGES = [
  ['team_max', (event) => stageItem(event, { team_max: 6 })],
  ['team_min', (event) => stageItem(event, { team_min: 3 })],
  ['leg_order', (event) => stage(event, 'form', { leg_order: { [event.categoryIds[0]]: true } })],
]

for (const [field, change] of CHANGES) {
  test(`T-13 ${field} with taken > 0 → competition_locked at stage and at publish`, async () => {
    const event = await paidEvent()
    const cat = event.categoryIds[0]
    await asTeamCompetition(cat)
    // Staged while nobody is in: the same change is refused at publish once somebody is.
    assert.ifError((await change(event)).error)
    unwrap(await db().from('competitions').update({ kind: 'individual', team_min: null, team_max: null }).eq('category_id', cat).select(), 'back')
    await paidOrderOk(event)
    await asTeamCompetition(cat)
    assert.equal((await competitionOf(cat)).taken, 1)

    locked(await publishChanges(event), 'publish')
    unwrap(await discard(event), 'discard')
    locked(await change(event), 'stage')
    const after = await competitionOf(cat)
    assert.deepEqual([after.team_min, after.team_max, after.leg_order_enabled], [2, 5, false])
  })

  test(`T-13 ${field} with only a pending order (taken 0) → competition_locked at stage and at publish`, async () => {
    const event = await paidEvent()
    const cat = event.categoryIds[0]
    await asTeamCompetition(cat)
    assert.ifError((await change(event)).error)
    unwrap(await db().from('competitions').update({ kind: 'individual', team_min: null, team_max: null }).eq('category_id', cat).select(), 'back')
    await orderOk(event)
    await asTeamCompetition(cat)
    assert.equal((await competitionOf(cat)).taken, 0)

    locked(await publishChanges(event), 'publish')
    unwrap(await discard(event), 'discard')
    locked(await change(event), 'stage')
  })
}

test('T-13 an unchanged size and leg order pass on a competition in use', async () => {
  const event = await paidEvent()
  const cat = event.categoryIds[0]
  await paidOrderOk(event)
  await asTeamCompetition(cat, { leg_order_enabled: true })
  assert.ifError((await stageItem(event, { capacity: 20 })).error)
  assert.ifError((await stage(event, 'form', { leg_order: { [cat]: true } })).error)
  assert.ifError((await publishChanges(event)).error)
  const c = await competitionOf(cat)
  assert.deepEqual([c.capacity, c.team_min, c.team_max, c.leg_order_enabled], [20, 2, 5, true])
})

test('T-13 with no confirmed and no pending entry the size and leg order are applied and stored', async () => {
  const event = await paidEvent()
  const cat = event.categoryIds[0]
  await asTeamCompetition(cat)
  assert.ifError((await stageItem(event, { team_min: 3, team_max: 6 })).error)
  assert.ifError((await stage(event, 'form', { leg_order: { [cat]: true } })).error)
  assert.equal((await competitionOf(cat)).team_max, 5, 'nothing live changes before publish')
  assert.ifError((await publishChanges(event)).error)
  const c = await competitionOf(cat)
  assert.deepEqual([c.team_min, c.team_max, c.leg_order_enabled], [3, 6, true])
})

test('T-13 a new team competition stores its size; an expired order no longer locks', async () => {
  const event = await paidEvent()
  const cat = event.categoryIds[0]
  const order = await orderOk(event)
  await asTeamCompetition(cat)
  locked(await stageItem(event, { team_max: 6 }), 'pending')
  await expireNow(order.orderId)
  const r = await stage(event, 'competitions', {
    pricing_mode: 'fixed',
    items: [ITEM(cat, { team_max: 6 }), ITEM(null, { name: 'Sztafeta 2', team_min: 4, team_max: 8 })],
  })
  assert.ifError(r.error)
  const ids = unwrap(await publishChanges(event), 'publish').categoryIds
  assert.equal((await competitionOf(cat)).team_max, 6)
  const added = await competitionOf(ids[1])
  seen.add(ids[1])
  assert.deepEqual([added.kind, added.team_min, added.team_max], ['team', 4, 8])
})

test('T-13 a team going back to individual loses its size and its leg order', async () => {
  const event = await paidEvent()
  const cat = event.categoryIds[0]
  await asTeamCompetition(cat, { leg_order_enabled: true })
  assert.ifError((await stageItem(event, { kind: 'individual', team_min: null, team_max: null })).error)
  assert.ifError((await publishChanges(event)).error)
  const c = await competitionOf(cat)
  assert.deepEqual([c.kind, c.team_min, c.team_max, c.leg_order_enabled], ['individual', null, null, false])
})

test('T-13 leg order never lands on an individual competition, and a foreign id is refused', async () => {
  const event = await paidEvent()
  const cat = event.categoryIds[0]
  // Staged on a team, and the team then goes back to individual in the same round of changes.
  await asTeamCompetition(cat)
  assert.ifError((await stage(event, 'form', { leg_order: { [cat]: true } })).error)
  assert.ifError((await stageItem(event, { kind: 'individual', team_min: null, team_max: null })).error)
  assert.ifError((await publishChanges(event)).error)
  assert.equal((await competitionOf(cat)).leg_order_enabled, false)

  const other = await paidEvent()
  const foreign = await stage(event, 'form', { leg_order: { [other.categoryIds[0]]: true } })
  assert.equal(foreign.error?.message, 'foreign_id')
})

test('T-13 a draft stores the size and the leg order, with no lock', async () => {
  const tag = crypto.randomUUID().slice(0, 8)
  const ev = unwrap(await admin().from('events').insert({ name: `Teams ${tag}`, slug: `teams-${tag}` }).select().single(), 'event')
  unwrap(await admin().from('registration_settings').insert({ event_id: ev.id, club_id: ZT_CLUB }).select(), 'settings')
  const saved = unwrap(await rpc('save_registration_section', {
    p_event_id: ev.id, p_section: 'competitions',
    p_value: { pricing_mode: 'free', items: [ITEM(null, { team_min: 3, team_max: 4 })] },
  }), 'save competitions')
  const cat = saved.categoryIds[0]
  seen.add(cat)
  unwrap(await rpc('save_registration_section', {
    p_event_id: ev.id, p_section: 'form', p_value: { leg_order: { [cat]: true } },
  }), 'save form')
  const c = await competitionOf(cat)
  assert.deepEqual([c.team_min, c.team_max, c.leg_order_enabled], [3, 4, true])

  // Save again as individual: the leg order goes with the team.
  unwrap(await rpc('save_registration_section', {
    p_event_id: ev.id, p_section: 'competitions',
    p_value: { pricing_mode: 'free', items: [ITEM(cat, { kind: 'individual', team_min: null, team_max: null })] },
  }), 'save individual')
  const back = await competitionOf(cat)
  assert.deepEqual([back.team_min, back.team_max, back.leg_order_enabled], [null, null, false])
})

test('T-13 W-63\'s consent lock still holds beside a leg order', async () => {
  const event = await paidEvent()
  const cat = event.categoryIds[0]
  unwrap(await db().from('event_consents').insert({ event_id: event.eventId, kind: 'custom', text: 'Na własną odpowiedzialność.', sort_order: 9 }).select(), 'consent')
  await paidOrderOk(event)
  await asTeamCompetition(cat)
  const r = await stage(event, 'form', { consents: [], leg_order: { [cat]: false } })
  assert.equal(r.error?.message, 'consent_locked', JSON.stringify(r))
  assert.equal((await rows('registration_pending_changes', { event_id: event.eventId })).length, 0)
})
