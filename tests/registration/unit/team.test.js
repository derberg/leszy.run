// Plan 5, task 1: T-01…T-05, the team rules (squad size, adult captain, leg order, team name).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeTeamRequest, teamNameKey, validateSquadMember, validateTeam,
} from '../../../supabase/functions/_shared/registration/team.js'
import { warsawToday } from '../../../supabase/functions/_shared/registration/dates.js'

// 2026-10-28 10:00 in Warsaw.
const NOW = new Date('2026-10-28T09:00:00Z')
const TODAY = warsawToday(NOW)
const yearsAgo = (n) => {
  const [y, m, d] = TODAY.split('-').map(Number)
  return new Date(Date.UTC(y - n, m - 1, d)).toISOString().slice(0, 10)
}

const SESSION = 'kapitan@example.pl'
const CAPTAIN_MESSAGE = 'Kapitanem drużyny może być tylko osoba pełnoletnia.'
const CAPTAIN_SELF_MESSAGE = 'Kapitanem drużyny może być tylko osoba, która zapisuje drużynę.'

const competition = (over = {}) => ({
  teamMin: 3, teamMax: 5, legOrderEnabled: false,
  formFields: {}, competition: { minAge: null, maxAge: null, isKids: false },
  raceDate: '2027-03-14', reckoning: 'race_day', ageGroups: [], kidsGroups: [], ...over,
})

const person = (over = {}) => ({
  firstName: 'Ola', lastName: 'Leśna', birthDate: '1990-05-01', gender: 'K', email: 'ola@example.pl', phone: '600100200', ...over,
})
const captain = (over = {}, member = {}) => ({ person: person({ firstName: 'Kasia', email: SESSION, ...over }), leg: null, guardianConsent: false, ...member })
const adult = (i, over = {}) => ({ person: person({ firstName: `Ala${i}`, email: `ala${i}@example.pl`, ...over }), leg: null, guardianConsent: false })
const minor = (i, age) => ({ person: person({ firstName: `Ela${i}`, email: '', birthDate: yearsAgo(age) }), leg: null, guardianConsent: true })

const request = (members, over = {}) => ({ categoryId: 'c1', teamName: 'Wilcze Stado', members, membersConsent: true, ...over })
const run = (req, comp = competition(), ctx = {}) => validateTeam(req, { sessionEmail: SESSION, competition: comp, now: NOW, ...ctx })
const squad = (n) => [captain(), ...Array.from({ length: n - 1 }, (_, i) => adult(i))]

test('T-01 a 4-person squad → roles self, adult, minor, minor; every member in the team category', () => {
  const r = run(request([captain(), adult(1), minor(1, 17), minor(2, 16)]))
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.deepEqual(r.value.members.map((m) => m.role), ['self', 'adult', 'minor', 'minor'])
  assert.deepEqual(r.value.members.map((m) => m.categoryId), ['c1', 'c1', 'c1', 'c1'])
  assert.deepEqual(r.value.members.map((m) => m.leg), [null, null, null, null])
  assert.equal(r.value.teamName, 'Wilcze Stado')
  assert.equal(r.value.members[2].isMinor, true)
  assert.equal(r.value.members[0].firstName, 'Kasia')
  assert.deepEqual(r.errors, {})
  assert.deepEqual(r.fieldErrors, {})
  assert.equal(r.groupError, null)
})

test('T-01 a minor member still needs the guardian consent; a member error sits on that index', () => {
  const r = run(request([captain(), adult(1), { ...minor(1, 16), guardianConsent: false }]))
  assert.equal(r.ok, false)
  assert.equal(r.value, null)
  assert.deepEqual(r.errors, { 2: { guardianConsent: 'Zaznacz zgodę opiekuna.' } })
  assert.equal(r.groupError, null)
})

test('T-01 a member with the captain\'s address is the group rule\'s duplicate', () => {
  const r = run(request([captain(), adult(1), adult(2, { email: 'KAPITAN@example.pl' })]))
  assert.equal(r.ok, false)
  assert.deepEqual(r.errors, { 2: { email: 'Ten adres jest już w tym zgłoszeniu.' } })
})

test('T-01 a person error comes from validatePerson under the member index', () => {
  const r = run(request([captain(), adult(1, { phone: '' }), adult(2)]))
  assert.equal(r.ok, false)
  assert.ok(r.errors[1].phone)
})

