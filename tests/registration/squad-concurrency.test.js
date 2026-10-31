// Plan 5, task 4: concurrency of team_squad_edit (T-35 in docs/registration/scenario-matrix.md).
// Every call runs on its own PostgREST connection at the same time. Invariants: no 40P01, taken
// never moves, and no participant is written past closes_at. LOCAL stack only.
import { after, afterEach, before, test } from 'node:test'
import assert from 'node:assert/strict'
import postgres from 'postgres'
import { localEnv, sessionFor } from './helpers/stack.js'
import { acceptAgreement } from './helpers/registrationFixtures.js'
import {
  attemptFor, competitionOf, confirm, db, one, overdue, profileFor, rows, rpc, runnerEmail,
} from './helpers/orders.js'
import { adult, groupMeta, isDeadlock } from './helpers/groups.js'
import { assertSlotInvariant } from './helpers/slotInvariant.js'
import { STAFETA, captain, freeTeamEvent, paidTeamEvent, squadEdit, teamOk } from './helpers/teams.js'
import { newToken } from '../../supabase/functions/_shared/registration/tokens.js'

let owner
let sqlClient
const sql = () => (sqlClient ??= postgres(localEnv().dbUrl, { max: 2, onnotice: () => {} }))
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
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })
const noDeadlock = (r, label) => assert.ok(!isDeadlock(r), `${label}: ${r.error?.message}`)
/** Starts the two calls together, the first one first on even rounds and last on odd ones. */
const bothOrders = async (round, a, b) => (round % 2
  ? (await Promise.all([b(), a()])).reverse()
  : Promise.all([a(), b()]))

async function pair(event) {
  const cat = event.categoryIds[0]
  const email = runnerEmail('captain')
  const members = [captain(email), adult(cat, 'adult')]
  const out = await teamOk(event, { members })
  return { cat, out, teamId: out.teamId, ids: out.registrations.map((r) => r.id), actor: await profileFor(email), members }
}
const newAdult = (cat) => adult(cat, 'adult', runnerEmail('new'))
const add = (event, t, meta) => squadEdit(event, t.teamId, t.actor, { op: 'add', person: newAdult(t.cat) }, meta)

test('T-35a two parallel adds to a team at max − 1 → one team_full, on a free and on a paid team', async () => {
  const competitions = [STAFETA(50, { teamMax: 3 })]
  for (const event of [await free({ competitions }), await paid({ competitions })]) {
    const meta = await groupMeta(event.eventId)
    for (let i = 0; i < 10; i++) {
      const t = await pair(event)
      const rs = await Promise.all([add(event, t, meta), add(event, t, meta)])
      rs.forEach((r) => noDeadlock(r, `round ${i}`))
      assert.deepEqual(rs.filter((r) => r.error).map((r) => r.error.message), ['team_full'], JSON.stringify(rs))
      assert.equal((await rows('registrations', { team_id: t.teamId })).length, 3)
    }
  }
})

