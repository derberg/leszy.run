// Runner self-service, task 12: the runner's own competition change (change_competition with
// p_actor_kind 'runner') and data edit (runner_edit_registration), gated by the club's switches
// registration_settings.runner_competition_change / runner_data_edit, and their audit in
// registration_changes (field names, never values). Scenarios RS-01…RS-08 in
// docs/registration/scenario-matrix.md. LOCAL stack only.
import { after, afterEach, before, test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import postgres from 'postgres'
import { localEnv, resetThrottle, sessionFor } from './helpers/stack.js'
import { acceptAgreement, callFn, createPublishedPaidEvent } from './helpers/registrationFixtures.js'
import { competitionOf, db, one, profileFor, rows, rpc, setSettings } from './helpers/orders.js'
import { BIEG, DZIECI, adult, minor, orderGroupOk } from './helpers/groups.js'
import { captain, freeTeamEvent, teamOk } from './helpers/teams.js'
import { paidEntry } from './helpers/transfers.js'
import { assertSlotInvariant } from './helpers/slotInvariant.js'
import { changeCompetition, changeOk } from './helpers/competitionChange.js'

const BIEG_5 = (capacity = 50) =>
  ({ name: 'Bieg 5 km', discipline: 'run', distanceLabel: '5 km', startTime: '11:00', capacity })
const BIEG_21 = (capacity = 50) =>
  ({ name: 'Bieg 21 km', discipline: 'run', distanceLabel: '21 km', startTime: '09:30', capacity })

let owner, ownerId
let sqlClient
const sql = () => (sqlClient ??= postgres(localEnv().dbUrl, { max: 1, onnotice: () => {} }))
const competitionsSeen = new Set()
const seen = (event) => { event.categoryIds.forEach((c) => competitionsSeen.add(c)); return event }

before(async () => {
  localEnv()
  await resetThrottle()
  await acceptAgreement('zatyrani-test')
  owner = await sessionFor('owner@zatyrani-test.local')
  ownerId = await profileFor('owner@zatyrani-test.local')
})
after(async () => { if (sqlClient) await sqlClient.end() })
afterEach(async () => {
  const competitions = [...competitionsSeen]
  competitionsSeen.clear()
  for (const id of competitions) await assertSlotInvariant(id)
})

const refused = (r, message) => {
  assert.equal(r.data, null, JSON.stringify(r.data))
  assert.equal(r.error?.message, message)
}
const reg = (id) => one('registrations', { id })
const changesOf = async (registrationId) =>
  (await rows('registration_changes', { registration_id: registrationId }))
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))

const runnerEdit = (registrationId, fields, actor = null) =>
  rpc('runner_edit_registration', { p_registration_id: registrationId, p_fields: fields, p_actor: actor })
const organizerEdit = (registrationId, fields) =>
  rpc('organizer_edit_registration', { p_registration_id: registrationId, p_fields: fields, p_actor: ownerId })
const ok = (r) => { assert.equal(r.error, null, r.error?.message); return r.data }

/** 9 km 60 zł, 5 km 40 zł, 21 km 80 zł, kids 20 zł. */
async function paidEvent() {
  return seen(await createPublishedPaidEvent(owner, {
    competitions: [BIEG(), BIEG_5(), BIEG_21(), DZIECI()],
    prices: { 'Bieg 9 km': 6000, 'Bieg 5 km': 4000, 'Bieg 21 km': 8000, 'Bieg dzieci 1 km': 2000 },
  }))
}

// ---------------------------------------------------------------- RS-01 switches

