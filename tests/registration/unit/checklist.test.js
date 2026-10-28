// W-13: the publish checklist (_shared/registration/checklist.js).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { publishChecklist, blockingMessage, SLUG_TAKEN_ITEM } from '../../../supabase/functions/_shared/registration/checklist.js'
import { registrationWindow } from '../../../supabase/functions/_shared/registration/dates.js'

const window = (opensOn, closesOn) => {
  const { opensAt, closesAt } = registrationWindow({ opensOn, closesOn })
  return { opensAt: opensAt.toISOString(), closesAt: closesAt.toISOString() }
}

const comp = (over = {}) => ({
  categoryId: 'c1', name: 'Bieg 9 km', distanceLabel: '9 km', startTime: '10:00:00', capacity: 50,
  gpxUploadId: 'g1', isKids: false, hiddenAt: null, ...over,
})

// Everything filled, including the optional items.
function complete(over = {}) {
  return {
    settings: {
      name: 'Bieg Leszego', slug: 'bieg-leszego', eventDate: '2026-12-06',
      ...window('2026-11-01', '2026-12-06'),
      townLabel: 'Nieborowice', lat: 50.2381, lng: 18.5412,
      regulaminKind: 'link', regulaminUrl: 'https://example.org/regulamin', regulaminUploadId: null,
      posterUploadId: 'p1', pricingMode: 'free', contactEmail: 'zapisy@klub.example',
      ...over.settings,
    },
    competitions: over.competitions ?? [comp(), comp({ categoryId: 'c2', name: 'Bieg dzieci', distanceLabel: '400 m', isKids: true })],
    officeHours: over.officeHours ?? [{ date: '2026-12-06', from: '08:00', to: '09:30' }],
    hasAgreement: over.hasAgreement ?? true,
  }
}

const keys = (items) => items.map((i) => i.key)

test('W-13 a complete event has nothing blocking and nothing missing', () => {
  assert.deepEqual(publishChecklist(complete()), { blocking: [], missing: [] })
})

test('W-13 an empty draft lists every required item', () => {
  const r = publishChecklist({ settings: { pricingMode: 'free' }, competitions: [], officeHours: [], hasAgreement: false })
  assert.deepEqual(keys(r.blocking), ['name', 'slug', 'event_date', 'registration_dates', 'place', 'competitions', 'regulamin', 'contact_email', 'agreement'])
  assert.deepEqual(keys(r.missing), ['office_hours', 'poster', 'kids'])
})

test('W-13 registration closing on race day is fine; closing the day after the race blocks', () => {
  assert.deepEqual(publishChecklist(complete({ settings: window('2026-11-01', '2026-12-06') })).blocking, [])
  const late = publishChecklist(complete({ settings: window('2026-11-01', '2026-12-07') }))
  assert.deepEqual(late.blocking, [{ key: 'registration_dates', label: 'Zapisy online muszą się skończyć najpóźniej w dniu zawodów' }])
})

test('W-13 the race-day bound is a Warsaw day across the DST switch (race 25.10, closes 25.10 vs 26.10)', () => {
  const base = { eventDate: '2026-10-25' }
  assert.deepEqual(publishChecklist(complete({ settings: { ...base, ...window('2026-10-01', '2026-10-25') } })).blocking, [])
  assert.deepEqual(keys(publishChecklist(complete({ settings: { ...base, ...window('2026-10-01', '2026-10-26') } })).blocking),
    ['registration_dates'])
})

test('W-13 a missing date of the window blocks', () => {
  assert.deepEqual(keys(publishChecklist(complete({ settings: { closesAt: null } })).blocking), ['registration_dates'])
})

test('W-13 the place needs the town and the pin', () => {
  assert.deepEqual(keys(publishChecklist(complete({ settings: { lat: null } })).blocking), ['place'])
  assert.deepEqual(keys(publishChecklist(complete({ settings: { townLabel: '  ' } })).blocking), ['place'])
})

test('W-13 a competition without distance, start time or limit blocks, naming what it lacks', () => {
  const r = publishChecklist(complete({ competitions: [comp({ distanceLabel: null, startTime: null, capacity: null })] }))
  assert.deepEqual(r.blocking, [{ key: 'competition:c1', label: 'Konkurencja „Bieg 9 km”: dystans, godzina startu, limit miejsc' }])
})

test('W-13 a hidden competition does not count, so only hidden ones means none', () => {
  const r = publishChecklist(complete({ competitions: [comp({ hiddenAt: '2026-11-02T10:00:00Z', distanceLabel: null })] }))
  assert.deepEqual(keys(r.blocking), ['competitions'])
})

test('W-13 the organizer contact address is required (ruling P2-R19)', () => {
  const r = publishChecklist(complete({ settings: { contactEmail: '  ' } }))
  assert.deepEqual(r.blocking, [{ key: 'contact_email', label: 'Adres kontaktowy organizatora' }])
})

test('W-13 the regulamin is a PDF upload or a link, matching its kind', () => {
  assert.deepEqual(keys(publishChecklist(complete({ settings: { regulaminKind: 'pdf', regulaminUrl: null, regulaminUploadId: 'u1' } })).blocking), [])
  assert.deepEqual(keys(publishChecklist(complete({ settings: { regulaminKind: 'pdf', regulaminUploadId: null } })).blocking), ['regulamin'])
  assert.deepEqual(keys(publishChecklist(complete({ settings: { regulaminKind: 'link', regulaminUrl: '' } })).blocking), ['regulamin'])
  assert.deepEqual(keys(publishChecklist(complete({ settings: { regulaminKind: null } })).blocking), ['regulamin'])
})

test('W-13 no current agreement blocks', () => {
  assert.deepEqual(keys(publishChecklist(complete({ hasAgreement: false })).blocking), ['agreement'])
})

test('W-13 a paid event blocks with „Płatności online — wkrótce” while payments are off', () => {
  const r = publishChecklist(complete({ settings: { pricingMode: 'fixed' } }))
  assert.deepEqual(r.blocking, [{ key: 'payments', label: 'Płatności online — wkrótce' }])
})

test('W-13 optional items name their wizard step and never block', () => {
  const r = publishChecklist(complete({
    settings: { posterUploadId: null }, officeHours: [], competitions: [comp({ gpxUploadId: null })],
  }))
  assert.deepEqual(r.blocking, [])
  assert.deepEqual(r.missing, [
    { key: 'office_hours', label: 'Godziny otwarcia biura zawodów', step: 'biuro' },
    { key: 'gpx:c1', label: 'Ślad GPX: Bieg 9 km', step: 'konkurencje' },
    { key: 'poster', label: 'Plakat', step: 'podstawy' },
    { key: 'kids', label: 'Dystanse dzieci', step: 'konkurencje' },
  ])
})

test('W-13 the refusal message lists the labels', () => {
  assert.equal(blockingMessage([{ key: 'a', label: 'Data zawodów' }, SLUG_TAKEN_ITEM]),
    'Uzupełnij: Data zawodów, Adres zawodów jest zajęty')
})
