import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  initTeam, setSize, droppedBy, moveMember, removeMember, memberVariant, toTeamRequest, legOf, squadCards, checkTeam, checkCaptain,
  teamContext, teamFailure, memberAfter, firstOpenMember, memberAgeLabel, repricedFee,
} from '../../src/lib/teamDraft.js'
import { setCardOpen, setGuardianConsent, updatePerson, LIST_STEP } from '../../src/lib/groupDraft.js'
import { EMPTY_PERSON } from '../../src/lib/personFormModel.js'
import { TEAM_NAME_CHARS_MESSAGE } from '../../../supabase/functions/_shared/registration/team.js'

// Plan 5 task 7a: the team form's draft (RB1, RB2) as pure functions.
// T-60 size, leg order and the request; T-61 a member's variant.

const CAT = '11111111-1111-4111-8111-111111111111'
const COMPETITION = { categoryId: CAT, kind: 'team', teamMin: 2, teamMax: 5, legOrderEnabled: true, minAge: null, maxAge: null, isKids: false, ageGroups: [], kidsGroups: [] }
const RAW = { eventDate: '2026-12-06', ageReckoning: 'race_day', formFields: { city: 'off', club: 'off', ice: 'off', nationality: 'off' } }
const NOW = new Date('2026-11-06T10:00:00Z')
const TODAY = '2026-11-06'
const context = teamContext(RAW, COMPETITION, NOW)

const me = { ...EMPTY_PERSON, firstName: 'Ola', lastName: 'Leśna', birthDate: '1988-03-01', gender: 'K', email: 'ola@x.pl', phone: '600100200' }
const piotr = { firstName: 'Piotr', lastName: 'Leśny', birthDate: '1987-01-01', gender: 'M', email: 'piotr@x.pl', phone: '600300400' }
const ewa = { firstName: 'Ewa', lastName: 'Bór', birthDate: '1990-01-01', gender: 'K', email: 'ewa@x.pl', phone: '600500600' }
const zosia = { firstName: 'Zosia', lastName: 'Leśna', birthDate: '2014-05-05', gender: 'K' }

function team(people = [me, piotr, ewa]) {
  let d = initTeam(people.length, CAT)
  d.cards.forEach((c, i) => { d = updatePerson(d, c.key, people[i]) })
  return { ...d, teamName: 'Wilcze Stado', membersConsent: true }
}
const legs = (d) => toTeamRequest(d, { legOrder: true, today: TODAY }).members.map((m) => [m.person.firstName, m.leg])

describe('T-60 setSize keeps entered members growing and drops from the end shrinking', () => {
  it('initTeam: the captain plus empty cards, the captain first', () => {
    const d = initTeam(3, CAT)
    assert.equal(d.cards.length, 3)
    assert.deepEqual(d.order, d.cards.map((c) => c.key))
    assert.equal(d.teamName, '')
    assert.equal(d.membersConsent, false)
  })
  it('growing keeps everybody and adds empty cards at the end', () => {
    const d = team()
    const grown = setSize(d, 5)
    assert.equal(grown.cards.length, 5)
    assert.deepEqual(grown.cards.slice(0, 3).map((c) => c.person.firstName), ['Ola', 'Piotr', 'Ewa'])
    assert.equal(grown.cards[4].person.firstName, '')
    assert.deepEqual(grown.order.slice(0, 3), d.order)
    assert.equal(grown.order.length, 5)
  })
  it('shrinking drops from the end, the captain and the first members stay', () => {
    const d = setSize(team(), 2)
    assert.deepEqual(d.cards.map((c) => c.person.firstName), ['Ola', 'Piotr'])
    assert.equal(d.order.length, 2)
  })
  it('the end is the end of the squad as shown, and the captain is never dropped', () => {
    const moved = moveMember(team(), 0, 2) // Piotr, Ewa, Ola
    const d = setSize(moved, 2)
    assert.deepEqual(squadCards(d).map(({ card }) => card.person.firstName), ['Piotr', 'Ola'])
  })
  it('droppedBy names who a smaller size would drop', () => {
    assert.deepEqual(droppedBy(team(), 2).map((c) => c.person.firstName), ['Ewa'])
    assert.deepEqual(droppedBy(team(), 3), [])
    assert.deepEqual(droppedBy(team(), 4), [])
  })
  it('removeMember takes that member out of the order; the captain stays', () => {
    const d = team()
    const out = removeMember(d, d.cards[1].key)
    assert.deepEqual(out.cards.map((c) => c.person.firstName), ['Ola', 'Ewa'])
    assert.equal(out.order.length, 2)
    assert.equal(removeMember(d, d.cards[0].key), d)
  })
})

