import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SECTIONS, validateSection, parsePriceGrosze } from '../../../supabase/functions/_shared/registration/sections.js'

const DRAFT = { state: 'draft', eventDate: null }
const PUBLISHED = { state: 'published', eventDate: '2026-12-06' }

const item = (over = {}) => ({
  name: 'Bieg 9 km', kind: 'individual', discipline: 'run', distanceLabel: '9 km', startTime: '10:00',
  capacity: 80, minAge: 16, maxAge: null, isKids: false, timed: true, ...over,
})

test('SECTIONS lists the seven wizard sections', () => {
  assert.deepEqual(SECTIONS, ['basics', 'office', 'competitions', 'categories', 'timing', 'form', 'payments'])
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

test('competitions: tiered pricing and team kind are refused with Wkrótce.', () => {
  const t = validateSection('competitions', { pricingMode: 'tiered', items: [item()] }, DRAFT)
  assert.deepEqual(t.errors, { pricingMode: 'Wkrótce.' })
  const k = validateSection('competitions', { pricingMode: 'free', items: [item({ kind: 'team' })] }, DRAFT)
  assert.deepEqual(k.errors, { kind: 'Wkrótce.' })
})

test('competitions: a valid free list normalizes to the RPC shape', () => {
  const r = validateSection('competitions', { pricingMode: 'free', items: [item({ price: '60' })] }, DRAFT)
  assert.equal(r.ok, true)
  assert.equal(r.value.pricing_mode, 'free')
  assert.deepEqual(r.value.items[0], {
    category_id: null, name: 'Bieg 9 km', kind: 'individual', discipline: 'run', distance_label: '9 km',
    start_time: '10:00', capacity: 80, min_age: 16, max_age: null, is_kids: false, timed: true,
    gpx_upload_id: null, price: null,
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

test('W-64 form: nationality defaults to off (Brak); the other switches to optional', () => {
  const r = validateSection('form', { formFields: {} }, DRAFT)
  assert.equal(r.ok, true, JSON.stringify(r.errors))
  assert.deepEqual(r.value.form_fields, { city: 'optional', club: 'optional', ice: 'optional', nationality: 'off' })
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
