// Plan 4: prepareRegistration runs validateGroup. The legacy one-person body is a group of one
// whose person is the registering `self`; Task 1's one-person, adults-only guard is gone.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prepareRegistration } from '../../../supabase/functions/_shared/registration/registrationRequest.js'

const CAT = '11111111-1111-4111-8111-111111111111'
const NOW = Date.now()
const tables = {
  competitions: { event_id: 'e1', category_id: CAT, hidden_at: null, min_age: null, max_age: null, is_kids: false },
  registration_settings: {
    event_id: 'e1', state: 'published', club_id: 'c1', form_fields: {}, event_date: '2027-03-14', age_reckoning: 'race_day',
    opens_at: new Date(NOW - 86400000).toISOString(), closes_at: new Date(NOW + 86400000).toISOString(),
  },
  clubs: { registration_enabled: true },
}
const fakeAdmin = {
  from(table) {
    const q = {
      select: () => q, eq: () => q, in: () => q,
      maybeSingle: async () => ({ data: tables[table] ?? null, error: null }),
      then: (res) => res({ data: table === 'competitions' ? [tables.competitions] : [], error: null }),
    }
    return q
  },
}
const req = new Request('http://x', { method: 'POST' })
const run = (body) => prepareRegistration(req, fakeAdmin, { categoryId: CAT, ...body }, { pricing: () => null, throttles: () => [] })
const adult = { firstName: 'Ola', lastName: 'Leśna', birthDate: '1990-05-01', gender: 'K', email: 'ola@example.pl', phone: '600100200' }

test('G-33 a minor registering themself → 400 invalid_group „Osobę niepełnoletnią zapisuje rodzic lub opiekun.”', async () => {
  // No session: the legacy body's person is the one the code goes to, so they are `self`.
  const r = await run({ person: { ...adult, birthDate: '2015-01-01' } })
  assert.equal(r.response.status, 400)
  const body = await r.response.json()
  assert.deepEqual(body, { error: 'Osobę niepełnoletnią zapisuje rodzic lub opiekun.', code: 'invalid_group' })
})

test('G-33 two adults in one body are a valid group: they pass the people step', async () => {
  const r = await run({ people: [adult, { ...adult, email: 'b@example.pl' }] })
  assert.equal(r.response.status, 400)
  assert.equal((await r.response.json()).code, 'consents_required')
})

test('G-33 eleven people → 400 invalid_group (MAX_PEOPLE_PER_REQUEST = 10)', async () => {
  const people = Array.from({ length: 11 }, (_, i) => ({ ...adult, email: `p${i}@example.pl` }))
  const r = await run({ people })
  assert.equal(r.response.status, 400)
  const body = await r.response.json()
  assert.equal(body.code, 'invalid_group')
  assert.match(body.error, /najwyżej 10 osób/)
})

test('G-33 a field error keyed per person, and the legacy `fields` = person 0', async () => {
  const r = await run({ people: [{ ...adult, gender: 'X' }, { ...adult, email: 'b@example.pl', firstName: '' }] })
  assert.equal(r.response.status, 400)
  const body = await r.response.json()
  assert.equal(body.code, 'invalid_person')
  assert.equal(body.error, 'Popraw zaznaczone pola.')
  assert.deepEqual(body.people, { 0: { gender: 'Wybierz płeć.' }, 1: { firstName: 'Podaj imię.' } })
  assert.deepEqual(body.fields, { gender: 'Wybierz płeć.' })
})

test('G-33 the same address twice in one group → 400 invalid_person under the second person\'s email (at most one self)', async () => {
  const r = await run({ people: [adult, { ...adult, firstName: 'Ala' }] })
  assert.equal(r.response.status, 400)
  const body = await r.response.json()
  assert.equal(body.code, 'invalid_person')
  assert.deepEqual(body.people, { 1: { email: 'Ten adres jest już w tym zgłoszeniu.' } })
})

test('G-33 one adult still passes the people step', async () => {
  const r = await run({ person: adult })
  assert.equal(r.response?.status, 400)
  assert.equal((await r.response.json()).code, 'consents_required')
})
