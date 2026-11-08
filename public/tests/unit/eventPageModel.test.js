import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { groupCompetitions, startsByTime, eventPageModel, mergePending, previewRaw, statParts } from '../../src/lib/eventPageModel.js'
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
    assert.deepEqual(model().stats, { registered: 87, confirmed: 84, free: 113, teams: null, daysLeft: '27 dni' })
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

  it('an office hours note rides on its row', () => {
    const raw = { ...RA1, office: { ...RA1.office, hours: [{ date: '2026-12-05', from: '17:00', to: '19:00', note: 'tylko bieg dzieci' }, { date: '2026-12-06', from: '08:00', to: '09:30', note: null }] } }
    assert.deepEqual(model(raw).office, [
      { label: 'sob 5.12', hours: '17:00–19:00', note: 'tylko bieg dzieci' },
      { label: 'ndz 6.12', hours: '8:00–9:30' },
    ])
  })

  it('competition rows: start and age, current price, next tier', () => {
    const [bieg9, , , , kids] = model().competitions
    assert.deepEqual(bieg9, {
      categoryId: 'c1', name: 'Bieg 9 km', kind: 'individual', startLabel: 'start 10:00 · od 16 lat', ageLabel: 'od 16 lat',
      priceLabel: '60 zł', teamLine: null, nextPriceLabel: 'od 16.11: 70 zł', full: false, state: 'open', extras: [],
      taken: 40, capacity: 80, free: 40, startTime: '10:00', distanceLabel: '9 km', teamSize: null, priceUnit: 'za osobę', group: 'Bieg',
    })
    assert.equal(kids.startLabel, 'start 11:30 · do 15 lat · dystans wg wieku')
    assert.equal(kids.priceLabel, '20 zł')
  })

  it('panel groups: by discipline, kids and teams apart, in order of first appearance', () => {
    const groups = groupCompetitions(model().competitions)
    assert.deepEqual(groups.map((g) => [g.name, g.items.map((c) => c.name)]), [
      ['Bieg', ['Bieg 9 km', 'Bieg 3 km']],
      ['Nordic walking', ['Nordic walking 9 km', 'Nordic walking 3 km']],
      ['Dzieci', ['Bieg dzieci']],
    ])
    const team = model({ ...RA1, competitions: [comp({ categoryId: 't', name: 'Sztafeta', kind: 'team', teamMin: 4, teamMax: 5, priceGrosze: 20000 })] }).competitions[0]
    assert.deepEqual([team.group, team.teamSize, team.priceUnit], ['Sztafety i drużyny', 'drużyna 4–5 os.', 'za drużynę'])
    const free = model({ ...RA1, competitions: [comp({ categoryId: 'f', name: 'F', priceGrosze: 0, nextPrice: null })] }).competitions[0]
    assert.equal(free.priceUnit, null, 'a free entry has no „za osobę”')
  })

  it('starts: one line per start time, competitions starting together share it, no time last', () => {
    const rows = model({ ...RA1, competitions: [...RA1.competitions, comp({ categoryId: 'x', name: 'Bez godziny', startTime: null })] }).competitions
    assert.deepEqual(startsByTime(rows).map((s) => [s.time, s.items.map((c) => c.categoryId)]), [
      ['10:00', ['c1']], ['10:05', ['c2']], ['10:10', ['c3', 'c4']], ['11:30', ['c5']], [null, ['x']],
    ])
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

  it('the start list is linked once the event has a competition', () => {
    assert.equal(model().showStartList, true)
    assert.equal(model({ ...RA1, competitions: [] }).showStartList, false)
  })

  it('a paid event shows the regulamin file', () => {
    const m = model()
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

  it('office place: its own address and pin, with OpenStreetMap and Google Maps links', () => {
    assert.deepEqual(model().officePlace, {
      label: 'Szkoła Podstawowa, ul. Szkolna 4',
      mapUrl: 'https://www.openstreetmap.org/?mlat=50.24&mlon=18.54#map=17/50.24/18.54',
      googleMapsUrl: 'https://www.google.com/maps/search/?api=1&query=50.24,18.54',
    })
  })

  it('office at the event: the event place and pin; nothing known → null', () => {
    const same = model({ ...RA1, office: { ...RA1.office, sameAsEvent: true, address: null, lat: null, lng: null } })
    assert.deepEqual(same.officePlace, {
      label: 'Nieborowice, Boisko przy szkole',
      mapUrl: 'https://www.openstreetmap.org/?mlat=50.2381&mlon=18.5412#map=17/50.2381/18.5412',
      googleMapsUrl: 'https://www.google.com/maps/search/?api=1&query=50.2381,18.5412',
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

  it('T-51 the runner preview shows a staged kind, team size and leg order', () => {
    const raw = { pricingMode: 'free', competitions: [{ categoryId: 'c1', name: 'Bieg', kind: 'individual', teamMin: null, teamMax: null, legOrderEnabled: false }] }
    const out = mergePending(raw, { payload: {
      competitions: { pricing_mode: 'free', items: [{ category_id: 'c1', name: 'Bieg', kind: 'team', team_min: 2, team_max: 4 }] },
      form: { leg_order: { c1: true } },
    } })
    const c = out.competitions[0]
    assert.deepEqual([c.kind, c.teamMin, c.teamMax, c.legOrderEnabled], ['team', 2, 4, true])
    assert.equal(raw.competitions[0].kind, 'individual', 'the raw is never changed')
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

  it('a staged guardian consent stays minors-only in the preview', () => {
    const merged = mergePending(RA1, { payload: { form: { consents: [{ id: null, text: 'Opiekun.', minorsOnly: true }, { id: null, text: 'Wszyscy.' }] } } })
    assert.deepEqual(merged.consents.filter((k) => k.kind === 'custom').map((k) => [k.text, k.minorsOnly]), [['Opiekun.', true], ['Wszyscy.', false]])
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

describe('eventPageModel start place and deadline (W-67, W-68)', () => {
  it('W-67 start: the event place and pin from Podstawy, with OpenStreetMap and Google Maps links', () => {
    assert.deepEqual(model().startPlace, {
      label: 'Nieborowice, Boisko przy szkole',
      mapUrl: 'https://www.openstreetmap.org/?mlat=50.2381&mlon=18.5412#map=17/50.2381/18.5412',
      googleMapsUrl: 'https://www.google.com/maps/search/?api=1&query=50.2381,18.5412',
    })
    assert.equal(model().officeAtStart, false)
  })

  it('W-67 an office at the event is flagged as at the start; no town and no pin → no start place', () => {
    const same = model({ ...RA1, office: { ...RA1.office, sameAsEvent: true } })
    assert.equal(same.officeAtStart, true)
    assert.deepEqual(model({ ...RA1, town: { label: 'Nieborowice', lat: null, lng: null } }).startPlace, { label: 'Nieborowice', mapUrl: null, googleMapsUrl: null })
    assert.equal(model({ ...RA1, town: null }).startPlace, null)
  })

  it('W-68 registration closes on the last day at 23:59 Warsaw time, winter and summer', () => {
    // closesAt is exclusive: the Warsaw midnight after the last day.
    assert.equal(model().closesLabel, '2.12.2026, 23:59')
    assert.equal(model({ ...RA1, closesAt: '2026-06-30T22:00:00Z' }, new Date('2026-06-01T10:00:00Z')).closesLabel, '30.06.2026, 23:59')
    // The night the clocks go back: 25.10 ends at 23:00Z.
    assert.equal(model({ ...RA1, closesAt: '2026-10-25T23:00:00Z' }, new Date('2026-10-01T10:00:00Z')).closesLabel, '25.10.2026, 23:59')
    assert.equal(model({ ...RA1, closesAt: null }).closesLabel, null)
  })

  it('W-68 the window state is exposed for the deadline line', () => {
    assert.equal(model().registrationState, 'open')
    assert.equal(model(RA1, new Date('2026-09-01T10:00:00Z')).registrationState, 'soon')
    assert.equal(model(RA1, new Date('2026-12-03T10:00:00Z')).registrationState, 'closed')
  })
})

describe('eventPageModel course elevation (review U2 M2)', () => {
  const withCourse = (c) => model({ ...RA1, competitions: [comp({ categoryId: 'c1', name: 'Bieg 9 km', distanceLabel: '9 km', course: c })] }).courses[0]

  it('a GPX with varying elevation keeps its profile and climb', () => {
    const c = withCourse({ km: 9.1, upM: 80, downM: 80, points: 10, profile: [[0, 250], [4.5, 290], [9.1, 250]], gpxPath: GPX9 })
    assert.equal(c.hasElevation, true)
    assert.equal(c.upM, 80)
    assert.equal(c.profile.length, 3)
  })

  it('no elevation, or a flat one, hides the profile and the climb', () => {
    for (const profile of [[], [[0, 250], [9.1, 250]]]) {
      const c = withCourse({ km: 9.1, upM: 0, downM: 0, points: 10, profile, gpxPath: GPX9 })
      assert.equal(c.hasElevation, false)
      assert.equal(c.upM, null)
      assert.equal(c.downM, null)
      assert.deepEqual(c.profile, [])
    }
  })
})

describe('T-62 RA1: the team card', () => {
  const team = (over = {}) => comp({ categoryId: 't1', name: 'Sztafeta', kind: 'team', teamMin: 2, teamMax: 5, capacity: 20, taken: 3, priceGrosze: 24000, ...over })
  const line = (c) => eventPageModel({ ...RA1, competitions: [c] }).competitions[0].teamLine

  it('„Drużyny N–M osób · <cena> / drużyna · X / Y DRUŻYN”', () => {
    assert.equal(line(team()), 'Drużyny 2–5 osób · 240 zł / drużyna · 3 / 20 DRUŻYN')
  })
  it('a free team has no „/ drużyna”, one fixed size reads as one', () => {
    assert.equal(line(team({ priceGrosze: 0 })), 'Drużyny 2–5 osób · Bezpłatne · 3 / 20 DRUŻYN')
    assert.equal(line(team({ teamMin: 4, teamMax: 4 })), 'Drużyny 4-osobowe · 240 zł / drużyna · 3 / 20 DRUŻYN')
  })
  it('a team competition with no size yet says nothing about one, never „undefined”', () => {
    assert.equal(line(team({ teamMin: null, teamMax: null })), '240 zł / drużyna · 3 / 20 DRUŻYN')
    assert.equal(line(team({ teamMin: undefined, teamMax: undefined })), '240 zł / drużyna · 3 / 20 DRUŻYN')
    assert.equal(line(team({ teamMin: 2, teamMax: null })), '240 zł / drużyna · 3 / 20 DRUŻYN')
  })
  it('an individual competition has none', () => {
    assert.equal(line(comp({ categoryId: 'c', name: 'Bieg' })), null)
  })
})

describe('Final review: RA1 never adds people and teams into one number', () => {
  const team = (over = {}) => comp({ categoryId: 't1', name: 'Sztafeta', kind: 'team', teamMin: 2, teamMax: 5, capacity: 20, taken: 3, confirmed: 3, priceGrosze: 24000, ...over })
  const people = comp({ categoryId: 'c1', name: 'Bieg 9 km', capacity: 80, taken: 40, confirmed: 39 })

  it('I-5 a mixed event: people from the individual competitions, teams on their own', () => {
    const m = eventPageModel({ ...RA1, competitions: [people, team()] }, NOW)
    assert.deepEqual(m.stats, { registered: 40, confirmed: 39, free: 40, teams: { registered: 3, free: 17, only: false }, daysLeft: '27 dni' })
    assert.deepEqual(statParts(m.stats), {
      registered: [{ count: 40, unit: 'osób' }, { count: 3, unit: 'drużyny' }],
      free: [{ count: 40, unit: 'osób' }, { count: 17, unit: 'drużyn' }],
    })
  })
  it('I-5 only teams: the units say drużyny; only people: one bare number, as before', () => {
    const m = eventPageModel({ ...RA1, competitions: [team({ taken: 1, capacity: 2 })] }, NOW)
    assert.deepEqual(statParts(m.stats), { registered: [{ count: 1, unit: 'drużyna' }], free: [{ count: 1, unit: 'drużyna' }] })
    assert.deepEqual(statParts(model().stats), { registered: [{ count: 87, unit: null }], free: [{ count: 113, unit: null }] })
  })
  it('L-2 the team line\'s limit word follows the limit', () => {
    const line = (capacity, taken = 0) => eventPageModel({ ...RA1, competitions: [team({ capacity, taken })] }, NOW).competitions[0].teamLine
    assert.match(line(1), / · 0 \/ 1 DRUŻYNA$/)
    assert.match(line(3, 1), / · 1 \/ 3 DRUŻYNY$/)
    assert.match(line(5), / · 0 \/ 5 DRUŻYN$/)
    assert.match(line(22), / · 0 \/ 22 DRUŻYNY$/)
    assert.match(line(12), / · 0 \/ 12 DRUŻYN$/)
  })
  it('kind rides on the row, so the group form can leave a team competition out', () => {
    const m = eventPageModel({ ...RA1, competitions: [people, team()] }, NOW)
    assert.deepEqual(m.competitions.map((c) => c.kind), ['individual', 'team'])
  })
})

// ---------------------------------------------------------------- Plan 7 task 3

describe('extras (Plan 7)', () => {
  const SHIRT = {
    id: 'x1', name: 'Koszulka techniczna', imagePath: 'e1/extra/k.jpg', price: 4500, orderUntil: '2026-11-25',
    categoryIds: [], variants: [{ id: 'v1', label: 'M', left: 3 }, { id: 'v2', label: 'L', left: 0 }],
  }
  const MEDAL = { id: 'x2', name: 'Medal grawerowany', imagePath: null, price: 2000, orderUntil: '2026-12-06', categoryIds: ['c5'], variants: [{ id: 'v3', label: 'Jeden rozmiar', left: 50 }] }
  const withExtras = { ...RA1, extras: [SHIRT, MEDAL] }

  it('every competition lists the extras offered in it: none named = every competition', () => {
    const m = model(withExtras)
    assert.deepEqual(m.competitions[0].extras.map((x) => x.name), ['Koszulka techniczna'])
    assert.deepEqual(m.competitions[4].extras.map((x) => x.name), ['Koszulka techniczna', 'Medal grawerowany'])
  })

  it('an extra shows its image URL, price and order deadline; a variant with nothing left stays, as „brak”', () => {
    const [shirt] = model(withExtras).competitions[0].extras
    assert.deepEqual(shirt, {
      id: 'x1', name: 'Koszulka techniczna', description: null, imageUrl: fileUrl('e1/extra/k.jpg'), priceLabel: '45 zł', orderUntil: '2026-11-25',
      orderUntilLabel: 'zamówienia do 25.11',
      variants: [{ id: 'v1', label: 'M', left: 3, soldOut: false, leftLabel: null }, { id: 'v2', label: 'L', left: 0, soldOut: true, leftLabel: 'brak' }],
    })
  })

  it('W-86 an extra carries its description as the organizer wrote it', () => {
    const text = '35 zł pokrywa koszt wykonania koszulki,\npozostałe 25 zł trafia na cel zbiórki.'
    const [shirt] = model({ ...RA1, extras: [{ ...SHIRT, description: text }] }).competitions[0].extras
    assert.equal(shirt.description, text)
  })

  it('a raw with no extras key gives every competition an empty list', () => {
    assert.ok(model().competitions.every((c) => Array.isArray(c.extras) && c.extras.length === 0))
  })
})

describe('mergePending: staged tiers and extras (Plan 7)', () => {
  // The A3 mockup staged through the wizard: 15.11 / 25.11 / do końca zapisów, 60 / 70 / 80 zł.
  const A3 = {
    pricing_mode: 'tiered',
    tiers: [{ id: null, ends_on: '2026-11-15' }, { id: 't2', ends_on: '2026-11-25' }, { id: null, ends_on: null }],
    items: [{ category_id: 'c1', name: 'Bieg 9 km', start_time: '10:00', capacity: 80, min_age: 16, max_age: null, is_kids: false, timed: true,
      discipline: 'run', distance_label: '9 km', gpx_upload_id: null, price: null, prices: { 'new:0': 6000, t2: 7000, 'new:2': 8000 } }],
  }

  it('V-19 the current and next staged tier give the price and RA1\'s „od 16.11: 70 zł”', () => {
    const merged = mergePending({ ...RA1, pricingMode: 'free' }, { payload: { competitions: A3 } }, new Date('2026-11-06T10:00:00Z'))
    assert.equal(merged.competitions[0].priceGrosze, 6000)
    assert.deepEqual(merged.competitions[0].nextPrice, { grosze: 7000, from: '2026-11-16' })
    const m = eventPageModel(withFileUrls(merged, BASE), NOW)
    assert.equal(m.competitions[0].priceLabel, '60 zł')
    assert.equal(m.competitions[0].nextPriceLabel, 'od 16.11: 70 zł')
  })

  it('a tier ends at Warsaw midnight: on 15.11 at 23:59:59 Warsaw tier 1, a millisecond later tier 2', () => {
    const at = (iso) => mergePending(RA1, { payload: { competitions: A3 } }, new Date(iso)).competitions[0]
    assert.equal(at('2026-11-15T22:59:59.999Z').priceGrosze, 6000)
    const later = at('2026-11-15T23:00:00.000Z')
    assert.equal(later.priceGrosze, 7000)
    assert.deepEqual(later.nextPrice, { grosze: 8000, from: '2026-11-26' })
    assert.equal(at('2026-11-30T12:00:00Z').nextPrice, null)
  })

  it('staged extras replace the live ones, with stock as what is left after the live sales', () => {
    const raw = { ...RA1, extras: [{ id: 'x1', name: 'Koszulka', imagePath: 'e1/extra/k.jpg', price: 4500, orderUntil: '2026-11-25', categoryIds: [], variants: [{ id: 'v1', label: 'M', left: 3 }] }] }
    const merged = mergePending(raw, {
      payload: { extras: { items: [
        { id: 'x1', name: 'Koszulka', image_upload_id: 'u1', price: 4500, order_until: '2026-11-25', category_ids: [],
          variants: [{ id: 'v1', label: 'M', stock: 10 }, { id: null, label: 'XL', stock: 5 }] },
        { id: null, name: 'Czapka', description: 'Na cel zbiórki.', image_upload_id: null, price: 3000, order_until: '2026-12-01', category_ids: ['c1'], variants: [{ id: null, label: 'Uni', stock: 100000 }] },
      ] } },
      uploads: { u1: { path: 'e1/extra/nowa.jpg', meta: {} } },
      sold: { v1: 7 },
    })
    assert.deepEqual(merged.extras, [
      { id: 'x1', name: 'Koszulka', description: null, imagePath: 'e1/extra/nowa.jpg', price: 4500, orderUntil: '2026-11-25', categoryIds: [],
        variants: [{ id: 'v1', label: 'M', left: 3 }, { id: null, label: 'XL', left: 5 }] },
      { id: null, name: 'Czapka', description: 'Na cel zbiórki.', imagePath: null, price: 3000, orderUntil: '2026-12-01', categoryIds: ['c1'],
        variants: [{ id: null, label: 'Uni', left: 100000 }] },
    ])
    assert.equal(raw.extras[0].variants.length, 1, 'input untouched')
  })
})

describe('W-72 W-73 description and cause page', () => {
  it('the description is passed through as text; the cause page only on a charity event', () => {
    const m = model({ ...RA1, description: 'Opis.\nDruga linia.', charityUrl: 'https://example.org/zuzia' })
    assert.equal(m.description, 'Opis.\nDruga linia.')
    assert.equal(m.charityUrl, 'https://example.org/zuzia')
    const plain = model({ ...RA1, isCharity: false, description: null, charityUrl: 'https://example.org/zuzia' })
    assert.equal(plain.description, null)
    assert.equal(plain.charityUrl, null)
    assert.equal(model(RA1).description, null)
  })
  it('a cause page that is not http(s) is never a link', () => {
    assert.equal(model({ ...RA1, charityUrl: 'javascript:alert(1)' }).charityUrl, null)
  })
  it('mergePending shows a staged description and cause page in the preview', () => {
    const out = mergePending(RA1, { payload: { basics: { description: 'Nowy opis', charity_url: 'https://example.org/c' } } })
    assert.equal(out.description, 'Nowy opis')
    assert.equal(out.charityUrl, 'https://example.org/c')
  })
})

describe('W-77 event page („Więcej informacji”)', () => {
  it('an http(s) address is passed through on any event; anything else is never a link', () => {
    assert.equal(model({ ...RA1, isCharity: false, websiteUrl: 'https://example.org/bieg' }).websiteUrl, 'https://example.org/bieg')
    assert.equal(model(RA1).websiteUrl, null)
    assert.equal(model({ ...RA1, websiteUrl: 'javascript:alert(1)' }).websiteUrl, null)
  })
  it('mergePending shows a staged event page in the preview', () => {
    assert.equal(mergePending(RA1, { payload: { basics: { website_url: 'https://example.org/b' } } }).websiteUrl, 'https://example.org/b')
  })
})

describe('the poster on the event page', () => {
  it('is the uploaded poster’s public URL, and nothing when there is none', () => {
    assert.equal(model(RA1).posterUrl, fileUrl('e1/poster/p.jpg'))
    assert.equal(model({ ...RA1, posterPath: null }).posterUrl, null)
  })
  it('never anything but an http(s) address', () => {
    assert.equal(eventPageModel({ ...RA1, posterUrl: 'javascript:alert(1)' }, NOW).posterUrl, null)
  })
})

describe('previewRaw (Podgląd jako zawodnik)', () => {
  it('gives the preview the file URLs the public page gets: regulamin PDF and poster', () => {
    const raw = previewRaw(RA1, null, BASE)
    assert.equal(raw.regulamin.url, fileUrl('e1/regulamin/r.pdf'))
    assert.equal(raw.posterUrl, fileUrl('e1/poster/p.jpg'))
    assert.equal(eventPageModel(raw, NOW).regulaminUrl, fileUrl('e1/regulamin/r.pdf'))
  })
  it('lays staged changes over the live raw before the URLs are made', () => {
    const pending = { payload: { basics: { poster_upload_id: 'u9' } }, uploads: { u9: { path: 'e1/poster/new.jpg', meta: {} } } }
    assert.equal(previewRaw(RA1, pending, BASE).posterUrl, fileUrl('e1/poster/new.jpg'))
  })
})

describe('W-78 the share of the income for the cause', () => {
  it('is shown only on a charity event, and only a whole number', () => {
    assert.equal(model({ ...RA1, charityPercent: 100 }).charityPercent, 100)
    assert.equal(model(RA1).charityPercent, null)
    assert.equal(model({ ...RA1, isCharity: false, charityPercent: 100 }).charityPercent, null)
    assert.equal(model({ ...RA1, charityPercent: '50' }).charityPercent, null)
  })
  it('a staged change shows in the preview', () => {
    const merged = mergePending(RA1, { payload: { basics: { charity_percent: 50 } } })
    assert.equal(merged.charityPercent, 50)
  })
})
