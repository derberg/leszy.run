import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HOURS_NOTE_MAX, SECTIONS, validateSection, parsePriceGrosze } from '../../../supabase/functions/_shared/registration/sections.js'

const DRAFT = { state: 'draft', eventDate: null }
const PUBLISHED = { state: 'published', eventDate: '2026-12-06' }

const item = (over = {}) => ({
  name: 'Bieg 9 km', kind: 'individual', discipline: 'run', distanceLabel: '9 km', startTime: '10:00',
  capacity: 80, minAge: 16, maxAge: null, isKids: false, timed: true, ...over,
})

test('SECTIONS lists the eight wizard sections, extras last (D7-7)', () => {
  assert.deepEqual(SECTIONS, ['basics', 'office', 'competitions', 'categories', 'timing', 'form', 'payments', 'extras'])
})

test('an unknown section is refused', () => {
  const r = validateSection('bogus', {}, DRAFT)
  assert.equal(r.ok, false)
  assert.ok(r.errors.section)
})

test('every section rejects an unknown key, taken and system columns', () => {
  for (const section of SECTIONS) {
    for (const key of ['bogus', 'taken', 'state', 'club_id', 'event_id']) {
      const r = validateSection(section, { [key]: 1 }, DRAFT)
      assert.equal(r.ok, false, `${section}.${key}`)
      assert.ok(r.errors[key], `${section}.${key} has an error`)
    }
  }
})

test('a competition item rejects an unknown key and taken', () => {
  for (const key of ['bogus', 'taken']) {
    const r = validateSection('competitions', { pricingMode: 'free', items: [item({ [key]: 3 })] }, DRAFT)
    assert.equal(r.ok, false)
    assert.ok(r.errors[key])
  }
})

test('a non-object value is refused', () => {
  for (const v of [null, [], 'x', 3]) assert.equal(validateSection('basics', v, DRAFT).ok, false)
})

test('competitions: capacity 0 → Limit musi być większy od zera.', () => {
  const r = validateSection('competitions', { pricingMode: 'free', items: [item({ capacity: 0 })] }, DRAFT)
  assert.equal(r.ok, false)
  assert.deepEqual(r.errors, { capacity: 'Limit musi być większy od zera.' })
})


const TEAM_SIZE = 'Skład: od 2 do 10 osób, min ≤ max.'
const team = (over = {}) => item({ kind: 'team', teamMin: 3, teamMax: 5, ...over })
const competitions = (i, ctx = DRAFT) => validateSection('competitions', { pricingMode: 'free', items: [i] }, ctx)

test('T-06 competitions: a team with min 3 / max 5 is accepted, draft or published, as team_min / team_max', () => {
  for (const ctx of [DRAFT, PUBLISHED]) {
    const r = competitions(team(), ctx)
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.value.items[0].kind, 'team')
    assert.equal(r.value.items[0].team_min, 3)
    assert.equal(r.value.items[0].team_max, 5)
  }
  assert.equal(competitions(team({ teamMin: 2, teamMax: 10 })).ok, true)
  assert.equal(competitions(team({ teamMin: 4, teamMax: 4 })).ok, true)
})

test('T-06 competitions: a team size outside 2–10, min above max, or none at all is refused', () => {
  for (const [teamMin, teamMax, field] of [
    [1, 5, 'teamMin'], [0, 5, 'teamMin'], [11, 11, 'teamMin'], [null, 5, 'teamMin'], [undefined, 5, 'teamMin'], ['3', 5, 'teamMin'], [2.5, 5, 'teamMin'],
    [2, 11, 'teamMax'], [5, 3, 'teamMax'], [3, null, 'teamMax'], [3, undefined, 'teamMax'], [3, '5', 'teamMax'],
  ]) {
    const r = competitions(team({ teamMin, teamMax }))
    assert.equal(r.ok, false, `${teamMin}–${teamMax}`)
    assert.deepEqual(r.errors, { [field]: TEAM_SIZE }, `${teamMin}–${teamMax}`)
  }
})

test('T-06 competitions: an unknown kind is refused; an individual competition keeps no team size', () => {
  assert.deepEqual(competitions(item({ kind: 'relay' })).errors, { kind: 'Nieprawidłowa wartość.' })
  const r = competitions(item({ teamMin: 3, teamMax: 5 }))
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.value.items[0].kind, 'individual')
  assert.equal(r.value.items[0].team_min, null)
  assert.equal(r.value.items[0].team_max, null)
})

const TEAM_ID = '11111111-1111-4111-8111-111111111111'
const SOLO_ID = '22222222-2222-4222-8222-222222222222'

test('T-06 form: legOrder is accepted for a team competition and comes out as leg_order', () => {
  const r = validateSection('form', { legOrder: { [TEAM_ID]: true } }, { ...DRAFT, teamCategoryIds: [TEAM_ID] })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.deepEqual(r.value, { leg_order: { [TEAM_ID]: true } })
  const off = validateSection('form', { legOrder: { [TEAM_ID]: false } }, { ...PUBLISHED, teamCategoryIds: [TEAM_ID] })
  assert.deepEqual(off.value, { leg_order: { [TEAM_ID]: false } })
})

