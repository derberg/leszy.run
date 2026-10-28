import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { eventPageModel, mergePending } from '../../src/lib/eventPageModel.js'
import { withFileUrls } from '../../src/lib/eventFiles.js'

const BASE = 'https://proj.supabase.co'
const fileUrl = (path) => `${BASE}/storage/v1/object/public/registration-files/${path}`
const GPX9 = 'e1/gpx/aaa.gpx'
const GPX3 = 'e1/gpx/bbb.gpx'
const course = (km, gpxPath) => ({ km, upM: 120, downM: 120, points: 812, profile: [[0, 250], [km, 252]], gpxPath })

const comp = (over) => ({
  categoryId: over.categoryId, name: over.name, kind: 'individual', discipline: 'run', distanceLabel: null,
  startTime: '10:00', capacity: 40, taken: 0, confirmed: 0, minAge: null, maxAge: null, isKids: false,
  timed: true, priceGrosze: 6000, nextPrice: { grosze: 7000, from: '2026-11-16' },
  ageGroups: [], kidsGroups: [], course: null, ...over,
})

// The RA1 board: Charytatywny Bieg Leszego, 6.12.2026, five competitions, 87
// registered (84 confirmed) of 200 places, registration through 2.12.
const RA1 = {
  eventId: 'e1', slug: 'charytatywny-bieg-leszego', state: 'published',
  club: { name: 'ZATYRANI' }, contactEmail: 'biuro@zatyrani.pl',
  name: 'Charytatywny Bieg Leszego', eventDate: '2026-12-06', firstStartTime: '10:00',
  opensAt: '2026-09-30T22:00:00Z', closesAt: '2026-12-02T23:00:00Z',
  isCharity: true, charityGoal: 'Cały dochód na leczenie Zuzi.', donationsEnabled: true,
  town: { label: 'Nieborowice', area: 'GM. PILCHOWICE · ŚLĄSKIE', placeDetails: 'Boisko przy szkole', lat: 50.2381, lng: 18.5412 },
  office: {
    sameAsEvent: false, address: 'Szkoła Podstawowa, ul. Szkolna 4', notes: null, lat: 50.24, lng: 18.54,
    hours: [{ date: '2026-12-05', from: '17:00', to: '19:00' }, { date: '2026-12-06', from: '08:00', to: '09:30' }],
  },
  timing: { mode: 'leszyrun', company: null, resultsUrl: null, liveResultsUrl: null },
  regulamin: { kind: 'pdf', url: null, path: 'e1/regulamin/r.pdf', version: 1 },
  posterPath: 'e1/poster/p.jpg',
  ageReckoning: 'race_day', formFields: { phone: 'optional', city: 'optional', club: 'optional', ice: 'optional' },
  pricingMode: 'tiered',
  consents: [{ id: 'k1', kind: 'regulamin', text: 'Akceptuję regulamin.' }, { id: 'k2', kind: 'data_info', text: 'Zapoznałem się.' }],
  competitions: [
    comp({ categoryId: 'c1', name: 'Bieg 9 km', distanceLabel: '9 km', startTime: '10:00', capacity: 80, taken: 40, confirmed: 39, minAge: 16, course: course(9.1, GPX9) }),
    comp({ categoryId: 'c2', name: 'Bieg 3 km', distanceLabel: '3 km', startTime: '10:05', capacity: 40, taken: 20, confirmed: 19, minAge: 12, course: course(3.05, GPX3) }),
    comp({ categoryId: 'c3', name: 'Nordic walking 9 km', discipline: 'nw', distanceLabel: '9 km', startTime: '10:10', capacity: 40, taken: 17, confirmed: 16, minAge: 16, course: course(9.1, GPX9) }),
    comp({ categoryId: 'c4', name: 'Nordic walking 3 km', discipline: 'nw', distanceLabel: '3 km', startTime: '10:10', capacity: 20, taken: 5, confirmed: 5, minAge: 12, course: course(3.05, GPX3) }),
    comp({
      categoryId: 'c5', name: 'Bieg dzieci', startTime: '11:30', capacity: 20, taken: 5, confirmed: 5, maxAge: 15, isKids: true,
      priceGrosze: 2000, nextPrice: { grosze: 2500, from: '2026-11-16' },
      kidsGroups: [{ label: '2016–2018', birthYearFrom: 2016, birthYearTo: 2018, gender: null, distanceLabel: '600 m' }],
    }),
  ],
}

