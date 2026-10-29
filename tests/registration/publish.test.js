// Plan 2, task 5: publishing a registration event (W-14…W-16 in
// docs/registration/scenario-matrix.md). LOCAL stack only. Every event gets a
// random name, so reruns on a stack holding earlier events still pass.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { admin, authenticatedClient, sessionFor } from './helpers/stack.js'
import { acceptAgreement, makeClub, callFn, createPublishedFreeEvent } from './helpers/registrationFixtures.js'
import { slugify } from '../../supabase/functions/_shared/registration/slug.js'

const ZT = '00000000-0000-4000-8000-0000000000c1'

const rand = () => crypto.randomBytes(4).toString('hex')
const db = () => admin()

let owner, zAdmin, member, outsider
before(async () => {
  await acceptAgreement('zatyrani-test')
  ;[owner, zAdmin, member, outsider] = await Promise.all([
    'owner@zatyrani-test.local', 'admin@zatyrani-test.local', 'member@zatyrani-test.local', 'owner@inny-klub.local',
  ].map(sessionFor))
})

const comp = (over = {}) => ({
  name: 'Bieg 9 km', kind: 'individual', discipline: 'run', distanceLabel: '9 km', startTime: '10:00',
  capacity: 50, minAge: 16, maxAge: null, isKids: false, timed: true, ...over,
})

async function createEvent(session = owner, clubId = ZT, name = `Bieg Leszego ${rand()}`) {
  const r = await callFn('create-registration-event', session, { clubId, name })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  return { eventId: r.body.data.eventId, name }
}

async function save(eventId, section, value, session = owner) {
  const r = await callFn('save-registration-section', session, { eventId, section, value })
  assert.equal(r.status, 200, `${section}: ${JSON.stringify(r.body)}`)
  return r.body.data
}

// Every blocking item filled.
async function completeEvent({ session = owner, clubId = ZT, items = [comp()] } = {}) {
  const ev = await createEvent(session, clubId)
  await save(ev.eventId, 'basics', {
    eventDate: '2027-03-14', opensOn: '2027-01-10', closesOn: '2027-03-12',
    townLabel: 'Nieborowice', townArea: 'GM. PILCHOWICE · ŚLĄSKIE', lat: 50.2381, lng: 18.5412,
    regulaminKind: 'link', regulaminUrl: 'https://example.org/regulamin.pdf', contactEmail: 'zapisy@klub.example',
  }, session)
  const { categoryIds } = await save(ev.eventId, 'competitions', { pricingMode: 'free', items }, session)
  return { ...ev, categoryIds }
}

const publish = (eventId, session = owner) => callFn('publish-registration-event', session, { eventId, action: 'publish' })

async function settingsOf(eventId) {
  const { data, error } = await db().from('registration_settings').select('*').eq('event_id', eventId).single()
  if (error) throw error
  return data
}

async function calendarRows(eventId) {
  const { data, error } = await db().from('calendar_events').select('*').eq('source', 'leszyrun').eq('source_id', eventId)
  if (error) throw error
  return data
}

// ---------------------------------------------------------------- W-14 blocked

test('W-14 publishing an incomplete draft → 409 listing what is missing; nothing changes', async () => {
  const { eventId } = await createEvent()
  const r = await publish(eventId)
  assert.equal(r.status, 409, JSON.stringify(r.body))
  const keys = r.body.blocking.map((b) => b.key)
  for (const k of ['event_date', 'registration_dates', 'place', 'competitions', 'regulamin']) assert.ok(keys.includes(k), k)
  assert.ok(!keys.includes('name') && !keys.includes('slug') && !keys.includes('agreement'), keys.join())
  assert.match(r.body.error, /^Uzupełnij: /)
  assert.ok(r.body.error.includes('Data zawodów'))

  assert.equal((await settingsOf(eventId)).state, 'draft')
  const { data: ev } = await db().from('events').select('name, visibility').eq('id', eventId).single()
  assert.deepEqual(ev, { name: 'Szkic', visibility: 'private' })
  assert.equal((await calendarRows(eventId)).length, 0)
})

test('W-69 a draft complete but for the regulamin and the contact address → 409 naming both; each one filled in lifts its item', async () => {
  const ev = await createEvent()
  await save(ev.eventId, 'basics', {
    eventDate: '2027-03-14', opensOn: '2027-01-10', closesOn: '2027-03-12',
    townLabel: 'Nieborowice', townArea: 'GM. PILCHOWICE · ŚLĄSKIE', lat: 50.2381, lng: 18.5412,
  })
  await save(ev.eventId, 'competitions', { pricingMode: 'free', items: [comp()] })
  let r = await publish(ev.eventId)
  assert.equal(r.status, 409, JSON.stringify(r.body))
  assert.deepEqual(r.body.blocking.map((b) => b.key), ['regulamin', 'contact_email'])
  assert.equal(r.body.error, 'Uzupełnij: Regulamin (PDF albo link), Adres kontaktowy organizatora')

  await save(ev.eventId, 'basics', { regulaminKind: 'link', regulaminUrl: 'https://example.org/regulamin.pdf' })
  r = await publish(ev.eventId)
  assert.equal(r.status, 409, JSON.stringify(r.body))
  assert.deepEqual(r.body.blocking.map((b) => b.key), ['contact_email'])
  assert.equal((await settingsOf(ev.eventId)).state, 'draft')

  await save(ev.eventId, 'basics', { contactEmail: 'zapisy@klub.example' })
  r = await publish(ev.eventId)
  assert.equal(r.status, 200, JSON.stringify(r.body))
})

