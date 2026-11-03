import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  initTeam, setSize, droppedBy, moveMember, removeMember, memberVariant, toTeamRequest, legOf, squadCards, checkTeam, checkCaptain,
  teamContext, teamFailure, memberAfter, firstOpenMember, memberAgeLabel, repricedFee, carryOverMember, carryOverSquad, carriedIn, memberCopiedFrom,
  setMoreFields, setParentChoice, setParent, teamConsents,
} from '../../src/lib/teamDraft.js'
import { setCardOpen, setGuardianConsent, updatePerson, cardEmpty, copiedFromNames, LIST_STEP } from '../../src/lib/groupDraft.js'
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
  it('an adult member sends only name, birth date, gender and e-mail while the other fields are hidden', () => {
    const typed = { ...piotr, city: 'Zabrze', club: 'X', iceName: 'Jan', icePhone: '600', nationality: 'PL' }
    const d = team([me, typed, ewa])
    const [captain, member] = toTeamRequest(d, { today: TODAY }).members
    assert.deepEqual(Object.keys(member.person).sort(), ['birthDate', 'email', 'firstName', 'gender', 'lastName'])
    assert.equal(captain.person.phone, me.phone, 'the captain sends everything')
    // „Pokaż więcej pól”: what the captain sees is sent; hidden again, it is not.
    const shown = setMoreFields(d, d.cards[1].key, true)
    assert.equal(toTeamRequest(shown, { today: TODAY }).members[1].person.city, 'Zabrze')
    const hidden = setMoreFields(shown, d.cards[1].key, false)
    assert.ok(!('city' in toTeamRequest(hidden, { today: TODAY }).members[1].person))
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

describe('the guardian consent (minorsOnly) in a team', () => {
  const consents = [{ id: 'k1' }, { id: 'kg', minorsOnly: true }]
  it('an adult squad sends it not', () => {
    assert.deepEqual(toTeamRequest(team(), { consents, today: TODAY }).acceptedConsentIds, ['k1'])
  })
  it('a squad with a child sends it', () => {
    assert.deepEqual(toTeamRequest(team([me, zosia]), { consents, today: TODAY }).acceptedConsentIds, ['k1', 'kg'])
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
    const broken = updatePerson(d, d.cards[1].key, { firstName: '' })
    const r = checkTeam(broken, { context, now: NOW })
    assert.equal(r.ok, false)
    assert.deepEqual(Object.keys(r.errors), [broken.cards[1].key])
    assert.ok(r.errors[broken.cards[1].key].firstName)
  })
  it('an adult member with only name, birth date, gender and e-mail passes, whatever the form asks', () => {
    const asks = teamContext({ ...RAW, formFields: { city: 'required', club: 'required', ice: 'required', nationality: 'required' } }, COMPETITION, NOW)
    const five = ({ phone: _p, ...p }) => p
    const captain = { ...me, city: 'Gliwice', club: 'ZATYRANI', iceName: 'Jan', icePhone: '600100201', nationality: 'PL' }
    const r = checkTeam(team([captain, five(piotr), five(ewa)]), { context: asks, now: NOW })
    assert.equal(r.ok, true, JSON.stringify(r))
    const broken = checkTeam(team([{ ...captain, club: '' }, five(piotr), five(ewa)]), { context: asks, now: NOW })
    assert.equal(broken.ok, false, 'the captain still fills the whole form')
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

describe('carryOverMember: a member starts with the club and town of the card before them', () => {
  // The captain with a club and a town, two empty members behind.
  function squad() {
    let d = initTeam(3, CAT)
    d = updatePerson(d, d.cards[0].key, { ...me, club: 'KB Leszy', city: 'Gdynia' })
    return d
  }
  const [cap, m2, m3] = [0, 1, 2]
  const person = (d, i) => d.cards[i].person

  it("member 2 takes the captain's club and town, marked as copied from the captain", () => {
    const d0 = squad()
    const d = carryOverMember(d0, d0.cards[m2].key)
    assert.equal(person(d, m2).club, 'KB Leszy')
    assert.equal(person(d, m2).city, 'Gdynia')
    assert.deepEqual(copiedFromNames(d, d.cards[m2].key), { club: 'Ola Leśna', city: 'Ola Leśna' })
    assert.equal(person(d, m3).club, '', 'only the opened card is filled')
  })

  it('an adult member\'s copied club and town stay off the request while „Pokaż więcej pól” is closed, and show as copied once open', () => {
    const base = squad()
    let d = carryOverMember(base, base.cards[m2].key)
    d = updatePerson(d, d.cards[m2].key, { firstName: 'Piotr', lastName: 'Leśny', birthDate: '1987-01-01', gender: 'M', email: 'piotr@x.pl' })
    const collapsed = toTeamRequest(d, { today: TODAY }).members[m2].person
    assert.ok(!('club' in collapsed) && !('city' in collapsed), JSON.stringify(collapsed))
    const open = setMoreFields(d, d.cards[m2].key, true)
    assert.equal(toTeamRequest(open, { today: TODAY }).members[m2].person.club, 'KB Leszy')
    assert.deepEqual(memberCopiedFrom(open, open.cards[m2].key), { club: 'Ola Leśna', city: 'Ola Leśna' })
    // A child's card has no such section: the copy goes as on main.
    const kid = updatePerson(d, d.cards[m2].key, { birthDate: '2014-05-05', gender: 'K', email: '' })
    assert.equal(toTeamRequest(kid, { today: TODAY }).members[m2].person.club, 'KB Leszy')
  })

  it('member 3 copies from a finished member 2, not from the captain', () => {
    let d = squad()
    d = carryOverMember(d, d.cards[m2].key)
    d = updatePerson(d, d.cards[m2].key, { ...piotr, club: 'AZS' })
    d = setCardOpen(d, d.cards[m2].key, false)
    d = carryOverMember(d, d.cards[m3].key)
    assert.equal(person(d, m3).club, 'AZS')
    assert.equal(person(d, m3).city, 'Gdynia', "member 2's copied town goes on")
    assert.deepEqual(copiedFromNames(d, d.cards[m3].key), { club: 'Piotr Leśny', city: 'Piotr Leśny' })
  })

  it('an unfinished member 2 is skipped: member 3 falls back to the captain', () => {
    let d = squad()
    d = updatePerson(d, d.cards[m2].key, { club: 'AZS' })
    d = carryOverMember(d, d.cards[m3].key)
    assert.equal(person(d, m3).club, 'KB Leszy')
  })

  it('a field typed into on the card is never overwritten, the other one still is', () => {
    let d = squad()
    d = carryOverMember(d, d.cards[m2].key)
    d = updatePerson(d, d.cards[m2].key, { club: 'Własny klub' })
    assert.deepEqual(Object.keys(copiedFromNames(d, d.cards[m2].key)), ['city'], 'the edited club is no longer marked copied')
    d = updatePerson(d, d.cards[cap].key, { club: 'Nowy', city: 'Sopot' })
    d = carryOverMember(d, d.cards[m2].key)
    assert.equal(person(d, m2).club, 'Własny klub')
    assert.equal(person(d, m2).city, 'Sopot', "an untyped copy follows the captain's change")
  })

  it('„Wyczyść” (an empty patch) empties the field for good', () => {
    let d = squad()
    d = carryOverMember(d, d.cards[m2].key)
    d = updatePerson(d, d.cards[m2].key, { club: '' })
    assert.equal(person(d, m2).club, '')
    assert.deepEqual(Object.keys(copiedFromNames(d, d.cards[m2].key)), ['city'])
    d = carryOverMember(d, d.cards[m2].key)
    assert.equal(person(d, m2).club, '', 'opening the card again does not bring it back')
  })

  it('nothing to copy: the same draft, and a captain with no club copies nothing', () => {
    let d = initTeam(2, CAT)
    d = updatePerson(d, d.cards[cap].key, me)
    assert.equal(carryOverMember(d, d.cards[m2].key), d)
    const full = squad()
    const once = carryOverMember(full, full.cards[m2].key)
    assert.equal(carryOverMember(once, once.cards[m2].key), once, 'opening it again changes nothing')
  })

  it("the captain's card never takes a copy", () => {
    const d = squad()
    assert.equal(carryOverMember(d, d.cards[cap].key), d)
  })

  it('with leg order the source is the card before in the squad as shown', () => {
    let d = squad()
    d = updatePerson(d, d.cards[m3].key, { ...ewa, club: 'Ewa Team' })
    d = setCardOpen(d, d.cards[m3].key, false)
    d = moveMember(d, 2, 0) // Ewa runs leg 1, the captain leg 2, member 2 leg 3
    d = carryOverMember(d, d.cards[m2].key)
    assert.equal(person(d, m2).club, 'KB Leszy', 'the captain is the nearest card before member 2')
    d = moveMember(d, 1, 2) // captain to leg 3: Ewa, member 2, captain
    d = updatePerson(d, d.cards[m2].key, { city: 'x' })
    d = carryOverMember(d, d.cards[m2].key)
    assert.equal(person(d, m2).club, 'Ewa Team')
  })

  it('a copied club alone leaves the card empty, so „Usuń” asks nothing', () => {
    const d0 = squad()
    const d = carryOverMember(d0, d0.cards[m2].key)
    assert.equal(cardEmpty(d.cards[m2]), true)
    assert.equal(cardEmpty(updatePerson(d, d.cards[m2].key, { firstName: 'A' }).cards[m2]), false)
  })

  it('the copied club goes in the request like a typed one, on a card that shows it („Pokaż więcej pól”)', () => {
    const d0 = squad()
    const d = setMoreFields(carryOverMember(d0, d0.cards[m2].key), d0.cards[m2].key, true)
    const req = toTeamRequest(d, { today: TODAY })
    assert.equal(req.members[1].person.club, 'KB Leszy')
  })
})

describe('carryOverSquad: a copy follows its source after the step that made it (review #395)', () => {
  const ON = { club: 'optional', city: 'optional' }
  // Captain „KS Lesy”; members 2 and 3 opened and finished in turn, the way the form does it, each
  // with „Pokaż więcej pól” open so the request carries what the card shows.
  function finished() {
    let d = initTeam(3, CAT)
    d = updatePerson(d, d.cards[0].key, { ...me, club: 'KS Lesy', city: 'Gdynia' })
    for (const [i, p] of [[1, piotr], [2, ewa]]) {
      const key = d.cards[i].key
      d = setMoreFields(d, key, true)
      d = carryOverMember(d, key, ON)
      d = updatePerson(d, key, p)
      d = setCardOpen(d, key, false)
    }
    return d
  }
  const clubs = (d) => toTeamRequest(d, { today: TODAY }).members.map((m) => m.person.club)

  it("the captain's club fixed on RB1 reaches both finished members, through the chain", () => {
    let d = finished()
    assert.deepEqual(clubs(d), ['KS Lesy', 'KS Lesy', 'KS Lesy'])
    d = updatePerson(d, d.cards[0].key, { club: 'KS Leszy' })
    d = carryOverSquad(d, ON)
    assert.deepEqual(clubs(d), ['KS Leszy', 'KS Leszy', 'KS Leszy'])
    assert.deepEqual(memberCopiedFrom(d, d.cards[2].key), { club: 'Piotr Leśny', city: 'Piotr Leśny' }, 'member 3 still copies member 2')
  })

  it('a member who typed their own club stops the chain there; the next one follows them', () => {
    let d = finished()
    d = updatePerson(d, d.cards[1].key, { club: 'AZS' })
    d = updatePerson(d, d.cards[0].key, { club: 'KS Leszy' })
    d = carryOverSquad(d, ON)
    assert.deepEqual(clubs(d), ['KS Leszy', 'AZS', 'AZS'])
  })

  it('a captain who empties the club empties the copies, and the same draft comes back once settled', () => {
    let d = finished()
    d = carryOverSquad(updatePerson(d, d.cards[0].key, { club: '' }), ON)
    assert.deepEqual(clubs(d), ['', '', ''])
    assert.equal(carryOverSquad(d, ON), d)
  })

  it('a member never opened is not filled in behind their back', () => {
    let d = initTeam(3, CAT)
    d = updatePerson(d, d.cards[0].key, { ...me, club: 'KS Lesy' })
    assert.equal(carryOverSquad(d, ON), d)
  })

  it('carriedIn names the fields the carryover filled, for clearing their errors', () => {
    const d = finished()
    const next = carryOverSquad(updatePerson(d, d.cards[0].key, { club: 'KS Leszy' }), ON)
    assert.deepEqual(carriedIn(d, next).map(({ key, field }) => [d.cards.findIndex((c) => c.key === key), field]), [[1, 'club'], [2, 'club']])
  })

  it("a field the organizer switched off is never copied", () => {
    let d = initTeam(2, CAT)
    d = updatePerson(d, d.cards[0].key, { ...me, club: 'KS Lesy', city: 'Gdynia' })
    d = carryOverMember(d, d.cards[1].key, { club: 'off', city: 'optional' })
    assert.equal(d.cards[1].person.club, '')
    assert.equal(d.cards[1].person.city, 'Gdynia')
  })

  it('a nameless source is named by their leg, not their request index', () => {
    let d = initTeam(3, CAT)
    d = updatePerson(d, d.cards[0].key, { club: 'KS Lesy' })
    d = moveMember(d, 0, 1) // the captain runs leg 2
    d = carryOverMember(d, d.cards[2].key, ON)
    assert.deepEqual(memberCopiedFrom(d, d.cards[2].key), { club: 'osoba 2' })
  })
})

// A child's parent who is not the captain: the captain names them on the child's card, the box goes.
describe('TP-40 a child\'s parent who is not the captain', () => {
  const marta = { firstName: 'Marta', lastName: 'Leśna', email: 'marta@x.pl' }
  const withChild = () => team([me, piotr, zosia])
  const childKey = (d) => d.cards[2].key

  it('by default the captain is the guardian: the box goes in the request, no parent', () => {
    const base = withChild()
    const d = setGuardianConsent(base, base.cards[2].key, true)
    const m = toTeamRequest(d, { today: TODAY }).members[2]
    assert.equal(m.guardianConsent, true)
    assert.equal('parent' in m, false)
  })
  it('„Rodzic lub opiekun to ktoś inny”: the parent goes in the request, the box does not', () => {
    let d = withChild()
    d = setParentChoice(d, childKey(d), true)
    d = setParent(d, childKey(d), marta)
    const m = toTeamRequest(d, { today: TODAY }).members[2]
    assert.deepEqual(m.parent, marta)
    assert.equal('guardianConsent' in m, false)
    assert.equal(checkTeam(d, { context, now: NOW }).ok, true)
  })
  it('back to „Jestem rodzicem”: the parent typed is kept on the card but never sent', () => {
    let d = withChild()
    d = setParent(setParentChoice(d, childKey(d), true), childKey(d), marta)
    d = setParentChoice(d, childKey(d), false)
    assert.deepEqual(d.cards[2].parent, marta)
    assert.equal('parent' in toTeamRequest(d, { today: TODAY }).members[2], false)
  })
  it('the parent\'s errors land on the child\'s card; the captain\'s own address is refused', () => {
    let d = withChild()
    d = setParent(setParentChoice(d, childKey(d), true), childKey(d), { ...marta, email: 'OLA@x.pl' })
    const r = checkTeam(d, { context, now: NOW })
    assert.equal(r.ok, false)
    assert.match(r.errors[childKey(d)].parentEmail, /To Twój adres/)
  })
  it('a minors-only consent is shown only while a child the captain answers for is in the squad', () => {
    const consents = [{ id: 'r', kind: 'regulamin' }, { id: 'g', kind: 'custom', minorsOnly: true }]
    let d = withChild()
    assert.deepEqual(teamConsents(d, consents, TODAY).map((c) => c.id), ['r', 'g'])
    d = setParentChoice(d, childKey(d), true)
    assert.deepEqual(teamConsents(d, consents, TODAY).map((c) => c.id), ['r'])
    assert.deepEqual(toTeamRequest(d, { consents, today: TODAY }).acceptedConsentIds, ['r'])
  })
  it('an adult\'s card never sends a parent, whatever the card holds', () => {
    let d = team()
    d = setParent(setParentChoice(d, d.cards[1].key, true), d.cards[1].key, marta)
    assert.equal('parent' in toTeamRequest(d, { today: TODAY }).members[1], false)
  })
})
