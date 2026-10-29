// Plan 4, task 1: G-01…G-05, the group rules (roles, guardian rule, in-group duplicates).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeGroupRequest, validateGroup } from '../../../supabase/functions/_shared/registration/group.js'
import { warsawToday } from '../../../supabase/functions/_shared/registration/dates.js'

// 2026-10-28 10:00 in Warsaw.
const NOW = new Date('2026-10-28T09:00:00Z')
const TODAY = warsawToday(NOW)
const yearsAgo = (n, extraDays = 0) => {
  const [y, m, d] = TODAY.split('-').map(Number)
  return new Date(Date.UTC(y - n, m - 1, d + extraDays)).toISOString().slice(0, 10)
}

const cctx = { formFields: {}, competition: { minAge: null, maxAge: null, isKids: false }, raceDate: '2027-03-14', reckoning: 'race_day', ageGroups: [], kidsGroups: [] }
const competitions = new Map([['c1', cctx], ['c2', { ...cctx, competition: { minAge: 21, maxAge: null, isKids: false } }]])

const person = (over = {}) => ({
  firstName: 'Ola', lastName: 'Leśna', birthDate: '1990-05-01', gender: 'K', email: 'ola@example.pl', phone: '600100200', ...over,
})
const entry = (p = {}, over = {}) => ({ categoryId: 'c1', person: person(p), guardianConsent: false, ...over })
const buyer = { firstName: 'Jan', lastName: 'Leśny', email: 'Jan@Example.pl' }
const run = (people, extra = {}) => validateGroup({ people, buyer: null, ...extra }, { sessionEmail: null, competitions, now: NOW, ...(extra.ctx ?? {}) })

test('G-01 roles: self by session email, adult and minor by birth date', () => {
  const r = validateGroup(
    { people: [entry(), entry({ firstName: 'Ala', email: 'ala@example.pl', birthDate: yearsAgo(18) }),
      entry({ firstName: 'Ela', email: 'ela@example.pl', birthDate: yearsAgo(18, 1) }, { guardianConsent: true })], buyer: null },
    { sessionEmail: 'OLA@example.pl', competitions, now: NOW })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.deepEqual(r.value.map((v) => v.role), ['self', 'adult', 'minor'])
  assert.equal(r.value[2].isMinor, true)
  assert.equal(r.buyerEmail, 'ola@example.pl')
  assert.equal(r.value[0].categoryId, 'c1')
})

test('G-01 two people with the session email: at most one self', () => {
  const r = validateGroup({ people: [entry(), entry({ firstName: 'Inna' })], buyer: null }, { sessionEmail: 'ola@example.pl', competitions, now: NOW })
  assert.equal(r.ok, false)
  assert.equal(r.errors[1].email, 'Ten adres jest już w tym zgłoszeniu.')
})

test('G-01 no self and no buyer → buyer error', () => {
  const r = run([entry()])
  assert.equal(r.ok, false)
  assert.ok(r.errors.buyer)
})

test('G-02 minor without guardian consent → error on that index; minor-only group with buyer is ok', () => {
  const kid = { firstName: 'Kuba', email: '', birthDate: yearsAgo(10) }
  const bad = run([entry(), entry(kid)], { buyer })
  assert.equal(bad.ok, false)
  assert.deepEqual(bad.errors[1], { guardianConsent: 'Zaznacz zgodę opiekuna.' })
  assert.equal(bad.errors[0], undefined)

  const ok = run([entry(kid, { guardianConsent: true })], { buyer })
  assert.equal(ok.ok, true, JSON.stringify(ok))
  assert.equal(ok.buyerEmail, 'jan@example.pl')
  assert.equal(ok.value[0].role, 'minor')
  assert.equal(ok.value[0].email, null)
})

test('G-02 a minor whose email is the session email → groupError', () => {
  const r = validateGroup({ people: [entry({ birthDate: yearsAgo(10) }, { guardianConsent: true })], buyer },
    { sessionEmail: 'ola@example.pl', competitions, now: NOW })
  assert.equal(r.ok, false)
  assert.equal(r.groupError, 'Osobę niepełnoletnią zapisuje rodzic lub opiekun.')
})

test('G-03 duplicate email (case-insensitive) → error on the second index only', () => {
  const r = run([entry(), entry({ firstName: 'Inna', email: 'OLA@example.pl' })], { buyer })
  assert.equal(r.ok, false)
  assert.equal(r.errors[0], undefined)
  assert.deepEqual(r.errors[1], { email: 'Ten adres jest już w tym zgłoszeniu.' })
})