test('T-02 sizes 2 and 6 against min 3 / max 5 → groupError, sizes 3 and 5 pass', () => {
  for (const n of [2, 6]) {
    const r = run(request(squad(n)))
    assert.equal(r.ok, false)
    assert.equal(r.groupError, 'Drużyna musi mieć od 3 do 5 osób.')
    assert.equal(r.value, null)
  }
  for (const n of [3, 5]) assert.equal(run(request(squad(n))).ok, true)
})

test('T-02 an empty or oversized squad never reaches the person rules', () => {
  assert.equal(run(request([])).groupError, 'Drużyna musi mieć od 3 do 5 osób.')
  const huge = run(request(Array.from({ length: 500 }, () => null)))
  assert.equal(huge.groupError, 'Drużyna musi mieć od 3 do 5 osób.')
  assert.deepEqual(huge.errors, {})
})

test('T-02 a size error still reports the name and the consent', () => {
  const r = run(request(squad(2), { teamName: 'A', membersConsent: false }))
  assert.equal(r.groupError, 'Drużyna musi mieć od 3 do 5 osób.')
  assert.equal(r.fieldErrors.teamName, 'Nazwa drużyny musi mieć od 2 do 40 znaków.')
  assert.equal(r.fieldErrors.membersConsent, 'Zaznacz zgodę członków drużyny.')
})

test('T-02 a competition with no size, or no category id, takes no team', () => {
  const noSize = run(request(squad(3)), competition({ teamMin: null, teamMax: null }))
  assert.equal(noSize.ok, false)
  assert.equal(noSize.groupError, 'Ta konkurencja nie przyjmuje zapisów.')
  assert.equal(run(request(squad(3), { categoryId: null })).groupError, 'Ta konkurencja nie przyjmuje zapisów.')
  assert.equal(validateTeam(request(squad(3)), { sessionEmail: SESSION, now: NOW }).groupError, 'Ta konkurencja nie przyjmuje zapisów.')
})

test('T-02 a 17-year-old captain → ruling 2, not the group rule and not the guardian consent', () => {
  const r = run(request([captain({ birthDate: yearsAgo(17) }), adult(1), adult(2)]))
  assert.equal(r.ok, false)
  assert.equal(r.groupError, CAPTAIN_MESSAGE)
  assert.deepEqual(r.errors, {})
})

test('T-02 a captain who turns 18 today is an adult', () => {
  assert.equal(run(request([captain({ birthDate: yearsAgo(18) }), adult(1), adult(2)])).ok, true)
})

test('T-02 a captain who is not the signed-in person → their own copy, with no buyer error', () => {
  for (const sessionEmail of ['ktos@example.pl', null]) {
    const r = run(request(squad(3)), competition(), { sessionEmail })
    assert.equal(r.ok, false)
    assert.equal(r.groupError, CAPTAIN_SELF_MESSAGE)
    assert.deepEqual(r.errors, {})
  }
})

test('T-02 the session address on a later member does not make the first member the captain', () => {
  const r = run(request([adult(1), captain(), adult(2)]))
  assert.equal(r.groupError, CAPTAIN_SELF_MESSAGE)
})

test('T-02 a minor captain is told so whatever else is wrong with the form', () => {
  const minorCaptain = (over) => [captain({ birthDate: yearsAgo(16), ...over }), adult(1), adult(2)]
  for (const over of [{ phone: '' }, { firstName: '' }, { gender: '' }, { email: 'zly-adres' }]) {
    const r = run(request(minorCaptain(over)))
    assert.equal(r.ok, false)
    assert.equal(r.groupError, CAPTAIN_MESSAGE, JSON.stringify(over))
  }
  // Outside the competition's ages too: the range error stays, the captain rule still answers.
  const ranged = competition({ competition: { minAge: 30, maxAge: null, isKids: false } })
  assert.equal(run(request(minorCaptain({})), ranged).groupError, CAPTAIN_MESSAGE)
  // Minor and not signed in: being a minor cannot be fixed by logging in, so it is what they read.
  assert.equal(run(request(minorCaptain({})), competition(), { sessionEmail: null }).groupError, CAPTAIN_MESSAGE)
})

