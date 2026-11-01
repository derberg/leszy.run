// Plan 5, task 9: a team's personal data under export-my-data, delete-my-account and the 30-day
// purge (T-81, T-82 and T-83 in docs/registration/scenario-matrix.md). The team's name is free
// text the captain typed, and it often names the family, so it must not outlive the people: both
// the captain's deletion and the purge replace it, and the team keeps its place on the start list.
// LOCAL stack only; every event and address is random.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { sessionFor } from './helpers/stack.js'
import { acceptAgreement, callFn } from './helpers/registrationFixtures.js'
import { attemptFor, confirmOk, db, one, rows, runnerEmail } from './helpers/orders.js'
import { adult, minor } from './helpers/groups.js'
import { captain, freeTeamEvent, paidTeamEvent, teamOk } from './helpers/teams.js'

const NEUTRAL = /^Drużyna [0-9A-F]{8}$/

let owner
before(async () => {
  await acceptAgreement('zatyrani-test')
  owner = await sessionFor('owner@zatyrani-test.local')
})

const sha256 = (t) => crypto.createHash('sha256').update(t).digest('hex')
const familyName = () => `Rodzina Leśnych ${crypto.randomBytes(3).toString('hex')}`

const warsawToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(new Date())
const isoDay = (offset) => {
  const [y, m, d] = warsawToday().split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + offset)).toISOString().slice(0, 10)
}

/** The relay squad: the captain, Piotr (an added adult), two children. Confirmed. */
async function relay({ paid = false } = {}) {
  const event = paid ? await paidTeamEvent(owner) : await freeTeamEvent(owner)
  const cat = event.categoryIds[0]
  const myEmail = runnerEmail('gdpr-captain')
  const piotrEmail = runnerEmail('gdpr-piotr')
  const session = await sessionFor(myEmail)
  const name = familyName()
  const out = await teamOk(event, {
    name,
    profileId: session.profileId,
    members: [
      captain(myEmail, { firstName: 'Ola', lastName: 'Leśna', city: 'Leszno' }),
      adult(cat, 'adult', piotrEmail, { firstName: 'Piotr', lastName: 'Borowy', gender: 'M' }),
      minor(cat, { firstName: 'Zosia', birthDate: '2009-05-05' }),
      minor(cat, { firstName: 'Staś', gender: 'M', birthDate: '2010-05-05' }),
    ],
  })
  if (paid) {
    const att = await attemptFor(out.orderId, out.total)
    assert.equal((await confirmOk(out.orderId, att.txn, out.total)).outcome, 'confirmed')
  }
  return { event, session, myEmail, piotrEmail, name, ...out }
}

