// Plan 2, task 3: creating a registration event and autosaving its draft
// sections (W-09…W-11 in docs/registration/scenario-matrix.md). LOCAL stack
// only. Names carry a random suffix and no test asserts a bare global slug, so
// a rerun on a stack that already holds earlier events still passes.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { admin, sessionFor } from './helpers/stack.js'
import { acceptAgreement, makeClub, callFn } from './helpers/registrationFixtures.js'
import { slugify } from '../../supabase/functions/_shared/registration/slug.js'

const ZT = '00000000-0000-4000-8000-0000000000c1' // enabled
const IK = '00000000-0000-4000-8000-0000000000c2' // disabled

const rand = () => crypto.randomBytes(4).toString('hex')
const db = () => admin()

let owner, zAdmin, member, ikOwner, ikAdmin, ikMember
before(async () => {
  await acceptAgreement('zatyrani-test')
  ;[owner, zAdmin, member, ikOwner, ikAdmin, ikMember] = await Promise.all([
    'owner@zatyrani-test.local', 'admin@zatyrani-test.local', 'member@zatyrani-test.local',
    'owner@inny-klub.local', 'admin@inny-klub.local', 'member@inny-klub.local',
  ].map(sessionFor))
})

async function createEvent(session = owner, name = `Bieg Leszego ${rand()}`, clubId = ZT) {
  const r = await callFn('create-registration-event', session, { clubId, name })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  return { eventId: r.body.data.eventId, name }
}

async function settingsOf(eventId) {
  const { data, error } = await db().from('registration_settings').select('*').eq('event_id', eventId).single()
  if (error) throw error
  return data
}

const comp = (over = {}) => ({
  name: 'Bieg 9 km', kind: 'individual', discipline: 'run', distanceLabel: '9 km', startTime: '10:00',
  capacity: 50, minAge: 16, maxAge: null, isKids: false, timed: true, ...over,
})

async function saveCompetitions(eventId, items, session = owner, pricingMode = 'free') {
  return callFn('save-registration-section', session, { eventId, section: 'competitions', value: { pricingMode, items } })
}

async function competitionsOf(eventId) {
  const { data, error } = await db().from('competitions').select('*').eq('event_id', eventId).order('sort_order')
  if (error) throw error
  return data
}

// ---------------------------------------------------------------- W-09 create

test('W-09 owner creates an event: slug from the name, a second create gets -2', async () => {
  const name = `Bieg Leszego ${rand()}`
  const base = slugify(name)
  const a = await createEvent(owner, name)
  const b = await createEvent(owner, name)
  assert.equal((await settingsOf(a.eventId)).slug, base)
  assert.equal((await settingsOf(b.eventId)).slug, `${base}-2`)
  assert.match((await settingsOf(a.eventId)).slug, new RegExp(`^${base}(-\\d+)?$`))
})

test('W-09 two creates with the same name fired concurrently both succeed with distinct slugs', async () => {
  const name = `Bieg Leszego ${rand()}`
  const [r1, r2] = await Promise.all([
    callFn('create-registration-event', owner, { clubId: ZT, name }),
    callFn('create-registration-event', zAdmin, { clubId: ZT, name }),
  ])
  assert.equal(r1.status, 201, JSON.stringify(r1.body))
  assert.equal(r2.status, 201, JSON.stringify(r2.body))
  const s1 = await settingsOf(r1.body.data.eventId)
  const s2 = await settingsOf(r2.body.data.eventId)
  assert.notEqual(s1.slug, s2.slug)
  for (const s of [s1, s2]) assert.match(s.slug, new RegExp(`^${slugify(name)}(-\\d+)?$`))
})

test('W-09 the draft events row carries placeholders and the timing defaults', async () => {
  const { eventId, name } = await createEvent()
  const { data: ev, error } = await db().from('events')
    .select('name, slug, visibility, club_id, rssi_threshold, min_finish_seconds, date').eq('id', eventId).single()
  if (error) throw error
  assert.equal(ev.name, 'Szkic')
  assert.equal(ev.slug, `szkic-${eventId}`)
  assert.equal(ev.visibility, 'private')
  assert.equal(ev.club_id, ZT)
  assert.equal(ev.rssi_threshold, -9000)
  assert.equal(ev.min_finish_seconds, 300)
  assert.equal(ev.date, null)
  const s = await settingsOf(eventId)
  assert.equal(s.name, name)
  assert.equal(s.club_id, ZT)
  assert.equal(s.state, 'draft')
})