test('G-03 duplicate minor (same name and birth date) → error on firstName of the second', () => {
  const kid = { firstName: 'Kuba', email: '', birthDate: yearsAgo(10) }
  const r = run([entry(kid, { guardianConsent: true }), entry({ ...kid, firstName: ' kuba ' }, { guardianConsent: true })], { buyer })
  assert.equal(r.ok, false)
  assert.equal(r.errors[0], undefined)
  assert.deepEqual(r.errors[1], { firstName: 'Ten adres jest już w tym zgłoszeniu.' })
})

test('G-04 more than 10 people → groupError; legacy body is a group of one', () => {
  const many = Array.from({ length: 11 }, (_, i) => entry({ firstName: `P${i}`, email: `p${i}@example.pl` }))
  const r = run(many, { buyer })
  assert.equal(r.ok, false)
  assert.equal(r.groupError, 'W jednym zgłoszeniu możesz zapisać najwyżej 10 osób.')
  const ten = run(many.slice(0, 10), { buyer })
  assert.equal(ten.ok, true, JSON.stringify(ten))

  const n = normalizeGroupRequest({ categoryId: 'c1', person: { firstName: 'A' } })
  assert.deepEqual(n, { people: [{ categoryId: 'c1', person: { firstName: 'A' }, guardianConsent: false }], buyer: null })
})

test('G-04 normalize: people with guardianConsent and buyer; consent only when exactly true', () => {
  const n = normalizeGroupRequest({
    people: [{ categoryId: 'c1', person: { firstName: 'A' }, guardianConsent: true }, { categoryId: 'c2', person: {}, guardianConsent: 'yes' }],
    buyer: { firstName: ' Jan ', lastName: 'K', email: ' J@x.pl ' },
  })
  assert.equal(n.people[0].guardianConsent, true)
  assert.equal(n.people[1].guardianConsent, false)
  assert.deepEqual(n.buyer, { firstName: 'Jan', lastName: 'K', email: 'J@x.pl' })
  assert.deepEqual(normalizeGroupRequest(null), { people: [], buyer: null })
})

test('G-05 adult without email → error; minor without email ok; minor without phone → error', () => {
  const adult = run([entry({ email: '' })], { buyer })
  assert.deepEqual(adult.errors[0], { email: 'Podaj poprawny adres e-mail.' })
  const kidOk = run([entry({ email: '', birthDate: yearsAgo(9) }, { guardianConsent: true })], { buyer })
  assert.equal(kidOk.ok, true, JSON.stringify(kidOk))
  assert.equal(kidOk.value[0].email, null)
  const kidNoPhone = run([entry({ email: '', phone: '', birthDate: yearsAgo(9) }, { guardianConsent: true })], { buyer })
  assert.deepEqual(kidNoPhone.errors[0], { phone: 'Podaj numer telefonu.' })
})

test('G-05 an adult under the competition minAge → the range message; unknown category → groupError', () => {
  const r = run([entry({ birthDate: yearsAgo(19) }, { categoryId: 'c2' })], { buyer })
  assert.deepEqual(r.errors[0], { birthDate: 'Ta konkurencja jest dla osób w wieku 21+.' })
  const u = run([entry({}, { categoryId: 'nope' })], { buyer })
  assert.equal(u.ok, false)
  assert.equal(u.groupError, 'Ta konkurencja nie przyjmuje zapisów.')
})

test('G-05 buyer-only payer (not a participant): needs name and a valid email', () => {
  const r = run([entry()], { buyer: { firstName: '', lastName: 'K', email: 'zly' } })
  assert.equal(r.ok, false)
  assert.deepEqual(Object.keys(r.errors.buyer).sort(), ['email', 'firstName'])
})

test('G-05 a minor with a malformed email is refused; a minor email equal to another person is a duplicate', () => {
  const kid = { firstName: 'Kuba', birthDate: yearsAgo(10) }
  const bad = run([entry({ ...kid, email: 'zly' }, { guardianConsent: true })], { buyer })
  assert.deepEqual(bad.errors[0], { email: 'Podaj poprawny adres e-mail.' })
  const dup = run([entry({ ...kid, email: 'ola@example.pl' }, { guardianConsent: true }), entry()], { buyer })
  assert.deepEqual(dup.errors[1], { email: 'Ten adres jest już w tym zgłoszeniu.' })
})

test('G-05 a session with a minor-only group and a buyer: ok, the buyer pays', () => {
  const r = validateGroup({ people: [entry({ email: '', birthDate: yearsAgo(10) }, { guardianConsent: true })], buyer },
    { sessionEmail: 'other@example.pl', competitions, now: NOW })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.buyerEmail, 'jan@example.pl')
})

test('G-01 a self whose own fields fail gets no buyer error on top', () => {
  const r = validateGroup({ people: [entry({ phone: '' })], buyer: null }, { sessionEmail: 'ola@example.pl', competitions, now: NOW })
  assert.deepEqual(r.errors, { 0: { phone: 'Podaj numer telefonu.' } })
})
