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

test('P-59 a staged „do końca zapisów” is what the Płatności step shows, and switching back clears it', () => {
  const base = { ...live, settings: { ...live.settings, paymentWindowHours: 168, paymentWindowUntilClose: false } }
  const on = stagedEvent({ ...base, pending: { payload: { payments: { payment_window_until_close: true } } } })
  assert.equal(on.settings.paymentWindowUntilClose, true)
  assert.equal(on.settings.paymentWindowHours, 168)
  const off = stagedEvent({ ...base, settings: { ...base.settings, paymentWindowUntilClose: true },
    pending: { payload: { payments: { payment_window_hours: 24, payment_window_until_close: false } } } })
  assert.deepEqual([off.settings.paymentWindowHours, off.settings.paymentWindowUntilClose], [24, false])
})

// ---------------------------------------------------------------- teams (plan 5, task 6)

const liveTeam = {
  ...live,
  competitions: [{
    categoryId: C1, name: 'Sztafeta', kind: 'team', teamMin: 2, teamMax: 6, legOrderEnabled: false,
    capacity: 20, taken: 0, inUse: true, hiddenAt: null, priceGrosze: null,
  }],
}
const stagedItem = { category_id: C1, name: 'Sztafeta', kind: 'team', team_min: 2, team_max: 8, capacity: 20, hidden: false, price: null }

test('T-50 a staged team size is what the step shows (P2-R25)', () => {
  const e = stagedEvent({ ...liveTeam, pending: { payload: { competitions: { pricing_mode: 'free', items: [stagedItem] } } } })
  assert.deepEqual([e.competitions[0].kind, e.competitions[0].teamMin, e.competitions[0].teamMax], ['team', 2, 8])
})

test('T-52 a staged list keeps the live lock and leg order: a pending team has taken 0, only inUse knows', () => {
  const e = stagedEvent({ ...liveTeam, pending: { payload: { competitions: { pricing_mode: 'free', items: [stagedItem] } } } })
  assert.equal(e.competitions[0].inUse, true)
  assert.equal(e.competitions[0].legOrderEnabled, false)
  const fresh = stagedEvent({ ...liveTeam, pending: { payload: { competitions: { pricing_mode: 'free', items: [{ ...stagedItem, category_id: null }] } } } })
  assert.equal(fresh.competitions[0].inUse, false)
})

test('T-51 a staged leg order is what the step shows, with the live value beside it (P2-R25)', () => {
  const e = stagedEvent({ ...liveTeam, pending: { payload: { form: { leg_order: { [C1]: true } } } } })
  assert.equal(e.competitions[0].legOrderEnabled, true)
  assert.equal(e.competitions[0].legOrderLive, false)
  assert.equal(liveTeam.competitions[0].legOrderEnabled, false, 'the input is never changed')

  const both = stagedEvent({ ...liveTeam, pending: { payload: {
    competitions: { pricing_mode: 'free', items: [stagedItem] }, form: { leg_order: { [C1]: true } },
  } } })
  assert.deepEqual([both.competitions[0].legOrderEnabled, both.competitions[0].legOrderLive, both.competitions[0].teamMax], [true, false, 8])
})

test('V-70 staged tiers and tier prices are what the Konkurencje grid shows; a column the publish creates is new:<index>', () => {
  const T1 = '33333333-3333-4333-8333-333333333333'
  const e = stagedEvent({ ...live, tiers: [{ id: T1, endsOn: '2026-11-15', sortOrder: 0 }], pending: { payload: {
    competitions: { pricing_mode: 'tiered', tiers: [{ id: T1, ends_on: '2026-11-15' }, { id: null, ends_on: null }], items: [
      { category_id: C1, name: 'Bieg 9 km', start_time: '10:00', capacity: 50, hidden: false, kind: 'individual', is_kids: false, timed: true,
        price: null, prices: { [T1]: 6000, 'new:1': 8000 } },
    ] },
  } } })
  assert.equal(e.settings.pricingMode, 'tiered')
  assert.deepEqual(e.tiers, [{ id: T1, endsOn: '2026-11-15', sortOrder: 0 }, { id: null, endsOn: null, sortOrder: 1 }])
  assert.deepEqual(e.competitions[0].prices, { [T1]: 6000, 'new:1': 8000 })
})

test('V-71 staged extras keep each live variant\'s `sold`: a staged list cannot unlock what sold', () => {
  const X1 = '44444444-4444-4444-8444-444444444444'
  const V1 = '55555555-5555-4555-8555-555555555555'
  const e = stagedEvent({ ...live,
    extras: [{ id: X1, name: 'Koszulka', price: 4500, orderUntil: '2026-12-01', categoryIds: [], variants: [{ id: V1, label: 'M', stock: 10, sold: 2 }] }],
    pending: { payload: { extras: { items: [{
      id: X1, name: 'Koszulka tech', description: '35 zł to koszt koszulki.', image_upload_id: null, price: 4500, order_until: '2026-12-02', category_ids: [C1],
      variants: [{ id: V1, label: 'M', stock: 12 }, { id: null, label: 'L', stock: 100000 }],
    }] } } } })
  assert.deepEqual(e.extras, [{
    id: X1, name: 'Koszulka tech', description: '35 zł to koszt koszulki.', imageUploadId: null, price: 4500, orderUntil: '2026-12-02', categoryIds: [C1],
    variants: [{ id: V1, label: 'M', stock: 12, sold: 2 }, { id: null, label: 'L', stock: 100000, sold: 0 }],
  }])
})

test('a staged consent carries minorsOnly (the guardian consent), false when not sent', () => {
  const e = stagedEvent({ ...live, pending: { payload: { form: { consents: [{ id: null, text: 'Opiekun.', minorsOnly: true }, { id: null, text: 'Wszyscy.' }] } } } })
  assert.deepEqual(e.consents.filter((k) => k.kind === 'custom').map((k) => [k.text, k.minorsOnly]), [['Opiekun.', true], ['Wszyscy.', false]])
})
