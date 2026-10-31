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

test('G-35 no buyer sent → no `buyer` error block, in a legacy body and in a people body (m-2)', async () => {
  const legacyBody = await (await run({ person: { ...adult, email: '' } })).response.json()
  assert.equal(legacyBody.code, 'invalid_person')
  assert.equal('buyer' in legacyBody, false, JSON.stringify(legacyBody))
  assert.ok(legacyBody.fields.email)
  const peopleBody = await (await run({ people: [{ ...adult, email: '' }] })).response.json()
  assert.equal('buyer' in peopleBody, false, JSON.stringify(peopleBody))
  // A buyer that was sent keeps its errors.
  const sent = await (await run({ people: [{ ...adult, email: '' }], buyer: { firstName: '', lastName: 'X', email: 'x@example.pl' } })).response.json()
  assert.deepEqual(sent.buyer, { firstName: 'Podaj imię.' })
})

test('G-35 fullRefusal names the competition a group no longer fits, or none when it is not known (m-5)', async () => {
  const { fullRefusal } = await import('../../../supabase/functions/_shared/registration/registrationRequest.js')
  const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const comps = [{ category_id: A, name: 'Bieg 9 km', taken: 1, capacity: 5 }, { category_id: B, name: 'Bieg dzieci', taken: 4, capacity: 5 }]
  const people = [{ categoryId: A }, { categoryId: B }, { categoryId: B }]
  assert.deepEqual(fullRefusal(comps, people, { legacy: false }),
    { error: 'Brak wolnych miejsc w konkurencji Bieg dzieci.', code: 'full', categoryId: B })
  assert.deepEqual(fullRefusal(comps, [{ categoryId: A }], { legacy: false }), { error: 'Brak wolnych miejsc.', code: 'full' })
  assert.deepEqual(fullRefusal(comps, people, { legacy: true }), { error: 'Brak wolnych miejsc w tej konkurencji.', code: 'full' })
})