test('RS-01 the club unticked a switch: the runner is refused not_allowed, the organizer is not', async () => {
  const event = await paidEvent()
  const [, c5] = event.categoryIds
  const a = await paidEntry(event)
  await setSettings(event.eventId, { runner_competition_change: false, runner_data_edit: false })

  refused(await changeCompetition(a.reg.id, c5, -2000, { kind: 'runner', actor: a.profileId }), 'not_allowed')
  refused(await runnerEdit(a.reg.id, { city: 'Szubin' }, a.profileId), 'not_allowed')
  assert.equal((await reg(a.reg.id)).category_id, a.reg.category_id)
  assert.deepEqual(await changesOf(a.reg.id), [])

  // The organizer's paths ignore the runner switches.
  assert.equal(ok(await organizerEdit(a.reg.id, { city: 'Szubin' })).changed, true)
  assert.equal((await changeOk(a.reg.id, c5, -2000, { actor: ownerId })).outcome, 'refund')
  assert.deepEqual(await changesOf(a.reg.id), [], 'the organizer audits in organizer_actions, never here')
})

test('RS-01 each switch gates only its own action', async () => {
  const event = await paidEvent()
  const [, c5] = event.categoryIds
  const a = await paidEntry(event)
  await setSettings(event.eventId, { runner_competition_change: false })
  assert.equal(ok(await runnerEdit(a.reg.id, { city: 'Nakło' }, a.profileId)).changed, true)
  await setSettings(event.eventId, { runner_competition_change: true, runner_data_edit: false })
  assert.equal((await changeOk(a.reg.id, c5, -2000, { kind: 'runner', actor: a.profileId })).outcome, 'refund')
})

// ---------------------------------------------------------------- RS-02 runner competition change

test('RS-02 a runner change writes registration_changes for each outcome, grosze = the signed difference', async () => {
  const event = await paidEvent()
  const [c9, c5, c21] = event.categoryIds

  // Cheaper: moves and refunds.
  const a = await paidEntry(event)
  const out = await changeOk(a.reg.id, c5, -2000, { kind: 'runner', actor: a.profileId })
  assert.equal(out.outcome, 'refund')
  let [row] = await changesOf(a.reg.id)
  assert.equal(row.kind, 'competition')
  assert.equal(row.actor_profile_id, a.profileId)
  assert.equal(row.from_category_id, c9)
  assert.equal(row.to_category_id, c5)
  assert.equal(row.grosze, -2000)
  assert.deepEqual(row.fields, [])

  // Dearer: a surcharge is created, the row is written at creation.
  const b = await paidEntry(event)
  const s = await changeOk(b.reg.id, c21, 2000, { kind: 'runner', actor: b.profileId })
  assert.equal(s.outcome, 'surcharge')
  ;[row] = await changesOf(b.reg.id)
  assert.deepEqual([row.from_category_id, row.to_category_id, row.grosze], [c9, c21, 2000])
  assert.equal((await reg(b.reg.id)).category_id, c9, 'the entry moves only when the surcharge is paid')

  // Same price: moves.
  const { error } = await db().from('competition_prices').update({ amount: 6000 }).eq('category_id', c5)
  if (error) throw error
  const c = await paidEntry(event)
  assert.equal((await changeOk(c.reg.id, c5, 0, { kind: 'runner', actor: c.profileId })).outcome, 'moved')
  ;[row] = await changesOf(c.reg.id)
  assert.deepEqual([row.from_category_id, row.to_category_id, row.grosze], [c9, c5, 0])
})

test('RS-02 a refused runner change writes nothing; a replay of a refund writes no second row', async () => {
  const event = await paidEvent()
  const [, c5] = event.categoryIds
  const a = await paidEntry(event)
  const key = crypto.randomUUID()
  refused(await changeCompetition(a.reg.id, c5, -1000, { kind: 'runner', actor: a.profileId, key }), 'price_changed:-2000')
  assert.deepEqual(await changesOf(a.reg.id), [])
  await changeOk(a.reg.id, c5, -2000, { kind: 'runner', actor: a.profileId, key })
  const replay = await changeOk(a.reg.id, c5, -2000, { kind: 'runner', actor: a.profileId, key })
  assert.equal(replay.replay, true)
  assert.equal((await changesOf(a.reg.id)).length, 1)
})

