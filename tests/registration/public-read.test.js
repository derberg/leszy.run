// Plan 2, task 6: the public event snapshot and the members-only preview
// (W-18…W-20 and W-45 in docs/registration/scenario-matrix.md). LOCAL stack only.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { admin, localEnv, resetThrottle, sessionFor } from './helpers/stack.js'
import { lastCodeFor, startCapture } from './helpers/emailCapture.js'
import { acceptAgreement, callFn, createPublishedFreeEvent } from './helpers/registrationFixtures.js'
import { mergePending } from '../../public/src/lib/eventPageModel.js'

const rand = () => crypto.randomBytes(4).toString('hex')
const db = () => admin()

let owner, member, innyMember, stopCapture, handler
before(async () => {
  const { url, anonKey } = localEnv()
  // The Vercel function reads these on its first request.
  process.env.VITE_SUPABASE_URL = url
  process.env.VITE_SUPABASE_ANON_KEY = anonKey
  ;({ default: handler } = await import('../../public/api/event.js'))
  stopCapture = await startCapture()
  await resetThrottle()
  await acceptAgreement('zatyrani-test')
  ;[owner, member, innyMember] = await Promise.all([
    'owner@zatyrani-test.local', 'member@zatyrani-test.local', 'member@inny-klub.local',
  ].map(sessionFor))
})
after(async () => { if (stopCapture) await stopCapture() })

/** Calls api/event.js the way Vercel does (Node req/res). */
async function getEvent(query) {
  const headers = {}
  const res = {
    statusCode: 0,
    setHeader(k, v) { headers[k.toLowerCase()] = v },
    end(body) { this.body = body },
  }
  await handler({ url: `/api/event${query}`, method: 'GET', headers: {} }, res)
  return { status: res.statusCode, headers, body: JSON.parse(res.body) }
}

const CDN_60 = 'max-age=60, stale-while-revalidate=600, stale-if-error=600'

async function draftEvent() {
  const club = await db().from('clubs').select('id').eq('slug', 'zatyrani-test').single()
  const r = await callFn('create-registration-event', owner, { clubId: club.data.id, name: `Szkic Leszego ${rand()}` })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  const { data } = await db().from('registration_settings').select('slug').eq('event_id', r.body.data.eventId).single()
  return { eventId: r.body.data.eventId, slug: data.slug }
}

