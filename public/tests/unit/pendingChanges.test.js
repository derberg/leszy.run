import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  changeValue, changesSummary, noticeTarget, defaultNotice, peopleLabel, noticeResult, registeredLine, closesLabel,
  missingAfterPublish, noticeCheck,
} from '../../src/lib/pendingChanges.js'

const C1 = '11111111-1111-4111-8111-111111111111'
const C2 = '22222222-2222-4222-8222-222222222222'
const competitions = [{ categoryId: C1, name: 'Bieg 9 km' }, { categoryId: C2, name: 'Nordic walking 3 km' }]

test('changeValue: scalars, empty, booleans and grosze', () => {
  assert.equal(changeValue({ field: 'competitions.start_time' }, '10:15'), '10:15')
  assert.equal(changeValue({ field: 'competitions.capacity' }, 30), '30')
  assert.equal(changeValue({ field: 'basics.place_details' }, null), '—')
  assert.equal(changeValue({ field: 'basics.is_charity' }, true), 'tak')
  assert.equal(changeValue({ field: 'basics.is_charity' }, false), 'nie')
  assert.equal(changeValue({ field: 'competitions.price' }, 6000), '60 zł')
  assert.equal(changeValue({ field: 'competitions.price' }, 2550), '25,5 zł')
})

test('changeValue: dates in Warsaw, the registration end as its last day', () => {
  assert.equal(changeValue({ field: 'basics.event_date' }, '2026-12-06'), '6.12.2026')
  assert.equal(changeValue({ field: 'basics.opens_at' }, '2026-10-31T23:00:00.000Z'), '1.11.2026')
  // closes_at is the start of the day after the last day of registration.
  assert.equal(changeValue({ field: 'basics.closes_at' }, '2026-12-03T23:00:00.000Z'), '3.12.2026')
})

test('changeValue: files, choices and lists', () => {
  assert.equal(changeValue({ field: 'basics.poster_upload_id' }, C1), 'plik')
  assert.equal(changeValue({ field: 'competitions.discipline' }, 'nw'), 'nordic walking')
  assert.equal(changeValue({ field: 'competitions.pricing_mode' }, 'free'), 'bezpłatne')
  assert.equal(changeValue({ field: 'office.hours' }, [{ date: '2026-12-05', from: '17:00', to: '19:00' }, { date: '2026-12-06', from: '08:00', to: '09:30' }]),
    '5.12 17:00–19:00, 6.12 08:00–09:30')
  assert.equal(changeValue({ field: 'categories.age_groups' }, [{ label: 'M20' }, { label: 'K20' }]), 'M20, K20')
  assert.equal(changeValue({ field: 'form.consents' }, ['Zgoda A']), 'Zgoda A')
  assert.equal(changeValue({ field: 'office.hours' }, []), '—')
  assert.equal(changeValue({ field: 'form.form_fields' }, { phone: 'required', club: 'off' }), 'telefon: wymagane, klub: brak')
})

test('changesSummary: the labels, in order', () => {
  assert.equal(changesSummary([{ label: 'Bieg 9 km: godzina startu' }, { label: 'Nordic walking 3 km: limit miejsc' }]),
    'Bieg 9 km: godzina startu, Nordic walking 3 km: limit miejsc')
  assert.equal(changesSummary([]), '')
})

test('noticeTarget: everyone → the event; one competition → its name', () => {
  assert.equal(noticeTarget({ all: true, categoryIds: [] }, competitions, 'Bieg Leszego'), 'Bieg Leszego')
  assert.equal(noticeTarget({ all: false, categoryIds: [C1] }, competitions, 'Bieg Leszego'), 'Bieg 9 km')
  assert.equal(noticeTarget({ all: false, categoryIds: [C1, C2] }, competitions, 'Bieg Leszego'), 'Bieg 9 km, Nordic walking 3 km')
})

test('peopleLabel: Polish counts', () => {
  assert.equal(peopleLabel(1), '1 osoba')
  assert.equal(peopleLabel(3), '3 osoby')
  assert.equal(peopleLabel(34), '34 osoby')
  assert.equal(peopleLabel(5), '5 osób')
  assert.equal(peopleLabel(12), '12 osób')
})