test('T-35b 50 edits racing „Opublikuj zmiany” moving closes_at → no 40P01, nothing written past the new closes_at', async () => {
  const event = await free({ capacity: 60 })
  const cat = event.categoryIds[0]
  const teams = []
  while (teams.length < 50) teams.push(...await Promise.all(Array.from({ length: 5 }, () => pair(event))))
  const before = await taken(cat)
  const meta = await groupMeta(event.eventId)

  const closes = new Date(Date.now() + 500)
  const staged = await rpc('stage_registration_section', {
    p_event_id: event.eventId, p_section: 'basics', p_actor: owner.profileId,
    p_value: { closes_at: closes.toISOString() },
  })
  assert.equal(staged.error, null, staged.error?.message)

  const publish = rpc('publish_registration_changes', {
    p_event_id: event.eventId, p_actor: owner.profileId, p_expected_updated_at: null,
  }).then((r) => ({ ...r, doneAt: Date.now() }))
  const edits = teams.map(async (t, i) => {
    await sleep(i * 20) // from before the publish until well past closes_at
    return i % 2
      ? add(event, t, meta)
      : squadEdit(event, t.teamId, t.actor, { op: 'swap', registrationId: t.ids[1], person: newAdult(cat) }, meta)
  })
  const [pub, ...rs] = await Promise.all([publish, ...edits])

  assert.equal(pub.error, null, pub.error?.message)
  assert.ok(pub.doneAt < closes.getTime(), 'the publish must land before the moment it names, or the test proves nothing')
  rs.forEach((r, i) => noDeadlock(r, `edit ${i}`))
  const closed = rs.filter((r) => r.error)
  assert.ok(closed.every((r) => r.error.message === 'squad_closed'), JSON.stringify(closed.map((r) => r.error)))
  const committed = rs.filter((r) => !r.error)
  assert.ok(committed.length > 0, 'no edit landed before the close')
  assert.ok(closed.length > 0, 'no edit landed after the close')

  const addedIds = committed.flatMap((r) => r.data.added.map((a) => a.id))
  const { data: stamps, error } = await db().from('participants').select('created_at, updated_at').in('registration_id', addedIds)
  assert.ifError(error)
  assert.equal(stamps.length, addedIds.length)
  for (const p of stamps) {
    assert.ok(new Date(p.created_at) < closes, `${p.created_at} is past ${closes.toISOString()}`)
    assert.ok(new Date(p.updated_at) < closes, `${p.updated_at} is past ${closes.toISOString()}`)
  }
  const { data: removed, error: e2 } = await db().from('participants').select('removed_at')
    .eq('event_id', event.eventId).not('removed_at', 'is', null)
  assert.ifError(e2)
  assert.equal(removed.length, committed.filter((r) => r.data.removed.length).length)
  assert.ok(removed.every((p) => new Date(p.removed_at) < closes))
  assert.equal((await rows('participants', { event_id: event.eventId })).length, 100 + addedIds.length)
  assert.equal(await taken(cat), before)
})

/** What a publish does: both locks, a change, a commit `holdMs` later, while `edit` waits for them. */
async function whilePublishHolds(event, change, edit, holdMs = 400) {
  let result
  await sql().begin(async (tx) => {
    await tx`select 1 from public.competitions where event_id = ${event.eventId} order by category_id for update`
    await tx`select 1 from public.registration_settings where event_id = ${event.eventId} for update`
    await change(tx)
    result = edit()
    await sleep(holdMs)
  })
  return result
}

test('T-35e an edit that waited for a publish judges closes_at after the wait, by the clock, not by when it began', async () => {
  const event = await free()
  const t = await pair(event)
  const meta = await groupMeta(event.eventId)
  const closes = new Date(Date.now() + 200).toISOString() // passes while the edit waits
  const r = await whilePublishHolds(event,
    (tx) => tx`update public.registration_settings set closes_at = ${closes} where event_id = ${event.eventId}`,
    () => add(event, t, meta))
  assert.equal(r.error?.message, 'squad_closed', JSON.stringify(r))
  assert.equal((await rows('registrations', { team_id: t.teamId })).length, 2)
})

test('T-35e an edit that waited for a size change judges the new team_max', async () => {
  const event = await free()
  const t = await pair(event)
  const meta = await groupMeta(event.eventId)
  const r = await whilePublishHolds(event,
    (tx) => tx`update public.competitions set team_max = 2 where category_id = ${t.cat}`,
    () => add(event, t, meta))
  assert.equal(r.error?.message, 'team_full', JSON.stringify(r))
})