test('RS-03 an order paid outside LESZY.RUN: a cheaper runner change is offline_paid even with the acknowledgement', async () => {
  const event = await paidEvent()
  const [c9, c5] = event.categoryIds
  const out = await orderGroupOk(event, [adult(c9, 'self')])
  const marked = await rpc('organizer_mark_paid_offline', { p_order_id: out.orderId, p_actor: ownerId, p_note: 'gotówka' })
  assert.equal(marked.error, null, marked.error?.message)
  const [r0] = await rows('registrations', { order_id: out.orderId })
  refused(await changeCompetition(r0.id, c5, -2000, { kind: 'runner', actor: r0.profile_id, offlineAck: true }), 'offline_paid')
  assert.deepEqual(await changesOf(r0.id), [])
  // The club still can.
  assert.equal((await changeOk(r0.id, c5, -2000, { actor: ownerId, offlineAck: true })).outcome, 'moved_offline_refund')
})

test('RS-03 a team entry: the runner cannot change its competition (team_competition)', async () => {
  const event = seen(await freeTeamEvent(owner))
  const cat = event.categoryIds[0]
  const t = await teamOk(event, { members: [captain(), adult(cat, 'adult')] })
  const regs = await rows('registrations', { team_id: t.teamId })
  assert.equal(regs.length, 2)
  for (const r of regs) refused(await changeCompetition(r.id, cat, 0, { kind: 'runner' }), 'team_competition')
})

// ---------------------------------------------------------------- RS-04 runner data edit

test('RS-04 the runner may not change the first name, last name or e-mail', async () => {
  const event = await paidEvent()
  const a = await paidEntry(event)
  for (const fields of [{ firstName: 'Ala' }, { lastName: 'Nowak' }, { email: 'x@y.pl' }, { city: 'Szubin', lastName: 'Nowak' }]) {
    refused(await runnerEdit(a.reg.id, fields, a.profileId), 'field_not_allowed')
  }
  refused(await runnerEdit(a.reg.id, { bib: '7' }, a.profileId), 'invalid_field')
  const r = await reg(a.reg.id)
  assert.equal(r.last_name, a.reg.last_name)
  assert.equal(r.city, a.reg.city)
  assert.deepEqual(await changesOf(a.reg.id), [])
})

test('RS-05 a birth date or gender change re-derives the age group and re-checks eligibility; a role change is refused', async () => {
  const event = await paidEvent()
  const [c9] = event.categoryIds
  const ins = await db().from('age_groups').insert([
    { category_id: c9, gender: 'K', label: 'K30', min_age: 30, max_age: 39 },
    { category_id: c9, gender: 'M', label: 'M40', min_age: 40, max_age: 49 },
  ])
  if (ins.error) throw ins.error
  await db().from('competitions').update({ max_age: 60 }).eq('category_id', c9)
  const a = await paidEntry(event)
  assert.equal(a.reg.birth_date, '1990-01-01')

  refused(await runnerEdit(a.reg.id, { birthDate: '1950-01-01' }, a.profileId), 'ineligible')
  refused(await runnerEdit(a.reg.id, { birthDate: '2015-01-01' }, a.profileId), 'role_change')
  refused(await runnerEdit(a.reg.id, { phone: 'abc' }, a.profileId), 'edit_invalid')

  const year = new Date().getUTCFullYear()
  const birth35 = `${year - 35}-01-01`
  const out = ok(await runnerEdit(a.reg.id, { birthDate: birth35 }, a.profileId))
  assert.equal(out.changed, true)
  assert.equal(out.ageGroupLabel, 'K30')
  assert.deepEqual(out.fields, ['birthDate'])
  const birth45 = `${year - 45}-01-01`
  const out2 = ok(await runnerEdit(a.reg.id, { birthDate: birth45, gender: 'M', phone: '+48600700800' }, a.profileId))
  assert.equal(out2.ageGroupLabel, 'M40')
  const r = await reg(a.reg.id)
  assert.equal(r.age_group_label, 'M40')
  assert.equal(r.gender, 'M')
  const p = await one('participants', { id: r.participant_id })
  assert.equal(p.birth_date, birth45)
  assert.equal(p.phone, '+48600700800')
})