describe('T-60 moveMember renumbers the legs, the captain stays member 0 of the request', () => {
  it('legs are 1…n in the order on screen', () => {
    assert.deepEqual(legs(team()), [['Ola', 1], ['Piotr', 2], ['Ewa', 3]])
  })
  it('moving a member renumbers everybody between', () => {
    assert.deepEqual(legs(moveMember(team(), 2, 0)), [['Ola', 2], ['Piotr', 3], ['Ewa', 1]])
    assert.deepEqual(legs(moveMember(team(), 1, 2)), [['Ola', 1], ['Piotr', 3], ['Ewa', 2]])
  })
  it('the captain may run any leg and is still the first member sent', () => {
    const d = moveMember(team(), 0, 2)
    assert.deepEqual(legs(d), [['Ola', 3], ['Piotr', 1], ['Ewa', 2]])
    assert.equal(legOf(d, d.cards[0].key), 3)
  })
  it('a move off the ends changes nothing', () => {
    const d = team()
    assert.equal(moveMember(d, 0, -1), d)
    assert.equal(moveMember(d, 2, 3), d)
    assert.equal(moveMember(d, 1, 1), d)
  })
  it('the legs still come out 1…n after a move and a resize, as the server requires', () => {
    let d = moveMember(team(), 2, 0)
    d = setSize(d, 4)
    d = updatePerson(d, d.cards[3].key, { firstName: 'Jan' })
    assert.deepEqual(toTeamRequest(d, { legOrder: true, today: TODAY }).members.map((m) => m.leg).sort(), [1, 2, 3, 4])
  })
})

describe('T-60 toTeamRequest', () => {
  it('with leg order off sends no leg', () => {
    const body = toTeamRequest(moveMember(team(), 2, 0), { legOrder: false, today: TODAY })
    assert.ok(body.members.every((m) => !('leg' in m)))
  })
  it('the register-team body', () => {
    const body = toTeamRequest(team(), { consents: [{ id: 'k1' }, { id: 'k2' }], displayedTotal: 24000, today: TODAY })
    assert.equal(body.categoryId, CAT)
    assert.equal(body.teamName, 'Wilcze Stado')
    assert.equal(body.membersConsent, true)
    assert.deepEqual(body.acceptedConsentIds, ['k1', 'k2'])
    assert.equal(body.serviceRegulamin, true)
    assert.equal(body.displayedTotal, 24000)
    assert.equal(body.members[1].person.email, 'piotr@x.pl')
    assert.ok(!('code' in body) && !('website' in body))
  })
  it('the honeypot goes only when filled', () => {
    assert.equal(toTeamRequest(team(), { website: 'x', today: TODAY }).website, 'x')
  })
  it('a child: no e-mail, the guardian box, the captain\'s phone while untouched', () => {
    let d = team([me, zosia])
    d = setGuardianConsent(d, d.cards[1].key, true)
    const [, child] = toTeamRequest(d, { today: TODAY }).members
    assert.equal(child.guardianConsent, true)
    assert.ok(!('email' in child.person))
    assert.equal(child.person.phone, me.phone)
  })
})

describe('T-61 memberVariant', () => {
  it('one day short of 18 is a minor, at 18 an adult', () => {
    assert.equal(memberVariant({ birthDate: '2008-11-07' }, TODAY), 'minor')
    assert.equal(memberVariant({ birthDate: '2008-11-06' }, TODAY), 'adult')
  })
  it('no date yet is the adult layout', () => {
    assert.equal(memberVariant({ birthDate: '' }, TODAY), 'adult')
  })
  it('„<wiek> LAT” is the age on race day, in the right form', () => {
    assert.equal(memberAgeLabel({ birthDate: '2014-05-05' }, RAW.eventDate, 'race_day'), '12 LAT')
    assert.equal(memberAgeLabel({ birthDate: '2023-05-05' }, RAW.eventDate, 'race_day'), '3 LATA')
  })
})