async function registerRunner(event, categoryId) {
  const email = `runner-public-${rand()}@test.local`
  const fns = localEnv().functionsUrl
  const post = (fn, body) => fetch(`${fns}/${fn}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' }, body: JSON.stringify(body),
  })
  assert.equal((await post('auth-request-code', { email })).status, 200)
  let code = null
  for (let i = 0; i < 20 && !code; i++) {
    code = await lastCodeFor(email)
    if (!code) await new Promise((r) => setTimeout(r, 250))
  }
  const { data: consents } = await db().from('event_consents').select('id').eq('event_id', event.eventId)
  const r = await post('register-free', {
    categoryId, code, serviceRegulamin: true, acceptedConsentIds: consents.map((c) => c.id),
    person: { firstName: 'Ola', lastName: 'Leśna', birthDate: '1990-05-01', gender: 'K', email, phone: '600100200' },
  })
  assert.equal(r.status, 201, await r.text())
}

/** Every key at any depth. */
function keysDeep(v, out = new Set()) {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out))
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keysDeep(x, out) }
  return out
}

// ---------------------------------------------------------------- W-18

test('W-18 bad slugs → 400 no-store, never reaching Supabase', async () => {
  for (const q of ['', '?slug=Bad%20Slug', '?slug=ab', `?slug=${'a'.repeat(81)}`, '?slug=Bieg-Leszego',
    '?slug=bieg--leszego', '?slug=bieg-leszego&x=1', '?slug=bieg-leszego&slug=other', '?other=bieg-leszego']) {
    const r = await getEvent(q)
    assert.equal(r.status, 400, q)
    assert.equal(r.headers['cache-control'], 'no-store', q)
    assert.equal(r.headers['vercel-cdn-cache-control'], undefined, q)
  }
})

test('W-18 a draft or unknown slug → 404, cached 60 s like a hit', async () => {
  const draft = await draftEvent()
  for (const slug of [draft.slug, `nie-ma-${rand()}`]) {
    const r = await getEvent(`?slug=${slug}`)
    assert.equal(r.status, 404, slug)
    assert.equal(r.headers['vercel-cdn-cache-control'], CDN_60)
    assert.equal(r.headers['cache-control'], 'public, max-age=0, must-revalidate')
  }
})

test('W-18 published → 200 with cache headers and a version that changes only after a registration', async () => {
  const event = await createPublishedFreeEvent(owner)
  const a = await getEvent(`?slug=${event.slug}`)
  assert.equal(a.status, 200, JSON.stringify(a.body))
  assert.equal(a.headers['vercel-cdn-cache-control'], CDN_60)
  assert.equal(a.headers['cache-control'], 'public, max-age=0, must-revalidate')
  assert.equal(a.headers.etag, `"${a.body.version}"`)
  assert.match(a.body.version, /^[0-9a-f]{40}$/)
  assert.ok(Date.parse(a.body.generatedAt))
  assert.equal(a.body.eventId, event.eventId)
  assert.equal(a.body.slug, event.slug)
  assert.equal(a.body.state, 'published')
  assert.equal(a.body.pricingMode, 'free')
  assert.equal(a.body.regulamin.url, 'https://example.org/regulamin.pdf')
  const [c] = a.body.competitions
  assert.deepEqual(
    { categoryId: c.categoryId, name: c.name, startTime: c.startTime, capacity: c.capacity, taken: c.taken, confirmed: c.confirmed, priceGrosze: c.priceGrosze, nextPrice: c.nextPrice },
    { categoryId: event.categoryIds[0], name: 'Bieg 9 km', startTime: '10:00', capacity: 50, taken: 0, confirmed: 0, priceGrosze: 0, nextPrice: null },
  )
  assert.deepEqual(a.body.consents.map((k) => k.kind).sort(), ['data_info', 'regulamin'])

  const b = await getEvent(`?slug=${event.slug}`)
  assert.equal(b.body.version, a.body.version, 'nothing changed → same version')

  await registerRunner(event, event.categoryIds[0])
  const after = await getEvent(`?slug=${event.slug}`)
  assert.notEqual(after.body.version, a.body.version)
  assert.equal(after.body.competitions[0].taken, 1)
  assert.equal(after.body.competitions[0].confirmed, 1)
})

test('W-45 a hidden competition is absent from the public snapshot', async () => {
  const event = await createPublishedFreeEvent(owner, { competitions: [
    { name: 'Bieg 9 km', discipline: 'run', distanceLabel: '9 km', startTime: '10:00', capacity: 50 },
    { name: 'Nordic walking 3 km', discipline: 'nw', distanceLabel: '3 km', startTime: '10:10', capacity: 20 },
  ] })
  const before = await getEvent(`?slug=${event.slug}`)
  assert.deepEqual(before.body.competitions.map((c) => c.name), ['Bieg 9 km', 'Nordic walking 3 km'])

  const { error } = await db().from('competitions').update({ hidden_at: new Date().toISOString() }).eq('category_id', event.categoryIds[1])
  assert.ifError(error)
  const r = await getEvent(`?slug=${event.slug}`)
  assert.deepEqual(r.body.competitions.map((c) => c.categoryId), [event.categoryIds[0]])
  assert.equal(JSON.stringify(r.body).includes(event.categoryIds[1]), false)
  assert.notEqual(r.body.version, before.body.version)

  const anon = createClient(localEnv().url, localEnv().anonKey, { auth: { persistSession: false } })
  const { data } = await anon.rpc('registration_public', { p_slug: event.slug })
  assert.deepEqual(data.competitions.map((c) => c.categoryId), [event.categoryIds[0]])
})

// ---------------------------------------------------------------- W-19

test('W-19 anon: registration_raw refused, registration_public null for drafts, no private keys in the payload', async () => {
  const anon = createClient(localEnv().url, localEnv().anonKey, { auth: { persistSession: false } })
  const event = await createPublishedFreeEvent(owner)

  const raw = await anon.rpc('registration_raw', { p_event_id: event.eventId })
  assert.ok(raw.error, 'anon may not call registration_raw')
  assert.match(raw.error.message, /permission denied/)

  const draft = await draftEvent()
  const d = await anon.rpc('registration_public', { p_slug: draft.slug })
  assert.ifError(d.error)
  assert.equal(d.data, null)

  await registerRunner(event, event.categoryIds[0])
  const pub = await anon.rpc('registration_public', { p_slug: event.slug })
  assert.ifError(pub.error)
  const keys = keysDeep(pub.data)
  for (const k of keys) assert.doesNotMatch(k, /payout|email|iban|profile|club_?id|upload/i, k)
  const ids = [...keys].filter((k) => /id$/i.test(k)).sort()
  assert.deepEqual([...new Set(ids)], ['categoryId', 'eventId', 'id'], 'only event, category and consent ids')
  const text = JSON.stringify(pub.data)
  for (const personal of ['Leśna', '600100200', '1990-05-01']) assert.equal(text.includes(personal), false, `no runner data: ${personal}`)
  const r = await getEvent(`?slug=${event.slug}`)
  for (const k of keysDeep(r.body)) assert.doesNotMatch(k, /payout|email|iban|Path$/i, k)
})

// ---------------------------------------------------------------- W-20

test('W-20 preview: a member gets the raw (pending merged on request), others 404', async () => {
  const event = await createPublishedFreeEvent(owner)
  const plain = await callFn('preview-registration-event', member, { eventId: event.eventId })
  assert.equal(plain.status, 200, JSON.stringify(plain.body))
  assert.equal(plain.body.data.raw.eventId, event.eventId)
  assert.equal(plain.body.data.pending, null)

  const items = [{
    category_id: event.categoryIds[0], name: 'Bieg 9 km', kind: 'individual', discipline: 'run', distance_label: '9 km',
    start_time: '10:15', capacity: 50, min_age: null, max_age: null, is_kids: false, timed: true, gpx_upload_id: null, price: null,
  }]
  const { error } = await db().from('registration_pending_changes').insert({
    event_id: event.eventId, payload: { competitions: { pricing_mode: 'free', items } }, changed_fields: ['competitions'],
  })
  assert.ifError(error)

  const withPending = await callFn('preview-registration-event', member, { eventId: event.eventId, withPending: true })
  assert.equal(withPending.status, 200)
  const { raw, pending } = withPending.body.data
  assert.equal(raw.competitions[0].startTime, '10:00', 'raw is the live event')
  assert.deepEqual(pending.changedFields, ['competitions'])
  assert.equal(mergePending(raw, pending).competitions[0].startTime, '10:15')

  const without = await callFn('preview-registration-event', member, { eventId: event.eventId, withPending: false })
  assert.equal(without.body.data.pending, null)

  const draft = await draftEvent()
  const d = await callFn('preview-registration-event', member, { eventId: draft.eventId })
  assert.equal(d.status, 200, 'a draft previews for members')
  assert.equal(d.body.data.raw.state, 'draft')

  assert.equal((await callFn('preview-registration-event', innyMember, { eventId: event.eventId })).status, 404)
  assert.equal((await callFn('preview-registration-event', null, { eventId: event.eventId })).status, 404)
  assert.equal((await callFn('preview-registration-event', member, { eventId: 'nope' })).status, 404)
})

test('W-20 the raw of a draft: current and next price tier, course from the GPX upload, file paths', async () => {
  const draft = await draftEvent()
  const saved = await callFn('save-registration-section', owner, { eventId: draft.eventId, section: 'competitions', value: {
    pricingMode: 'fixed',
    items: [{ name: 'Bieg 9 km', kind: 'individual', discipline: 'run', distanceLabel: '9 km', startTime: '10:00', capacity: 80, minAge: 16, timed: true, isKids: false, price: '60' }],
  } })
  assert.equal(saved.status, 200, JSON.stringify(saved.body))
  const [categoryId] = saved.body.data.categoryIds

  // Tiered pricing has no wizard yet: two tiers written directly, the open-ended one later.
  const day = (n) => new Date(Date.now() + n * 864e5).toLocaleDateString('en-CA', { timeZone: 'Europe/Warsaw' })
  const { data: tier } = await db().from('price_tiers').insert({ event_id: draft.eventId, ends_on: day(10), sort_order: -1 }).select('id').single()
  await db().from('competition_prices').insert({ category_id: categoryId, tier_id: tier.id, amount: 5000 }).then(({ error }) => assert.ifError(error))
  const meta = { km: 9.1, upM: 120, downM: 118, points: 812, profile: [[0, 250], [9.1, 252]], fileName: 'trasa.gpx' }
  const { data: gpx } = await db().from('registration_uploads')
    .insert({ event_id: draft.eventId, kind: 'gpx', path: `${draft.eventId}/gpx/t.gpx`, meta }).select('id').single()
  await db().from('competitions').update({ gpx_upload_id: gpx.id }).eq('category_id', categoryId).then(({ error }) => assert.ifError(error))

  const r = await callFn('preview-registration-event', owner, { eventId: draft.eventId })
  assert.equal(r.status, 200)
  const [c] = r.body.data.raw.competitions
  assert.equal(c.priceGrosze, 5000)
  assert.deepEqual(c.nextPrice, { grosze: 6000, from: day(11) })
  assert.deepEqual(c.course, { km: 9.1, upM: 120, downM: 118, points: 812, profile: [[0, 250], [9.1, 252]], gpxPath: `${draft.eventId}/gpx/t.gpx` })
  assert.equal(c.minAge, 16)
  assert.equal(r.body.data.raw.pricingMode, 'fixed')
})
