// Plan 2, task 9: W-28, validatePerson (the registration form's person, checked
// on the server before register_free).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validatePerson, MINOR_MESSAGE } from '../../../supabase/functions/_shared/registration/person.js'

// 2026-10-28 10:00 in Warsaw.
const NOW = new Date('2026-10-28T09:00:00Z')
const RACE = '2027-03-14'

const ALL_OPTIONAL = { phone: 'optional', city: 'optional', club: 'optional', ice: 'optional' }

const person = (over = {}) => ({
  firstName: ' Ola ', lastName: ' Leśna ', birthDate: '1990-05-01', gender: 'K', email: ' Ola@Example.PL ', ...over,
})

const ctx = (over = {}) => ({
  formFields: ALL_OPTIONAL,
  competition: { minAge: null, maxAge: null, isKids: false },
  raceDate: RACE,
  reckoning: 'race_day',
  ageGroups: [],
  kidsGroups: [],
  now: NOW,
  ...over,
})

test('W-28 a complete adult is accepted and normalised', () => {
  const r = validatePerson(person({ phone: ' +48 600 100 200 ', city: ' Gliwice ', club: '', iceName: '', icePhone: '' }), ctx())
  assert.equal(r.ok, true, JSON.stringify(r.errors))
  assert.deepEqual(r.errors, {})
  assert.deepEqual(r.value, {
    firstName: 'Ola', lastName: 'Leśna', birthDate: '1990-05-01', gender: 'K', email: 'ola@example.pl',
    phone: '+48 600 100 200', city: 'Gliwice', club: null, iceName: null, icePhone: null,
    ageGroupLabel: 'K open', kidsGroupId: null,
  })
})

test('W-28 first name, last name, birth date, gender and email are always required', () => {
  const r = validatePerson({}, ctx())
  assert.equal(r.ok, false)
  assert.deepEqual(Object.keys(r.errors).sort(), ['birthDate', 'email', 'firstName', 'gender', 'lastName'])
  const blank = validatePerson(person({ firstName: '  ', lastName: '', email: 'nie-email', birthDate: '1990-02-30' }), ctx())
  assert.deepEqual(Object.keys(blank.errors).sort(), ['birthDate', 'email', 'firstName', 'lastName'])
})

test('W-28 gender other than M or K is refused', () => {
  for (const gender of ['X', 'F', 'k', '', null]) {
    const r = validatePerson(person({ gender }), ctx())
    assert.equal(r.ok, false, String(gender))
    assert.ok(r.errors.gender, String(gender))
  }
  assert.equal(validatePerson(person({ gender: 'M' }), ctx()).ok, true)
})

test('W-28 a birth date in the future or before 1900 is refused', () => {
  assert.ok(validatePerson(person({ birthDate: '2030-01-01' }), ctx()).errors.birthDate)
  assert.ok(validatePerson(person({ birthDate: '1899-12-31' }), ctx()).errors.birthDate)
})

test('W-28 formFields: required fields must be filled, off fields are dropped', () => {
  const formFields = { phone: 'required', city: 'off', club: 'optional', ice: 'required' }
  const missing = validatePerson(person({ city: 'Gliwice' }), ctx({ formFields }))
  assert.equal(missing.ok, false)
  assert.deepEqual(Object.keys(missing.errors).sort(), ['iceName', 'icePhone', 'phone'])

  const r = validatePerson(person({
    phone: '600100200', city: 'Gliwice', club: 'ZATYRANI', iceName: 'Jan Leśny', icePhone: '600 200 300',
  }), ctx({ formFields }))
  assert.equal(r.ok, true, JSON.stringify(r.errors))
  assert.equal(r.value.city, null, 'an off field is never stored')
  assert.equal(r.value.club, 'ZATYRANI')
  assert.equal(r.value.iceName, 'Jan Leśny')
})

test('W-28 a missing formFields entry counts as optional; an invalid phone is refused', () => {
  const r = validatePerson(person(), ctx({ formFields: {} }))
  assert.equal(r.ok, true)
  assert.ok(validatePerson(person({ phone: 'abc' }), ctx()).errors.phone)
})

