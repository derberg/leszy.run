import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  newDraft, addPerson, removePerson, updatePerson, setGuardianConsent, setNotRunning, cardVariant, cardVariants,
  effectivePerson, peopleCount, canAdd, toRequest, checkDraft, draftReady, groupFailure, cardName, fixMessage, cardEmpty,
  setCardOpen, formStep, stepAfter, LIST_STEP,
} from '../../src/lib/groupDraft.js'
import { EMPTY_PERSON, personContext } from '../../src/lib/personFormModel.js'

// Plan 4 task 5a: the group form's draft (RA2/RA3) as pure functions.
// G-37 cardVariant, G-38 toRequest and the child's phone (D4-26), G-39 the guardian box and „Dalej”.

const RAW = {
  eventDate: '2026-12-06', ageReckoning: 'race_day',
  formFields: { city: 'optional', club: 'off', ice: 'off', nationality: 'off' },
  consents: [{ id: 'k1', kind: 'regulamin', text: 'Akceptuję regulamin.' }, { id: 'k2', kind: 'data_info', text: 'Znam informację o danych osobowych.' }],
  competitions: [
    { categoryId: 'c9', name: 'Bieg 9 km', minAge: null, maxAge: null, isKids: false, ageGroups: [], kidsGroups: [] },
    { categoryId: 'ck', name: 'Bieg dzieci 1 km', minAge: null, maxAge: 17, isKids: true, ageGroups: [], kidsGroups: [] },
  ],
}
const NOW = new Date('2026-11-06T10:00:00Z')
const TODAY = '2026-11-06'
const contexts = new Map(RAW.competitions.map((c) => [c.categoryId, personContext(RAW, c, NOW)]))

const me = { ...EMPTY_PERSON, firstName: 'Ola', lastName: 'Leśna', birthDate: '1988-03-01', gender: 'K', email: 'ola@x.pl', phone: '600100200' }
const partner = { firstName: 'Piotr', lastName: 'Leśny', birthDate: '1987-01-01', gender: 'M', email: 'piotr@x.pl', phone: '600300400' }
const kid = { firstName: 'Zosia', lastName: 'Leśna', birthDate: '2016-05-05', gender: 'K' }

/** Card 1 is me; card 2 a partner in the 9 km; card 3 a child in the kids' run. */
function family() {
  let d = newDraft('c9')
  d = updatePerson(d, d.cards[0].key, me)
  d = addPerson(d, { categoryId: 'c9' })
  d = updatePerson(d, d.cards[1].key, partner)
  d = addPerson(d, { categoryId: 'ck' })
  d = updatePerson(d, d.cards[2].key, kid)
  return d
}

describe('G-37 cardVariant: the child layout until the 18th birthday on today\'s Warsaw date', () => {
  it('one day short of 18 is a minor, the 18th birthday an adult', () => {
    assert.equal(cardVariant({ birthDate: '2008-11-07' }, TODAY), 'minor')
    assert.equal(cardVariant({ birthDate: '2008-11-06' }, TODAY), 'adult')
    assert.equal(cardVariant({ birthDate: '1980-01-01' }, TODAY), 'adult')
  })
  it('the Warsaw day decides: 23:30 UTC on 5 Nov is already 6 Nov in Warsaw', () => {
    assert.equal(cardVariant({ birthDate: '2008-11-06' }, new Date('2026-11-05T23:30:00Z')), 'adult')
    assert.equal(cardVariant({ birthDate: '2008-11-06' }, new Date('2026-11-05T22:30:00Z')), 'minor')
  })
  it('no (or a half-typed) birth date keeps the adult card', () => {
    assert.equal(cardVariant({ birthDate: '' }, TODAY), 'adult')
    assert.equal(cardVariant({ birthDate: '2016-02-30' }, TODAY), 'adult')
  })
  it('card 1 is „self”, or „buyer” with „Nie startuję”; the others by birth date', () => {
    const d = family()
    assert.deepEqual(cardVariants(d, TODAY), ['self', 'adult', 'minor'])
    assert.deepEqual(cardVariants(setNotRunning(d, true), TODAY), ['buyer', 'adult', 'minor'])
  })
})