test('T-06 form: legOrder on an individual or unknown competition is refused, whichever way it is switched', () => {
  const ctx = { ...DRAFT, teamCategoryIds: [TEAM_ID] }
  for (const v of [true, false]) {
    const r = validateSection('form', { legOrder: { [SOLO_ID]: v } }, ctx)
    assert.equal(r.ok, false)
    assert.deepEqual(r.errors, { legOrder: 'Kolejność zmian ustawisz tylko w konkurencji drużynowej.' })
  }
  assert.equal(validateSection('form', { legOrder: { [TEAM_ID]: true } }, DRAFT).ok, false, 'no team list in the context refuses')
})

test('T-06 form: a legOrder that is not a map of booleans is refused', () => {
  const ctx = { ...DRAFT, teamCategoryIds: [TEAM_ID] }
  for (const legOrder of [null, [], true, 'x']) assert.ok(validateSection('form', { legOrder }, ctx).errors.legOrder, String(legOrder))
  assert.ok(validateSection('form', { legOrder: { [TEAM_ID]: 'tak' } }, ctx).errors.legOrder)
})

test('competitions: a valid free list normalizes to the RPC shape', () => {
  const r = validateSection('competitions', { pricingMode: 'free', items: [item({ price: '60' })] }, DRAFT)
  assert.equal(r.ok, true)
  assert.equal(r.value.pricing_mode, 'free')
  assert.deepEqual(r.value.items[0], {
    category_id: null, name: 'Bieg 9 km', kind: 'individual', discipline: 'run', distance_label: '9 km',
    start_time: '10:00', capacity: 80, min_age: 16, max_age: null, is_kids: false, timed: true,
    gpx_upload_id: null, price: null, team_min: null, team_max: null,
  })
})

test('competitions: fixed pricing parses prices to integer grosze', () => {
  const cases = { '60': 6000, '60,5': 6050, '60,50': 6050, '0': 0, '60.5': 6050, ' 45 ': 4500 }
  for (const [input, grosze] of Object.entries(cases)) {
    const r = validateSection('competitions', { pricingMode: 'fixed', items: [item({ price: input })] }, DRAFT)
    assert.equal(r.ok, true, input)
    assert.equal(r.value.items[0].price, grosze, input)
    assert.ok(Number.isInteger(r.value.items[0].price))
  }
})

test('competitions: bad prices are refused', () => {
  for (const input of ['-1', '60,505', 'abc', '', '1e3', '60,', ',5']) {
    const r = validateSection('competitions', { pricingMode: 'fixed', items: [item({ price: input })] }, DRAFT)
    assert.equal(r.ok, false, input)
    assert.ok(r.errors.price, input)
  }
})

test('parsePriceGrosze returns integer grosze or null', () => {
  assert.equal(parsePriceGrosze('60'), 6000)
  assert.equal(parsePriceGrosze('60,50'), 6050)
  assert.equal(parsePriceGrosze('0,01'), 1)
  assert.equal(parsePriceGrosze('60,505'), null)
  assert.equal(parsePriceGrosze('-1'), null)
  assert.equal(parsePriceGrosze('abc'), null)
})

test('competitions: other item rules', () => {
  const bad = [
    [{ name: '  ' }, 'name'],
    [{ discipline: 'swim' }, 'discipline'],
    [{ startTime: '25:00' }, 'startTime'],
    [{ capacity: 2.5 }, 'capacity'],
    [{ minAge: 30, maxAge: 20 }, 'maxAge'],
    [{ categoryId: 'not-a-uuid' }, 'categoryId'],
    [{ gpxUploadId: 'nope' }, 'gpxUploadId'],
  ]
  for (const [over, field] of bad) {
    const r = validateSection('competitions', { pricingMode: 'free', items: [item(over)] }, DRAFT)
    assert.equal(r.ok, false, field)
    assert.ok(r.errors[field], field)
  }
  assert.ok(validateSection('competitions', { pricingMode: 'free', items: 'x' }, DRAFT).errors.items)
})

test('basics: date-only registration window becomes Warsaw instants', () => {
  const r = validateSection('basics', {
    name: ' Bieg Leszego ', slug: 'bieg-leszego', eventDate: '2026-12-06', firstStartTime: '10:00',
    opensOn: '2026-11-01', closesOn: '2026-12-01', isCharity: true, charityGoal: 'Leczenie Zuzi',
    donationsEnabled: false, townLabel: 'Nieborowice', townArea: 'GM. PILCHOWICE · ŚLĄSKIE',
    placeDetails: 'Boisko LKS', lat: 50.2381, lng: 18.5412, regulaminKind: 'link',
    regulaminUrl: 'https://example.com/regulamin.pdf',
  }, DRAFT)
  assert.equal(r.ok, true, JSON.stringify(r.errors))
  assert.equal(r.value.name, 'Bieg Leszego')
  assert.equal(r.value.opens_at, '2026-10-31T23:00:00.000Z')
  assert.equal(r.value.closes_at, '2026-12-01T23:00:00.000Z')
  assert.equal(r.value.event_date, '2026-12-06')
  assert.equal(r.value.lat, 50.2381)
})

test('basics: only the keys sent are written (patch)', () => {
  const r = validateSection('basics', { placeDetails: 'Boisko' }, DRAFT)
  assert.deepEqual(r.value, { place_details: 'Boisko' })
})