const NOW = new Date('2026-11-06T10:00:00Z')
const model = (raw = RA1, now = NOW) => eventPageModel(withFileUrls(raw, BASE), now)

describe('eventPageModel (RA1)', () => {
  it('stats: registered, confirmed, free places, days until registration closes', () => {
    assert.deepEqual(model().stats, { registered: 87, confirmed: 84, free: 113, daysLeft: '27 dni' })
  })

  it('header: title, Warsaw date with weekday, place, charity goal', () => {
    const m = model()
    assert.equal(m.title, 'Charytatywny Bieg Leszego')
    assert.equal(m.dateLabel, '6.12.2026 · niedziela')
    assert.equal(m.placeLabel, 'Nieborowice')
    assert.equal(m.charityGoal, 'Cały dochód na leczenie Zuzi.')
  })

  it('office hours as short weekday and day, hours without a leading zero', () => {
    assert.deepEqual(model().office, [
      { label: 'sob 5.12', hours: '17:00–19:00' },
      { label: 'ndz 6.12', hours: '8:00–9:30' },
    ])
  })

  it('competition rows: start and age, current price, next tier', () => {
    const [bieg9, , , , kids] = model().competitions
    assert.deepEqual(bieg9, {
      categoryId: 'c1', name: 'Bieg 9 km', startLabel: 'start 10:00 · od 16 lat', ageLabel: 'od 16 lat',
      priceLabel: '60 zł', nextPriceLabel: 'od 16.11: 70 zł', full: false, state: 'open',
    })
    assert.equal(kids.startLabel, 'start 11:30 · do 15 lat · dystans wg wieku')
    assert.equal(kids.priceLabel, '20 zł')
  })

  it('courses grouped by GPX file, tab label from the distance, names of every competition on it', () => {
    const { courses } = model()
    assert.deepEqual(courses.map((c) => [c.key, c.label, c.competitionNames]), [
      ['trasa-1', '9 km', 'BIEG 9 KM · NORDIC WALKING 9 KM'],
      ['trasa-2', '3 km', 'BIEG 3 KM · NORDIC WALKING 3 KM'],
    ])
    assert.equal(courses[0].km, 9.1)
    assert.equal(courses[0].upM, 120)
    assert.equal(courses[0].points, 812)
    assert.deepEqual(courses[0].profile, [[0, 250], [9.1, 252]])
    assert.equal(courses[0].gpxUrl, fileUrl(GPX9))
  })

  it('a paid event shows the fee note and the regulamin file', () => {
    const m = model()
    assert.equal(m.showFeeNote, true)
    assert.equal(m.regulaminUrl, fileUrl('e1/regulamin/r.pdf'))
  })
})

describe('eventPageModel organizer and places (RA1, RA2, RA5)', () => {
  it('the organizer is the club; the contact is the event address, never a person', () => {
    const m = model()
    assert.equal(m.organizerName, 'ZATYRANI')
    assert.equal(m.contactEmail, 'biuro@zatyrani.pl')
    assert.equal(model({ ...RA1, contactEmail: undefined }).contactEmail, null)
  })

  it('office place: its own address and pin, with an OpenStreetMap link', () => {
    assert.deepEqual(model().officePlace, {
      label: 'Szkoła Podstawowa, ul. Szkolna 4',
      mapUrl: 'https://www.openstreetmap.org/?mlat=50.24&mlon=18.54#map=17/50.24/18.54',
    })
  })

  it('office at the event: the event place and pin; nothing known → null', () => {
    const same = model({ ...RA1, office: { ...RA1.office, sameAsEvent: true, address: null, lat: null, lng: null } })
    assert.deepEqual(same.officePlace, {
      label: 'Nieborowice, Boisko przy szkole',
      mapUrl: 'https://www.openstreetmap.org/?mlat=50.2381&mlon=18.5412#map=17/50.2381/18.5412',
    })
    assert.equal(model({ ...RA1, office: { sameAsEvent: false, hours: [] } }).officePlace, null)
    assert.equal(same.eventPlace, 'Nieborowice, Boisko przy szkole')
  })
})