const IMAGE_TEXT = 'Akceptuję, że mój wizerunek utrwalony podczas zawodów (zdjęcia, wideo) może zostać opublikowany w relacjach i wynikach zawodów, zgodnie z regulaminem.'

test('W-09 W-66 three system acceptances (regulamin, data information, image) and an event_created action', async () => {
  const { eventId } = await createEvent()
  const { data: consents } = await db().from('event_consents').select('kind, text, sort_order').eq('event_id', eventId)
  const rank = { regulamin: 0, data_info: 1, image: 2 }
  consents.sort((a, b) => rank[a.kind] - rank[b.kind])
  assert.deepEqual(consents.map((c) => [c.kind, c.text]), [
    ['regulamin', 'Akceptuję regulamin zawodów.'],
    ['data_info', 'Znam informację o danych osobowych.'],
    ['image', IMAGE_TEXT],
  ])
  const { data: acts } = await db().from('organizer_actions').select('actor_id, club_id, action')
    .eq('event_id', eventId)
  assert.deepEqual(acts, [{ actor_id: owner.profileId, club_id: ZT, action: 'event_created' }])
})

test('W-09 create: non-member 403, member 403, disabled club 404, empty name 422', async () => {
  assert.equal((await callFn('create-registration-event', ikMember, { clubId: ZT, name: 'X Bieg' })).status, 403)
  assert.equal((await callFn('create-registration-event', member, { clubId: ZT, name: 'X Bieg' })).status, 403)
  assert.equal((await callFn('create-registration-event', ikOwner, { clubId: IK, name: 'X Bieg' })).status, 404)
  const r = await callFn('create-registration-event', owner, { clubId: ZT, name: '   ' })
  assert.equal(r.status, 422)
  assert.ok(r.body.fields.name)
  assert.equal((await callFn('create-registration-event', null, { clubId: ZT, name: 'X' })).status, 401)
})