async function deleteAccount(email, session) {
  const { error } = await db().from('auth_codes').insert({
    email, code_hash: sha256('123456'), purpose: 'delete_account', expires_at: new Date(Date.now() + 600000).toISOString(),
  })
  assert.ifError(error)
  const r = await callFn('delete-my-account', session, { action: 'confirm', code: '123456' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
}

const startList = async (eventId) => {
  const { data, error } = await db().rpc('start_list', { p_event_id: eventId })
  assert.ifError(error)
  return data
}

test('T-81 the captain\'s export holds the team and both children, never the added adult; a member\'s export names the team', async () => {
  const t = await relay({ paid: true })

  const mine = await callFn('export-my-data', t.session, {})
  assert.equal(mine.status, 200, JSON.stringify(mine.body))
  assert.deepEqual(mine.body.teams, [{
    name: t.name, competition: 'Sztafeta', event_name: mine.body.teams[0].event_name,
    event_date: mine.body.teams[0].event_date, size: 4, status: 'confirmed', created_at: mine.body.teams[0].created_at,
  }])
  assert.deepEqual(mine.body.registrations.map((r) => r.first_name), ['Ola'])
  assert.equal(mine.body.registrations[0].team_name, t.name)
  assert.deepEqual(mine.body.registrations_as_guardian.map((r) => r.first_name).sort(), ['Staś', 'Zosia'])
  const whole = JSON.stringify(mine.body)
  assert.ok(!whole.includes(t.piotrEmail))
  assert.ok(!whole.includes('Borowy'))
  assert.ok(!whole.includes('Piotr'))

  const piotr = await sessionFor(t.piotrEmail)
  const his = await callFn('export-my-data', piotr, {})
  assert.equal(his.status, 200, JSON.stringify(his.body))
  assert.deepEqual(his.body.teams, [], 'only the captain holds the team record')
  assert.equal(his.body.registrations[0].team_name, t.name, 'the team he runs in is his data too')
})

test('T-82 the captain deletes their account → the team stays listed under a neutral name, and team-squad answers 404 to any session', async () => {
  const t = await relay()
  const before = await startList(t.event.eventId)
  assert.equal(before.entries.find((e) => e.kind === 'team').name, t.name)

  await deleteAccount(t.myEmail, t.session)

  const team = await one('teams', { id: t.teamId })
  assert.match(team.name, NEUTRAL)
  assert.equal(team.released_at, null, 'the team keeps its place')
  assert.ok(team.captain_registration_id)

  const after = await startList(t.event.eventId)
  const entry = after.entries.find((e) => e.kind === 'team')
  assert.equal(entry.name, team.name)
  assert.equal(entry.size, 4)
  assert.ok(!entry.members.includes('Ola'), 'the deleted captain is not named')
  assert.equal(entry.town, null)
  assert.ok(!JSON.stringify(after).includes(t.name))
  assert.equal(after.competitions[0].free + after.competitions[0].paid, before.competitions[0].free + before.competitions[0].paid)

  for (const session of [owner, await sessionFor(t.piotrEmail)]) {
    const r = await callFn('team-squad', session, { teamId: t.teamId, action: 'get' })
    assert.equal(r.status, 404, JSON.stringify(r.body))
  }
  const dead = await callFn('team-squad', t.session, { teamId: t.teamId, action: 'get' })
  assert.equal(dead.status, 401, 'the session went with the account')
})

test('T-82 a released team of a captain who deletes their account loses its name too, and a member deleting theirs changes nothing', async () => {
  const event = await paidTeamEvent(owner)
  const email = runnerEmail('gdpr-pending')
  const session = await sessionFor(email)
  const name = familyName()
  const pending = await teamOk(event, { name, profileId: session.profileId, members: [captain(email), adult(event.categoryIds[0], 'adult')] })

  await deleteAccount(email, session)
  const released = await one('teams', { id: pending.teamId })
  assert.ok(released.released_at, 'the pending order was cancelled')
  assert.match(released.name, NEUTRAL)

  const t = await relay()
  await deleteAccount(t.piotrEmail, await sessionFor(t.piotrEmail))
  assert.equal((await one('teams', { id: t.teamId })).name, t.name)
})

test('T-82 two neutral names in one competition do not collide', async () => {
  const event = await freeTeamEvent(owner)
  const made = []
  for (const tag of ['a', 'b']) {
    const email = runnerEmail(`gdpr-two-${tag}`)
    const session = await sessionFor(email)
    const out = await teamOk(event, { profileId: session.profileId, members: [captain(email), adult(event.categoryIds[0], 'adult')] })
    made.push({ email, session, teamId: out.teamId })
  }
  for (const m of made) await deleteAccount(m.email, m.session)
  const teams = await rows('teams', { event_id: event.eventId })
  assert.equal(new Set(teams.map((x) => x.name)).size, 2)
  assert.ok(teams.every((x) => NEUTRAL.test(x.name) && x.released_at === null))
})

test('T-83 the 30-day purge takes the names of teams of an event at least 30 days past, released ones too, and a second run has nothing to do', async () => {
  const old = await relay()
  const boundary = await relay()
  const recent = await relay()
  const released = await relay()
  const unreleased = await db().from('teams').update({ released_at: new Date().toISOString() }).eq('id', released.teamId)
  assert.ifError(unreleased.error)
  for (const [t, days] of [[old, 31], [boundary, 30], [recent, 29], [released, 31]]) {
    const moved = await db().from('registration_settings').update({ event_date: isoDay(-days) }).eq('event_id', t.event.eventId)
    assert.ifError(moved.error)
  }

  const first = await db().rpc('purge_registration_contact_data')
  assert.ifError(first.error)

  assert.match((await one('teams', { id: old.teamId })).name, NEUTRAL)
  assert.match((await one('teams', { id: boundary.teamId })).name, NEUTRAL)
  assert.match((await one('teams', { id: released.teamId })).name, NEUTRAL)
  assert.equal((await one('teams', { id: recent.teamId })).name, recent.name)
  assert.ok(!JSON.stringify(await startList(old.event.eventId)).includes(old.name), 'the name is gone from the list')
  assert.equal((await startList(old.event.eventId)).entries.filter((e) => e.kind === 'team').length, 1)

  const again = await db().rpc('purge_registration_contact_data')
  assert.ifError(again.error)
  assert.equal(again.data, 0)
})