test('W-14 registration closing after race day blocks publish', async () => {
  const { eventId } = await completeEvent()
  await save(eventId, 'basics', { eventDate: '2027-03-14', opensOn: '2027-01-10', closesOn: '2027-03-15' })
  const r = await publish(eventId)
  assert.equal(r.status, 409)
  assert.deepEqual(r.body.blocking, [{ key: 'registration_dates', label: 'Zapisy online muszą się skończyć najpóźniej w dniu zawodów' }])
  assert.equal((await settingsOf(eventId)).state, 'draft')
})

test('W-14 a paid event cannot be published yet', async () => {
  // A club of its own: no club payout details, whatever other files left in the seed club.
  const own = await makeClub({ slug: `w14-${rand()}` })
  const session = await sessionFor(own.ownerEmail)
  const { eventId, categoryIds } = await completeEvent({ session, clubId: own.clubId })
  await save(eventId, 'competitions', { pricingMode: 'fixed', items: [comp({ categoryId: categoryIds[0], price: '60' })] }, session)
  const r = await publish(eventId, session)
  assert.equal(r.status, 409)
  assert.deepEqual(r.body.blocking, [
    { key: 'payments', label: 'Płatności online — wkrótce' },
    { key: 'payout', label: 'Uzupełnij dane do wypłat w ustawieniach klubu' },
  ])
})

test('W-14 get-registration-event returns the checklist', async () => {
  const { eventId } = await completeEvent()
  const r = await callFn('get-registration-event', member, { eventId })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.deepEqual(r.body.data.checklist.blocking, [])
  assert.deepEqual(r.body.data.checklist.missing.map((m) => m.key).sort(), ['gpx:' + r.body.data.competitions[0].categoryId, 'kids', 'office_hours', 'poster'].sort())
})

test('W-14 a slug taken by an ordinary event meanwhile → 409 „Adres zawodów jest zajęty”, state stays draft', async () => {
  const { eventId } = await completeEvent()
  const { slug } = await settingsOf(eventId)
  const squatter = crypto.randomUUID()
  const { error } = await db().from('events').insert({ id: squatter, name: `Inne ${rand()}`, slug })
  assert.ifError(error)
  try {
    const r = await publish(eventId)
    assert.equal(r.status, 409, JSON.stringify(r.body))
    assert.deepEqual(r.body.blocking, [{ key: 'slug_taken', label: 'Adres zawodów jest zajęty' }])
    assert.equal((await settingsOf(eventId)).state, 'draft')
    const { data: ev } = await db().from('events').select('slug, visibility').eq('id', eventId).single()
    assert.deepEqual(ev, { slug: `szkic-${eventId}`, visibility: 'private' })
    assert.equal((await calendarRows(eventId)).length, 0)
  } finally {
    await db().from('events').delete().eq('id', squatter)
  }
})

test('W-14 without the current agreement → 409 agreement_required', async () => {
  const club = await makeClub({ slug: 'publikacja-umowa' })
  const own = await sessionFor(club.ownerEmail)
  const { eventId } = await completeEvent({ session: own, clubId: club.clubId })
  await db().from('organizer_agreements').delete().eq('club_id', club.clubId)
  try {
    const r = await publish(eventId, own)
    assert.equal(r.status, 409, JSON.stringify(r.body))
    assert.equal(r.body.code, 'agreement_required')
    assert.equal((await settingsOf(eventId)).state, 'draft')
  } finally {
    await acceptAgreement('publikacja-umowa')
  }
})

// ---------------------------------------------------------------- W-15 published

