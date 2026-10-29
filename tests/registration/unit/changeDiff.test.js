// changeDiff / noticeAudience: what „Opublikuj zmiany” shows and whom the
// optional change notice goes to (W-24).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { changeDiff, noticeAudience, noticeRows } from '../../../supabase/functions/_shared/registration/changeDiff.js'

const C1 = '11111111-1111-4111-8111-111111111111'
const C2 = '22222222-2222-4222-8222-222222222222'

const live = {
  settings: {
    name: 'Bieg Leszego', event_date: '2026-12-06', first_start_time: '10:00:00', town_label: 'Nieborowice',
    town_area: 'GM. PILCHOWICE · ŚLĄSKIE', place_details: 'Boisko', lat: 50.2381, lng: 18.5412,
    opens_at: '2026-11-01T23:00:00+00:00', closes_at: '2026-12-05T23:00:00+00:00', pricing_mode: 'free',
    regulamin_kind: 'link', regulamin_url: 'https://example.org/r.pdf', regulamin_upload_id: null,
    office_address: null, timing_company: null, form_fields: { phone: 'optional', city: 'optional', club: 'optional', ice: 'optional' },
  },
  competitions: [
    { category_id: C1, name: 'Bieg 9 km', kind: 'individual', discipline: 'run', start_time: '10:00:00', distance_label: '9 km',
      capacity: 50, min_age: null, max_age: null, is_kids: false, timed: true, gpx_upload_id: null, hidden_at: null, price: null },
    { category_id: C2, name: 'Marsz 5 km', kind: 'individual', discipline: 'run', start_time: '10:05:00', distance_label: '5 km',
      capacity: 30, min_age: null, max_age: null, is_kids: false, timed: true, gpx_upload_id: null, hidden_at: null, price: null },
  ],
  officeHours: [],
}

const item = (c, over = {}) => ({
  category_id: c.category_id, name: c.name, kind: 'individual', discipline: 'run', distance_label: c.distance_label,
  start_time: c.start_time.slice(0, 5), capacity: c.capacity, min_age: null, max_age: null, is_kids: false, timed: true,
  gpx_upload_id: null, price: null, ...over,
})

test('a value staged unchanged is no change; time and timestamp spellings compare by value', () => {
  const diff = changeDiff(live, {
    basics: { name: 'Bieg Leszego', first_start_time: '10:00', opens_at: '2026-11-01T23:00:00.000Z', lat: 50.2381 },
    competitions: { pricing_mode: 'free', items: live.competitions.map((c) => item(c)) },
  })
  assert.deepEqual(diff, [])
})

test('basics changes list field, label, before and after', () => {
  const diff = changeDiff(live, { basics: { name: 'Bieg Leszego 2026', event_date: '2026-12-13', town_label: 'Gliwice' } })
  assert.deepEqual(diff.map((d) => [d.field, d.before, d.after]), [
    ['basics.name', 'Bieg Leszego', 'Bieg Leszego 2026'],
    ['basics.event_date', '2026-12-06', '2026-12-13'],
    ['basics.town_label', 'Nieborowice', 'Gliwice'],
  ])
  assert.equal(diff[1].label, 'Data zawodów')
  assert.equal(diff[0].categoryId, undefined)
})

test('a competition change carries its categoryId; start time is shown as HH:MM', () => {
  const diff = changeDiff(live, {
    competitions: { pricing_mode: 'free', items: [item(live.competitions[0], { start_time: '10:15', capacity: 60 }), item(live.competitions[1])] },
  })
  assert.deepEqual(diff.map((d) => [d.field, d.before, d.after, d.categoryId]), [
    ['competitions.start_time', '10:00', '10:15', C1],
    ['competitions.capacity', 50, 60, C1],
  ])
  assert.match(diff[0].label, /Bieg 9 km/)
})

test('hiding, unhiding and adding a competition are listed', () => {
  const hiddenLive = { ...live, competitions: [live.competitions[0], { ...live.competitions[1], hidden_at: '2026-11-02T10:00:00Z' }] }
  const diff = changeDiff(hiddenLive, {
    competitions: {
      pricing_mode: 'free',
      items: [
        item(live.competitions[0], { hidden: true }),
        item(live.competitions[1], { hidden: false }),
        { ...item(live.competitions[0]), category_id: null, name: 'Bieg 3 km' },
      ],
    },
  })
  assert.deepEqual(diff.map((d) => [d.field, d.categoryId ?? null, d.after]), [
    ['competitions.hidden', C1, 'ukryta'],
    ['competitions.hidden', C2, 'widoczna'],
    ['competitions.new', null, 'Bieg 3 km'],
  ])
})

test('noticeAudience: date or place → everyone; start time or distance → that competition only; others → nobody', () => {
  assert.deepEqual(noticeAudience([]), { all: false, categoryIds: [] })
  assert.deepEqual(noticeAudience([{ field: 'basics.name' }, { field: 'competitions.capacity', categoryId: C1 }]),
    { all: false, categoryIds: [] })
  assert.deepEqual(noticeAudience([
    { field: 'competitions.start_time', categoryId: C1 }, { field: 'competitions.distance_label', categoryId: C1 },
    { field: 'competitions.distance_label', categoryId: C2 },
  ]), { all: false, categoryIds: [C1, C2] })
  for (const field of ['basics.event_date', 'basics.town_label', 'basics.place_details', 'basics.first_start_time']) {
    assert.equal(noticeAudience([{ field }]).all, true, field)
  }
})