test('W-09 a name with no usable letters still gets a valid slug', async () => {
  const { eventId } = await createEvent(owner, `Ø ${rand().slice(0, 1)}`)
  const s = await settingsOf(eventId)
  assert.match(s.slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  assert.ok(s.slug.length >= 3)
})

test('W-09 the SQL slug matches slugify() from the shared module', async () => {
  const names = ['Charytatywny Bieg Łęgowego 2026!', 'Żółć Ąć Ęń Śó Źł', '  --Bieg--  ', 'Ångström Café', 'a'.repeat(79) + ' bbb']
  for (const n of names) {
    const { data, error } = await db().rpc('registration_slugify', { p_text: n })
    if (error) throw error
    assert.equal(data, slugify(n), n)
  }
})

test('W-09 saving basics with another event\'s slug → 422 Ten adres jest już zajęty.', async () => {
  const a = await createEvent()
  const b = await createEvent()
  const taken = (await settingsOf(a.eventId)).slug
  const r = await callFn('save-registration-section', owner, { eventId: b.eventId, section: 'basics', value: { slug: taken } })
  assert.equal(r.status, 422)
  assert.equal(r.body.error, 'Ten adres jest już zajęty.')
  assert.equal(r.body.fields.slug, 'Ten adres jest już zajęty.')
  // an events.slug (a timing event without registration) is taken too
  const r2 = await callFn('save-registration-section', owner, { eventId: b.eventId, section: 'basics', value: { slug: `szkic-${a.eventId}` } })
  assert.equal(r2.status, 422)
  assert.notEqual((await settingsOf(b.eventId)).slug, taken)
})

// ---------------------------------------------------------------- W-10 save

test('W-10 admin saves basics while owner saves competitions: both persist', async () => {
  const { eventId } = await createEvent()
  const slug = `bieg-${rand()}`
  const [r1, r2] = await Promise.all([
    callFn('save-registration-section', zAdmin, { eventId, section: 'basics', value: {
      slug, eventDate: '2026-12-06', firstStartTime: '10:00', opensOn: '2026-11-01', closesOn: '2026-12-01',
      townLabel: 'Nieborowice', townArea: 'GM. PILCHOWICE · ŚLĄSKIE', lat: 50.2381, lng: 18.5412,
    } }),
    saveCompetitions(eventId, [comp(), comp({ name: 'Bieg 3 km', distanceLabel: '3 km', capacity: 40 })]),
  ])
  assert.equal(r1.status, 200, JSON.stringify(r1.body))
  assert.equal(r2.status, 200, JSON.stringify(r2.body))
  assert.ok(r1.body.data.savedAt)
  assert.equal(r2.body.data.categoryIds.length, 2)
  const s = await settingsOf(eventId)
  assert.equal(s.slug, slug)
  assert.equal(s.event_date, '2026-12-06')
  assert.equal(new Date(s.opens_at).toISOString(), '2026-10-31T23:00:00.000Z')
  assert.equal(new Date(s.closes_at).toISOString(), '2026-12-01T23:00:00.000Z')
  assert.equal(Number(s.lat), 50.2381)
  assert.equal((await competitionsOf(eventId)).length, 2)
  const { data: acts } = await db().from('organizer_actions').select('action, payload, actor_id')
    .eq('event_id', eventId).eq('action', 'section_saved')
  assert.equal(acts.length, 2)
  assert.deepEqual(acts.map((a) => a.payload.section).sort(), ['basics', 'competitions'])
  for (const a of acts) assert.deepEqual(Object.keys(a.payload), ['section'])
})

test('W-10 member write 403 but read 200; inny-klub admin 404; invalid section 422', async () => {
  const { eventId } = await createEvent()
  const w = await callFn('save-registration-section', member, { eventId, section: 'timing', value: { timingMode: 'none' } })
  assert.equal(w.status, 403)
  const r = await callFn('get-registration-event', member, { eventId })
  assert.equal(r.status, 200)
  assert.equal(r.body.data.role, 'member')
  assert.equal((await callFn('save-registration-section', ikAdmin, { eventId, section: 'timing', value: { timingMode: 'none' } })).status, 404)
  assert.equal((await callFn('get-registration-event', ikAdmin, { eventId })).status, 404)
  assert.equal((await callFn('get-registration-event', owner, { eventId: crypto.randomUUID() })).status, 404)
  assert.equal((await callFn('get-registration-event', owner, { eventId: 'nope' })).status, 404)
  const bad = await callFn('save-registration-section', owner, { eventId, section: 'timing', value: { taken: 3 } })
  assert.equal(bad.status, 422)
  assert.ok(bad.body.fields.taken)
  assert.equal((await callFn('save-registration-section', owner, { eventId, section: 'payments', value: {} })).status, 422)
})

test('W-10 the admin of another enabled club with an agreement gets 404 on this event', async () => {
  const other = await makeClub({ slug: `p2-${rand()}` })
  const otherAdmin = await sessionFor(other.adminEmail)
  const { eventId } = await createEvent()
  assert.equal((await callFn('get-registration-event', otherAdmin, { eventId })).status, 404)
  assert.equal((await callFn('save-registration-section', otherAdmin, { eventId, section: 'timing', value: { timingMode: 'none' } })).status, 404)
})

test('W-10 the owner of a club without the current agreement → 409 agreement_required', async () => {
  const club = await makeClub({ slug: `p2-${rand()}`, agreement: false })
  const o = await sessionFor(club.ownerEmail)
  const r = await callFn('create-registration-event', o, { clubId: club.clubId, name: 'Bieg bez umowy' })
  assert.equal(r.status, 409)
  assert.equal(r.body.code, 'agreement_required')
  assert.equal(r.body.error, 'Brak akceptacji umowy organizatora.')
  const l = await callFn('list-club-registration-events', o, { clubId: club.clubId })
  assert.equal(l.status, 409)
  assert.equal(l.body.code, 'agreement_required')
})

test('W-10 an event of a club that was disabled answers 404 to its own owner', async () => {
  const slug = `p2-${rand()}`
  const club = await makeClub({ slug })
  const o = await sessionFor(club.ownerEmail)
  const { eventId } = await createEvent(o, `Bieg ${rand()}`, club.clubId)
  assert.equal((await callFn('get-registration-event', o, { eventId })).status, 200)
  await makeClub({ slug, enabled: false })
  assert.equal((await callFn('get-registration-event', o, { eventId })).status, 404)
  assert.equal((await callFn('save-registration-section', o, { eventId, section: 'timing', value: { timingMode: 'none' } })).status, 404)
  assert.equal((await callFn('list-club-registration-events', o, { clubId: club.clubId })).status, 404)
})

test('W-10 list-club-registration-events: members see the club\'s events with counts', async () => {
  const { eventId, name } = await createEvent()
  await saveCompetitions(eventId, [comp({ capacity: 30 }), comp({ name: 'Bieg 3 km', capacity: 20 })])
  const r = await callFn('list-club-registration-events', member, { clubId: ZT })
  assert.equal(r.status, 200)
  const row = r.body.data.find((e) => e.eventId === eventId)
  assert.deepEqual(row, { eventId, name, state: 'draft', eventDate: null, taken: 0, capacity: 50, hasPending: false })
  assert.equal((await callFn('list-club-registration-events', ikMember, { clubId: ZT })).status, 403)
})

test('W-10 get-registration-event returns the editor payload', async () => {
  const { eventId, name } = await createEvent()
  await saveCompetitions(eventId, [comp({ price: '60' })], owner, 'fixed')
  await callFn('save-registration-section', owner, { eventId, section: 'office', value: {
    sameAsEvent: false, address: 'SP, ul. Szkolna 4', hours: [{ date: '2026-12-05', from: '17:00', to: '19:00' }],
  } })
  const r = await callFn('get-registration-event', owner, { eventId })
  assert.equal(r.status, 200)
  const d = r.body.data
  assert.equal(d.role, 'owner')
  assert.equal(d.settings.name, name)
  assert.equal(d.settings.state, 'draft')
  assert.equal(d.settings.pricingMode, 'fixed')
  assert.equal(d.settings.officeAddress, 'SP, ul. Szkolna 4')
  assert.equal(d.competitions.length, 1)
  assert.equal(d.competitions[0].name, 'Bieg 9 km')
  assert.equal(d.competitions[0].priceGrosze, 6000)
  assert.equal(d.competitions[0].taken, 0)
  assert.deepEqual(d.officeHours.map((h) => [h.date, h.from, h.to]), [['2026-12-05', '17:00', '19:00']])
  assert.equal(d.consents.length, 3)
  assert.deepEqual(d.ageGroups, [])
  assert.deepEqual(d.kidsGroups, [])
  assert.deepEqual(d.uploads, [])
  assert.equal(d.pending, null)
  assert.equal(d.registeredCount, 0)
})

// ---------------------------------------------------------------- W-11 competitions

test('W-11 a draft competition gets placeholder category name and slug, untimed follows timed', async () => {
  const { eventId } = await createEvent()
  const r = await saveCompetitions(eventId, [comp(), comp({ name: 'Bieg dzieci', isKids: true, timed: false, minAge: 0, maxAge: 15 })])
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const ids = r.body.data.categoryIds
  const { data: cats } = await db().from('categories').select('id, name, slug, untimed').in('id', ids)
  for (const c of cats) {
    assert.match(c.name, /^Szkic \d+$/)
    assert.equal(c.slug, `szkic-${c.id}`)
    assert.notEqual(c.name, 'Bieg 9 km')
  }
  assert.equal(cats.find((c) => c.id === ids[0]).untimed, false)
  assert.equal(cats.find((c) => c.id === ids[1]).untimed, true)
  const comps = await competitionsOf(eventId)
  assert.deepEqual(comps.map((c) => c.name), ['Bieg 9 km', 'Bieg dzieci'])
})

test('W-11 saving again with the returned ids updates in place', async () => {
  const { eventId } = await createEvent()
  const first = await saveCompetitions(eventId, [comp()])
  const [id] = first.body.data.categoryIds
  const second = await saveCompetitions(eventId, [comp({ categoryId: id, capacity: 99, name: 'Bieg 10 km' })])
  assert.equal(second.status, 200)
  assert.deepEqual(second.body.data.categoryIds, [id])
  const comps = await competitionsOf(eventId)
  assert.equal(comps.length, 1)
  assert.equal(comps[0].capacity, 99)
  assert.equal(comps[0].name, 'Bieg 10 km')
})

test('W-11 another event\'s categoryId → 422 and nothing changes', async () => {
  const a = await createEvent()
  const b = await createEvent()
  const ra = await saveCompetitions(a.eventId, [comp()])
  const rb = await saveCompetitions(b.eventId, [comp({ name: 'B' })])
  const before = { a: await competitionsOf(a.eventId), b: await competitionsOf(b.eventId) }
  const r = await saveCompetitions(b.eventId, [
    comp({ categoryId: rb.body.data.categoryIds[0], name: 'B zmieniona' }),
    comp({ categoryId: ra.body.data.categoryIds[0], name: 'przejęta' }),
  ])
  assert.equal(r.status, 422)
  assert.deepEqual(await competitionsOf(a.eventId), before.a)
  assert.deepEqual(await competitionsOf(b.eventId), before.b)
})

test('W-11 another event\'s upload id → 422', async () => {
  const a = await createEvent()
  const b = await createEvent()
  const { data: up, error } = await db().from('registration_uploads')
    .insert({ event_id: a.eventId, kind: 'gpx', path: `${a.eventId}/gpx/x.gpx` }).select('id').single()
  if (error) throw error
  const r = await saveCompetitions(b.eventId, [comp({ gpxUploadId: up.id })])
  assert.equal(r.status, 422)
  const r2 = await callFn('save-registration-section', owner, { eventId: b.eventId, section: 'basics', value: { posterUploadId: up.id } })
  assert.equal(r2.status, 422)
  assert.equal((await competitionsOf(b.eventId)).length, 0)
  // the right kind on the right event is accepted
  const ok = await saveCompetitions(a.eventId, [comp({ gpxUploadId: up.id })])
  assert.equal(ok.status, 200)
})

test('W-11 removing a competition in draft deletes its category and competition rows', async () => {
  const { eventId } = await createEvent()
  const r = await saveCompetitions(eventId, [comp({ price: '50' }), comp({ name: 'Bieg 3 km', price: '30' })], owner, 'fixed')
  const [keep, drop] = r.body.data.categoryIds
  await callFn('save-registration-section', owner, { eventId, section: 'categories', value: {
    ageGroups: [{ categoryId: drop, gender: 'K', label: 'K30–39', minAge: 30, maxAge: 39 }],
  } })
  const r2 = await saveCompetitions(eventId, [comp({ categoryId: keep, price: '50' })], owner, 'fixed')
  assert.equal(r2.status, 200, JSON.stringify(r2.body))
  assert.deepEqual((await competitionsOf(eventId)).map((c) => c.category_id), [keep])
  const { data: cats } = await db().from('categories').select('id').eq('event_id', eventId)
  assert.deepEqual(cats.map((c) => c.id), [keep])
  const { data: ag } = await db().from('age_groups').select('id').eq('category_id', drop)
  assert.equal(ag.length, 0)
  const { data: prices } = await db().from('competition_prices').select('category_id, amount')
  assert.equal(prices.filter((p) => p.category_id === drop).length, 0)
  assert.equal(prices.find((p) => p.category_id === keep).amount, 5000)
})

test('W-11 a competition with taken > 0 cannot be removed: 409 competition_locked', async () => {
  const { eventId } = await createEvent()
  const r = await saveCompetitions(eventId, [comp(), comp({ name: 'Bieg 3 km' })])
  const [keep, drop] = r.body.data.categoryIds
  await db().from('competitions').update({ taken: 1 }).eq('category_id', drop)
  const r2 = await saveCompetitions(eventId, [comp({ categoryId: keep })])
  assert.equal(r2.status, 409)
  assert.equal(r2.body.code, 'competition_locked')
  assert.equal((await competitionsOf(eventId)).length, 2)
})

test('W-11 fixed pricing keeps one open-ended tier; free removes prices and tiers', async () => {
  const { eventId } = await createEvent()
  const r = await saveCompetitions(eventId, [comp({ price: '60,50' })], owner, 'fixed')
  const [id] = r.body.data.categoryIds
  await saveCompetitions(eventId, [comp({ categoryId: id, price: '70' })], owner, 'fixed')
  const { data: tiers } = await db().from('price_tiers').select('id, ends_on').eq('event_id', eventId)
  assert.equal(tiers.length, 1)
  assert.equal(tiers[0].ends_on, null)
  const { data: prices } = await db().from('competition_prices').select('amount').eq('category_id', id)
  assert.deepEqual(prices, [{ amount: 7000 }])
  assert.equal((await settingsOf(eventId)).pricing_mode, 'fixed')
  const fixedNoPrice = await saveCompetitions(eventId, [comp({ categoryId: id })], owner, 'fixed')
  assert.equal(fixedNoPrice.status, 422)
  await saveCompetitions(eventId, [comp({ categoryId: id })])
  assert.equal((await db().from('price_tiers').select('id').eq('event_id', eventId)).data.length, 0)
  assert.equal((await db().from('competition_prices').select('amount').eq('category_id', id)).data.length, 0)
  assert.equal((await settingsOf(eventId)).pricing_mode, 'free')
})

test('W-11 office hours are Warsaw local times; timing and form sections save', async () => {
  const { eventId } = await createEvent()
  const o = await callFn('save-registration-section', owner, { eventId, section: 'office', value: {
    sameAsEvent: false, address: 'SP', lat: 50.24, lng: 18.53,
    hours: [{ date: '2026-12-05', from: '17:00', to: '19:00' }, { date: '2026-07-01', from: '08:00', to: '09:30' }],
  } })
  assert.equal(o.status, 200, JSON.stringify(o.body))
  const { data: hours } = await db().from('office_hours').select('starts_at, ends_at').eq('event_id', eventId).order('starts_at')
  assert.deepEqual(hours.map((h) => new Date(h.starts_at).toISOString()), ['2026-07-01T06:00:00.000Z', '2026-12-05T16:00:00.000Z'])
  await callFn('save-registration-section', owner, { eventId, section: 'office', value: { hours: [] } })
  assert.equal((await db().from('office_hours').select('id').eq('event_id', eventId)).data.length, 0)

  const t = await callFn('save-registration-section', owner, { eventId, section: 'timing', value: { timingMode: 'external', timingCompany: 'Time-Sport' } })
  assert.equal(t.status, 200)
  const f = await callFn('save-registration-section', owner, { eventId, section: 'form', value: {
    formFields: { phone: 'required', city: 'optional', club: 'off', ice: 'optional', nationality: 'required' },
    consents: [{ text: 'Startuję na własną odpowiedzialność.' }],
  } })
  assert.equal(f.status, 200, JSON.stringify(f.body))
  const s = await settingsOf(eventId)
  assert.equal(s.timing_mode, 'external')
  assert.deepEqual(s.form_fields, { city: 'optional', club: 'off', ice: 'optional', nationality: 'required' }, 'phone is never stored (P2-R32)')
  const { data: consents } = await db().from('event_consents').select('id, kind').eq('event_id', eventId)
  assert.equal(consents.length, 4)
  // dropping the custom consent keeps the three system acceptances
  await callFn('save-registration-section', owner, { eventId, section: 'form', value: { consents: [] } })
  const { data: after } = await db().from('event_consents').select('kind').eq('event_id', eventId)
  assert.deepEqual(after.map((c) => c.kind).sort(), ['data_info', 'image', 'regulamin'])
})

test('W-64 a new event asks for no nationality: form_fields defaults to nationality off', async () => {
  const { eventId } = await createEvent()
  const s = await settingsOf(eventId)
  assert.equal(s.form_fields.nationality, 'off')
  assert.equal('phone' in s.form_fields, false)
})

test('W-66 the organizer can neither delete nor retype the image acceptance (P2-R33)', async () => {
  const { eventId } = await createEvent()
  const { data: [image] } = await db().from('event_consents').select('id, text').eq('event_id', eventId).eq('kind', 'image')
  assert.equal(image.text, IMAGE_TEXT)

  const emptied = await callFn('save-registration-section', owner, { eventId, section: 'form', value: { consents: [] } })
  assert.equal(emptied.status, 200, JSON.stringify(emptied.body))
  const retyped = await callFn('save-registration-section', owner, { eventId, section: 'form', value: {
    consents: [{ id: image.id, text: 'Zgadzam się na wszystko.' }],
  } })
  assert.equal(retyped.status, 422, JSON.stringify(retyped.body))

  const { data: still } = await db().from('event_consents').select('id, kind, text').eq('event_id', eventId).eq('kind', 'image')
  assert.deepEqual(still, [{ id: image.id, kind: 'image', text: IMAGE_TEXT }])

  const second = await db().from('event_consents').insert({ event_id: eventId, kind: 'image', text: 'Druga.' })
  assert.equal(second.error?.code, '23505', 'one image acceptance per event')
})

test('W-66 W-71 the form-rulings backfill gives an older event its image acceptance and the new form_fields shape, once', async () => {
  const { eventId } = await createEvent()
  // An event as it looked before 20261030000000: no image row, a phone key, no nationality key.
  const del = await db().from('event_consents').delete().eq('event_id', eventId).eq('kind', 'image')
  assert.equal(del.error, null)
  const old = await db().from('registration_settings')
    .update({ form_fields: { phone: 'optional', city: 'required', club: 'off', ice: 'optional' } }).eq('event_id', eventId)
  assert.equal(old.error, null)
  // A form that already chose a nationality mode keeps it.
  const { eventId: chosen } = await createEvent()
  await db().from('registration_settings')
    .update({ form_fields: { phone: 'off', city: 'optional', club: 'optional', ice: 'off', nationality: 'required' } }).eq('event_id', chosen)

  const run = await db().rpc('registration_backfill_form_rulings')
  assert.equal(run.error, null, run.error?.message)
  assert.ok(run.data.images >= 1 && run.data.formFields >= 2, JSON.stringify(run.data))

  const { data: images } = await db().from('event_consents').select('kind, text, sort_order').eq('event_id', eventId).eq('kind', 'image')
  assert.deepEqual(images, [{ kind: 'image', text: IMAGE_TEXT, sort_order: 1 }])
  assert.deepEqual((await settingsOf(eventId)).form_fields, { city: 'required', club: 'off', ice: 'optional', nationality: 'off' })
  assert.deepEqual((await settingsOf(chosen)).form_fields, { city: 'optional', club: 'optional', ice: 'off', nationality: 'required' })

  const again = await db().rpc('registration_backfill_form_rulings')
  assert.deepEqual(again.data, { images: 0, formFields: 0 })
  const { count } = await db().from('event_consents').select('id', { count: 'exact', head: true }).eq('event_id', eventId).eq('kind', 'image')
  assert.equal(count, 1)
})

test('W-71 the backfill is not callable by clients', async () => {
  const { localEnv } = await import('./helpers/stack.js')
  const { createClient } = await import('@supabase/supabase-js')
  const anon = createClient(localEnv().url, localEnv().anonKey)
  const r = await anon.rpc('registration_backfill_form_rulings')
  assert.equal(r.error?.code, '42501', JSON.stringify(r.error))
  assert.match(r.error.message, /permission denied for function registration_backfill_form_rulings/)
})

test('W-11 a closed event refuses saves with 409 not_draft (a published one stages them, W-21)', async () => {
  const { eventId } = await createEvent()
  await db().from('registration_settings').update({ state: 'closed' }).eq('event_id', eventId)
  const r = await callFn('save-registration-section', owner, { eventId, section: 'office', value: { notes: 'x' } })
  assert.equal(r.status, 409)
  assert.equal(r.body.code, 'not_draft')
})

test('W-11 every section save moves registration_settings.updated_at (the wizard\'s „ZAPISANO” time after a reload)', async () => {
  const { eventId } = await createEvent()
  const values = {
    basics: { placeDetails: 'Boisko' },
    office: { notes: 'Uwagi' },
    competitions: { pricingMode: 'free', items: [comp()] },
    // These two only touch child tables: nothing else would move the settings row.
    categories: { ageGroups: [], kidsGroups: [] },
    timing: { timingCompany: 'Pomiar' },
    form: { consents: [] },
  }
  for (const [section, value] of Object.entries(values)) {
    const before = (await settingsOf(eventId)).updated_at
    await new Promise((r) => setTimeout(r, 15))
    const r = await callFn('save-registration-section', owner, { eventId, section, value })
    assert.equal(r.status, 200, `${section}: ${JSON.stringify(r.body)}`)
    const after = (await settingsOf(eventId)).updated_at
    assert.ok(Date.parse(after) > Date.parse(before), `${section}: ${before} → ${after}`)
  }
})