describe('G-38 toRequest', () => {
  it('sends every card as people[] with its own competition; a child without an e-mail and with the guardian box', () => {
    let d = family()
    d = setGuardianConsent(d, d.cards[2].key, true)
    const body = toRequest(d, { consents: RAW.consents, today: TODAY })
    assert.equal(body.buyer, undefined)
    assert.deepEqual(body.people.map((p) => p.categoryId), ['c9', 'c9', 'ck'])
    assert.equal(body.people[0].person.email, 'ola@x.pl')
    assert.equal(body.people[1].person.email, 'piotr@x.pl')
    assert.equal('email' in body.people[2].person, false, 'a minor has no e-mail')
    assert.equal(body.people[2].guardianConsent, true)
    assert.equal('guardianConsent' in body.people[0], false)
    assert.deepEqual(body.acceptedConsentIds, ['k1', 'k2'])
    assert.equal(body.serviceRegulamin, true)
    assert.equal('code' in body, false)
    assert.equal(toRequest(d, { consents: RAW.consents, today: TODAY, code: ' 123456 ' }).code, '123456')
  })
  it('G-63 a group of one with no buyer sends Plan 3\'s body { categoryId, person }, so functions still on Plan 3 accept it (M-1)', () => {
    let d = newDraft('c9')
    d = updatePerson(d, d.cards[0].key, me)
    const body = toRequest(d, { consents: RAW.consents, today: TODAY, code: ' 123456 ' })
    assert.equal('people' in body, false)
    assert.equal('buyer' in body, false)
    assert.equal(body.categoryId, 'c9')
    assert.deepEqual(body.person, {
      firstName: 'Ola', lastName: 'Leśna', birthDate: '1988-03-01', gender: 'K', email: 'ola@x.pl', phone: '600100200',
      city: me.city, club: me.club, iceName: me.iceName, icePhone: me.icePhone, nationality: me.nationality,
    })
    assert.deepEqual(body.acceptedConsentIds, ['k1', 'k2'])
    assert.equal(body.serviceRegulamin, true)
    assert.equal(body.code, '123456')
  })
  it('G-63 two people, or one person with „Nie startuję” (a buyer), send people[]', () => {
    let d = newDraft('c9')
    d = updatePerson(d, d.cards[0].key, me)
    d = addPerson(d, { categoryId: 'c9' })
    d = updatePerson(d, d.cards[1].key, partner)
    const two = toRequest(d, { consents: RAW.consents, today: TODAY })
    assert.equal('categoryId' in two, false)
    assert.equal(two.people.length, 2)
    let b = setNotRunning(newDraft('c9'), true)
    b = updatePerson(b, b.cards[0].key, me)
    b = updatePerson(b, b.cards[1].key, partner)
    const bought = toRequest(b, { consents: RAW.consents, today: TODAY })
    assert.equal('categoryId' in bought, false)
    assert.equal(bought.people.length, 1)
    assert.deepEqual(bought.buyer, { firstName: 'Ola', lastName: 'Leśna', email: 'ola@x.pl' })
  })
  it('„Nie startuję” turns card 1 into `buyer` (imię, nazwisko, e-mail) and registers nobody for it', () => {
    const d = setNotRunning(family(), true)
    const body = toRequest(d, { consents: RAW.consents, today: TODAY })
    assert.deepEqual(body.buyer, { firstName: 'Ola', lastName: 'Leśna', email: 'ola@x.pl' })
    assert.equal(body.people.length, 2)
    assert.deepEqual(body.people.map((p) => p.person.firstName), ['Piotr', 'Zosia'])
  })
  it('a new card copies card 1\'s phone when it is a child; an edit of it sticks (D4-26)', () => {
    let d = newDraft('c9')
    d = updatePerson(d, d.cards[0].key, me)
    d = addPerson(d, { categoryId: 'ck' })
    const k = d.cards[1].key
    d = updatePerson(d, k, kid)
    assert.equal(effectivePerson(d, 1, TODAY).phone, '600100200')
    // card 1's phone changes while the child's was never edited: the child follows
    d = updatePerson(d, d.cards[0].key, { phone: '600999888' })
    assert.equal(effectivePerson(d, 1, TODAY).phone, '600999888')
    d = updatePerson(d, k, { phone: '511222333' })
    d = updatePerson(d, d.cards[0].key, { phone: '600000000' })
    assert.equal(effectivePerson(d, 1, TODAY).phone, '511222333')
    assert.equal(toRequest(d, { consents: RAW.consents, today: TODAY }).people[1].person.phone, '511222333')
    // an adult card's phone is the adult's own: nothing is copied
    d = addPerson(d, { categoryId: 'c9' })
    d = updatePerson(d, d.cards[2].key, { ...partner, phone: '' })
    assert.equal(effectivePerson(d, 2, TODAY).phone, '')
  })
  it('„Nie startuję” keeps card 1\'s phone for the children only, never as a field of the buyer', () => {
    let d = setNotRunning(newDraft('c9'), true)
    d = updatePerson(d, d.cards[0].key, me)
    d = updatePerson(d, d.cards[1].key, kid)
    const body = toRequest(d, { consents: RAW.consents, today: TODAY })
    assert.equal(body.people[0].person.phone, '600100200')
    assert.equal('phone' in body.buyer, false)
  })
  it('a card can be removed (never card 1), and the 10th person ends adding', () => {
    let d = family()
    d = removePerson(d, d.cards[1].key)
    assert.deepEqual(d.cards.map((c) => c.categoryId), ['c9', 'ck'])
    assert.equal(removePerson(d, d.cards[0].key), d)
    for (let i = 0; i < 8; i++) d = addPerson(d, { categoryId: 'c9' })
    assert.equal(peopleCount(d), 10)
    assert.equal(canAdd(d), false)
    assert.equal(addPerson(d, { categoryId: 'c9' }), d)
    // „Nie startuję”: card 1 is nobody, so one more person fits
    d = setNotRunning(d, true)
    assert.equal(peopleCount(d), 9)
    assert.equal(canAdd(d), true)
  })
  it('„+ Kolejne dziecko” takes the competition and the surname of the child before', () => {
    let d = family()
    d = addPerson(d, { after: d.cards[2].key })
    assert.equal(d.cards[3].categoryId, 'ck')
    assert.equal(d.cards[3].person.lastName, 'Leśna')
    assert.equal(d.cards[3].person.firstName, '')
  })
})