test('noticeRows: the rows that put someone on the notice, the pin left out of the text', () => {
  const rows = [
    { field: 'basics.name' }, { field: 'basics.event_date' }, { field: 'basics.lat' }, { field: 'basics.lng' },
    { field: 'competitions.capacity', categoryId: C1 }, { field: 'competitions.start_time', categoryId: C1 },
  ]
  assert.deepEqual(noticeRows(rows).map((r) => r.field), ['basics.event_date', 'competitions.start_time'])
})

test('mergedChecklistInput: the event as it will be, in publishChecklist\'s shape', async () => {
  const { mergedChecklistInput } = await import('../../../supabase/functions/_shared/registration/changeDiff.js')
  const { publishChecklist } = await import('../../../supabase/functions/_shared/registration/checklist.js')
  const settled = { ...live, settings: { ...live.settings, name: 'Bieg', slug: 'bieg', contact_email: 'zapisy@klub.example' } }
  const ok = mergedChecklistInput(settled, { basics: { name: 'Bieg 2' } })
  assert.equal(ok.settings.name, 'Bieg 2')
  assert.deepEqual(publishChecklist({ ...ok, hasAgreement: true }).blocking, [])

  const keys = (pending) => publishChecklist({ ...mergedChecklistInput(settled, pending), hasAgreement: true }).blocking.map((b) => b.key)
  assert.deepEqual(keys({ basics: { opens_at: null, closes_at: null } }), ['registration_dates'])
  assert.deepEqual(keys({ basics: { regulamin_url: null } }), ['regulamin'])
  assert.deepEqual(keys({ basics: { event_date: '2026-12-01' } }), ['registration_dates'])
  // Hiding every competition leaves none visible.
  assert.deepEqual(keys({ competitions: { pricing_mode: 'free', items: live.competitions.map((c) => item(c, { hidden: true })) } }), ['competitions'])
})

test('P-40 a staged payment window is listed as „Czas na opłacenie zgłoszenia”, in days', () => {
  const withWindow = { ...live, settings: { ...live.settings, payment_window_hours: 168 } }
  assert.deepEqual(changeDiff(withWindow, { payments: { payment_window_hours: 336 } }), [
    { field: 'payments.payment_window_hours', label: 'Czas na opłacenie zgłoszenia', before: '7 dni', after: '14 dni' },
  ])
  assert.deepEqual(changeDiff(withWindow, { payments: { payment_window_hours: 24 } })[0].after, '24 godziny')
  assert.deepEqual(changeDiff(withWindow, { payments: { payment_window_hours: 168 } }), [])
})

test('P-59 „do końca zapisów” is one row of „Czas na opłacenie zgłoszenia”, both ways', () => {
  const days7 = { ...live, settings: { ...live.settings, payment_window_hours: 168, payment_window_until_close: false } }
  assert.deepEqual(changeDiff(days7, { payments: { payment_window_until_close: true } }), [
    { field: 'payments.payment_window_hours', label: 'Czas na opłacenie zgłoszenia', before: '7 dni', after: 'do końca zapisów' },
  ])
  const untilClose = { ...live, settings: { ...live.settings, payment_window_hours: 168, payment_window_until_close: true } }
  assert.deepEqual(changeDiff(untilClose, { payments: { payment_window_hours: 24, payment_window_until_close: false } }), [
    { field: 'payments.payment_window_hours', label: 'Czas na opłacenie zgłoszenia', before: 'do końca zapisów', after: '24 godziny' },
  ])
  assert.deepEqual(changeDiff(untilClose, { payments: { payment_window_until_close: true } }), [])
  // The hours behind „do końca zapisów” are not shown: switching them changes nothing the runner sees.
  assert.deepEqual(changeDiff(untilClose, { payments: { payment_window_hours: 336, payment_window_until_close: true } }), [])
})

test('P-42 mergedChecklistInput carries the payout state through', async () => {
  const { mergedChecklistInput } = await import('../../../supabase/functions/_shared/registration/changeDiff.js')
  const payout = { mode: 'club', ready: false }
  assert.deepEqual(mergedChecklistInput({ ...live, payout }, { basics: { name: 'X' } }).payout, payout)
  assert.deepEqual(mergedChecklistInput({ ...live, payout }, { payments: { payment_window_hours: 24 } }).settings.paymentWindowHours, 24)
})

test('M-1 the checklist on staged values: a staged paid pricing with a payout not ready blocks', async () => {
  const { mergedChecklistInput } = await import('../../../supabase/functions/_shared/registration/changeDiff.js')
  const { publishChecklist } = await import('../../../supabase/functions/_shared/registration/checklist.js')
  const settled = { ...live, settings: { ...live.settings, name: 'Bieg', slug: 'bieg', contact_email: 'zapisy@klub.example' } }
  const paid = { competitions: { pricing_mode: 'fixed', items: live.competitions.map((c) => item(c, { price: 6000 })) } }
  const keys = (payout) => publishChecklist({ ...mergedChecklistInput({ ...settled, payout }, paid), hasAgreement: true }).blocking.map((b) => b.key)
  assert.deepEqual(keys({ mode: 'club', ready: false }), ['payments', 'payout'])
  assert.deepEqual(keys({ mode: 'club', ready: true }), ['payments'])
})
