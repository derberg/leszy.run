// Plan 4, task 1 fix round: until validateGroup is wired in (Task 4), prepareRegistration
// keeps today's behaviour: one person, adults only.
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
      select: () => q, eq: () => q,
      maybeSingle: async () => ({ data: tables[table] ?? null, error: null }),
      then: (res) => res({ data: [], error: null }),
    }
    return q
  },
}
const req = new Request('http://x', { method: 'POST' })
const run = (body) => prepareRegistration(req, fakeAdmin, { categoryId: CAT, ...body }, { pricing: () => null, throttles: () => [] })
const adult = { firstName: 'Ola', lastName: 'Leśna', birthDate: '1990-05-01', gender: 'K', email: 'ola@example.pl', phone: '600100200' }

test('a minor is refused through prepareRegistration, as before groups', async () => {
  const r = await run({ person: { ...adult, birthDate: '2015-01-01' } })
  assert.equal(r.response.status, 400)
  const body = await r.response.json()
  assert.equal(body.code, 'invalid_person')
  assert.deepEqual(body.fields, { birthDate: 'Zapis osoby niepełnoletniej będzie możliwy wkrótce.' })
})

test('two people are refused through prepareRegistration', async () => {
  const r = await run({ people: [adult, { ...adult, email: 'b@example.pl' }] })
  assert.equal(r.response.status, 400)
  const body = await r.response.json()
  assert.equal(body.code, 'too_many_people')
  assert.equal(body.error, 'Można zapisać jedną osobę naraz.')
})

test('one adult still passes the people step', async () => {
  const r = await run({ person: adult })
  assert.equal(r.response?.status, 400)
  assert.equal((await r.response.json()).code, 'consents_required')
})