test('T-35c 100 rounds: an add racing expire_orders on the pending team order → no 40P01, nothing held', async () => {
  const event = await paid()
  const cat = event.categoryIds[0]
  const meta = await groupMeta(event.eventId)
  let landed = 0
  for (let i = 0; i < 100; i++) {
    const t = await pair(event)
    await overdue(t.out.orderId)
    const [edit, expired] = await bothOrders(i, () => add(event, t, meta), () => rpc('expire_orders', {}))
    noDeadlock(edit, `round ${i} add`)
    noDeadlock(expired, `round ${i} expire`)
    assert.equal(expired.error, null, expired.error?.message)
    if (edit.error) assert.equal(edit.error.message, 'team_inactive', `round ${i}`)
    else landed++
    // SKIP LOCKED: an expiry that met the add's order lock left the order to the next run.
    assert.equal((await rpc('expire_orders', {})).error, null)
    const regs = await rows('registrations', { team_id: t.teamId })
    assert.equal(regs.length, edit.error ? 2 : 3, `round ${i}`)
    assert.ok(regs.every((r) => r.status === 'expired'), JSON.stringify(regs.map((r) => r.status)))
    assert.ok((await one('teams', { id: t.teamId })).released_at, `round ${i}`)
    assert.equal(await taken(cat), 0)
  }
  console.log(`T-35c: the add landed in ${landed} of 100 rounds`)
})

test('T-35d 100 rounds: a swap racing accept_consent_request → accepted then cancelled, or gone; never both live', async () => {
  const event = await free({ capacity: 150 })
  const cat = event.categoryIds[0]
  const meta = await groupMeta(event.eventId)
  const seenOutcomes = { accepted: 0, gone: 0 }
  for (let i = 0; i < 100; i++) {
    const t = await pair(event)
    const token = await newToken()
    assert.equal((await rpc('issue_consent_request', { p_registration_id: t.ids[1], p_token_hash: token.hash })).data, true)
    const memberProfile = await profileFor(t.members[1].email)
    const [swap, acc] = await bothOrders(i,
      () => squadEdit(event, t.teamId, t.actor, { op: 'swap', registrationId: t.ids[1], person: newAdult(cat) }, meta),
      () => rpc('accept_consent_request', { p_token_hash: token.hash, p_profile_id: memberProfile, p_edits: null, p_meta: meta }))
    noDeadlock(swap, `round ${i} swap`)
    noDeadlock(acc, `round ${i} accept`)
    assert.equal(swap.error, null, swap.error?.message)
    const old = await one('registrations', { id: t.ids[1] })
    assert.equal(old.status, 'cancelled', `round ${i}`)
    assert.ok((await one('participants', { registration_id: old.id })).removed_at, `round ${i}`)
    if (acc.error) {
      assert.equal(acc.error.message, 'gone', `round ${i}`)
      assert.equal(old.consent_state, 'awaiting', `round ${i}`)
      seenOutcomes.gone++
    } else {
      assert.equal(acc.data.status, 'accepted', `round ${i}`)
      assert.equal(old.consent_state, 'accepted', `round ${i}`)
      seenOutcomes.accepted++
    }
    const live = (await rows('registrations', { team_id: t.teamId })).filter((r) => r.status === 'confirmed')
    assert.equal(live.length, 2, `round ${i}`)
    assert.ok(!live.some((r) => r.id === old.id))
  }
  assert.equal(await taken(cat), 100)
  console.log(`T-35d: ${JSON.stringify(seenOutcomes)}`)
})

test('T-35 a payment racing an add on the pending team → the new member is confirmed with the team, one slot', async () => {
  const event = await paid()
  const cat = event.categoryIds[0]
  const meta = await groupMeta(event.eventId)
  for (let i = 0; i < 20; i++) {
    const t = await pair(event)
    const att = await attemptFor(t.out.orderId, t.out.total)
    const [edit, paidR] = await bothOrders(i, () => add(event, t, meta), () => confirm(t.out.orderId, att.txn, t.out.total))
    noDeadlock(edit, `round ${i} add`)
    noDeadlock(paidR, `round ${i} confirm`)
    assert.equal(edit.error, null, edit.error?.message)
    assert.equal(paidR.data.outcome, 'confirmed', JSON.stringify(paidR.data))
    const regs = await rows('registrations', { team_id: t.teamId })
    assert.equal(regs.length, 3)
    assert.ok(regs.every((r) => r.status === 'confirmed' && r.participant_id), `round ${i}`)
  }
  assert.equal(await taken(cat), 20)
})