describe('G-39 the guardian box and „Dalej”', () => {
  it('a child card starts with the guardian box unticked', () => {
    const d = family()
    assert.equal(d.cards[2].guardianConsent, false)
  })
  it('„Dalej” waits for every consent and the service regulamin only; a child\'s box is on another step, so checkDraft sends the person there', () => {
    const d = family()
    const all = { k1: true, k2: true }
    assert.equal(draftReady(d, { consents: RAW.consents, accepted: { k1: true }, serviceAccepted: true }), false)
    assert.equal(draftReady(d, { consents: RAW.consents, accepted: all, serviceAccepted: false }), false)
    assert.equal(draftReady(d, { consents: RAW.consents, accepted: all, serviceAccepted: true }), true)
    assert.equal(checkDraft(d, { contexts, now: NOW }).errors[d.cards[2].key].guardianConsent, 'Zaznacz zgodę opiekuna.')
  })
  it('checkDraft answers per card, with the server\'s own rules (validateGroup)', () => {
    let d = family()
    d = updatePerson(d, d.cards[1].key, { email: 'OLA@x.pl' })
    const r = checkDraft(d, { contexts, now: NOW })
    assert.equal(r.ok, false)
    assert.equal(r.errors[d.cards[1].key].email, 'Ten adres jest już w tym zgłoszeniu.')
    assert.equal(r.errors[d.cards[2].key].guardianConsent, 'Zaznacz zgodę opiekuna.')
    assert.equal(r.errors[d.cards[0].key], undefined)
  })
  it('a minor on card 1 is the group error; „Nie startuję” with nobody else asks for a person', () => {
    let d = newDraft('c9')
    d = updatePerson(d, d.cards[0].key, { ...me, birthDate: '2010-01-01' })
    assert.equal(checkDraft(d, { contexts, now: NOW }).groupError, 'Osobę niepełnoletnią zapisuje rodzic lub opiekun.')
    d = setNotRunning(newDraft('c9'), true)
    d = removePerson(d, d.cards[1].key)
    d = updatePerson(d, d.cards[0].key, me)
    assert.equal(checkDraft(d, { contexts, now: NOW }).groupError, 'Dodaj co najmniej jedną osobę.')
  })
  it('„Nie startuję” checks the buyer\'s three fields only', () => {
    let d = setNotRunning(family(), true)
    d = setGuardianConsent(d, d.cards[2].key, true)
    d = updatePerson(d, d.cards[0].key, { birthDate: '', gender: '', email: 'zly-adres' })
    const r = checkDraft(d, { contexts, now: NOW })
    assert.deepEqual(r.errors[d.cards[0].key], { email: 'Podaj poprawny adres e-mail.' })
  })
})

