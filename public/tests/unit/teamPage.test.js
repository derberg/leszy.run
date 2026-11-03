import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  addLabel, captainTeamPath, checkMember, lastChangeDay, memberMeta, memberName, moveLeg, newMember, squadFailure, teamStatusLabel, toMemberRequest,
} from '../../src/lib/teamPage.js'
import { teamContext } from '../../src/lib/teamDraft.js'
import { EMPTY_PERSON } from '../../src/lib/personFormModel.js'

// Plan 5 task 7b: RB4, the captain's team page, as pure functions.

const COMPETITION = { categoryId: 'c', kind: 'team', teamMin: 2, teamMax: 5, legOrderEnabled: true, minAge: null, maxAge: null, isKids: false, ageGroups: [], kidsGroups: [] }
const RAW = { eventDate: '2026-12-06', ageReckoning: 'race_day', formFields: { city: 'off', club: 'off', ice: 'off', nationality: 'off' } }
const NOW = new Date('2026-11-06T10:00:00Z')
const TODAY = '2026-11-06'
const context = teamContext(RAW, COMPETITION, NOW)
const anna = { ...EMPTY_PERSON, firstName: 'Anna', lastName: 'Nowa', birthDate: '1990-01-01', gender: 'K', email: 'anna@x.pl', phone: '600100200' }
const zosia = { ...EMPTY_PERSON, firstName: 'Zosia', lastName: 'Leśna', birthDate: '2014-05-05', gender: 'K', email: 'stale@x.pl', phone: '600100200' }

describe('T-64 lastChangeDay: the last Warsaw day of an exclusive closes_at, as d.mm', () => {
  it('winter and summer time, and a month that needs its zero', () => {
    assert.equal(lastChangeDay('2026-12-03T23:00:00Z'), '3.12')
    assert.equal(lastChangeDay('2026-10-24T22:00:00Z'), '24.10')
    assert.equal(lastChangeDay('2026-04-01T22:00:00Z'), '1.04')
  })
  it('a close at the first of the month reads the last day of the one before', () => {
    assert.equal(lastChangeDay('2026-11-30T23:00:00Z'), '30.11')
  })
  it('no date → null', () => assert.equal(lastChangeDay(null), null))
})

describe('T-64 teamStatusLabel', () => {
  it('paid, awaiting, and a free team that must not read as paid', () => {
    assert.equal(teamStatusLabel('paid'), 'OPŁACONA')
    assert.equal(teamStatusLabel('awaiting'), 'CZEKA NA WPŁATĘ')
    assert.equal(teamStatusLabel('free'), 'ZAPISANA')
    assert.equal(teamStatusLabel(null), null)
  })
})

describe('T-64 toMemberRequest', () => {
  it('an adult carries the address and no acceptance: they accept from the e-mail', () => {
    const r = toMemberRequest(newMember(anna), { consents: [{ id: 'k1' }], today: TODAY })
    assert.equal(r.person.email, 'anna@x.pl')
    assert.deepEqual(Object.keys(r), ['person'])
  })
  it('a child drops the address and carries the guardian\'s consent, the event\'s consents and the service regulamin', () => {
    const r = toMemberRequest({ ...newMember(zosia), guardianConsent: true }, { consents: [{ id: 'k1' }, { id: 'k2' }], today: TODAY })
    assert.equal('email' in r.person, false)
    assert.equal(r.guardianConsent, true)
    assert.deepEqual(r.acceptedConsentIds, ['k1', 'k2'])
    assert.equal(r.serviceRegulamin, true)
  })
})

describe('the captain\'s add or swap: an adult member gives the rest on /zgoda (detailsLater)', () => {
  const asks = teamContext({ ...RAW, formFields: { city: 'required', club: 'off', ice: 'required', nationality: 'off' } }, COMPETITION, NOW)
  const five = { ...anna, phone: '', city: 'Zabrze' }
  it('only the five fields go while the more fields are hidden; shown, the rest goes too', () => {
    assert.deepEqual(Object.keys(toMemberRequest(newMember(five), { today: TODAY, detailsLater: true }).person).sort(),
      ['birthDate', 'email', 'firstName', 'gender', 'lastName'])
    assert.equal(toMemberRequest({ ...newMember(five), moreFields: true }, { today: TODAY, detailsLater: true }).person.city, 'Zabrze')
    assert.equal(toMemberRequest(newMember(five), { today: TODAY }).person.city, 'Zabrze', 'the organizer sends the whole form')
  })
  it('checkMember asks the captain for the five only; the organizer for everything', () => {
    assert.deepEqual(checkMember(newMember(five), { context: asks, today: TODAY, now: NOW, detailsLater: true }), {})
    assert.ok(checkMember(newMember(five), { context: asks, today: TODAY, now: NOW }).phone)
  })
})

describe('T-64 checkMember: the server\'s own check', () => {
  it('a complete adult passes, an empty one names its fields', () => {
    assert.deepEqual(checkMember(newMember(anna), { context, today: TODAY, now: NOW }), {})
    const e = checkMember(newMember(EMPTY_PERSON), { context, today: TODAY, now: NOW })
    assert.ok(e.firstName && e.email)
  })
  it('a child without the guardian\'s box is held on that box', () => {
    const e = checkMember(newMember(zosia), { context, today: TODAY, now: NOW })
    assert.deepEqual(Object.keys(e), ['guardianConsent'])
  })
})

