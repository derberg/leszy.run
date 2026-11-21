import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hostTeamNameRefusal, normalizeHostTeamName, mergeTeamNames, neutralTeamName, isRegistrationTeam, HOST_TEAM_NAME_MAX } from '../src/lib/hostTeams.js'
import { isTestRow, newSkipSets, rememberSkipped } from '../src/sync/configSync.js'

const EVENT = '11111111-2222-4333-8444-555555555555'
const OTHER = '99999999-2222-4333-8444-555555555555'
const TEAM = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const host = [{ id: 'p1', registrationId: null }, { id: 'p2', registrationId: null }]
const ask = (over = {}) => hostTeamNameRefusal({ eventId: EVENT, teamId: TEAM, name: 'Renifery', members: host, existing: null, ...over })

test('a host team gets its trimmed name, inner whitespace collapsed', () => {
  assert.deepEqual(ask({ name: '  Renifery \t z  Lasu ' }), { refusal: null, name: 'Renifery z Lasu' })
  assert.equal(normalizeHostTeamName(42), null)
})

test('bad ids, an empty or too long name are 400', () => {
  assert.equal(ask({ teamId: 'nope' }).refusal.status, 400)
  assert.equal(ask({ eventId: 'nope' }).refusal.status, 400)
  assert.equal(ask({ name: '   ' }).refusal.status, 400)
  assert.equal(ask({ name: null }).refusal.status, 400)
  assert.equal(ask({ name: 'ł'.repeat(HOST_TEAM_NAME_MAX) }).refusal, null, 'counted in characters, not bytes')
  assert.equal(ask({ name: 'x'.repeat(HOST_TEAM_NAME_MAX + 1) }).refusal.status, 400)
})

test('a team id with no live member in the event is 404', () => {
  assert.equal(ask({ members: [] }).refusal.status, 404)
})

test('a registration team (any member from the online registration) is refused: its name is never stored on a host', () => {
  const r = ask({ members: [{ id: 'p1', registrationId: null }, { id: 'p2', registrationId: 'reg-1' }] })
  assert.equal(r.refusal.status, 409)
  assert.equal(isRegistrationTeam([{ registrationId: 'reg-1' }]), true)
  assert.equal(isRegistrationTeam(host), false)
})

test('a stored name of another event under the same id is 409; a rename of the same event passes', () => {
  assert.equal(ask({ existing: { eventId: OTHER } }).refusal.status, 409)
  assert.equal(ask({ existing: { eventId: EVENT } }).refusal, null)
})

test('the host names win over Supabase for the same team, the rest are kept', () => {
  assert.deepEqual(
    mergeTeamNames({ a: 'Mikołaje', b: 'Stara nazwa' }, [{ id: 'b', name: 'Nowa nazwa' }, { id: 'c', name: 'Elfy' }]),
    { a: 'Mikołaje', b: 'Nowa nazwa', c: 'Elfy' },
  )
  assert.deepEqual(mergeTeamNames(undefined, undefined), {})
})

test('the neutral name spells Supabase team_neutral_name()', () => {
  assert.equal(neutralTeamName(TEAM), 'Drużyna AAAAAAAA')
})

test('configSync refuses the host_teams of a refused event and pulls the rest', () => {
  const skip = newSkipSets()
  rememberSkipped('events', { id: 'ev-test' }, skip)
  assert.equal(isTestRow('host_teams', { id: 't1', event_id: 'ev-test' }, skip), true)
  assert.equal(isTestRow('host_teams', { id: 't2', event_id: 'ev-real' }, skip), false)
})
