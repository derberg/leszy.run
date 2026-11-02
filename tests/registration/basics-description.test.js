// Wizard feedback on Podstawy (W-72, W-73, W-76 in docs/registration/scenario-matrix.md): the
// event description and the charity cause's page follow every basics rule. A draft writes them,
// a published event stages them and „Opublikuj zmiany” applies them with a diff row, and both
// reach registration_public / /api/event. A taken address is refused on save, before publish.
// LOCAL stack only; every event is random, so reruns pass.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { admin, localEnv, resetThrottle, sessionFor } from './helpers/stack.js'
import { startCapture } from './helpers/emailCapture.js'
import { acceptAgreement, callFn, createPublishedFreeEvent } from './helpers/registrationFixtures.js'

const rand = () => crypto.randomBytes(4).toString('hex')
const db = () => admin()
const DESCRIPTION = 'Nocny bieg po lesie.\n\nTrasa: https://example.org/trasa\n<script>alert(1)</script>'

let owner, member, stopCapture, handler, clubId
before(async () => {
  const { url, anonKey } = localEnv()
  process.env.VITE_SUPABASE_URL = url
  process.env.VITE_SUPABASE_ANON_KEY = anonKey
  ;({ default: handler } = await import('../../public/api/event.js'))
  stopCapture = await startCapture()
  await resetThrottle()
  await acceptAgreement('zatyrani-test')
  ;[owner, member] = await Promise.all(['owner@zatyrani-test.local', 'member@zatyrani-test.local'].map(sessionFor))
  clubId = (await db().from('clubs').select('id').eq('slug', 'zatyrani-test').single()).data.id
})
after(async () => { if (stopCapture) await stopCapture() })

async function getEvent(slug) {
  const res = { statusCode: 0, setHeader() {}, end(body) { this.body = body } }
  await handler({ url: `/api/event?slug=${slug}`, method: 'GET', headers: {} }, res)
  return { status: res.statusCode, body: JSON.parse(res.body) }
}
const settingsOf = async (eventId) => (await db().from('registration_settings').select('*').eq('event_id', eventId).single()).data
const save = (eventId, value, session = owner) => callFn('save-registration-section', session, { eventId, section: 'basics', value })

test('W-72 W-73 a draft saves the description and the cause page; the wizard reads them back', async () => {
  const r = await callFn('create-registration-event', owner, { clubId, name: `Opis Leszego ${rand()}` })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  const { eventId } = r.body.data
  const s = await save(eventId, { description: DESCRIPTION, isCharity: true, charityGoal: 'Rehabilitacja Zosi', charityUrl: 'https://example.org/zosia' })
  assert.equal(s.status, 200, JSON.stringify(s.body))
  const row = await settingsOf(eventId)
  assert.equal(row.description, DESCRIPTION)
  assert.equal(row.charity_url, 'https://example.org/zosia')
  const got = await callFn('get-registration-event', owner, { eventId })
  assert.equal(got.body.data.settings.description, DESCRIPTION)
  assert.equal(got.body.data.settings.charityUrl, 'https://example.org/zosia')

  const bad = await save(eventId, { charityUrl: 'javascript:alert(1)' })
  assert.equal(bad.status, 422)
  assert.equal(bad.body.fields.charityUrl, 'Podaj adres zaczynający się od http:// albo https://.')
  const long = await save(eventId, { description: 'a'.repeat(5001) })
  assert.equal(long.status, 422)
  assert.equal(long.body.fields.description, 'Najwyżej 5000 znaków.')
  assert.equal((await settingsOf(eventId)).description, DESCRIPTION)
  // A club member reads the wizard but cannot write.
  assert.equal((await save(eventId, { description: 'x' }, member)).status, 403)
})

test('W-72 W-73 the database refuses a description over 5000 characters and a non-http(s) cause page', async () => {
  const event = await createPublishedFreeEvent(owner)
  const long = await db().from('registration_settings').update({ description: 'a'.repeat(5001) }).eq('event_id', event.eventId)
  assert.equal(long.error?.code, '23514')
  const url = await db().from('registration_settings').update({ charity_url: 'javascript:alert(1)' }).eq('event_id', event.eventId)
  assert.equal(url.error?.code, '23514')
})

