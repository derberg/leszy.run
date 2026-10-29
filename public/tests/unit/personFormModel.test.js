import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  EMPTY_PERSON, profilePrefill, mergePrefill, fieldModes, personContext, categoryPreview, checkPerson,
  needsCode, consentsComplete, registerBody, registrationFailure,
} from '../../src/lib/personFormModel.js'

const RETIRED = 'Ten adres e-mail należał do usuniętego konta LESZY.RUN i nie może zostać użyty ponownie. Podaj inny adres albo napisz do nas: kontakt@leszy.run.'

const RAW = {
  eventDate: '2026-12-06', ageReckoning: 'race_day',
  formFields: { phone: 'off', city: 'optional', club: 'off', nationality: 'optional' },
  consents: [{ id: 'k1', kind: 'regulamin', text: 'Akceptuję regulamin zawodów.' }, { id: 'k2', kind: 'data_info', text: 'Znam informację o danych osobowych.' }],
  competitions: [{
    categoryId: 'c1', name: 'Nordic walking 9 km', minAge: 16, maxAge: null, isKids: false,
    ageGroups: [{ gender: 'K', label: 'NW K50–59', minAge: 50, maxAge: 59 }, { gender: 'M', label: 'NW M50–59', minAge: 50, maxAge: 59 }],
    kidsGroups: [],
  }],
}
const NOW = new Date('2026-11-06T10:00:00Z')
const ctx = personContext(RAW, RAW.competitions[0], NOW)
assert.equal(EMPTY_PERSON.nationality, '')
const grazyna = {
  ...EMPTY_PERSON, firstName: 'Grażyna', lastName: 'Wiśniewska', birthDate: '1971-05-02', gender: 'K',
  email: 'Grazyna.W@wp.pl ', phone: '+48 605 222 333', city: 'Pyskowice',
}

describe('mergePrefill (the profile lands after the person started typing)', () => {
  it('fills every field the person has not touched', () => {
    const p = mergePrefill({ ...EMPTY_PERSON, firstName: 'Ola' }, { email: 'ola@x.pl', gender: 'K' }, new Set(['firstName']))
    assert.equal(p.firstName, 'Ola')
    assert.equal(p.email, 'ola@x.pl')
    assert.equal(p.gender, 'K')
  })
  it('never overwrites a touched field, even one the person cleared', () => {
    const p = mergePrefill({ ...EMPTY_PERSON, birthDate: '1990-01-02', email: '' }, { birthDate: '1988-06-01', email: 'ola@x.pl' }, new Set(['birthDate', 'email']))
    assert.equal(p.birthDate, '1990-01-02')
    assert.equal(p.email, '')
  })
  it('a null prefill changes nothing', () => {
    assert.deepEqual(mergePrefill(grazyna, null, new Set()), grazyna)
  })
})

describe('profilePrefill (the logged-in person only)', () => {
  it('copies e-mail, birth date, phone, city and club; F becomes K', () => {
    assert.deepEqual(profilePrefill({
      email: 'runner@test.local', gender: 'F', date_of_birth: '1990-03-04', phone: '+48 600 100 200', city: 'Gliwice', club: 'Kijki',
    }), {
      email: 'runner@test.local', gender: 'K', birthDate: '1990-03-04', phone: '+48 600 100 200', city: 'Gliwice', club: 'Kijki',
    })
  })

  it('X and an empty gender leave the choice to the runner; missing fields are not invented', () => {
    assert.deepEqual(profilePrefill({ email: 'a@b.pl', gender: 'X' }), { email: 'a@b.pl' })
    assert.deepEqual(profilePrefill({ email: 'a@b.pl', gender: 'M', date_of_birth: null }), { email: 'a@b.pl', gender: 'M' })
    assert.deepEqual(profilePrefill(null), {})
  })

  it('never names: profiles hold no first or last name', () => {
    const p = profilePrefill({ email: 'a@b.pl', display_name: 'Ola', username: 'ola' })
    assert.equal(p.firstName, undefined)
    assert.equal(p.lastName, undefined)
  })
})

describe('fieldModes', () => {
  it('missing means optional, nationality missing means off; ice is one switch; the phone is no switch (P2-R32)', () => {
    assert.deepEqual(fieldModes({ phone: 'off', club: 'off' }), { city: 'optional', club: 'off', ice: 'optional', nationality: 'off' })
    assert.deepEqual(fieldModes({ nationality: 'required' }), { city: 'optional', club: 'optional', ice: 'optional', nationality: 'required' })
    assert.deepEqual(fieldModes(null), { city: 'optional', club: 'optional', ice: 'optional', nationality: 'off' })
  })
})

describe('categoryPreview („Twoja kategoria”)', () => {
  it('the age group on race day, live as birth date and gender are filled', () => {
    assert.equal(categoryPreview(grazyna, ctx), 'NW K50–59')
    assert.equal(categoryPreview({ ...grazyna, gender: 'M' }, ctx), 'NW M50–59')
    assert.equal(categoryPreview({ ...grazyna, birthDate: '1990-01-01' }, ctx), 'K open')
  })

  it('nothing until both are known and the date is real', () => {
    assert.equal(categoryPreview({ ...grazyna, gender: '' }, ctx), null)
    assert.equal(categoryPreview({ ...grazyna, birthDate: '' }, ctx), null)
    assert.equal(categoryPreview({ ...grazyna, birthDate: '1971-02-30' }, ctx), null)
    assert.equal(categoryPreview({ ...grazyna, birthDate: '19' }, ctx), null)
  })
})