test('basics: field rules', () => {
  const bad = [
    [{ name: '' }, 'name'],
    [{ slug: 'Bieg Leszego' }, 'slug'],
    [{ slug: 'ab' }, 'slug'],
    [{ eventDate: '2026-13-01' }, 'eventDate'],
    [{ opensOn: '2026-12-02', closesOn: '2026-12-01' }, 'closesOn'],
    [{ opensOn: '2026-12-01' }, 'closesOn'],
    [{ lat: 91 }, 'lat'],
    [{ lng: '18' }, 'lng'],
    [{ regulaminKind: 'doc' }, 'regulaminKind'],
    [{ regulaminUrl: 'javascript:alert(1)' }, 'regulaminUrl'],
    [{ isCharity: 'yes' }, 'isCharity'],
    [{ posterUploadId: 'x' }, 'posterUploadId'],
  ]
  for (const [v, field] of bad) {
    const r = validateSection('basics', v, DRAFT)
    assert.equal(r.ok, false, JSON.stringify(v))
    assert.ok(r.errors[field], `${JSON.stringify(v)} → ${field}`)
  }
})

test('basics: slug is refused after publish', () => {
  const r = validateSection('basics', { slug: 'nowy-adres' }, PUBLISHED)
  assert.equal(r.ok, false)
  assert.ok(r.errors.slug)
  assert.equal(validateSection('basics', { placeDetails: 'x' }, PUBLISHED).ok, true)
})

test('timing: timingMode only while draft', () => {
  const ok = validateSection('timing', {
    timingMode: 'external', timingCompany: 'Time-Sport', resultsUrl: 'https://wyniki.example.com', liveResultsUrl: null,
  }, DRAFT)
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.value, {
    timing_mode: 'external', timing_company: 'Time-Sport', results_url: 'https://wyniki.example.com', live_results_url: null,
  })
  assert.ok(validateSection('timing', { timingMode: 'none' }, PUBLISHED).errors.timingMode)
  assert.ok(validateSection('timing', { timingMode: 'manual' }, DRAFT).errors.timingMode)
  assert.equal(validateSection('timing', { resultsUrl: 'https://w.example.com' }, PUBLISHED).ok, true)
})

test('office: hours and place', () => {
  const r = validateSection('office', {
    sameAsEvent: false, address: 'SP, ul. Szkolna 4', notes: 'Z upoważnieniem', lat: 50.24, lng: 18.53,
    hours: [{ date: '2026-12-05', from: '17:00', to: '19:00' }],
  }, DRAFT)
  assert.equal(r.ok, true, JSON.stringify(r.errors))
  assert.deepEqual(r.value.hours, [{ date: '2026-12-05', from: '17:00', to: '19:00' }])
  assert.equal(r.value.office_same_as_event, false)
  const bad = validateSection('office', { hours: [{ date: '2026-12-05', from: '19:00', to: '17:00' }] }, DRAFT)
  assert.ok(bad.errors.to)
})

test('office: a row may carry a note, trimmed; a blank note is left out; a long one is refused', () => {
  const r = validateSection('office', { hours: [
    { date: '2026-12-05', from: '17:00', to: '19:00', note: '  tylko bieg dzieci ' },
    { date: '2026-12-06', from: '08:00', to: '09:30', note: '   ' },
  ] }, DRAFT)
  assert.equal(r.ok, true, JSON.stringify(r.errors))
  assert.deepEqual(r.value.hours, [
    { date: '2026-12-05', from: '17:00', to: '19:00', note: 'tylko bieg dzieci' },
    { date: '2026-12-06', from: '08:00', to: '09:30' },
  ])
  const long = validateSection('office', { hours: [{ date: '2026-12-05', from: '17:00', to: '19:00', note: 'x'.repeat(HOURS_NOTE_MAX + 1) }] }, DRAFT)
  assert.ok(long.errors.note)
  assert.ok(validateSection('office', { hours: [{ date: '2026-12-05', from: '17:00', to: '19:00', note: 5 }] }, DRAFT).errors.note)
})

test('categories: reckoning, age groups and kids groups', () => {
  const cat = '11111111-1111-4111-8111-111111111111'
  const r = validateSection('categories', {
    ageReckoning: 'year_end',
    ageGroups: [{ categoryId: cat, gender: 'K', label: 'K30–39', minAge: 30, maxAge: 39 }],
    kidsGroups: [{ categoryId: cat, label: 'Maluchy', birthYearFrom: 2021, birthYearTo: 2023, gender: null, distanceLabel: null }],
  }, DRAFT)
  assert.equal(r.ok, true, JSON.stringify(r.errors))
  assert.equal(r.value.age_reckoning, 'year_end')
  assert.deepEqual(r.value.age_groups[0], { id: null, category_id: cat, gender: 'K', label: 'K30–39', min_age: 30, max_age: 39 })
  assert.ok(validateSection('categories', { ageGroups: [{ categoryId: cat, gender: 'X', label: 'a', minAge: 1 }] }, DRAFT).errors.gender)
  assert.ok(validateSection('categories', { kidsGroups: [{ categoryId: cat, label: 'a', birthYearFrom: 2020, birthYearTo: 2019 }] }, DRAFT).errors.birthYearTo)
})