describe('eventPageModel states', () => {
  const free = {
    ...RA1, pricingMode: 'free', regulamin: { kind: 'link', url: 'https://example.org/r.pdf', path: null, version: 1 },
    competitions: RA1.competitions.map((c) => ({ ...c, priceGrosze: 0, nextPrice: null })),
  }

  it('free event: „Bezpłatne”, no next price, no fee note, regulamin link as given', () => {
    const m = model(free)
    assert.equal(m.competitions[0].priceLabel, 'Bezpłatne')
    assert.equal(m.competitions[0].nextPriceLabel, null)
    assert.equal(m.showFeeNote, false)
    assert.equal(m.regulaminUrl, 'https://example.org/r.pdf')
  })

  it('a full competition is marked full and never counts negative free places', () => {
    const over = { ...RA1, competitions: [comp({ categoryId: 'c1', name: 'X', capacity: 10, taken: 12, confirmed: 12 }), comp({ categoryId: 'c2', name: 'Y', capacity: 10, taken: 3 })] }
    const m = model(over)
    assert.deepEqual(m.competitions.map((c) => [c.full, c.state]), [[true, 'full'], [false, 'open']])
    assert.equal(m.stats.free, 7)
  })

  it('before opening „soon”; on the last day „1 dzień”; after closing „closed” with no countdown', () => {
    assert.equal(model(RA1, new Date('2026-09-30T21:59:00Z')).competitions[0].state, 'soon')
    const lastDay = model(RA1, new Date('2026-12-02T22:30:00Z'))
    assert.equal(lastDay.stats.daysLeft, '1 dzień')
    assert.equal(lastDay.competitions[0].state, 'open')
    const after = model(RA1, new Date('2026-12-02T23:00:00Z'))
    assert.equal(after.stats.daysLeft, null)
    assert.equal(after.competitions[0].state, 'closed')
    assert.equal(model({ ...RA1, state: 'closed' }).competitions[0].state, 'closed')
    assert.equal(model({ ...RA1, state: 'draft' }).competitions[0].state, 'open', 'a previewed draft follows its dates')
    assert.equal(model({ ...RA1, opensAt: null, closesAt: null }).competitions[0].state, 'closed')
  })

  it('age labels: range, none', () => {
    const m = model({ ...RA1, competitions: [comp({ categoryId: 'a', name: 'A', minAge: 16, maxAge: 29 }), comp({ categoryId: 'b', name: 'B' })] })
    assert.deepEqual(m.competitions.map((c) => [c.ageLabel, c.startLabel]), [
      ['16–29 lat', 'start 10:00 · 16–29 lat'], [null, 'start 10:00'],
    ])
  })
})

describe('withFileUrls', () => {
  it('turns storage paths into public URLs and drops the paths', () => {
    const raw = withFileUrls(RA1, BASE + '/')
    assert.equal(raw.posterUrl, fileUrl('e1/poster/p.jpg'))
    assert.equal(raw.regulamin.url, fileUrl('e1/regulamin/r.pdf'))
    assert.equal(raw.competitions[0].course.gpxUrl, fileUrl(GPX9))
    assert.equal(JSON.stringify(raw).includes('Path'), false)
    assert.equal('path' in raw.regulamin, false)
    assert.equal(RA1.posterPath, 'e1/poster/p.jpg', 'input untouched')
  })
})