describe('checkTeam: the server\'s own rules, keyed by card', () => {
  it('a whole squad passes', () => {
    assert.equal(checkTeam(team(), { context, now: NOW }).ok, true)
  })
  it('a member\'s error lands on that member\'s card', () => {
    const d = updatePerson(team(), team().cards[0].key, {}) // a fresh set of keys
    const broken = updatePerson(d, d.cards[1].key, { phone: '' })
    const r = checkTeam(broken, { context, now: NOW })
    assert.equal(r.ok, false)
    assert.deepEqual(Object.keys(r.errors), [broken.cards[1].key])
    assert.ok(r.errors[broken.cards[1].key].phone)
  })
  it('a child without the guardian box', () => {
    const d = team([me, zosia])
    const r = checkTeam(d, { context, now: NOW })
    assert.ok(r.errors[d.cards[1].key].guardianConsent)
  })
  it('the members\' consent is refused until ticked', () => {
    const r = checkTeam({ ...team(), membersConsent: false }, { context, now: NOW })
    assert.equal(r.ok, false)
    assert.ok(r.fieldErrors.membersConsent)
  })
})

describe('checkCaptain: leaving RB1 asks only about RB1', () => {
  it('empty members do not stop the captain', () => {
    let d = initTeam(3, CAT)
    d = updatePerson(d, d.cards[0].key, me)
    assert.equal(checkCaptain({ ...d, teamName: 'Wilcze Stado' }, { context, now: NOW }).ok, true)
  })
  it('a short name is the name field\'s error', () => {
    const d = { ...team(), teamName: 'W' }
    const r = checkCaptain(d, { context, now: NOW })
    assert.equal(r.ok, false)
    assert.ok(r.nameError)
  })
  it('a control character in the name is refused', () => {
    const r = checkCaptain({ ...team(), teamName: 'Wilcze\u0007Stado' }, { context, now: NOW })
    assert.equal(r.nameError, TEAM_NAME_CHARS_MESSAGE)
  })
  it('an empty address asks for the address, not for another captain', () => {
    const d = updatePerson(initTeam(2, CAT), initTeam(2, CAT).cards[0].key, {})
    const blank = updatePerson({ ...d, teamName: 'Wilcze Stado' }, d.cards[0].key, { ...me, email: '' })
    const r = checkCaptain(blank, { context, now: NOW })
    assert.equal(r.ok, false)
    assert.equal(r.groupError, null)
    assert.ok(r.errors[blank.cards[0].key].email)
  })
  it('a minor captain is ruling 2\'s refusal', () => {
    const d = team([{ ...me, birthDate: '2010-01-01' }, piotr])
    const r = checkCaptain(d, { context, now: NOW })
    assert.equal(r.ok, false)
    assert.match(r.groupError, /pełnoletnia/)
  })
})

describe('memberAfter: one person on screen at a time', () => {
  it('the next member still to fill, in squad order, then the list', () => {
    let d = team()
    d = setCardOpen(d, d.cards[1].key, false)
    assert.equal(memberAfter(d, d.cards[1].key, {}), d.cards[2].key)
    d = setCardOpen(d, d.cards[2].key, false)
    assert.equal(memberAfter(d, d.cards[2].key, {}), LIST_STEP)
  })
  it('a refused member comes first, the captain never', () => {
    let d = team()
    d = setCardOpen(setCardOpen(d, d.cards[1].key, false), d.cards[2].key, false)
    assert.equal(memberAfter(d, d.cards[1].key, { [d.cards[2].key]: { phone: 'x' } }), d.cards[2].key)
    assert.equal(memberAfter(d, d.cards[1].key, { [d.cards[0].key]: { phone: 'x' } }), LIST_STEP)
  })
  it('firstOpenMember skips the captain, wherever they run', () => {
    const d = moveMember(team(), 0, 2)
    assert.equal(firstOpenMember(d), d.cards[1].key)
    const done = d.cards.slice(1).reduce((acc, c) => setCardOpen(acc, c.key, false), d)
    assert.equal(firstOpenMember(done), LIST_STEP)
  })
})