test('W-28 age outside the competition range → message from the range', () => {
  const young = validatePerson(person({ birthDate: '2015-01-01' }), ctx({ competition: { minAge: 16, maxAge: null } }))
  assert.deepEqual(young.errors, { birthDate: 'Ta konkurencja jest dla osób w wieku 16+.' })
  const both = validatePerson(person({ birthDate: '1950-01-01' }), ctx({ competition: { minAge: 18, maxAge: 60 } }))
  assert.deepEqual(both.errors, { birthDate: 'Ta konkurencja jest dla osób w wieku 18–60 lat.' })
  const maxOnly = validatePerson(person({ birthDate: '1950-01-01' }), ctx({ competition: { minAge: null, maxAge: 60 } }))
  assert.deepEqual(maxOnly.errors, { birthDate: 'Ta konkurencja jest dla osób w wieku do 60 lat.' })
  // The range uses the event's age_reckoning: 39 on race day 2027-03-14, 40 by 31 December.
  const forty = { competition: { minAge: 40, maxAge: null } }
  const b = person({ birthDate: '1987-06-01' })
  assert.deepEqual(validatePerson(b, ctx(forty)).errors, { birthDate: 'Ta konkurencja jest dla osób w wieku 40+.' })
  assert.equal(validatePerson(b, ctx({ ...forty, reckoning: 'year_end' })).ok, true)
})

test('W-28 a minor (under 18 today in Warsaw) is refused whatever the reckoning says', () => {
  assert.equal(MINOR_MESSAGE, 'Zapis osoby niepełnoletniej będzie możliwy wkrótce.')
  // 17 today, 18 on race day (2027-03-14) and by year end.
  const turns18BeforeRace = person({ birthDate: '2009-01-15' })
  for (const reckoning of ['race_day', 'year_end']) {
    const r = validatePerson(turns18BeforeRace, ctx({ reckoning }))
    assert.deepEqual(r.errors, { birthDate: MINOR_MESSAGE }, reckoning)
  }
})

test('W-28 the 18th birthday is today in Warsaw (still the 27th in UTC) → accepted', () => {
  const now = new Date('2026-10-27T23:30:00Z') // 2026-10-28 00:30 in Warsaw
  assert.equal(validatePerson(person({ birthDate: '2008-10-28' }), ctx({ now })).ok, true)
  assert.deepEqual(validatePerson(person({ birthDate: '2008-10-29' }), ctx({ now })).errors, { birthDate: MINOR_MESSAGE })
})

test('W-28 age group label from the competition groups and the event reckoning', () => {
  const ageGroups = [
    { gender: 'K', label: 'K30–39', minAge: 30, maxAge: 39 },
    { gender: 'M', label: 'M30–39', minAge: 30, maxAge: 39 },
  ]
  // 29 on race day, 30 by year end.
  const p = person({ birthDate: '1997-06-01' })
  assert.equal(validatePerson(p, ctx({ ageGroups })).value.ageGroupLabel, 'K open')
  assert.equal(validatePerson(p, ctx({ ageGroups, reckoning: 'year_end' })).value.ageGroupLabel, 'K30–39')
  assert.equal(validatePerson(person({ birthDate: '1990-01-01', gender: 'M' }), ctx({ ageGroups })).value.ageGroupLabel, 'M30–39')
})

test('W-28 kids group id only in a kids competition, matching birth year and gender', () => {
  const kidsGroups = [
    { id: 'g-any', minYear: 1980, maxYear: 1989, gender: null },
    { id: 'g-k', minYear: 1990, maxYear: 1999, gender: 'K' },
    { id: 'g-m', minYear: 1990, maxYear: 1999, gender: 'M' },
  ]
  const kids = { competition: { minAge: null, maxAge: null, isKids: true }, kidsGroups }
  assert.equal(validatePerson(person(), ctx(kids)).value.kidsGroupId, 'g-k')
  assert.equal(validatePerson(person({ gender: 'M' }), ctx(kids)).value.kidsGroupId, 'g-m')
  assert.equal(validatePerson(person({ birthDate: '1985-01-01' }), ctx(kids)).value.kidsGroupId, 'g-any')
  assert.equal(validatePerson(person(), ctx({ kidsGroups })).value.kidsGroupId, null)
})

test('W-28 overlong text is refused', () => {
  assert.ok(validatePerson(person({ lastName: 'x'.repeat(101) }), ctx()).errors.lastName)
  assert.ok(validatePerson(person({ club: 'x'.repeat(201) }), ctx()).errors.club)
})