describe('mergePending', () => {
  const pending = {
    payload: {
      basics: { name: 'Bieg Leszego 2026', charity_goal: null },
      office: { office_address: 'Hala, ul. Leśna 1', hours: [{ date: '2026-12-06', from: '07:30', to: '09:30' }] },
      competitions: {
        pricing_mode: 'tiered',
        items: [
          { category_id: 'c1', name: 'Bieg 9 km', start_time: '10:15', capacity: 90, min_age: 16, max_age: null, is_kids: false, timed: true, discipline: 'run', distance_label: '9 km', gpx_upload_id: 'u9' },
          { category_id: 'c2', name: 'Bieg 3 km', start_time: '10:05', capacity: 40, min_age: 12, max_age: null, is_kids: false, timed: true, discipline: 'run', distance_label: '3 km', gpx_upload_id: null, hidden: true },
          { category_id: null, name: 'Marsz 5 km', start_time: '12:00', capacity: 30, min_age: null, max_age: null, is_kids: false, timed: false, discipline: 'nw', distance_label: '5 km', gpx_upload_id: 'u5' },
        ],
      },
    },
    changedFields: ['basics.name', 'competitions'],
    uploads: {
      u9: { path: GPX9, meta: { km: 9.1, upM: 120, downM: 120, points: 812, profile: [[0, 250], [9.1, 252]] } },
      u5: { path: 'e1/gpx/ccc.gpx', meta: { km: 5, upM: 10, downM: 10, points: 300, profile: [] } },
    },
  }

  it('no pending → the raw unchanged', () => {
    assert.equal(mergePending(RA1, null), RA1)
  })

  it('shows staged basics, office and competitions the way the public page will', () => {
    const merged = mergePending(RA1, pending)
    assert.equal(merged.name, 'Bieg Leszego 2026')
    assert.equal(merged.charityGoal, null)
    assert.equal(merged.office.address, 'Hala, ul. Leśna 1')
    assert.deepEqual(merged.office.hours, [{ date: '2026-12-06', from: '07:30', to: '09:30' }])
    assert.deepEqual(merged.competitions.map((c) => c.name), ['Bieg 9 km', 'Marsz 5 km'])
    const [c1, added] = merged.competitions
    assert.equal(c1.startTime, '10:15')
    assert.equal(c1.capacity, 90)
    assert.equal(c1.taken, 40, 'live counts kept')
    assert.equal(c1.priceGrosze, 6000, 'live price kept when the item has none')
    assert.equal(c1.course.gpxPath, GPX9)
    assert.equal(added.categoryId, null)
    assert.equal(added.taken, 0)
    assert.equal(added.course.km, 5)
    assert.equal(RA1.competitions[0].startTime, '10:00', 'input untouched')

    const m = eventPageModel(withFileUrls(merged, BASE), NOW)
    assert.equal(m.competitions[0].startLabel, 'start 10:15 · od 16 lat')
    assert.equal(m.title, 'Bieg Leszego 2026')
  })

  it('staged categories, timing and form replace their parts', () => {
    const merged = mergePending(RA1, { payload: {
      categories: { age_reckoning: 'year_end', age_groups: [{ id: null, category_id: 'c1', gender: 'K', label: 'K20', min_age: 20, max_age: 29 }], kids_groups: [] },
      timing: { timing_company: 'Firma' },
      form: { form_fields: { phone: 'required', city: 'off', club: 'optional', ice: 'optional' }, consents: [{ id: null, text: 'Zgoda na zdjęcia.' }] },
    } })
    assert.equal(merged.ageReckoning, 'year_end')
    assert.deepEqual(merged.competitions[0].ageGroups, [{ gender: 'K', label: 'K20', minAge: 20, maxAge: 29 }])
    assert.deepEqual(merged.competitions[4].kidsGroups, [])
    assert.equal(merged.timing.company, 'Firma')
    assert.equal(merged.timing.mode, 'leszyrun', 'live mode kept when not staged')
    assert.equal(merged.formFields.phone, 'required')
    assert.deepEqual(merged.consents.map((k) => [k.kind, k.text]), [
      ['regulamin', 'Akceptuję regulamin.'], ['data_info', 'Zapoznałem się.'], ['custom', 'Zgoda na zdjęcia.'],
    ])
  })

  it('a competition hidden live stays hidden unless the staged item unhides it', () => {
    const item = (over) => ({ category_id: 'hid', name: 'Ukryty 1 km', start_time: '09:00', capacity: 10, min_age: null, max_age: null, is_kids: false, timed: true, discipline: 'run', distance_label: '1 km', gpx_upload_id: null, ...over })
    const names = (it) => mergePending(RA1, { payload: { competitions: { pricing_mode: 'free', items: [it] } } }).competitions.map((c) => c.name)
    assert.deepEqual(names(item({})), [])
    assert.deepEqual(names(item({ hidden: false })), ['Ukryty 1 km'])
    assert.deepEqual(names(item({ category_id: 'c1', name: 'Bieg 9 km' })), ['Bieg 9 km'])
  })

  it('a draft preview shows a staged slug and timing mode', () => {
    const merged = mergePending(RA1, { payload: { basics: { slug: 'bieg-leszego-2026' }, timing: { timing_mode: 'external' } } })
    assert.equal(merged.slug, 'bieg-leszego-2026')
    assert.equal(merged.timing.mode, 'external')
    assert.equal(RA1.slug, 'charytatywny-bieg-leszego', 'input untouched')
  })
})

describe('mergePending contact address', () => {
  it('a staged contact address shows in the preview', () => {
    const out = mergePending(RA1, { payload: { basics: { contact_email: 'nowy@zatyrani.pl' } } })
    assert.equal(out.contactEmail, 'nowy@zatyrani.pl')
  })
})