test('T-02 the minimum is never below MIN_TEAM_SIZE, whatever a raw row holds', () => {
  const raw = competition({ teamMin: 0, teamMax: 5 })
  assert.equal(run(request([]), raw).groupError, 'Drużyna musi mieć od 2 do 5 osób.')
  assert.equal(run(request(squad(1)), raw).groupError, 'Drużyna musi mieć od 2 do 5 osób.')
  assert.equal(run(request(squad(2)), raw).ok, true)
})

test('T-03 leg order on: legs must be exactly 1…n, in any order across members', () => {
  const on = competition({ legOrderEnabled: true })
  const withLegs = (legs) => request(squad(legs.length).map((m, i) => ({ ...m, leg: legs[i] })))
  const ok = run(withLegs([3, 1, 2, 4]), on)
  assert.equal(ok.ok, true, JSON.stringify(ok))
  assert.deepEqual(ok.value.members.map((m) => m.leg), [3, 1, 2, 4])
  for (const legs of [[1, 2, 2, 4], [0, 1, 2, 3], [2, 3, 4, 5], [1, 2, 3, null], [1, 2, 3, 4.5]]) {
    const r = run(withLegs(legs), on)
    assert.equal(r.ok, false, String(legs))
    assert.equal(r.groupError, 'Ustal kolejność zmian.', String(legs))
  }
})

test('T-03 leg order off: legs sent are dropped, for every member', () => {
  const members = squad(4).map((m, i) => ({ ...m, leg: i + 1 }))
  const r = run(request(members))
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.deepEqual(r.value.members.map((m) => m.leg), [null, null, null, null])
  const bad = run(request(squad(4).map((m) => ({ ...m, leg: 2 }))))
  assert.equal(bad.ok, true, 'a repeated leg means nothing with leg order off')
})

test('T-04 the name is trimmed and 2–40 characters', () => {
  const message = 'Nazwa drużyny musi mieć od 2 do 40 znaków.'
  for (const teamName of [' A ', 'x'.repeat(41), '', '   ', undefined, 12]) {
    const r = run(normalizeTeamRequest(request(squad(3), { teamName })))
    assert.equal(r.ok, false, String(teamName))
    assert.equal(r.fieldErrors.teamName, message, String(teamName))
  }
  const ok = run(normalizeTeamRequest(request(squad(3), { teamName: `  ${'x'.repeat(40)}  ` })))
  assert.equal(ok.ok, true, JSON.stringify(ok))
  assert.equal(ok.value.teamName, 'x'.repeat(40))
  assert.equal(run(normalizeTeamRequest(request(squad(3), { teamName: 'AB' }))).ok, true)
})

test('T-04 the name is measured in characters, as the database counts them', () => {
  assert.equal(run(request(squad(3), { teamName: '🐺' })).fieldErrors.teamName, 'Nazwa drużyny musi mieć od 2 do 40 znaków.')
  assert.equal(run(request(squad(3), { teamName: '🐺'.repeat(40) })).ok, true)
})

test('T-04 the length is counted after whitespace is collapsed and the text composed', () => {
  assert.equal(run(request(squad(3), { teamName: `A${' '.repeat(39)}B` })).ok, true)
  assert.equal(run(request(squad(3), { teamName: `A${' '.repeat(60)}B` })).ok, true)
  assert.equal(run(request(squad(3), { teamName: 'x '.repeat(20).trim() + 'y' })).ok, true)
  assert.equal(run(request(squad(3), { teamName: 'Ż'.normalize('NFD').repeat(40) })).ok, true)
  assert.equal(run(request(squad(3), { teamName: 'x'.repeat(41) })).ok, false)
})

test('T-04 teamNameKey composes the text: two spellings of one letter are one name', () => {
  assert.equal(teamNameKey('Żółte Łosie'.normalize('NFD')), teamNameKey('Żółte Łosie'))
})

test('T-04 teamNameKey: lower case, whitespace collapsed, trimmed', () => {
  assert.equal(teamNameKey('  Wilcze   Stado '), 'wilcze stado')
  assert.equal(teamNameKey('WILCZE\t\nSTADO'), 'wilcze stado')
  assert.equal(teamNameKey('Żółte Łosie'), 'żółte łosie')
  assert.equal(teamNameKey(null), '')
})

