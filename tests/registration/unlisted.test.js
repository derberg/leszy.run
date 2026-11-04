// „Widoczność: Tylko przez link” (W-79…W-83 in docs/registration/scenario-matrix.md). An
// unlisted event is published and works for anyone with the link, but no listing shows it:
// events.visibility is 'unlisted' (every listing filters 'public') and it has no calendar_events
// row. The choice is registration_settings.listed, a basics field: saved in a draft, staged after
// publish with a „Widoczność” diff row. LOCAL stack only; every event is random, so reruns pass.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { admin, localEnv, resetThrottle, sessionFor } from './helpers/stack.js'
import { startCapture } from './helpers/emailCapture.js'
import { acceptAgreement, callFn, createPublishedFreeEvent } from './helpers/registrationFixtures.js'
import { startScratchHost } from './helpers/hostPull.js'

const db = () => admin()
const ZT = '00000000-0000-4000-8000-0000000000c1'
const EDGE_PROXY = { 'x-forwarded-host': 'localhost' }

let owner, member, stopCapture, eventApi, startListApi, resultsApi
before(async () => {
  const { url, anonKey } = localEnv()
  process.env.VITE_SUPABASE_URL = url
  process.env.VITE_SUPABASE_ANON_KEY = anonKey
  ;({ default: eventApi } = await import('../../public/api/event.js'))
  ;({ default: startListApi } = await import('../../public/api/startlist.js'))
  ;({ default: resultsApi } = await import('../../public/api/results.js'))
  stopCapture = await startCapture()
  await acceptAgreement('zatyrani-test')
  ;[owner, member] = await Promise.all(['owner@zatyrani-test.local', 'member@zatyrani-test.local'].map(sessionFor))
})
after(async () => { if (stopCapture) await stopCapture() })
beforeEach(async () => { await resetThrottle() })

/** Calls a public/api handler the way Vercel does (Node req/res). */
async function get(handler, url) {
  const res = { statusCode: 0, setHeader() {}, end(body) { this.body = body } }
  await handler({ url, method: 'GET', headers: {} }, res)
  return { status: res.statusCode, body: JSON.parse(res.body) }
}

const visibilityOf = async (eventId) => (await db().from('events').select('visibility').eq('id', eventId).single()).data.visibility
const calendarRows = async (eventId) => (await db().from('calendar_events').select('id, status')
  .eq('source', 'leszyrun').eq('source_id', eventId)).data
const save = (eventId, value, session = owner) => callFn('save-registration-section', session, { eventId, section: 'basics', value })
const publishChanges = (eventId) => callFn('publish-registration-event', owner, { eventId, action: 'publish_changes', notify: { send: false } })

async function registerRunner(event) {
  const email = `runner-${crypto.randomBytes(4).toString('hex')}@test.local`
  const session = await sessionFor(email)
  const { data: consents } = await db().from('event_consents').select('id').eq('event_id', event.eventId)
  const res = await fetch(`${localEnv().functionsUrl}/register-free`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...EDGE_PROXY, cookie: session.cookie },
    body: JSON.stringify({
      categoryId: event.categoryIds[0],
      person: { firstName: 'Ola', lastName: 'Ukryta', birthDate: '1990-05-01', gender: 'K', email, phone: '600100200' },
      acceptedConsentIds: consents.map((c) => c.id), serviceRegulamin: true,
    }),
  })
  return { status: res.status, body: await res.json() }
}

test('W-79 a draft saves „Tylko przez link”; the wizard reads it back; a member cannot write it; a non-boolean is refused', async () => {
  const created = await callFn('create-registration-event', owner, { clubId: ZT, name: `Ukryty Leszy ${crypto.randomBytes(4).toString('hex')}` })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const { eventId } = created.body.data
  assert.equal((await callFn('get-registration-event', owner, { eventId })).body.data.settings.listed, true, 'listed by default')
  assert.equal((await save(eventId, { listed: false })).status, 200)
  assert.equal((await db().from('registration_settings').select('listed').eq('event_id', eventId).single()).data.listed, false)
  assert.equal((await callFn('get-registration-event', owner, { eventId })).body.data.settings.listed, false)
  const bad = await save(eventId, { listed: 'nie' })
  assert.equal(bad.status, 422)
  assert.equal(bad.body.fields.listed, 'Nieprawidłowa wartość.')
  assert.equal((await save(eventId, { listed: true }, member)).status, 403)
  assert.equal(await visibilityOf(eventId), 'private', 'a draft stays private whatever it says')
})