test('form: field modes and custom consents', () => {
  const r = validateSection('form', {
    formFields: { city: 'optional', club: 'off', ice: 'optional', nationality: 'required' },
    consents: [{ text: 'Startuję na własną odpowiedzialność.' }],
  }, DRAFT)
  assert.equal(r.ok, true, JSON.stringify(r.errors))
  assert.deepEqual(r.value.form_fields, { city: 'optional', club: 'off', ice: 'optional', nationality: 'required' })
  assert.deepEqual(r.value.consents, [{ id: null, text: 'Startuję na własną odpowiedzialność.' }])
  assert.ok(validateSection('form', { formFields: { email: 'off' } }, DRAFT).errors.email)
  assert.ok(validateSection('form', { formFields: { club: 'maybe' } }, DRAFT).errors.club)
  assert.ok(validateSection('form', { formFields: { nationality: 'maybe' } }, DRAFT).errors.nationality)
  assert.ok(validateSection('form', { consents: [{ text: ' ' }] }, DRAFT).errors.text)
})

test('form: a consent can be minors-only (minorsOnly true), a boolean or nothing', () => {
  const r = validateSection('form', {
    consents: [{ text: 'Jako opiekun zgadzam się na udział dziecka w zawodach.', minorsOnly: true }, { text: 'Dla wszystkich.', minorsOnly: false }],
  }, DRAFT)
  assert.equal(r.ok, true, JSON.stringify(r.errors))
  assert.deepEqual(r.value.consents, [
    { id: null, text: 'Jako opiekun zgadzam się na udział dziecka w zawodach.', minorsOnly: true },
    { id: null, text: 'Dla wszystkich.' },
  ])
  assert.ok(validateSection('form', { consents: [{ text: 'A.', minorsOnly: 'yes' }] }, DRAFT).errors.minorsOnly)
  assert.ok(validateSection('form', { consents: [{ text: 'A.', minorsOnly: null }] }, DRAFT).errors.minorsOnly)
})

test('W-64 form: city and club default to required, ice to optional, nationality to off (Brak)', () => {
  const r = validateSection('form', { formFields: {} }, DRAFT)
  assert.equal(r.ok, true, JSON.stringify(r.errors))
  assert.deepEqual(r.value.form_fields, { city: 'required', club: 'required', ice: 'optional', nationality: 'off' })
})

test('W-65 form: phone is not a switch any more; a stored or sent phone mode is dropped, never stored', () => {
  for (const mode of ['required', 'optional', 'off']) {
    const r = validateSection('form', { formFields: { phone: mode, city: 'off' } }, DRAFT)
    assert.equal(r.ok, true, JSON.stringify(r.errors))
    assert.equal('phone' in r.value.form_fields, false, mode)
    assert.equal(r.value.form_fields.city, 'off')
  }
})

test('hidden: accepted per competition only once published, as a boolean', () => {
  const draft = validateSection('competitions', { pricingMode: 'free', items: [item({ hidden: true })] }, DRAFT)
  assert.equal(draft.ok, false)
  assert.ok(draft.errors.hidden)

  const pub = validateSection('competitions', {
    pricingMode: 'free',
    items: [item({ categoryId: '11111111-1111-4111-8111-111111111111', hidden: true }), item({ name: 'Bieg 3 km' })],
  }, PUBLISHED)
  assert.equal(pub.ok, true, JSON.stringify(pub.errors))
  assert.equal(pub.value.items[0].hidden, true)
  assert.equal('hidden' in pub.value.items[1], false, 'not sent → not staged')

  const bad = validateSection('competitions', { pricingMode: 'free', items: [item({ hidden: 'yes' })] }, PUBLISHED)
  assert.equal(bad.ok, false)
  assert.ok(bad.errors.hidden)
})

test('basics.contactEmail: stored lower-cased as contact_email, a bad address refused, null clears it', () => {
  const ok = validateSection('basics', { contactEmail: ' Zapisy@Klub.Example ' }, PUBLISHED)
  assert.equal(ok.ok, true, JSON.stringify(ok.errors))
  assert.equal(ok.value.contact_email, 'zapisy@klub.example')
  assert.equal(validateSection('basics', { contactEmail: 'nie-adres' }, DRAFT).errors.contactEmail, 'Podaj poprawny adres e-mail.')
  assert.equal(validateSection('basics', { contactEmail: null }, DRAFT).value.contact_email, null)
})

test('W-63 form: a consents list naming one consent twice is refused', () => {
  const id = '44444444-4444-4444-8444-444444444444'
  const r = validateSection('form', { consents: [{ id, text: 'Stara.' }, { id, text: 'Nowa.' }] }, PUBLISHED)
  assert.equal(r.ok, false)
  assert.ok(r.errors.consents)
  assert.equal(validateSection('form', { consents: [{ text: 'A.' }, { text: 'A.' }] }, DRAFT).ok, true, 'new consents carry no id')
})

// P-40: the payment window is the payments section (D3-4). The payout is not:
// it goes through update-event-payout, owner only.
test('P-40 payments: the window is 24 h, 7 days or 14 days, in a draft and after publish', () => {
  for (const hours of [24, 168, 336]) {
    for (const ctx of [DRAFT, PUBLISHED]) {
      assert.deepEqual(validateSection('payments', { paymentWindowHours: hours }, ctx), { ok: true, value: { payment_window_hours: hours } })
    }
  }
  assert.deepEqual(validateSection('payments', {}, DRAFT), { ok: true, value: {} })
})

