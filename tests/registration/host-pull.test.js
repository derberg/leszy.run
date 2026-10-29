// Plan 2, task 5: W-17, what a timing host pulls. A scratch postgres:16 on
// 55432 (helpers/hostPull.js) runs the backend's real pullConfig() against the
// LOCAL Supabase stack: a draft stays off the host, the same event appears with
// its categories once published, and an event timed by another company never
// arrives.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { sessionFor } from './helpers/stack.js'
import { acceptAgreement, callFn, createPublishedFreeEvent } from './helpers/registrationFixtures.js'
import { startScratchHost } from './helpers/hostPull.js'

const ZT = '00000000-0000-4000-8000-0000000000c1'

let owner, host
before(async () => {
  await acceptAgreement('zatyrani-test')
  owner = await sessionFor('owner@zatyrani-test.local')
  host = await startScratchHost()
})
after(async () => { await host?.stop() })

const onHost = async (eventId) => {
  const ev = await host.sql`select id, name, slug, date, visibility, club_id from events where id = ${eventId}`
  const cats = await host.sql`select id, name, slug, untimed from categories where event_id = ${eventId} order by name`
  return { event: ev[0] ? { ...ev[0] } : null, categories: cats.map((c) => ({ ...c })) }
}

async function save(eventId, section, value) {
  const r = await callFn('save-registration-section', owner, { eventId, section, value })
  assert.equal(r.status, 200, `${section}: ${JSON.stringify(r.body)}`)
  return r.body.data
}

test('W-17 a draft is absent on the host; after publish it is there with its categories', async () => {
  const name = `Bieg Leszego ${crypto.randomBytes(4).toString('hex')}`
  const created = await callFn('create-registration-event', owner, { clubId: ZT, name })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const { eventId } = created.body.data
  await save(eventId, 'basics', {
    eventDate: '2027-04-18', opensOn: '2027-02-01', closesOn: '2027-04-16',
    townLabel: 'Nieborowice', townArea: 'GM. PILCHOWICE · ŚLĄSKIE', lat: 50.2381, lng: 18.5412,
    regulaminKind: 'link', regulaminUrl: 'https://example.org/regulamin.pdf', contactEmail: 'zapisy@klub.example',
  })
  const { categoryIds } = await save(eventId, 'competitions', { pricingMode: 'free', items: [
    { name: 'Bieg 9 km', kind: 'individual', discipline: 'run', distanceLabel: '9 km', startTime: '10:00', capacity: 50, timed: true },
    { name: 'Bieg dzieci', kind: 'individual', discipline: 'run', distanceLabel: '400 m', startTime: '09:00', capacity: 30, isKids: true, timed: false },
  ] })

  await host.pull()
  assert.deepEqual(await onHost(eventId), { event: null, categories: [] })

  const published = await callFn('publish-registration-event', owner, { eventId, action: 'publish' })
  assert.equal(published.status, 200, JSON.stringify(published.body))

  await host.pull()
  const { event, categories } = await onHost(eventId)
  assert.ok(event, 'the published event reached the host')
  assert.equal(event.name, name)
  assert.equal(event.date, '2027-04-18')
  assert.equal(event.visibility, 'public')
  assert.equal(event.club_id, ZT)
  assert.match(event.slug, /^bieg-leszego-/)
  assert.deepEqual(categories, [
    { id: categoryIds[0], name: 'Bieg 9 km', slug: 'bieg-9-km', untimed: false },
    { id: categoryIds[1], name: 'Bieg dzieci', slug: 'bieg-dzieci', untimed: true },
  ])
})

test('W-17 a published event timed by another company never reaches the host', async () => {
  const { eventId } = await createPublishedFreeEvent(owner, { timingMode: 'external' })
  await host.pull()
  assert.deepEqual(await onHost(eventId), { event: null, categories: [] })
})