test('defaultNotice: subject from the event, body lists only what concerns the runners', () => {
  const diff = [
    { field: 'competitions.start_time', label: 'Bieg 9 km: godzina startu', before: '10:00', after: '10:15' },
    { field: 'competitions.capacity', label: 'Nordic walking 3 km: limit miejsc', before: 20, after: 30 },
    { field: 'basics.lat', label: 'Pinezka (szerokość)', before: 50.1, after: 50.2 },
  ]
  const n = defaultNotice('Bieg Leszego', diff)
  assert.equal(n.subject, 'Bieg Leszego: zmiany')
  assert.equal(n.body, 'Cześć,\n\nzmieniamy:\n- Bieg 9 km: godzina startu: 10:00 → 10:15\n\nPozostałe informacje bez zmian.')
})

test('noticeResult: how many were told and whether a send failed', () => {
  assert.equal(noticeResult({ sent: false, recipientCount: 0 }), 'Opublikowano zmiany.')
  assert.equal(noticeResult({ sent: true, recipientCount: 34, failed: 0 }), 'Opublikowano zmiany. Powiadomiono 34 osoby.')
  assert.equal(noticeResult({ sent: true, recipientCount: 30, failed: 4 }),
    'Opublikowano zmiany. Powiadomiono 30 osób. Nie udało się wysłać do 4 osób.')
  assert.equal(noticeResult({ sent: false, recipientCount: 0 }, true), 'Opublikowano zmiany. Powiadomienia nie wysłano.')
})

test('registeredLine and closesLabel for the published header', () => {
  const comps = [{ capacity: 50, hiddenAt: null }, { capacity: 30, hiddenAt: '2026-10-01T00:00:00Z' }, { capacity: 20, hiddenAt: null }]
  assert.equal(registeredLine(1, comps), '1 / 70 zapisanych')
  assert.equal(closesLabel('2026-12-03'), '3.12')
  assert.equal(closesLabel('2026-01-05'), '5.01')
  assert.equal(closesLabel(null), null)
})

test('M1 (P2-R29): after publish no „Dystanse dzieci”, and the GPX items fold into one „Ślad GPX”', () => {
  const missing = [
    { key: 'office_hours', label: 'Godziny otwarcia biura zawodów', step: 'biuro' },
    { key: `gpx:${C1}`, label: 'Ślad GPX: Bieg 9 km', step: 'konkurencje' },
    { key: `gpx:${C2}`, label: 'Ślad GPX: Nordic walking 3 km', step: 'konkurencje' },
    { key: 'poster', label: 'Plakat', step: 'podstawy' },
    { key: 'kids', label: 'Dystanse dzieci', step: 'konkurencje' },
  ]
  assert.deepEqual(missingAfterPublish(missing), [
    { key: 'office_hours', label: 'Godziny otwarcia biura zawodów', step: 'biuro' },
    { key: 'gpx', label: 'Ślad GPX', step: 'konkurencje' },
    { key: 'poster', label: 'Plakat', step: 'podstawy' },
  ])
  assert.deepEqual(missingAfterPublish([{ key: 'kids', label: 'Dystanse dzieci', step: 'konkurencje' }]), [])
})

test('M4: a pin-only move still gets a line in the suggested body', () => {
  const n = defaultNotice('Bieg Leszego', [{ field: 'basics.lat', label: 'Pinezka (szerokość)', before: 50.1, after: 50.2 }])
  assert.equal(n.body, 'Cześć,\n\nzmieniamy:\n- Miejsce startu: nowa pinezka na mapie\n\nPozostałe informacje bez zmian.')
})

test('M6: a ticked notice needs a subject and a body (spaces do not count)', () => {
  assert.deepEqual(noticeCheck({ subject: 'Zmiana', body: 'Treść' }), {})
  assert.deepEqual(noticeCheck({ subject: '   ', body: '' }), { subject: 'Podaj temat wiadomości.', body: 'Podaj treść wiadomości.' })
})