test('W-72 W-73 after publish both are staged, listed in the diff and live only after „Opublikuj zmiany”; /api/event serves them', async () => {
  const event = await createPublishedFreeEvent(owner)
  const before = await getEvent(event.slug)
  assert.equal(before.status, 200)
  assert.equal(before.body.description, null)
  assert.equal(before.body.charityUrl, null)

  const s = await save(event.eventId, { description: DESCRIPTION, isCharity: true, charityGoal: 'Rehabilitacja Zosi', charityUrl: 'https://example.org/zosia' })
  assert.equal(s.status, 200, JSON.stringify(s.body))
  assert.ok(s.body.data.changedFields.includes('basics.description'))
  assert.ok(s.body.data.changedFields.includes('basics.charity_url'))
  assert.equal((await settingsOf(event.eventId)).description, null, 'nothing live before publish')

  const preview = await callFn('publish-registration-event', owner, { eventId: event.eventId, action: 'preview_changes' })
  assert.equal(preview.status, 200, JSON.stringify(preview.body))
  const rows = Object.fromEntries(preview.body.data.diff.map((d) => [d.field, d]))
  assert.equal(rows['basics.description'].label, 'Opis wydarzenia')
  assert.equal(rows['basics.description'].after, DESCRIPTION)
  assert.equal(rows['basics.charity_url'].label, 'Strona celu')
  assert.equal(rows['basics.charity_url'].after, 'https://example.org/zosia')

  const pub = await callFn('publish-registration-event', owner, { eventId: event.eventId, action: 'publish_changes', notify: { send: false } })
  assert.equal(pub.status, 200, JSON.stringify(pub.body))
  const row = await settingsOf(event.eventId)
  assert.equal(row.description, DESCRIPTION)
  assert.equal(row.charity_url, 'https://example.org/zosia')

  const { data: raw, error } = await db().rpc('registration_public', { p_slug: event.slug })
  assert.equal(error, null)
  assert.equal(raw.description, DESCRIPTION)
  assert.equal(raw.charityUrl, 'https://example.org/zosia')
  const after = await getEvent(event.slug)
  assert.equal(after.body.description, DESCRIPTION)
  assert.equal(after.body.charityUrl, 'https://example.org/zosia')
})

test('W-77 the event page: saved in a draft, refused when not http(s) (also by the column), staged after publish and served by /api/event', async () => {
  const r = await callFn('create-registration-event', owner, { clubId, name: `Strona Leszego ${rand()}` })
  const { eventId } = r.body.data
  assert.equal((await save(eventId, { websiteUrl: 'https://example.org/bieg' })).status, 200)
  assert.equal((await settingsOf(eventId)).website_url, 'https://example.org/bieg')
  assert.equal((await callFn('get-registration-event', owner, { eventId })).body.data.settings.websiteUrl, 'https://example.org/bieg')
  const bad = await save(eventId, { websiteUrl: 'javascript:alert(1)' })
  assert.equal(bad.status, 422)
  assert.equal(bad.body.fields.websiteUrl, 'Podaj adres zaczynający się od http:// albo https://.')

  const event = await createPublishedFreeEvent(owner)
  const col = await db().from('registration_settings').update({ website_url: 'javascript:alert(1)' }).eq('event_id', event.eventId)
  assert.equal(col.error?.code, '23514')
  assert.equal((await getEvent(event.slug)).body.websiteUrl, null)
  const s = await save(event.eventId, { websiteUrl: 'https://example.org/bieg' })
  assert.equal(s.status, 200, JSON.stringify(s.body))
  assert.ok(s.body.data.changedFields.includes('basics.website_url'))
  assert.equal((await settingsOf(event.eventId)).website_url, null, 'nothing live before publish')
  const preview = await callFn('publish-registration-event', owner, { eventId: event.eventId, action: 'preview_changes' })
  const row = preview.body.data.diff.find((d) => d.field === 'basics.website_url')
  assert.equal(row.label, 'Strona wydarzenia')
  const pub = await callFn('publish-registration-event', owner, { eventId: event.eventId, action: 'publish_changes', notify: { send: false } })
  assert.equal(pub.status, 200, JSON.stringify(pub.body))
  assert.equal((await getEvent(event.slug)).body.websiteUrl, 'https://example.org/bieg')
})

test('W-76 a taken address is refused on the step-1 save, before publish, and the other basics fields still save', async () => {
  const a = await createPublishedFreeEvent(owner)
  const r = await callFn('create-registration-event', owner, { clubId, name: `Adres Leszego ${rand()}` })
  const { eventId } = r.body.data
  const taken = await save(eventId, { slug: a.slug })
  assert.equal(taken.status, 422)
  assert.equal(taken.body.fields.slug, 'Ten adres jest już zajęty.')
  // The wizard saves again without the refused slug (Podstawy's refusedRef).
  const rest = await save(eventId, { description: 'Bez adresu' })
  assert.equal(rest.status, 200)
  const row = await settingsOf(eventId)
  assert.notEqual(row.slug, a.slug)
  assert.equal(row.description, 'Bez adresu')
})