test('T-05 membersConsent missing or not exactly true → error', () => {
  for (const membersConsent of [undefined, false, 'true', 1]) {
    const r = run(normalizeTeamRequest(request(squad(3), { membersConsent })))
    assert.equal(r.ok, false, String(membersConsent))
    assert.equal(r.fieldErrors.membersConsent, 'Zaznacz zgodę członków drużyny.')
    assert.equal(r.groupError, null)
  }
})

test('normalizeTeamRequest: the request shape, garbage included', () => {
  assert.deepEqual(normalizeTeamRequest({
    categoryId: 'c1', teamName: '  Wilcze Stado ', membersConsent: true,
    members: [{ person: { firstName: 'Ola' }, leg: 2, guardianConsent: true }, { person: { firstName: 'Ala' }, leg: '3', guardianConsent: 'yes' }, null],
  }), {
    categoryId: 'c1', teamName: 'Wilcze Stado', membersConsent: true,
    members: [
      { person: { firstName: 'Ola' }, leg: 2, guardianConsent: true },
      { person: { firstName: 'Ala' }, leg: null, guardianConsent: false },
      { person: {}, leg: null, guardianConsent: false },
    ],
  })
  for (const body of [null, undefined, 'x', {}]) {
    assert.deepEqual(normalizeTeamRequest(body), { categoryId: null, teamName: '', members: [], membersConsent: false })
  }
})

// ---------------------------------------------------------------- T-42 one new squad member

const MEMBER_NOW = new Date('2026-06-01T10:00:00Z')
const memberContext = { formFields: {}, competition: {}, raceDate: '2026-09-01', reckoning: 'race_day', ageGroups: [], kidsGroups: [], now: MEMBER_NOW }
const newAdult = { firstName: 'Anna', lastName: 'Nowa', birthDate: '1990-05-01', gender: 'K', email: 'Anna@Example.pl', phone: '600100200' }
const newChild = { firstName: 'Lena', lastName: 'Nowa', birthDate: '2016-05-05', gender: 'K', phone: '600100200' }

test('T-42 validateSquadMember: the role comes from the date, never from the request', () => {
  const adult = validateSquadMember({ person: { ...newAdult, role: 'minor' } }, memberContext)
  assert.equal(adult.ok, true)
  assert.equal(adult.value.role, 'adult')
  assert.equal(adult.value.email, 'anna@example.pl')
  assert.equal('isMinor' in adult.value, false)

  const child = validateSquadMember({ person: { ...newChild, role: 'adult' }, guardianConsent: true }, memberContext)
  assert.equal(child.ok, true)
  assert.equal(child.value.role, 'minor')
  // A day short of 18 is a child, the day itself an adult.
  assert.equal(validateSquadMember({ person: { ...newAdult, birthDate: '2008-06-02' }, guardianConsent: true }, memberContext).value.role, 'minor')
  assert.equal(validateSquadMember({ person: { ...newAdult, birthDate: '2008-06-01' } }, memberContext).value.role, 'adult')
})

test('T-42 validateSquadMember: a child needs the guardian consent; a bad date, an age outside the competition and no person are field errors', () => {
  assert.deepEqual(validateSquadMember({ person: newChild }, memberContext).errors, { guardianConsent: 'Zaznacz zgodę opiekuna.' })
  for (const birthDate of ['2016-02-31', 'jutro', '', null, 20160505]) {
    assert.equal(validateSquadMember({ person: { ...newAdult, birthDate } }, memberContext).errors.birthDate, 'Podaj poprawną datę urodzenia.')
  }
  const old = validateSquadMember({ person: newAdult }, { ...memberContext, competition: { maxAge: 30 } })
  assert.equal(old.errors.birthDate, 'Ta konkurencja jest dla osób w wieku do 30 lat.')
  assert.equal(validateSquadMember({}, memberContext).ok, false)
  assert.equal(validateSquadMember(undefined, memberContext).ok, false)
})

// ---------------------------------------------------------------- task-5a-review.md item 1

test('T-05 the stored name is the collapsed spelling: no line break or tab reaches an e-mail subject', () => {
  const r = run(request(squad(3), { teamName: '  Wilki\r\n  Stado\t ÓW ' }))
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.value.teamName, 'Wilki Stado ÓW')
})