describe('T-62 teamFailure: where a refusal shows', () => {
  const err = (status, code, extra = {}) => Object.assign(new Error(extra.message ?? code), { status, code, ...extra })
  const today = TODAY

  it('a taken name → under „Nazwa drużyny” on RB1, with nothing on any card', () => {
    const f = teamFailure(err(409, 'team_name_taken', { message: 'Ta nazwa drużyny jest już zajęta.', fields: { teamName: 'Ta nazwa drużyny jest już zajęta.' } }), team(), today)
    assert.equal(f.step, 'captain')
    assert.equal(f.nameError, 'Ta nazwa drużyny jest już zajęta.')
    assert.deepEqual(f.errors, {})
    assert.equal(f.message, null)
  })
  it('a member\'s duplicate → under that card\'s e-mail, on the member\'s step', () => {
    const d = team()
    const f = teamFailure(err(409, 'duplicate', { message: 'Ta osoba jest już zapisana na te zawody.', index: 2, errors: { 2: { email: 'x' } } }), d, today)
    assert.equal(f.step, 'squad')
    assert.equal(f.focus, d.cards[2].key)
    assert.equal(f.errors[d.cards[2].key].email, 'Ta osoba jest już zapisana na te zawody.')
    assert.equal(Object.keys(f.errors).length, 1)
  })
  it('a child\'s duplicate has no e-mail field: it shows on the name, by index', () => {
    const d = team([me, piotr, zosia])
    const f = teamFailure(err(409, 'duplicate', { message: 'dup', index: 2, errors: { 2: { email: 'dup' } } }), d, today)
    assert.deepEqual(f.errors[d.cards[2].key], { firstName: 'dup' })
    assert.equal(f.focus, d.cards[2].key)
  })
  it('`refused` is the form\'s own message, on the list', () => {
    const f = teamFailure(err(409, 'refused', { message: 'Nie udało się zapisać tej grupy.' }), team(), today)
    assert.equal(f.step, 'squad')
    assert.equal(f.focus, null)
    assert.equal(f.message, 'Nie udało się zapisać tej grupy.')
  })
  it('field errors keyed by person land on the cards', () => {
    const d = team()
    const f = teamFailure(err(400, 'invalid_person', { message: 'Popraw', errors: { 1: { phone: 'Podaj telefon.' } }, fields: {} }), d, today)
    assert.equal(f.errors[d.cards[1].key].phone, 'Podaj telefon.')
    assert.equal(f.focus, d.cards[1].key)
  })
  it('the captain\'s own refusal goes back to RB1', () => {
    const d = team()
    const f = teamFailure(err(403, 'email_retired', { message: 'retired', index: 0 }), d, today)
    assert.equal(f.step, 'captain')
    assert.equal(f.errors[d.cards[0].key].email, 'retired')
  })
  it('no session → the code step', () => {
    assert.equal(teamFailure(err(401, 'code_required', { message: 'Wpisz kod' }), team(), today).step, 'code')
  })
  it('anything else is a message on the list', () => {
    const f = teamFailure(err(409, 'team_size', { message: 'Drużyna musi mieć od 2 do 5 osób.' }), team(), today)
    assert.deepEqual([f.step, f.focus, f.message], ['squad', null, 'Drużyna musi mieć od 2 do 5 osób.'])
  })
})

describe('Final review L-1: a price_changed keeps the server\'s fee', () => {
  const err = (amounts, code = 'price_changed') => Object.assign(new Error('Cena się zmieniła. Sprawdź podsumowanie.'), { status: 409, code, amounts })
  it('the new fee from entryTotal, 0 zł included', () => {
    assert.equal(repricedFee(err({ entryPrices: [3000], entryTotal: 3000, total: 3000 })), 3000)
    assert.equal(repricedFee(err({ entryPrices: [0], entryTotal: 0, total: 0 })), 0)
  })
  it('anything else → null', () => {
    assert.equal(repricedFee(err(undefined)), null)
    assert.equal(repricedFee(err({ entryTotal: -1 })), null)
    assert.equal(repricedFee(err({ entryTotal: '3000' })), null)
    assert.equal(repricedFee(err({ entryTotal: 3000 }, 'full')), null)
    assert.equal(repricedFee(new Error('offline')), null)
  })
})