describe('checkPerson (the server rules, run before „Dalej”)', () => {
  it('a complete adult passes; the e-mail is normalised', () => {
    const r = checkPerson(grazyna, ctx)
    assert.equal(r.ok, true, JSON.stringify(r.errors))
    assert.equal(r.value.email, 'grazyna.w@wp.pl')
    assert.equal(r.value.club, null, 'off field dropped')
  })

  it('W-65 the phone is required even where the stored mode says off; the competition age and the adults-only rule (age on the registration day)', () => {
    assert.equal(checkPerson({ ...grazyna, phone: '' }, ctx).errors.phone, 'Podaj numer telefonu.')
    assert.equal(checkPerson({ ...grazyna, nationality: 'XX' }, ctx).errors.nationality, 'Wybierz kraj z listy.')
    assert.equal(checkPerson({ ...grazyna, birthDate: '2012-01-01' }, ctx).errors.birthDate, 'Ta konkurencja jest dla osób w wieku 16+.')
    // 17 on 6 Nov 2026, 18 by race day: a minor, adulthood is judged today (the group rules decide what a minor needs).
    assert.equal(checkPerson({ ...grazyna, birthDate: '2008-12-01' }, ctx).value.isMinor, true)
    assert.deepEqual(Object.keys(checkPerson(EMPTY_PERSON, ctx).errors).sort(), ['birthDate', 'email', 'firstName', 'gender', 'lastName', 'phone'])
  })
})

describe('needsCode', () => {
  it('no code when the session holds the same address', () => {
    assert.equal(needsCode('runner@test.local', ' Runner@Test.local'), false)
  })
  it('a code for anybody else', () => {
    assert.equal(needsCode(null, 'runner@test.local'), true)
    assert.equal(needsCode('owner@x.pl', 'runner@test.local'), true)
  })
  it('N1: no second code for an address this form already verified, whatever the session cache says', () => {
    assert.equal(needsCode(null, 'runner@test.local', 'Runner@Test.local '), false)
    assert.equal(needsCode('owner@x.pl', 'runner@test.local', 'runner@test.local'), false)
    assert.equal(needsCode(null, 'other@test.local', 'runner@test.local'), true)
    assert.equal(needsCode(null, 'runner@test.local', null), true)
  })
})

describe('consentsComplete', () => {
  it('every event consent and the LESZY.RUN service regulamin', () => {
    assert.equal(consentsComplete(RAW.consents, { k1: true, k2: true }, true), true)
    assert.equal(consentsComplete(RAW.consents, { k1: true, k2: true }, false), false)
    assert.equal(consentsComplete(RAW.consents, { k1: true }, true), false)
    assert.equal(consentsComplete([], {}, true), true)
  })
})

describe('registerBody', () => {
  it('posts the checked person, every consent id, the service regulamin and the code when there is one', () => {
    const { value } = checkPerson({ ...grazyna, nationality: 'PL' }, ctx)
    assert.deepEqual(registerBody({ categoryId: 'c1', person: value, consents: RAW.consents, code: ' 123456 ' }), {
      categoryId: 'c1',
      person: {
        firstName: 'Grażyna', lastName: 'Wiśniewska', birthDate: '1971-05-02', gender: 'K', email: 'grazyna.w@wp.pl',
        phone: '+48 605 222 333', city: 'Pyskowice', club: null, iceName: null, icePhone: null, nationality: 'PL',
      },
      acceptedConsentIds: ['k1', 'k2'], serviceRegulamin: true, code: '123456',
    })
    assert.equal('code' in registerBody({ categoryId: 'c1', person: value, consents: RAW.consents }), false)
  })
})

describe('registrationFailure (server answer → where it shows)', () => {
  const err = (status, code, message, fields) => Object.assign(new Error(message), { status, code, fields })

  it('a retired address and a duplicate show under the e-mail field, back on the form', () => {
    assert.deepEqual(registrationFailure(err(403, 'email_retired', RETIRED)), { step: 'form', fields: { email: RETIRED }, message: null })
    assert.deepEqual(registrationFailure(err(409, 'duplicate', 'Ten adres e-mail jest już zapisany na te zawody.')),
      { step: 'form', fields: { email: 'Ten adres e-mail jest już zapisany na te zawody.' }, message: null })
  })

  it('person field errors go back to their inputs', () => {
    assert.deepEqual(registrationFailure(err(400, 'invalid_person', 'Popraw zaznaczone pola.', { phone: 'Podaj numer telefonu.' })),
      { step: 'form', fields: { phone: 'Podaj numer telefonu.' }, message: 'Popraw zaznaczone pola.' })
  })

  it('a wrong or expired code stays on the code step', () => {
    assert.deepEqual(registrationFailure(err(401, undefined, 'Nieprawidłowy kod.')), { step: 'code', fields: { code: 'Nieprawidłowy kod.' }, message: null })
  })

  it('full, closed and the rest are a message on the form', () => {
    assert.deepEqual(registrationFailure(err(409, 'full', 'Brak wolnych miejsc w tej konkurencji.')),
      { step: 'form', fields: {}, message: 'Brak wolnych miejsc w tej konkurencji.' })
    assert.deepEqual(registrationFailure(new TypeError('Failed to fetch')),
      { step: 'form', fields: {}, message: 'Nie udało się połączyć. Spróbuj ponownie.' })
  })
})