describe('groupFailure: a server refusal lands on its card', () => {
  it('index-keyed duplicate and retired answers go under that card\'s e-mail, a child\'s under its name', () => {
    const d = family()
    let f = groupFailure({ status: 409, code: 'duplicate', index: 1, message: 'Ten adres e-mail jest już zapisany na te zawody.' }, d, TODAY)
    assert.deepEqual(f.errors, { [d.cards[1].key]: { email: 'Ten adres e-mail jest już zapisany na te zawody.' } })
    assert.equal(f.step, 'form')
    f = groupFailure({ status: 409, code: 'duplicate', index: 2, message: 'Ta osoba jest już zapisana na te zawody.' }, d, TODAY)
    assert.deepEqual(f.errors, { [d.cards[2].key]: { firstName: 'Ta osoba jest już zapisana na te zawody.' } })
    // „Nie startuję”: people[0] is card 2
    f = groupFailure({ status: 403, code: 'email_retired', index: 0, message: 'X' }, setNotRunning(d, true), TODAY)
    assert.deepEqual(f.errors, { [d.cards[1].key]: { email: 'X' } })
    // without an index: the one registering, card 1
    f = groupFailure({ status: 403, code: 'email_retired', message: 'X' }, d, TODAY)
    assert.deepEqual(f.errors, { [d.cards[0].key]: { email: 'X' } })
  })
  it('invalid_person per person and per buyer; full, refused and throttled are the form\'s message', () => {
    const d = setNotRunning(family(), true)
    let f = groupFailure({ status: 400, code: 'invalid_person', message: 'Popraw zaznaczone pola.', people: { 1: { phone: 'Podaj numer telefonu.' } }, buyer: { email: 'E' } }, d, TODAY)
    assert.deepEqual(f.errors, { [d.cards[2].key]: { phone: 'Podaj numer telefonu.' }, [d.cards[0].key]: { email: 'E' } })
    assert.equal(f.message, 'Popraw dane: Ola Leśna, Zosia Leśna.')
    assert.equal(f.focus, d.cards[0].key)
    // full without a competition any added card is in: the form's message only
    f = groupFailure({ status: 409, code: 'full', categoryId: 'cx', message: 'Brak wolnych miejsc w konkurencji Bieg dzieci 1 km.' }, d, TODAY)
    assert.deepEqual(f.errors, {})
    assert.equal(f.message, 'Brak wolnych miejsc w konkurencji Bieg dzieci 1 km.')
    assert.equal(f.focus, null)
    f = groupFailure({ status: 409, code: 'refused', message: 'Nie udało się zapisać tej grupy. Sprawdź dane i spróbuj ponownie.' }, d, TODAY)
    assert.equal(f.message, 'Nie udało się zapisać tej grupy. Sprawdź dane i spróbuj ponownie.')
    f = groupFailure({ status: 429, message: 'Zbyt wiele prób. Spróbuj ponownie później.' }, d, TODAY)
    assert.equal(f.message, 'Zbyt wiele prób. Spróbuj ponownie później.')
    f = groupFailure({ status: 401, code: 'code_required', message: 'Wpisz kod.' }, d, TODAY)
    assert.equal(f.step, 'code')
    assert.equal(groupFailure(new Error('offline'), d, TODAY).message, 'Nie udało się połączyć. Spróbuj ponownie.')
  })
})