test('P-40 payments: any other window is refused, 337 included', () => {
  for (const hours of [337, 0, 1, 48, 167, -24, 24.5, '168', null, true]) {
    const r = validateSection('payments', { paymentWindowHours: hours }, DRAFT)
    assert.equal(r.ok, false, String(hours))
    assert.equal(r.errors.paymentWindowHours, 'Wybierz czas na opłacenie zgłoszenia.')
  }
})

test('P-59 payments: „do końca zapisów” is paymentWindowUntilClose, a boolean, alone or beside the hours', () => {
  for (const ctx of [DRAFT, PUBLISHED]) {
    assert.deepEqual(validateSection('payments', { paymentWindowUntilClose: true }, ctx),
      { ok: true, value: { payment_window_until_close: true } })
    assert.deepEqual(validateSection('payments', { paymentWindowHours: 24, paymentWindowUntilClose: false }, ctx),
      { ok: true, value: { payment_window_hours: 24, payment_window_until_close: false } })
  }
  for (const v of ['true', 1, null, 'close']) {
    const r = validateSection('payments', { paymentWindowUntilClose: v }, DRAFT)
    assert.equal(r.ok, false, String(v))
    assert.equal(r.errors.paymentWindowUntilClose, 'Wybierz czas na opłacenie zgłoszenia.')
  }
  const snake = validateSection('payments', { payment_window_until_close: true }, DRAFT)
  assert.equal(snake.errors.payment_window_until_close, 'Nieznane pole.')
})

test('P-40 payments: taken and every payout key are refused; the payout is not a section', () => {
  for (const key of ['taken', 'payoutMode', 'payoutRecipient', 'payoutTaxId', 'payoutIban', 'payoutTitle',
    'payout_mode', 'payout_iban', 'iban', 'payment_window_hours']) {
    const r = validateSection('payments', { paymentWindowHours: 168, [key]: 'PL61109010140000071219812874' }, DRAFT)
    assert.equal(r.ok, false, key)
    assert.equal(r.errors[key], 'Nieznane pole.', key)
  }
})

// ---------------------------------------------------------------- Plan 7 task 3 (V-15)

// The A3 mockup: „DO 15.11” 60 zł, „DO 25.11” 70 zł, „DO KOŃCA ZAPISÓW” 80 zł. Registration open
// 1.11–5.12 (Warsaw days), race 6.12. The context carries the stored window as timestamps, the way
// save-registration-section reads registration_settings; the validator turns them into Warsaw days.
const WINDOW = { opensAt: '2026-10-31T23:00:00.000Z', closesAt: '2026-12-05T23:00:00.000Z' }
const TIERED_DRAFT = { ...DRAFT, eventDate: '2026-12-06', ...WINDOW }
const TIER_IDS = ['aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002']
const A3_TIERS = [{ endsOn: '2026-11-15' }, { endsOn: '2026-11-25' }, { endsOn: null }]
const A3_PRICES = { 'new:0': '60', 'new:1': '70', 'new:2': '80' }
const tiered = (over = {}) => ({ pricingMode: 'tiered', tiers: A3_TIERS, items: [item({ prices: A3_PRICES })], ...over })
const TIERS_ORDER = 'Daty progów muszą rosnąć i kończyć się przed zamknięciem zapisów.'

test('V-15 tiered: the A3 fixture (15.11 / 25.11 / end; 60/70/80) passes, snake_case tiers and prices in grosze', () => {
  const r = validateSection('competitions', tiered(), TIERED_DRAFT)
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.value.pricing_mode, 'tiered')
  assert.deepEqual(r.value.tiers, [
    { id: null, ends_on: '2026-11-15' }, { id: null, ends_on: '2026-11-25' }, { id: null, ends_on: null },
  ])
  assert.deepEqual(r.value.items[0].prices, { 'new:0': 6000, 'new:1': 7000, 'new:2': 8000 })
  assert.equal(r.value.items[0].price, null)
})

test('V-15 tiered: a tier key is the tier id, or new:<index> for a new tier; published edits validate too', () => {
  const tiers = [{ id: TIER_IDS[0], endsOn: '2026-11-15' }, { endsOn: '2026-11-20' }, { id: TIER_IDS[1], endsOn: null }]
  const prices = { [TIER_IDS[0]]: '60', 'new:1': '65', [TIER_IDS[1]]: '80,50' }
  for (const ctx of [TIERED_DRAFT, { ...PUBLISHED, ...WINDOW }]) {
    const r = validateSection('competitions', tiered({ tiers, items: [item({ prices })] }), ctx)
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.deepEqual(r.value.tiers, [
      { id: TIER_IDS[0], ends_on: '2026-11-15' }, { id: null, ends_on: '2026-11-20' }, { id: TIER_IDS[1], ends_on: null },
    ])
    assert.deepEqual(r.value.items[0].prices, { [TIER_IDS[0]]: 6000, 'new:1': 6500, [TIER_IDS[1]]: 8050 })
  }
})

test('V-15 tiered: equal dates fail with the tiers message', () => {
  const r = validateSection('competitions', tiered({ tiers: [{ endsOn: '2026-11-15' }, { endsOn: '2026-11-15' }, { endsOn: null }] }), TIERED_DRAFT)
  assert.equal(r.ok, false)
  assert.equal(r.errors.tiers, TIERS_ORDER)
})

