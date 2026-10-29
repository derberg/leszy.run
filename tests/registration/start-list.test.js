// Plan 3, task 9: the public start list (start_list() + public/api/startlist.js)
// and the organizer's payment counts in list-event-registrations (P-45 in
// docs/registration/scenario-matrix.md). LOCAL stack only; every event and
// address is random, so reruns on a stack holding earlier data still pass.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createClient } from '@supabase/supabase-js'
import { localEnv, resetThrottle, sessionFor } from './helpers/stack.js'
import { startCapture } from './helpers/emailCapture.js'
import { acceptAgreement, callFn, createPublishedFreeEvent, createPublishedPaidEvent } from './helpers/registrationFixtures.js'
import { attemptFor, confirmOk, db, expireNow, orderOk, person, rpc, runnerEmail, setSettings } from './helpers/orders.js'

let owner, clubAdmin, member, stopCapture, handler, anon
before(async () => {
  const { url, anonKey } = localEnv()
  process.env.VITE_SUPABASE_URL = url
  process.env.VITE_SUPABASE_ANON_KEY = anonKey
  ;({ default: handler } = await import('../../public/api/startlist.js'))
  anon = createClient(url, anonKey, { auth: { persistSession: false } })
  stopCapture = await startCapture()
  await resetThrottle()
  await acceptAgreement('zatyrani-test')
  ;[owner, clubAdmin, member] = await Promise.all([
    'owner@zatyrani-test.local', 'admin@zatyrani-test.local', 'member@zatyrani-test.local',
  ].map(sessionFor))
})
after(async () => { if (stopCapture) await stopCapture() })

const BIEG = { name: 'Bieg 9 km', discipline: 'run', distanceLabel: '9 km', startTime: '10:00', capacity: 50 }
const MARSZ = { name: 'Marsz 5 km', discipline: 'nw', distanceLabel: '5 km', startTime: '10:05', capacity: 30 }

/** Calls api/startlist.js the way Vercel does (Node req/res). */
async function getStartList(query) {
  const headers = {}
  const res = {
    statusCode: 0,
    setHeader(k, v) { headers[k.toLowerCase()] = v },
    end(body) { this.body = body },
  }
  await handler({ url: `/api/startlist${query}`, method: 'GET', headers: {} }, res)
  return { status: res.statusCode, headers, body: JSON.parse(res.body) }
}

/** Every key at any depth of a JSON value. */
function keysOf(value, out = new Set()) {
  if (Array.isArray(value)) for (const v of value) keysOf(v, out)
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) { out.add(k.toLowerCase()); keysOf(v, out) }
  }
  return out
}

const FORBIDDEN_KEYS = [
  'birthdate', 'birth_date', 'email', 'phone', 'bib', 'bibnumber', 'bib_number', 'price', 'listprice', 'list_price',
  'amount', 'orderid', 'order_id', 'id', 'registrationid', 'registration_id', 'profileid', 'profile_id', 'icename',
  'ice_name', 'icephone', 'ice_phone', 'gender', 'expiresat', 'expires_at',
]

/**
 * A paid event with four people in „Bieg 9 km”: paid (confirmed), awaiting
 * (pending order), expired and cancelled; and one paid in „Marsz 5 km”.
 */
async function eventWithOrders() {
  const event = await createPublishedPaidEvent(owner, { competitions: [BIEG, MARSZ], prices: { 'Bieg 9 km': 6000, 'Marsz 5 km': 4000 } })
  const [bieg, marsz] = event.categoryIds
  const people = {
    paid: person(runnerEmail('paid'), { firstName: 'Anna', lastName: 'Zielna', city: 'Gliwice', club: 'ZATYRANI', phone: '+48500111222', birthDate: '1985-03-14' }),
    awaiting: person(runnerEmail('wait'), { firstName: 'Bartek', lastName: 'Czekaj', city: 'Zabrze', club: null }),
    expired: person(runnerEmail('exp'), { firstName: 'Celina', lastName: 'Wygasła', city: 'Bytom' }),
    cancelled: person(runnerEmail('canc'), { firstName: 'Damian', lastName: 'Anulowany', city: 'Pyskowice' }),
    marsz: person(runnerEmail('nw'), { firstName: 'Ewa', lastName: 'Kijek', city: 'Knurów', club: 'Kijki', ageGroupLabel: 'K40' }),
  }
  const orders = {}
  for (const [key, p] of Object.entries(people)) {
    orders[key] = await orderOk(event, { people: [p], categoryId: key === 'marsz' ? marsz : bieg })
  }
  for (const key of ['paid', 'marsz']) {
    const o = orders[key]
    const { txn } = await attemptFor(o.orderId, o.total)
    await confirmOk(o.orderId, txn, o.total)
  }
  await expireNow(orders.expired.orderId)
  const c = await rpc('cancel_order', { p_order_id: orders.cancelled.orderId, p_reason: 'test' })
  if (c.error) throw new Error(c.error.message)
  return { event, bieg, marsz, people, orders }
}