describe('I-1: a refusal routed to a card names the person and says where to look', () => {
  it('a duplicate on person 2 → „Popraw dane: Piotr Leśny.” and focus on that card', () => {
    const d = family()
    const f = groupFailure({ status: 409, code: 'duplicate', index: 1, message: 'Ten adres e-mail jest już zapisany na te zawody.' }, d, TODAY)
    assert.equal(f.message, 'Popraw dane: Piotr Leśny.')
    assert.equal(f.focus, d.cards[1].key)
  })
  it('„Nie startuję” shifts the index: people[1] is card 3, the child', () => {
    const d = setNotRunning(family(), true)
    const f = groupFailure({ status: 409, code: 'duplicate', index: 1, message: 'Ta osoba jest już zapisana na te zawody.' }, d, TODAY)
    assert.deepEqual(f.errors, { [d.cards[2].key]: { firstName: 'Ta osoba jest już zapisana na te zawody.' } })
    assert.equal(f.message, 'Popraw dane: Zosia Leśna.')
    assert.equal(f.focus, d.cards[2].key)
  })
  it('full with a categoryId lands on the competition select of each added card in it', () => {
    const d = family()
    const f = groupFailure({ status: 409, code: 'full', categoryId: 'ck', message: 'Brak wolnych miejsc w konkurencji Bieg dzieci 1 km.' }, d, TODAY)
    assert.deepEqual(f.errors, { [d.cards[2].key]: { competition: 'Brak wolnych miejsc w konkurencji Bieg dzieci 1 km.' } })
    assert.equal(f.message, 'Brak wolnych miejsc w konkurencji Bieg dzieci 1 km. Zmień konkurencję: Zosia Leśna.')
    assert.equal(f.focus, d.cards[2].key)
  })
  it('a card with no name yet is „osoba N”', () => {
    const d = addPerson(family(), { categoryId: 'c9' })
    assert.equal(cardName(d, 3), 'osoba 4')
    assert.equal(fixMessage(d, { [d.cards[3].key]: { firstName: 'Podaj imię.' } }), 'Popraw dane: osoba 4.')
    assert.equal(fixMessage(d, {}), null)
  })
})

describe('M-3: a child\'s card never shows or blocks on an e-mail error', () => {
  it('invalid_person with an e-mail error on a child\'s card drops it', () => {
    const d = family()
    const f = groupFailure({ status: 400, code: 'invalid_person', message: 'Popraw zaznaczone pola.', people: { 2: { email: 'Podaj adres e-mail.' } } }, d, TODAY)
    assert.deepEqual(f.errors, {})
    assert.equal(f.message, 'Popraw zaznaczone pola.')
    assert.equal(f.focus, null)
  })
  it('a child in a competition for adults: the birth date error shows, the e-mail one does not', () => {
    const raw = { ...RAW, competitions: [{ ...RAW.competitions[0], minAge: 18 }, RAW.competitions[1]] }
    const ctx = new Map(raw.competitions.map((c) => [c.categoryId, personContext(raw, c, NOW)]))
    let d = family()
    d = updatePerson(d, d.cards[2].key, { phone: '600100200' })
    d = { ...d, cards: d.cards.map((c, i) => (i === 2 ? { ...c, categoryId: 'c9', guardianConsent: true } : c)) }
    const r = checkDraft(d, { contexts: ctx, now: NOW })
    assert.equal(r.ok, false)
    assert.ok(r.errors[d.cards[2].key].birthDate)
    assert.equal('email' in r.errors[d.cards[2].key], false)
  })
})