test('W-80 publishing an unlisted event: visibility unlisted, no calendar row; the page, the start list, the results and registration work by link; the club list says listed false', async () => {
  const event = await createPublishedFreeEvent(owner, { listed: false })
  assert.equal(await visibilityOf(event.eventId), 'unlisted')
  assert.deepEqual(await calendarRows(event.eventId), [], 'no calendar_events row: not on /kalendarz, the landing pages or the sitemap')

  const page = await get(eventApi, `/api/event?slug=${event.slug}`)
  assert.equal(page.status, 200, JSON.stringify(page.body))
  assert.equal(page.body.listed, false, 'the page knows to carry noindex')

  const reg = await registerRunner(event)
  assert.equal(reg.status, 201, JSON.stringify(reg.body))
  const list = await get(startListApi, `/api/startlist?event=${event.eventId}`)
  assert.equal(list.status, 200, JSON.stringify(list.body))
  assert.equal(JSON.stringify(list.body).includes('Ola'), true, 'the runner is on the start list')
  const { data: pub, error } = await createClientAnon().from('participants_public').select('first_name').in('category_id', event.categoryIds)
  assert.equal(error, null)
  assert.deepEqual(pub, [{ first_name: 'Ola' }])
  const results = await get(resultsApi, `/api/results?event=${event.eventId}`)
  assert.equal(results.status, 200, JSON.stringify(results.body))

  const clubList = await callFn('list-club-registration-events', owner, { clubId: ZT })
  assert.equal(clubList.status, 200)
  assert.equal(clubList.body.data.find((e) => e.eventId === event.eventId).listed, false)

  // The timing host still pulls it: hostSkipsEvent reads the state and the timing, never the visibility.
  const host = await startScratchHost()
  try {
    await host.pull()
    const rows = await host.sql`select visibility from events where id = ${event.eventId}`
    assert.deepEqual(rows.map((r) => r.visibility), ['unlisted'])
  } finally {
    await host.stop()
  }
})

test('W-81 a listed event is public with an active calendar row; „Tylko przez link” is staged with a „Widoczność” row and applied only by „Opublikuj zmiany”; listing again brings the row back', async () => {
  const event = await createPublishedFreeEvent(owner)
  assert.equal(await visibilityOf(event.eventId), 'public')
  assert.deepEqual((await calendarRows(event.eventId)).map((r) => r.status), ['active'])

  const s = await save(event.eventId, { listed: false })
  assert.equal(s.status, 200, JSON.stringify(s.body))
  assert.deepEqual(s.body.data.changedFields, ['basics.listed'])
  assert.equal(await visibilityOf(event.eventId), 'public', 'nothing live before publish')
  const preview = await callFn('publish-registration-event', owner, { eventId: event.eventId, action: 'preview_changes' })
  assert.equal(preview.status, 200, JSON.stringify(preview.body))
  assert.deepEqual(preview.body.data.diff, [{ field: 'basics.listed', label: 'Widoczność', before: 'Publiczne', after: 'Tylko przez link' }])

  assert.equal((await publishChanges(event.eventId)).status, 200)
  assert.equal(await visibilityOf(event.eventId), 'unlisted')
  assert.deepEqual(await calendarRows(event.eventId), [])
  assert.equal((await get(eventApi, `/api/event?slug=${event.slug}`)).body.listed, false)

  assert.equal((await save(event.eventId, { listed: true })).status, 200)
  assert.equal((await publishChanges(event.eventId)).status, 200)
  assert.equal(await visibilityOf(event.eventId), 'public')
  assert.deepEqual((await calendarRows(event.eventId)).map((r) => r.status), ['active'])
})

test('W-82 an admin\'s rejected calendar row survives unlisting and listing again, and stays rejected', async () => {
  const event = await createPublishedFreeEvent(owner)
  const [row] = await calendarRows(event.eventId)
  assert.equal((await db().from('calendar_events').update({ status: 'rejected' }).eq('id', row.id)).error, null)
  assert.equal((await save(event.eventId, { listed: false })).status, 200)
  assert.equal((await publishChanges(event.eventId)).status, 200)
  assert.deepEqual(await calendarRows(event.eventId), [{ id: row.id, status: 'rejected' }])
  assert.equal((await save(event.eventId, { listed: true })).status, 200)
  assert.equal((await publishChanges(event.eventId)).status, 200)
  assert.deepEqual(await calendarRows(event.eventId), [{ id: row.id, status: 'rejected' }])
})

test('W-83 the listing queries the public app runs leave an unlisted event out and keep a listed one', async () => {
  const hidden = await createPublishedFreeEvent(owner, { listed: false })
  const shown = await createPublishedFreeEvent(owner)
  const anon = createClientAnon()
  // Landing (upcoming and past), Home and LeszyrunBanner all read events by this filter.
  const { data, error } = await anon.from('events').select('id').eq('visibility', 'public').in('id', [hidden.eventId, shown.eventId])
  assert.equal(error, null)
  assert.deepEqual(data.map((r) => r.id), [shown.eventId])
  // The /kalendarz pages, the landing pages and the sitemap are built from calendar_events,
  // which only the service role reads (F-24): the build's manifest leaves the hidden one out.
  const { data: cal } = await db().from('calendar_events').select('source_id').eq('source', 'leszyrun')
    .in('source_id', [hidden.eventId, shown.eventId])
  assert.deepEqual(cal.map((r) => r.source_id), [shown.eventId])
})

function createClientAnon() {
  const { url, anonKey } = localEnv()
  return createClient(url, anonKey, { auth: { persistSession: false } })
}
