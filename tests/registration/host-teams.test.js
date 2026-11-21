// Names of relay teams set up on a timing host (migration 20261121110000_host_teams.sql): the host
// pushes host_teams, results_team_names() serves them to the public results next to the
// registration teams', anon cannot touch the table, and purge_host_team_names() replaces a name
// 30 days after the race. Scenarios HT-1…HT-5 in docs/registration/scenario-matrix.md. LOCAL stack only.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { localEnv, sessionFor } from './helpers/stack.js'
import { acceptAgreement } from './helpers/registrationFixtures.js'
import { db, one, rand, runnerEmail } from './helpers/orders.js'
import { adult } from './helpers/groups.js'
import { captain, freeTeamEvent, teamOk } from './helpers/teams.js'

const ok = (r) => { assert.equal(r.error, null, r.error?.message); return r.data }
const anon = () => { const { url, anonKey } = localEnv(); return createClient(url, anonKey, { auth: { persistSession: false } }) }
const made = []
after(async () => {
  for (const id of made) await db().from('events').delete().eq('id', id)
})

const isoDay = (daysAgo) => new Date(Date.now() - daysAgo * 86400_000).toISOString().slice(0, 10)

/** A plain timing-host event (no registration_settings) with one relay team of `size` runners. */
async function hostEvent({ daysAgo = 0, size = 2, name = 'Renifery' } = {}) {
  const ev = ok(await db().from('events').insert({ name: `Sztafeta ${rand()}`, slug: `sztafeta-${rand()}`, date: isoDay(daysAgo) }).select().single())
  made.push(ev.id)
  const cat = ok(await db().from('categories').insert({ event_id: ev.id, name: 'Sztafeta', slug: `s-${rand()}`, team_mode: 'relay_free' }).select().single())
  const teamId = crypto.randomUUID()
  const people = ok(await db().from('participants').insert(Array.from({ length: size }, (_, i) => ({
    event_id: ev.id, category_id: cat.id, first_name: 'Ola', last_name: `Leśna${i}`, team_id: teamId,
  }))).select())
  ok(await db().from('host_teams').insert({ id: teamId, event_id: ev.id, name }))
  return { eventId: ev.id, teamId, people }
}
const names = async (eventId) => ok(await anon().rpc('results_team_names', { p_event_id: eventId }))

test('HT-1 results_team_names gives anon the host teams of that event that have a live member', async () => {
  const a = await hostEvent({ name: 'Renifery' })
  const b = await hostEvent({ name: 'Elfy' })
  assert.deepEqual(await names(a.eventId), [{ team_id: a.teamId, name: 'Renifery' }])

  ok(await db().from('participants').update({ removed_at: new Date().toISOString() }).in('id', b.people.map((p) => p.id)))
  assert.deepEqual(await names(b.eventId), [], 'a team with no live member has no public name')
})

test('HT-2 a registration team keeps its own name even when host_teams holds the same id', async () => {
  await acceptAgreement('zatyrani-test')
  const owner = await sessionFor('owner@zatyrani-test.local')
  const event = await freeTeamEvent(owner)
  const cat = event.categoryIds[0]
  const out = await teamOk(event, { members: [captain(runnerEmail('captain')), adult(cat, 'adult')] })
  ok(await db().from('host_teams').insert({ id: out.teamId, event_id: event.eventId, name: 'Podszyta nazwa' }))
  try {
    const rows = (await names(event.eventId)).filter((r) => r.team_id === out.teamId)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].name, (await one('teams', { id: out.teamId })).name)
  } finally {
    await db().from('host_teams').delete().eq('id', out.teamId)
  }
})

test('HT-3 anon can neither read nor write host_teams', async () => {
  const a = await hostEvent()
  const read = await anon().from('host_teams').select('id').eq('id', a.teamId)
  assert.ok(read.error || read.data.length === 0, 'anon reads nothing')
  const write = await anon().from('host_teams').insert({ id: crypto.randomUUID(), event_id: a.eventId, name: 'X' })
  assert.ok(write.error, 'anon cannot insert')
  assert.equal((await one('host_teams', { id: a.teamId })).name, 'Renifery')
})

test('HT-4 purge_host_team_names replaces the name 30 days after the race and leaves a later one', async () => {
  const due = await hostEvent({ daysAgo: 31, name: 'Rodzina Leśnych' })
  const recent = await hostEvent({ daysAgo: 28, name: 'Rodzina Polnych' })
  const bad = ok(await db().from('events').insert({ name: `Zła data ${rand()}`, slug: `zla-${rand()}`, date: '2026-02-30' }).select().single())
  made.push(bad.id)
  const badTeam = crypto.randomUUID()
  ok(await db().from('host_teams').insert({ id: badTeam, event_id: bad.id, name: 'Bez daty' }))

  const { data: n, error } = await db().rpc('purge_host_team_names')
  assert.equal(error, null, error?.message)
  assert.ok(n >= 1)
  assert.equal((await one('host_teams', { id: due.teamId })).name, `Drużyna ${due.teamId.slice(0, 8).toUpperCase()}`)
  assert.equal((await one('host_teams', { id: recent.teamId })).name, 'Rodzina Polnych')
  assert.equal((await one('host_teams', { id: badTeam })).name, 'Bez daty', 'an impossible date is no date, not an error')

  assert.ok((await anon().rpc('purge_host_team_names')).error, 'anon cannot run the purge')
})

test('HT-5 a named host team loses its public name once a registration runner is moved into it', async () => {
  await acceptAgreement('zatyrani-test')
  const owner = await sessionFor('owner@zatyrani-test.local')
  const event = await freeTeamEvent(owner)
  const cat = event.categoryIds[0]
  const out = await teamOk(event, { members: [captain(runnerEmail('captain')), adult(cat, 'adult')] })
  const hostTeam = crypto.randomUUID()
  ok(await db().from('participants').insert({ event_id: event.eventId, category_id: cat, first_name: 'Ola', last_name: 'Biuro', team_id: hostTeam }))
  ok(await db().from('host_teams').insert({ id: hostTeam, event_id: event.eventId, name: 'Z biura' }))
  try {
    assert.ok((await names(event.eventId)).some((r) => r.team_id === hostTeam && r.name === 'Z biura'))
    const moved = await one('participants', { registration_id: out.registrations[1].id })
    ok(await db().from('participants').update({ team_id: hostTeam }).eq('id', moved.id))
    assert.ok(!(await names(event.eventId)).some((r) => r.team_id === hostTeam), 'the host name is no longer published')
  } finally {
    await db().from('host_teams').delete().eq('id', hostTeam)
  }
})