test('V-15 tiered: the window is compared as Warsaw days: a tier may end on the opening day, never on the last day', () => {
  const at = (endsOn) => validateSection('competitions', tiered({
    tiers: [{ endsOn }, { endsOn: null }], items: [item({ prices: { 'new:0': '60', 'new:1': '70' } })],
  }), TIERED_DRAFT)
  assert.equal(at('2026-11-01').ok, true, 'the first Warsaw day of the window (opens_at is 31.10 23:00 UTC)')
  assert.equal(at('2026-10-31').errors.tiers, TIERS_ORDER)
  assert.equal(at('2026-12-04').ok, true)
  assert.equal(at('2026-12-05').errors.tiers, TIERS_ORDER, 'the last day of registration (closes_at is 5.12 23:00 UTC)')
})

test('V-15 tiered: 6 tiers, two open tiers, an open tier that is not last are refused', () => {
  const six = Array.from({ length: 5 }, (_, i) => ({ endsOn: `2026-11-1${i}` })).concat([{ endsOn: null }])
  const keysOf = (tiers) => Object.fromEntries(tiers.map((_, i) => [`new:${i}`, '60']))
  for (const tiers of [six, [{ endsOn: null }, { endsOn: null }], [{ endsOn: null }, { endsOn: '2026-11-15' }]]) {
    const r = validateSection('competitions', tiered({ tiers, items: [item({ prices: keysOf(tiers) })] }), TIERED_DRAFT)
    assert.equal(r.ok, false, JSON.stringify(tiers))
    assert.ok(r.errors.tiers)
  }
})

test('V-15 tiered: every competition needs a valid price for exactly the listed tiers', () => {
  const PRICE = 'Podaj cenę w złotych, np. 60 albo 60,50.'
  for (const prices of [
    { 'new:0': '60', 'new:1': '70' },
    { 'new:0': '60', 'new:1': '70', 'new:2': '80', 'new:3': '90' },
    { 'new:0': '60', 'new:1': 'siedemdziesiąt', 'new:2': '80' },
    { 'new:0': '60', 'new:1': '-70', 'new:2': '80' },
    { 'new:0': '60', 'new:1': '100000,01', 'new:2': '80' },
    { [TIER_IDS[0]]: '60', 'new:1': '70', 'new:2': '80' },
    null, '60',
  ]) {
    const r = validateSection('competitions', tiered({ items: [item({ prices })] }), TIERED_DRAFT)
    assert.equal(r.ok, false, JSON.stringify(prices))
    assert.equal(r.errors.prices, PRICE, JSON.stringify(prices))
  }
})

test('V-15 tiered: a tier id must be a uuid and appear once; a tier carries only id and endsOn', () => {
  const bad = (tiers) => validateSection('competitions', tiered({ tiers, items: [item({ prices: Object.fromEntries(tiers.map((t, i) => [t.id ?? `new:${i}`, '60'])) })] }), TIERED_DRAFT)
  assert.ok(bad([{ id: 'nope', endsOn: '2026-11-15' }, { endsOn: null }]).errors.id)
  assert.ok(bad([{ id: TIER_IDS[0], endsOn: '2026-11-15' }, { id: TIER_IDS[0], endsOn: null }]).errors.tiers)
  assert.equal(bad([{ endsOn: '2026-11-15', sortOrder: 1 }, { endsOn: null }]).errors.sortOrder, 'Nieznane pole.')
})

test('V-15 fixed keeps items[].price and stores no tiers; free drops every price; tiers sent with them are ignored', () => {
  const fixed = validateSection('competitions', { pricingMode: 'fixed', tiers: A3_TIERS, items: [item({ price: '60', prices: A3_PRICES })] }, TIERED_DRAFT)
  assert.equal(fixed.ok, true, JSON.stringify(fixed))
  assert.equal(fixed.value.items[0].price, 6000)
  assert.equal(fixed.value.items[0].prices, undefined)
  assert.equal(fixed.value.tiers, undefined)
  const free = validateSection('competitions', { pricingMode: 'free', tiers: A3_TIERS, items: [item({ price: '60', prices: A3_PRICES })] }, TIERED_DRAFT)
  assert.equal(free.ok, true, JSON.stringify(free))
  assert.equal(free.value.items[0].price, null)
  assert.equal(free.value.items[0].prices, undefined)
  assert.equal(free.value.tiers, undefined)
})

// ---------------------------------------------------------------- payments: transfer (V-15)

test('V-15 payments: transferEnabled with transferUntil the day before the race passes; on race day it fails', () => {
  const ctx = { ...DRAFT, eventDate: '2026-12-06' }
  assert.deepEqual(validateSection('payments', { transferEnabled: true, transferUntil: '2026-12-05' }, ctx),
    { ok: true, value: { transfer_enabled: true, transfer_until: '2026-12-05' } })
  const raceDay = validateSection('payments', { transferEnabled: true, transferUntil: '2026-12-06' }, ctx)
  assert.equal(raceDay.ok, false)
  assert.equal(raceDay.errors.transferUntil, 'Przekazanie możliwe najpóźniej dzień przed zawodami.')
  assert.equal(validateSection('payments', { transferUntil: '2026-12-07' }, { ...PUBLISHED }).errors.transferUntil,
    'Przekazanie możliwe najpóźniej dzień przed zawodami.')
})