test('RS-06 registration_changes holds field names only, never values; an edit that changes nothing writes nothing', async () => {
  const event = await paidEvent()
  const a = await paidEntry(event)
  ok(await runnerEdit(a.reg.id, { city: 'Szubin', club: 'Wilki', phone: a.reg.phone }, a.profileId))
  const none = ok(await runnerEdit(a.reg.id, { city: 'Szubin' }, a.profileId))
  assert.equal(none.changed, false)
  const changes = await changesOf(a.reg.id)
  assert.equal(changes.length, 1)
  const [row] = changes
  assert.equal(row.kind, 'data')
  assert.equal(row.actor_profile_id, a.profileId)
  assert.deepEqual(row.fields, ['city', 'club'])
  assert.equal(row.from_category_id, null)
  assert.equal(row.to_category_id, null)
  assert.equal(row.grosze, null)
  assert.doesNotMatch(JSON.stringify(row), /Szubin|Wilki/)
})

test('RS-07 a team member is refused team_member; the captain edits their own data', async () => {
  const event = seen(await freeTeamEvent(owner))
  const cat = event.categoryIds[0]
  const t = await teamOk(event, { members: [captain(), adult(cat, 'adult')] })
  const team = await one('teams', { id: t.teamId })
  const regs = await rows('registrations', { team_id: t.teamId })
  const member = regs.find((r) => r.id !== team.captain_registration_id)
  refused(await runnerEdit(member.id, { city: 'Szubin' }), 'team_member')
  assert.equal(ok(await runnerEdit(team.captain_registration_id, { city: 'Szubin' })).changed, true)
})

test('RS-07 a child entry (the guardian edits it): a gender change is fine, an adult birth date is a role change', async () => {
  const event = await paidEvent()
  const kids = event.categoryIds[3]
  const c9 = event.categoryIds[0]
  const out = await orderGroupOk(event, [adult(c9, 'self'), minor(kids)])
  const child = (await rows('registrations', { order_id: out.orderId })).find((r) => r.email === null)
  // Live but awaiting payment: the edit is allowed, as for the organizer.
  assert.equal(child.status, 'pending_payment')
  assert.equal(ok(await runnerEdit(child.id, { gender: 'M' })).changed, true)
  refused(await runnerEdit(child.id, { birthDate: '1990-01-01' }), 'role_change')
})

test('RS-08 edits and changes end at closes_at', async () => {
  const event = await paidEvent()
  const [, c5] = event.categoryIds
  const a = await paidEntry(event)
  await setSettings(event.eventId, { closes_at: new Date(Date.now() - 60_000).toISOString() })
  refused(await runnerEdit(a.reg.id, { city: 'Szubin' }, a.profileId), 'edits_closed')
  refused(await changeCompetition(a.reg.id, c5, -2000, { kind: 'runner', actor: a.profileId }), 'edits_closed')
})

test('RS-08 grants: runner_edit_registration is service_role only, the helpers have no grant, the table is closed to clients', async () => {
  const pg = sql()
  const fns = await pg`
    SELECT p.proname, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
           has_function_privilege('service_role', p.oid, 'EXECUTE') AS service
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('runner_edit_registration', 'registration_edit_person', 'registration_log_runner_change')`
  const by = Object.fromEntries(fns.map((f) => [f.proname, f]))
  assert.deepEqual([by.runner_edit_registration.anon, by.runner_edit_registration.auth, by.runner_edit_registration.service], [false, false, true])
  for (const name of ['registration_edit_person', 'registration_log_runner_change']) {
    assert.deepEqual([by[name].anon, by[name].auth, by[name].service], [false, false, false], name)
  }
  const [t] = await pg`
    SELECT c.relrowsecurity AS rls,
           has_table_privilege('anon', c.oid, 'SELECT') AS anon_select,
           has_table_privilege('authenticated', c.oid, 'INSERT') AS auth_insert
      FROM pg_class c WHERE c.oid = 'public.registration_changes'::regclass`
  assert.deepEqual(t, { rls: true, anon_select: false, auth_insert: false })
})