test('P-45 start_list: name, town, club, competition, age group and paid; nothing personal; expired and cancelled held out', async () => {
  const { event, bieg, marsz, people, orders } = await eventWithOrders()

  const { data, error } = await anon.rpc('start_list', { p_event_id: event.eventId })
  assert.equal(error, null, error?.message)
  assert.deepEqual(data.competitions, [
    { categoryId: bieg, name: 'Bieg 9 km', capacity: 50, paid: 1, awaiting: 1 },
    { categoryId: marsz, name: 'Marsz 5 km', capacity: 30, paid: 1, awaiting: 0 },
  ])
  const byName = Object.fromEntries(data.entries.map((e) => [e.name, e]))
  assert.deepEqual(Object.keys(byName).sort(), ['Anna Zielna', 'Bartek Czekaj', 'Ewa Kijek'])
  assert.deepEqual(byName['Anna Zielna'], {
    name: 'Anna Zielna', town: 'Gliwice', club: 'ZATYRANI', categoryId: bieg, competition: 'Bieg 9 km', ageGroupLabel: 'K open', paid: true,
  })
  assert.deepEqual(byName['Bartek Czekaj'], {
    name: 'Bartek Czekaj', town: 'Zabrze', club: null, categoryId: bieg, competition: 'Bieg 9 km', ageGroupLabel: 'K open', paid: false,
  })
  assert.equal(byName['Ewa Kijek'].competition, 'Marsz 5 km')
  assert.equal(byName['Ewa Kijek'].ageGroupLabel, 'K40')

  // Nothing personal or financial at any depth, by key and by value.
  const keys = keysOf(data)
  for (const k of FORBIDDEN_KEYS) assert.ok(!keys.has(k), `start_list exposes ${k}`)
  const text = JSON.stringify(data)
  for (const p of Object.values(people)) assert.ok(!text.includes(p.email), 'an e-mail address leaked')
  assert.ok(!text.includes('500111222'), 'a phone number leaked')
  assert.ok(!text.includes('1985-03-14'), 'a birth date leaked')
  for (const o of Object.values(orders)) assert.ok(!text.includes(o.orderId), 'an order id leaked')
})

test('P-45 start_list: hidden competitions left out; null for a draft; a closed event still listed; anon cannot read orders', async () => {
  const { event, marsz } = await eventWithOrders()
  const { error: hErr } = await db().from('competitions').update({ hidden_at: new Date().toISOString() }).eq('category_id', marsz)
  assert.equal(hErr, null)
  const hidden = (await anon.rpc('start_list', { p_event_id: event.eventId })).data
  assert.deepEqual(hidden.competitions.map((c) => c.name), ['Bieg 9 km'])
  assert.ok(hidden.entries.every((e) => e.competition === 'Bieg 9 km'))

  await setSettings(event.eventId, { state: 'closed' })
  assert.equal((await anon.rpc('start_list', { p_event_id: event.eventId })).data.entries.length, 2)
  await setSettings(event.eventId, { state: 'draft' })
  const draft = await anon.rpc('start_list', { p_event_id: event.eventId })
  assert.equal(draft.error, null)
  assert.equal(draft.data, null)
  assert.equal((await anon.rpc('start_list', { p_event_id: '00000000-0000-4000-8000-000000000000' })).data, null)

  const orders = await anon.from('orders').select('id').eq('event_id', event.eventId)
  assert.ok(orders.error || orders.data.length === 0, 'anon read orders')
  const regs = await anon.from('registrations').select('id').eq('event_id', event.eventId)
  assert.ok(regs.error || regs.data.length === 0, 'anon read registrations')
})