test('V-15 payments: transferUntil is required when transfers are enabled; switched off it may be null', () => {
  const ctx = { ...DRAFT, eventDate: '2026-12-06' }
  for (const v of [{ transferEnabled: true }, { transferEnabled: true, transferUntil: null }, { transferEnabled: true, transferUntil: '5.12.2026' }]) {
    const r = validateSection('payments', v, ctx)
    assert.equal(r.ok, false, JSON.stringify(v))
    assert.ok(r.errors.transferUntil, JSON.stringify(v))
  }
  assert.deepEqual(validateSection('payments', { transferEnabled: false, transferUntil: null }, ctx),
    { ok: true, value: { transfer_enabled: false, transfer_until: null } })
  assert.equal(validateSection('payments', { transferEnabled: 'tak' }, ctx).ok, false)
  assert.equal(validateSection('payments', { transferFee: 500 }, ctx).errors.transferFee, 'Nieznane pole.')
})

// ---------------------------------------------------------------- extras (V-15)

const EXTRA = (over = {}) => ({
  name: 'Koszulka techniczna', price: '45', orderUntil: '2026-11-25', categoryIds: [],
  variants: [{ label: 'M', stock: 30 }, { label: 'L', stock: 100000 }], ...over,
})
const EXTRA_CTX = { ...DRAFT, eventDate: '2026-12-06' }
const CAT = '11111111-1111-4111-8111-111111111111'

test('V-15 extras: one extra with two variants passes as snake_case, prices in grosze, „Bez limitu” as 100 000', () => {
  const r = validateSection('extras', { items: [EXTRA({ categoryIds: [CAT, CAT.toUpperCase()] })] }, EXTRA_CTX)
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.deepEqual(r.value, { items: [{
    id: null, name: 'Koszulka techniczna', image_upload_id: null, price: 4500, order_until: '2026-11-25',
    category_ids: [CAT], variants: [{ id: null, label: 'M', stock: 30 }, { id: null, label: 'L', stock: 100000 }],
  }] })
})

test('V-15 extras: orderUntil may be the race day, not later', () => {
  assert.equal(validateSection('extras', { items: [EXTRA({ orderUntil: '2026-12-06' })] }, EXTRA_CTX).ok, true)
  const late = validateSection('extras', { items: [EXTRA({ orderUntil: '2026-12-07' })] }, EXTRA_CTX)
  assert.equal(late.ok, false)
  assert.ok(late.errors.orderUntil)
})

test('V-15 extras: at most 20 extras of 1–20 variants, stock 0–100 000, a name and a label', () => {
  const variants = (n) => Array.from({ length: n }, (_, i) => ({ label: `R${i}`, stock: 1 }))
  assert.equal(validateSection('extras', { items: Array.from({ length: 20 }, () => EXTRA()) }, EXTRA_CTX).ok, true)
  assert.ok(validateSection('extras', { items: Array.from({ length: 21 }, () => EXTRA()) }, EXTRA_CTX).errors.items)
  assert.equal(validateSection('extras', { items: [EXTRA({ variants: variants(20) })] }, EXTRA_CTX).ok, true)
  for (const n of [0, 21]) assert.ok(validateSection('extras', { items: [EXTRA({ variants: variants(n) })] }, EXTRA_CTX).errors.variants, String(n))
  for (const stock of [-1, 100001, 1.5, '30', null]) {
    assert.ok(validateSection('extras', { items: [EXTRA({ variants: [{ label: 'M', stock }] })] }, EXTRA_CTX).errors.stock, String(stock))
  }
  assert.equal(validateSection('extras', { items: [EXTRA({ variants: [{ label: 'M', stock: 0 }] })] }, EXTRA_CTX).ok, true)
  assert.ok(validateSection('extras', { items: [EXTRA({ name: '  ' })] }, EXTRA_CTX).errors.name)
  assert.ok(validateSection('extras', { items: [EXTRA({ variants: [{ label: '', stock: 1 }] })] }, EXTRA_CTX).errors.label)
  assert.ok(validateSection('extras', { items: [EXTRA({ price: '-5' })] }, EXTRA_CTX).errors.price)
  assert.ok(validateSection('extras', { items: [EXTRA({ categoryIds: ['nope'] })] }, EXTRA_CTX).errors.categoryIds)
  assert.equal(validateSection('extras', { items: [EXTRA({ sold: 3 })] }, EXTRA_CTX).errors.sold, 'Nieznane pole.')
  assert.equal(validateSection('extras', { items: [EXTRA({ variants: [{ label: 'M', stock: 3, sold: 1 }] })] }, EXTRA_CTX).errors.sold, 'Nieznane pole.')
})

test('V-15 extras: an empty list means no extras', () => {
  assert.deepEqual(validateSection('extras', { items: [] }, EXTRA_CTX), { ok: true, value: { items: [] } })
})

// ---------------------------------------------------------------- fix round 1: I-1

test('I-1 payments: {transferUntil: null} alone while transfers are on (stored or staged) is refused', () => {
  const on = { ...DRAFT, eventDate: '2026-12-06', transferEnabled: true, transferUntil: '2026-12-05' }
  const r = validateSection('payments', { transferUntil: null }, on)
  assert.equal(r.ok, false)
  assert.equal(r.errors.transferUntil, 'Podaj, do kiedy można przekazać pakiet.')
  assert.deepEqual(validateSection('payments', { transferUntil: null }, { ...on, transferEnabled: false }),
    { ok: true, value: { transfer_until: null } })
})