describe('M-2: „Nie startuję” and the card it opens', () => {
  it('on opens card 2 (autoCard); off removes it while it is empty', () => {
    const d = setNotRunning(newDraft('c9'), true)
    assert.equal(d.cards.length, 2)
    assert.equal(d.autoCard, d.cards[1].key)
    assert.equal(cardEmpty(d.cards[1]), true)
    const off = setNotRunning(d, false)
    assert.equal(off.cards.length, 1)
    assert.equal(off.notRunning, false)
  })
  it('off keeps card 2 once anything was typed into it', () => {
    let d = setNotRunning(newDraft('c9'), true)
    d = updatePerson(d, d.cards[1].key, { firstName: 'Zosia' })
    const off = setNotRunning(d, false)
    assert.equal(off.cards.length, 2)
    assert.equal(off.cards[1].person.firstName, 'Zosia')
  })
  it('a card the person added themselves is never removed by the toggle', () => {
    let d = addPerson(newDraft('c9'), { categoryId: 'c9' })
    d = setNotRunning(d, true)
    assert.equal(d.autoCard, undefined)
    assert.equal(setNotRunning(d, false).cards.length, 2)
  })
})

describe('G-69 one person on screen at a time', () => {
  const done = (d, ...keys) => keys.reduce((x, k) => setCardOpen(x, k, false), d)

  it('formStep: one card is the single form, whatever `at` says; otherwise the person named, or the list', () => {
    const one = newDraft('c9')
    assert.deepEqual(formStep(one, null), { kind: 'single' })
    assert.deepEqual(formStep(one, LIST_STEP), { kind: 'single' })
    const d = family()
    assert.deepEqual(formStep(d, d.cards[1].key), { kind: 'person', index: 1 })
    assert.deepEqual(formStep(d, d.cards[0].key), { kind: 'person', index: 0 })
    assert.deepEqual(formStep(d, LIST_STEP), { kind: 'list' })
    // the person shown was removed
    assert.deepEqual(formStep(d, 'card-gone'), { kind: 'list' })
    assert.deepEqual(formStep(removePerson(removePerson(d, d.cards[1].key), d.cards[2].key), d.cards[1].key), { kind: 'single' })
  })

  it('stepAfter: a person with no one waiting goes to the list', () => {
    const d = done(family(), ...family().cards.map((c) => c.key))
    const all = done(d, ...d.cards.map((c) => c.key))
    assert.equal(stepAfter(all, all.cards[1].key, {}), LIST_STEP)
  })

  it('stepAfter: „Nie startuję”, the payer done → the person still to fill in', () => {
    let d = setNotRunning(newDraft('c9'), true)
    d = setCardOpen(d, d.cards[0].key, false)
    assert.equal(stepAfter(d, d.cards[0].key, {}), d.cards[1].key)
  })

  it('stepAfter: another refused person comes first, then the list', () => {
    let d = family()
    d = done(d, ...d.cards.map((c) => c.key))
    const [, second, third] = d.cards.map((c) => c.key)
    const errors = { [second]: { email: 'X' }, [third]: { firstName: 'Y' } }
    assert.equal(stepAfter(d, second, errors), third)
    assert.equal(stepAfter(d, third, { [third]: { firstName: 'Y' } }), LIST_STEP)
  })
})