test('P-45 api/startlist: one event id or 400; the snapshot with a version, cached 60 s; 404 for a draft', async () => {
  const { event } = await eventWithOrders()
  for (const q of ['', '?event=', '?event=nie-uuid', `?event=${event.eventId.toUpperCase()}`, `?event=${event.eventId}&x=1`, `?slug=${event.slug}`]) {
    const r = await getStartList(q)
    assert.equal(r.status, 400, q)
    assert.equal(r.headers['cache-control'], 'no-store')
  }
  const ok = await getStartList(`?event=${event.eventId}`)
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  assert.match(ok.body.version, /^[0-9a-f]{40}$/)
  assert.equal(ok.body.entries.length, 3)
  assert.match(ok.headers['vercel-cdn-cache-control'], /max-age=60/)
  assert.equal(ok.headers.etag, `"${ok.body.version}"`)
  // The same data, the same version.
  assert.equal((await getStartList(`?event=${event.eventId}`)).body.version, ok.body.version)

  await setSettings(event.eventId, { state: 'draft' })
  const missing = await getStartList(`?event=${event.eventId}`)
  assert.equal(missing.status, 404)
  assert.match(missing.headers['vercel-cdn-cache-control'], /max-age=60/)
})

test('P-45 list-event-registrations: paymentStatus and expiresAt per row, counts beside data; owner and admin only', async () => {
  const { event, orders, people } = await eventWithOrders()
  assert.equal((await callFn('list-event-registrations', member, { eventId: event.eventId })).status, 404)
  const r = await callFn('list-event-registrations', owner, { eventId: event.eventId })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.deepEqual(r.body.counts, { paid: 2, awaiting: 1, free: 0 })
  const byName = Object.fromEntries(r.body.data.map((x) => [x.name, x]))
  assert.equal(byName['Anna Zielna'].paymentStatus, 'paid')
  assert.equal(byName['Anna Zielna'].expiresAt, null)
  assert.equal(byName['Bartek Czekaj'].paymentStatus, 'awaiting')
  const { data: o } = await db().from('orders').select('expires_at').eq('id', orders.awaiting.orderId).single()
  assert.equal(Date.parse(byName['Bartek Czekaj'].expiresAt), Date.parse(o.expires_at))
  // Expired and cancelled rows stay listed with their status, but count for nothing.
  assert.equal(byName['Celina Wygasła'].status, 'expired')
  assert.equal(byName['Celina Wygasła'].paymentStatus, null)
  assert.equal(byName['Damian Anulowany'].paymentStatus, null)
  assert.ok(!JSON.stringify(r.body).includes(people.paid.email))
  assert.deepEqual((await callFn('list-event-registrations', clubAdmin, { eventId: event.eventId })).body.counts, { paid: 2, awaiting: 1, free: 0 })
})

test('P-45 list-event-registrations: a free event counts its confirmed entries as free', async () => {
  const event = await createPublishedFreeEvent(owner)
  const email = runnerEmail('free')
  const runner = await sessionFor(email)
  const { data: consents } = await db().from('event_consents').select('id').eq('event_id', event.eventId)
  const reg = await callFn('register-free', runner, {
    categoryId: event.categoryIds[0],
    person: { firstName: 'Ola', lastName: 'Leśna', birthDate: '1990-05-01', gender: 'K', email, phone: '600100200' },
    acceptedConsentIds: consents.map((c) => c.id),
    serviceRegulamin: true,
  })
  assert.equal(reg.status, 201, JSON.stringify(reg.body))
  const r = await callFn('list-event-registrations', owner, { eventId: event.eventId })
  assert.deepEqual(r.body.counts, { paid: 0, awaiting: 0, free: 1 })
  assert.equal(r.body.data[0].paymentStatus, 'free')
  assert.equal(r.body.data[0].expiresAt, null)
})