test('I-1 payments: {transferEnabled: true} alone uses the stored date, which must still be the day before the race', () => {
  const ctx = { ...DRAFT, eventDate: '2026-12-06', transferEnabled: false }
  assert.deepEqual(validateSection('payments', { transferEnabled: true }, { ...ctx, transferUntil: '2026-12-05' }),
    { ok: true, value: { transfer_enabled: true } })
  assert.equal(validateSection('payments', { transferEnabled: true }, { ...ctx, transferUntil: '2026-12-06' }).errors.transferUntil,
    'Przekazanie możliwe najpóźniej dzień przed zawodami.')
  assert.equal(validateSection('payments', { transferEnabled: true }, { ...ctx, transferUntil: null }).errors.transferUntil,
    'Podaj, do kiedy można przekazać pakiet.')
})

test('M-1 competitions: a fixed or free save carries no tiers key at all', () => {
  for (const pricingMode of ['fixed', 'free']) {
    const r = validateSection('competitions', { pricingMode, items: [item({ price: '60' })] }, DRAFT)
    assert.equal(r.ok, true)
    assert.equal('tiers' in r.value, false)
  }
})

test('W-72 basics: the description is plain text up to 5000 characters, line breaks kept', () => {
  const text = '  Nocny bieg.\n\nTrasa leśna, <b>bez</b> asfaltu.\nZabierz czołówkę.  '
  const r = validateSection('basics', { description: text }, DRAFT)
  assert.equal(r.ok, true, JSON.stringify(r.errors))
  assert.equal(r.value.description, 'Nocny bieg.\n\nTrasa leśna, <b>bez</b> asfaltu.\nZabierz czołówkę.')
  assert.equal(validateSection('basics', { description: 'a'.repeat(5000) }, DRAFT).ok, true)
  const long = validateSection('basics', { description: 'a'.repeat(5001) }, DRAFT)
  assert.equal(long.ok, false)
  assert.equal(long.errors.description, 'Najwyżej 5000 znaków.')
  assert.deepEqual(validateSection('basics', { description: '   ' }, DRAFT).value, { description: null })
  assert.deepEqual(validateSection('basics', { description: null }, DRAFT).value, { description: null })
  assert.equal(validateSection('basics', { description: 5 }, DRAFT).ok, false)
})

test('W-73 basics: the cause page is an optional http(s) address', () => {
  for (const url of ['https://example.org/zbiorka', 'http://zbiorka.example.pl/zosia?x=1']) {
    const r = validateSection('basics', { charityUrl: url }, DRAFT)
    assert.equal(r.ok, true, url)
    assert.equal(r.value.charity_url, url)
  }
  assert.deepEqual(validateSection('basics', { charityUrl: '' }, DRAFT).value, { charity_url: null })
  assert.deepEqual(validateSection('basics', { charityUrl: null }, DRAFT).value, { charity_url: null })
  assert.equal(validateSection('basics', { charityUrl: ' https://example.org/a ' }, DRAFT).value.charity_url, 'https://example.org/a')
  for (const bad of ['javascript:alert(1)', 'ftp://example.org/x', 'example.org', 'https://', 'https://exa mple.org', `https://e.org/${'a'.repeat(500)}`, 7]) {
    const r = validateSection('basics', { charityUrl: bad }, DRAFT)
    assert.equal(r.ok, false, String(bad))
    assert.equal(r.errors.charityUrl, 'Podaj adres zaczynający się od http:// albo https://.')
  }
})

test('W-77 basics: the event page („Więcej informacji”) is an optional http(s) address', () => {
  const r = validateSection('basics', { websiteUrl: 'https://wilczypolmaraton.pl/' }, DRAFT)
  assert.equal(r.ok, true)
  assert.equal(r.value.website_url, 'https://wilczypolmaraton.pl/')
  assert.deepEqual(validateSection('basics', { websiteUrl: '' }, DRAFT).value, { website_url: null })
  assert.equal(validateSection('basics', { websiteUrl: ' https://example.org/a ' }, DRAFT).value.website_url, 'https://example.org/a')
  for (const bad of ['javascript:alert(1)', 'example.org', `https://e.org/${'a'.repeat(500)}`]) {
    const res = validateSection('basics', { websiteUrl: bad }, DRAFT)
    assert.equal(res.ok, false, String(bad))
    assert.equal(res.errors.websiteUrl, 'Podaj adres zaczynający się od http:// albo https://.')
  }
})

test('W-78 basics: the share of the income for the cause is an optional whole percent 1..100', () => {
  assert.equal(validateSection('basics', { charityPercent: 100 }, DRAFT).value.charity_percent, 100)
  assert.equal(validateSection('basics', { charityPercent: 1 }, DRAFT).value.charity_percent, 1)
  assert.deepEqual(validateSection('basics', { charityPercent: null }, DRAFT).value, { charity_percent: null })
  for (const bad of [0, 101, 50.5, '50', -1]) {
    const res = validateSection('basics', { charityPercent: bad }, DRAFT)
    assert.equal(res.ok, false, String(bad))
    assert.equal(res.errors.charityPercent, 'Podaj liczbę od 1 do 100.')
  }
})
