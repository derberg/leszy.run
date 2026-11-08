// Team timing (migration 20261118100000_team_timing.sql): the timing host learns which team and leg
// each runner is in from their registration, a team competition is a relay in any order by default,
// and the public results read a relay's laps and team names. Scenarios TT-1…TT-4 in
// docs/registration/scenario-matrix.md. LOCAL stack only.
import { after, afterEach, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createClient } from '@supabase/supabase-js'
import { localEnv, sessionFor } from './helpers/stack.js'
import { acceptAgreement } from './helpers/registrationFixtures.js'
import { db, one, profileFor, rows, runnerEmail } from './helpers/orders.js'
import { adult } from './helpers/groups.js'
import { assertSlotInvariant } from './helpers/slotInvariant.js'
import { captain, freeTeamEvent, squadEdit, teamOk } from './helpers/teams.js'

let owner
const seen = new Set()
const watch = (event) => { event.categoryIds.forEach((c) => seen.add(c)); return event }
const ok = (r) => { assert.equal(r.error, null, r.error?.message); return r.data }
const anon = () => { const { url, anonKey } = localEnv(); return createClient(url, anonKey, { auth: { persistSession: false } }) }

before(async () => {
  await acceptAgreement('zatyrani-test')
  owner = await sessionFor('owner@zatyrani-test.local')
})
afterEach(async () => {
  for (const categoryId of seen) await assertSlotInvariant(categoryId)
  seen.clear()
})
after(() => {})

/** A free team of `size` with leg order on: the captain, then adults. */
async function team(event, size = 3) {
  const cat = event.categoryIds[0]
  const email = runnerEmail('captain')
  const members = [captain(email), ...Array.from({ length: size - 1 }, () => adult(cat, 'adult'))].map((m, i) => ({ ...m, leg: i + 1 }))
  const out = await teamOk(event, { members })
  return { cat, teamId: out.teamId, ids: out.registrations.map((r) => r.id), actor: await profileFor(email) }
}
const participantOf = (registrationId) => one('participants', { registration_id: registrationId })

test('TT-1 a team competition is a relay in any order; each member\'s participant carries the team and leg', async () => {
  const event = watch(await freeTeamEvent(owner, { legOrder: true }))
  const { cat, teamId, ids } = await team(event)
  assert.equal((await one('categories', { id: cat })).team_mode, 'relay_free', 'a collected leg order is a wish, not a fixed order')
  for (const [i, id] of ids.entries()) {
    const p = await participantOf(id)
    assert.equal(p.team_id, teamId)
    assert.equal(p.team_leg, i + 1)
  }
})

test('TT-2 a captain\'s reorder reaches the participants', async () => {
  const event = watch(await freeTeamEvent(owner, { legOrder: true }))
  const { teamId, ids, actor } = await team(event, 3)
  ok(await squadEdit(event, teamId, actor, { op: 'reorder', legs: [ids[2], ids[0], ids[1]] }))
  assert.deepEqual(await Promise.all(ids.map(async (id) => (await participantOf(id)).team_leg)), [2, 3, 1])
})

test('TT-3 results_team_names gives anon the live teams of that event only', async () => {
  const event = watch(await freeTeamEvent(owner))
  const other = watch(await freeTeamEvent(owner))
  const { teamId } = await team(event, 2)
  const { teamId: otherTeam } = await team(other, 2)
  const { data, error } = await anon().rpc('results_team_names', { p_event_id: event.eventId })
  assert.equal(error, null)
  const ids = data.map((t) => t.team_id)
  assert.ok(ids.includes(teamId))
  assert.ok(!ids.includes(otherTeam))
  assert.equal(data.find((t) => t.team_id === teamId).name, (await one('teams', { id: teamId })).name)
})

test('TT-4 anon reads a relay\'s laps and the members\' teams, and can write neither', async () => {
  const event = watch(await freeTeamEvent(owner))
  const { cat, teamId, ids } = await team(event, 2)
  const p = await participantOf(ids[0])
  const run = ok(await db().from('race_runs').insert({ category_id: cat, status: 'active', started_at: new Date().toISOString() }).select().single())
  ok(await db().from('team_laps').insert({ race_run_id: run.id, team_id: teamId, participant_id: p.id, closed_at: new Date().toISOString() }))

  const lapsRead = await anon().from('team_laps').select('id, team_id, participant_id, closed_at, deleted_at').eq('race_run_id', run.id)
  assert.equal(lapsRead.error, null)
  assert.equal(lapsRead.data.length, 1)
  const pub = await anon().from('participants_public').select('id, team_id, team_leg').eq('id', p.id)
  assert.equal(pub.error, null)
  assert.equal(pub.data[0].team_id, teamId)

  const write = await anon().from('team_laps').insert({ race_run_id: run.id, team_id: teamId, participant_id: p.id, closed_at: new Date().toISOString() })
  assert.ok(write.error, 'anon cannot add a lap')
  assert.equal((await rows('team_laps', { race_run_id: run.id })).length, 1)
})
