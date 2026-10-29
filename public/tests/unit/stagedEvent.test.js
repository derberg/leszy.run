import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stagedEvent } from '../../src/lib/stagedEvent.js'

const C1 = '11111111-1111-4111-8111-111111111111'
const K1 = '22222222-2222-4222-8222-222222222222'

const live = {
  settings: { state: 'published', name: 'Bieg', placeDetails: 'Boisko', opensOn: '2026-11-01', closesOn: '2026-12-03', pricingMode: 'free', ageReckoning: 'race_day', timingCompany: null, formFields: { phone: 'optional' } },
  competitions: [{ categoryId: C1, name: 'Bieg 9 km', startTime: '10:00:00', capacity: 50, taken: 3, hiddenAt: null, priceGrosze: null }],
  officeHours: [], ageGroups: [], kidsGroups: [],
  consents: [{ id: K1, kind: 'regulamin', text: 'Akceptuję regulamin zawodów.' }],
  pending: null,
}

test('no pending changes: the live event as it is', () => {
  assert.equal(stagedEvent(live), live)
})

test('I5: every staged section replaces the live one in the step shapes', () => {
  const e = stagedEvent({ ...live, pending: { payload: {
    basics: { place_details: 'Hala', opens_at: '2026-10-31T23:00:00.000Z', closes_at: '2026-12-04T23:00:00.000Z' },
    office: { office_notes: 'X', hours: [{ date: '2026-12-05', from: '17:00', to: '19:00' }] },
    competitions: { pricing_mode: 'free', items: [
      { category_id: C1, name: 'Bieg 9 km', start_time: '10:15', capacity: 60, hidden: false, kind: 'individual', is_kids: false, timed: true, price: null },
      { category_id: null, name: 'Nowa', start_time: null, capacity: 5, hidden: false, kind: 'individual', is_kids: true, timed: true, price: null },
    ] },
    categories: { age_reckoning: 'year_end', age_groups: [{ id: null, category_id: C1, gender: 'K', label: 'K16+', min_age: 16, max_age: null }], kids_groups: [] },
    timing: { timing_company: 'Pomiar' },
    form: { form_fields: { phone: 'required' }, consents: [{ id: null, text: 'Nowa zgoda.' }] },
  } } })
  assert.equal(e.settings.placeDetails, 'Hala')
  assert.equal(e.settings.name, 'Bieg')
  assert.equal(e.settings.opensOn, '2026-11-01')
  assert.equal(e.settings.closesOn, '2026-12-04')
  assert.equal(e.settings.officeNotes, 'X')
  assert.deepEqual(e.officeHours, [{ date: '2026-12-05', from: '17:00', to: '19:00' }])
  assert.deepEqual(e.competitions.map((c) => [c.categoryId, c.startTime, c.capacity, c.taken, c.hiddenAt, c.isKids]),
    [[C1, '10:15', 60, 3, null, false], [null, null, 5, 0, null, true]])
  assert.equal(e.settings.ageReckoning, 'year_end')
  assert.deepEqual(e.ageGroups, [{ id: null, categoryId: C1, gender: 'K', label: 'K16+', minAge: 16, maxAge: null }])
  assert.equal(e.settings.timingCompany, 'Pomiar')
  assert.deepEqual(e.settings.formFields, { phone: 'required' })
  assert.deepEqual(e.consents.map((k) => [k.kind, k.text]), [['regulamin', 'Akceptuję regulamin zawodów.'], ['custom', 'Nowa zgoda.']])
})

test('a staged hidden flag shows as hidden, a staged unhide as visible', () => {
  const hiddenLive = { ...live, competitions: [{ ...live.competitions[0], hiddenAt: '2026-10-29T10:00:00Z' }] }
  const item = (hidden) => ({ pending: { payload: { competitions: { pricing_mode: 'free', items: [{ category_id: C1, name: 'B', hidden }] } } } })
  assert.equal(stagedEvent({ ...live, ...item(true) }).competitions[0].hiddenAt != null, true)
  assert.equal(stagedEvent({ ...hiddenLive, ...item(false) }).competitions[0].hiddenAt, null)
})

test('W-63 a staged consent list keeps the live `accepted` flag of each consent it lists', () => {
  const K2 = '33333333-3333-4333-8333-333333333333'
  const withCustom = { ...live, consents: [...live.consents, { id: K2, kind: 'custom', text: 'Zgoda.', accepted: true }] }
  const e = stagedEvent({ ...withCustom, pending: { payload: { form: { consents: [{ id: K2, text: 'Zgoda.' }, { id: null, text: 'Nowa.' }] } } } })
  assert.deepEqual(e.consents.filter((k) => k.kind === 'custom').map((k) => [k.text, k.accepted]), [['Zgoda.', true], ['Nowa.', false]])
})

test('P-40 a staged payment window is what the Płatności step shows', () => {
  const e = stagedEvent({ ...live, settings: { ...live.settings, paymentWindowHours: 168 }, pending: { payload: { payments: { payment_window_hours: 24 } } } })
  assert.equal(e.settings.paymentWindowHours, 24)
})