test('W-15 publish: settings published, events row public, categories named, one active calendar row, audit', async () => {
  const items = [comp(), comp({ name: 'Nordic Walking 5 km', discipline: 'nw', distanceLabel: '5 km', timed: false })]
  const { eventId, name, categoryIds } = await completeEvent({ items })
  const before = await settingsOf(eventId)

  const r = await publish(eventId, zAdmin)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.deepEqual(r.body.data, { state: 'published', url: `https://www.leszy.run/events/${before.slug}` })

  const s = await settingsOf(eventId)
  assert.equal(s.state, 'published')
  assert.ok(s.published_at)
  assert.equal(s.regulamin_version, 1)

  const { data: ev } = await db().from('events').select('name, slug, date, location, visibility, club_id').eq('id', eventId).single()
  assert.deepEqual(ev, { name, slug: before.slug, date: '2027-03-14', location: 'Nieborowice', visibility: 'public', club_id: ZT })

  const { data: cats } = await db().from('categories').select('id, name, slug, untimed').eq('event_id', eventId)
  const byId = Object.fromEntries(cats.map((c) => [c.id, c]))
  assert.deepEqual(byId[categoryIds[0]], { id: categoryIds[0], name: 'Bieg 9 km', slug: 'bieg-9-km', untimed: false })
  assert.deepEqual(byId[categoryIds[1]], { id: categoryIds[1], name: 'Nordic Walking 5 km', slug: slugify('Nordic Walking 5 km'), untimed: true })

  const cal = await calendarRows(eventId)
  assert.equal(cal.length, 1)
  assert.equal(cal[0].status, 'active')
  assert.equal(cal[0].leszyrun_event_id, eventId)
  assert.equal(cal[0].name, name)
  assert.equal(cal[0].date, '2027-03-14')
  assert.equal(cal[0].location, 'Nieborowice')
  assert.equal(cal[0].voivodeship, 'Śląskie')
  assert.equal(Number(cal[0].lat), 50.2381)
  assert.equal(Number(cal[0].lng), 18.5412)
  assert.deepEqual(cal[0].distances, ['9 km', '5 km'])
  assert.deepEqual(cal[0].event_type, ['nordic walking'])
  assert.equal(cal[0].registration_url, `https://www.leszy.run/events/${before.slug}`)
  assert.equal(cal[0].registration_deadline, '2027-03-12')
  assert.equal(cal[0].price_from, 0)
  assert.equal(cal[0].price_to, 0)

  const { data: actions } = await db().from('organizer_actions').select('action, actor_id, club_id, payload')
    .eq('event_id', eventId).eq('action', 'published')
  assert.equal(actions.length, 1)
  assert.equal(actions[0].club_id, ZT)
})

test('W-15 two publishes fired together: one 200, one 409, one calendar row', async () => {
  const { eventId } = await completeEvent()
  const results = await Promise.all([publish(eventId, owner), publish(eventId, zAdmin)])
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409], JSON.stringify(results.map((r) => r.body)))
  assert.equal(results.find((r) => r.status === 409).body.code, 'not_draft')
  assert.equal((await calendarRows(eventId)).length, 1)
})

test('W-15 publishing again → 409 not_draft', async () => {
  const { eventId } = await completeEvent()
  assert.equal((await publish(eventId)).status, 200)
  const again = await publish(eventId)
  assert.equal(again.status, 409)
  assert.equal(again.body.code, 'not_draft')
})

test('W-15 an existing calendar row is updated, not duplicated, and its locked fields are kept', async () => {
  const { eventId } = await completeEvent()
  const { error } = await db().from('calendar_events').insert({
    name: 'Nazwa poprawiona ręcznie', date: '2027-03-01', source: 'leszyrun', source_id: eventId,
    status: 'pending', locked_fields: ['name'],
  })
  assert.ifError(error)
  assert.equal((await publish(eventId)).status, 200)
  const cal = await calendarRows(eventId)
  assert.equal(cal.length, 1)
  assert.equal(cal[0].name, 'Nazwa poprawiona ręcznie')
  assert.equal(cal[0].date, '2027-03-14')
  assert.equal(cal[0].status, 'active')
  assert.equal(cal[0].leszyrun_event_id, eventId)
})

test('W-15 createPublishedFreeEvent builds a published event through the edge functions', async () => {
  const r = await createPublishedFreeEvent(owner, { competitions: [comp(), comp({ name: 'Bieg 21 km', distanceLabel: '21 km' })] })
  assert.equal((await settingsOf(r.eventId)).state, 'published')
  assert.equal(r.categoryIds.length, 2)
  const { data: ev } = await db().from('events').select('slug, visibility').eq('id', r.eventId).single()
  assert.deepEqual(ev, { slug: r.slug, visibility: 'public' })
})

test('W-15 the publish RPC refuses a stale read and is not callable by clients', async () => {
  const { eventId } = await completeEvent()
  const { profileId } = owner
  const stale = await db().rpc('publish_registration_event', {
    p_event_id: eventId, p_actor: profileId, p_expected_updated_at: '2000-01-01T00:00:00Z',
  })
  assert.equal(stale.error?.message, 'changed')
  assert.equal((await settingsOf(eventId)).state, 'draft')

  const asClient = await authenticatedClient().rpc('publish_registration_event', { p_event_id: eventId, p_actor: profileId })
  assert.ok(asClient.error, 'authenticated must not execute publish_registration_event')
  assert.equal((await settingsOf(eventId)).state, 'draft')
})

// ---------------------------------------------------------------- W-16 who

test('W-16 a member gets 403, an outsider 404, no session 401; nothing is published', async () => {
  const { eventId } = await completeEvent()
  assert.equal((await publish(eventId, member)).status, 403)
  assert.equal((await publish(eventId, outsider)).status, 404)
  assert.equal((await callFn('publish-registration-event', null, { eventId, action: 'publish' })).status, 401)
  assert.equal((await settingsOf(eventId)).state, 'draft')
})

test('W-16 an unknown action → 400', async () => {
  const { eventId } = await completeEvent()
  const r = await callFn('publish-registration-event', owner, { eventId, action: 'launch' })
  assert.equal(r.status, 400)
  assert.equal((await settingsOf(eventId)).state, 'draft')
})