test('RS-02 the competition of a runner change is re-derived like the organizer\'s', async () => {
  const event = await paidEvent()
  const [c9, c5] = event.categoryIds
  const a = await paidEntry(event)
  await changeOk(a.reg.id, c5, -2000, { kind: 'runner', actor: a.profileId })
  assert.equal((await reg(a.reg.id)).category_id, c5)
  assert.deepEqual([(await competitionOf(c9)).taken, (await competitionOf(c5)).taken], [0, 1])
})

// ---------------------------------------------------------------- RS-09 export-my-data / delete-my-account

async function deleteAccount(email, session) {
  const { error } = await db().from('auth_codes').insert({
    email, code_hash: crypto.createHash('sha256').update('123456').digest('hex'), purpose: 'delete_account',
    expires_at: new Date(Date.now() + 600000).toISOString(),
  })
  assert.ifError(error)
  const r = await callFn('delete-my-account', session, { action: 'confirm', code: '123456' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
}

test('RS-09 export-my-data holds the person\'s own changes and their child\'s, names the competitions, never a value or another person\'s row; delete-my-account nulls the actor and keeps the rows', async () => {
  const event = await paidEvent()
  const [c9, c5, , kids] = event.categoryIds
  const a = await paidEntry(event)
  await changeOk(a.reg.id, c5, -2000, { kind: 'runner', actor: a.profileId })
  ok(await runnerEdit(a.reg.id, { city: 'Szubin' }, a.profileId))
  // Somebody else's change, in the same event.
  const b = await paidEntry(event)
  ok(await runnerEdit(b.reg.id, { club: 'Wilki' }, b.profileId))
  // A guardian edits their child's entry.
  const parentEmail = `runner-parent-${crypto.randomBytes(4).toString('hex')}@test.local`
  const fam = await orderGroupOk(event, [adult(c9, 'self', parentEmail), minor(kids)])
  const child = (await rows('registrations', { order_id: fam.orderId })).find((r) => r.email === null)
  ok(await runnerEdit(child.id, { gender: 'M' }, await profileFor(parentEmail)))

  const session = await sessionFor(a.email)
  const r = await callFn('export-my-data', session, {})
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const changes = r.body.registration_changes
  assert.equal(changes.length, 2, JSON.stringify(changes))
  assert.deepEqual(changes.map((c) => c.kind).sort(), ['competition', 'data'])
  const comp = changes.find((c) => c.kind === 'competition')
  assert.deepEqual(comp, {
    registration_id: a.reg.id, kind: 'competition', fields: [], from_competition: 'Bieg 9 km', to_competition: 'Bieg 5 km',
    grosze: -2000, by_you: true, created_at: comp.created_at,
  })
  const data = changes.find((c) => c.kind === 'data')
  assert.deepEqual([data.registration_id, data.fields, data.by_you], [a.reg.id, ['city'], true])
  const text = JSON.stringify(changes)
  assert.doesNotMatch(text, /Szubin|Wilki|actor_profile_id/)
  assert.ok(!text.includes(b.reg.id))

  const parent = await callFn('export-my-data', await sessionFor(parentEmail), {})
  assert.equal(parent.status, 200, JSON.stringify(parent.body))
  assert.deepEqual(parent.body.registration_changes.map((c) => [c.registration_id, c.fields, c.by_you]), [[child.id, ['gender'], true]])

  await deleteAccount(a.email, session)
  const kept = await changesOf(a.reg.id)
  assert.equal(kept.length, 2, 'the audit stays')
  assert.ok(kept.every((c) => c.actor_profile_id === null))
  assert.equal((await changesOf(b.reg.id))[0].actor_profile_id, b.profileId, 'nobody else\'s row is touched')
})