describe('T-64 squadFailure: where a refusal goes', () => {
  const err = (over) => Object.assign(new Error(over.message ?? 'x'), over)
  it('squad_closed swaps the page to the closed state', () => {
    assert.equal(squadFailure(err({ status: 409, code: 'squad_closed' })).closed, true)
  })
  it('a field refusal stays on the form', () => {
    const f = squadFailure(err({ status: 409, code: 'duplicate', message: 'Zapisana.', fields: { email: 'Zapisana.' } }))
    assert.deepEqual(f.fields, { email: 'Zapisana.' })
    assert.equal(f.stale, false)
  })
  it('a retired address lands on the e-mail field', () => {
    assert.deepEqual(squadFailure(err({ status: 403, code: 'email_retired', message: 'Nie.' })).fields, { email: 'Nie.' })
  })
  it('a page behind the server reads the team again and shows why', () => {
    for (const code of ['invalid_legs', 'not_member', 'team_inactive', 'team_full', 'leg_order_off']) {
      const f = squadFailure(err({ status: 409, code, message: 'Powód.' }))
      assert.equal(f.stale, true, code)
      assert.equal(f.message, 'Powód.')
    }
  })
  it('no session → login; not found → the missing page; offline → Polish', () => {
    assert.equal(squadFailure(err({ status: 401 })).login, true)
    assert.equal(squadFailure(err({ status: 404 })).missing, true)
    assert.equal(squadFailure(err({})).message, 'Nie udało się połączyć. Spróbuj ponownie.')
  })
})

describe('T-64 the rest of the page', () => {
  it('„Dodaj N. osobę” names the next place, hidden at the maximum', () => {
    assert.equal(addLabel({ count: 4, max: 5 }), 'Dodaj 5. osobę')
    assert.equal(addLabel({ count: 5, max: 5 }), null)
  })
  it('a deleted member reads once', () => {
    assert.equal(memberName({ firstName: 'Usunięte konto', lastName: null }), 'Usunięte konto')
    assert.equal(memberName({ firstName: 'Ola', lastName: 'Leśna' }), 'Ola Leśna')
  })
  it('a row says the leg, the captain, the class, a child\'s age', () => {
    assert.deepEqual(memberMeta({ leg: 2, isCaptain: true, ageGroupLabel: 'K30' }, true), ['ZMIANA 2', 'KAPITAN', 'K30'])
    assert.deepEqual(memberMeta({ leg: 2, role: 'minor', ageGroupLabel: null, age: 12 }, false), ['12 LAT'])
  })
  it('moveLeg moves one place and leaves the ends alone', () => {
    assert.deepEqual(moveLeg(['a', 'b', 'c'], 1, -1), ['b', 'a', 'c'])
    assert.deepEqual(moveLeg(['a', 'b', 'c'], 2, 1), ['a', 'b', 'c'])
  })
})

describe('captainTeamPath (RA5 and the order page → RB4)', () => {
  it('the captain\'s line links to the team; anybody else\'s does not', () => {
    const lines = [{ teamId: 't1', isCaptain: false }, { teamId: 't1', isCaptain: true }]
    assert.equal(captainTeamPath('wilcza-16', lines), '/events/wilcza-16/druzyna/t1')
    assert.equal(captainTeamPath('wilcza-16', [{ teamId: 't1', isCaptain: false }]), null)
    assert.equal(captainTeamPath('wilcza-16', [{ teamId: null, isCaptain: false }]), null)
    assert.equal(captainTeamPath('wilcza-16', []), null)
    assert.equal(captainTeamPath(null, lines), null)
  })
})

describe('squadFailure: consents that changed', () => {
  it('asks for the snapshot again and stays on the form with the server\'s message', () => {
    const f = squadFailure(Object.assign(new Error('Zaznacz wymagane zgody.'), { status: 400, code: 'consents_changed' }))
    assert.equal(f.consentsChanged, true)
    assert.equal(f.message, 'Zaznacz wymagane zgody.')
    assert.equal(f.stale, false)
    assert.equal(f.closed, false)
  })
})

describe('TP-42 the captain\'s add or swap of a child whose parent is somebody else', () => {
  const marta = { firstName: 'Marta', lastName: 'Leśna', email: 'marta@x.pl' }
  it('the parent goes, no box, no consents of the captain\'s', () => {
    const r = toMemberRequest({ ...newMember(zosia), parentOther: true, parent: marta }, { consents: [{ id: 'k1' }], today: TODAY })
    assert.deepEqual(Object.keys(r).sort(), ['parent', 'person'])
    assert.deepEqual(r.parent, marta)
    assert.equal('email' in r.person, false)
  })
  it('checkMember refuses the captain\'s own address as the parent\'s', () => {
    const errors = checkMember({ ...newMember(zosia), parentOther: true, parent: { ...marta, email: 'kapitan@x.pl' } },
      { context, today: TODAY, captainEmail: 'Kapitan@x.pl' })
    assert.match(errors.parentEmail, /To Twój adres/)
  })
})
