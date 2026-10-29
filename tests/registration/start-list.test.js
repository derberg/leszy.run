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
import { adult, groupMeta, minor, orderGroupOk } from './helpers/groups.js'

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
  'ice_name', 'icephone', 'ice_phone', 'expiresat', 'expires_at',
]

const DZIECI = { name: 'Dzieci 1 km', discipline: 'run', distanceLabel: '1 km', startTime: '11:00', capacity: 20 }

/**
 * A paid event: in „Bieg 9 km” an adult who paid, a minor who paid, a paid
 * entry whose account was deleted, one awaiting payment, one expired and one
 * cancelled; one paid in „Marsz 5 km”; a minor in the 0 zł „Dzieci 1 km”.
 */
async function eventWithOrders() {
  const event = await createPublishedPaidEvent(owner, {
    competitions: [BIEG, MARSZ, DZIECI], prices: { 'Bieg 9 km': 6000, 'Marsz 5 km': 4000, 'Dzieci 1 km': 0 },
  })
  const [bieg, marsz, dzieci] = event.categoryIds
  const people = {
    paid: person(runnerEmail('paid'), { firstName: 'Anna', lastName: 'Zielna', city: 'Gliwice', club: 'ZATYRANI', phone: '+48500111222', birthDate: '1985-03-14' }),
    minor: person(runnerEmail('minor'), { firstName: 'Kuba', lastName: 'Młody', city: 'Gierałtowice', club: 'UKS Sokół', birthDate: '2012-06-01', gender: 'M', ageGroupLabel: 'M open' }),
    deleted: person(runnerEmail('del'), { firstName: 'Piotr', lastName: 'Skasowany', city: 'Rybnik' }),
    awaiting: person(runnerEmail('wait'), { firstName: 'Bartek', lastName: 'Czekaj', city: 'Zabrze', club: null }),
    expired: person(runnerEmail('exp'), { firstName: 'Celina', lastName: 'Wygasła', city: 'Bytom' }),
    cancelled: person(runnerEmail('canc'), { firstName: 'Damian', lastName: 'Anulowany', city: 'Pyskowice' }),
    marsz: person(runnerEmail('nw'), { firstName: 'Ewa', lastName: 'Kijek', city: 'Knurów', club: 'Kijki', ageGroupLabel: 'K40' }),
    kid: person(runnerEmail('kid'), { firstName: 'Zosia', lastName: 'Mała', city: 'Pilchowice', birthDate: '2017-02-02', ageGroupLabel: 'Dzieci I' }),
  }
  const categoryOf = { marsz, kid: dzieci }
  const orders = {}
  for (const [key, p] of Object.entries(people)) {
    orders[key] = await orderOk(event, { people: [p], categoryId: categoryOf[key] ?? bieg })
  }
  for (const key of ['paid', 'minor', 'deleted', 'marsz']) {
    const o = orders[key]
    const { txn } = await attemptFor(o.orderId, o.total)
    await confirmOk(o.orderId, txn, o.total)
  }
  await expireNow(orders.expired.orderId)
  const c = await rpc('cancel_order', { p_order_id: orders.cancelled.orderId, p_reason: 'test' })
  if (c.error) throw new Error(c.error.message)
  // What delete-my-account leaves of a registration.
  const { error: dErr } = await db().from('registrations')
    .update({ first_name: 'Usunięte konto', last_name: 'Usunięte konto', city: null, club: null })
    .eq('order_id', orders.deleted.orderId)
  if (dErr) throw dErr
  return { event, bieg, marsz, dzieci, people, orders }
}

test('P-45 start_list: name, town, club, competition, age group and payment; nothing personal; awaiting, expired and cancelled never listed by person', async () => {
  const { event, bieg, marsz, dzieci, people, orders } = await eventWithOrders()

  const { data, error } = await anon.rpc('start_list', { p_event_id: event.eventId })
  assert.equal(error, null, error?.message)
  assert.deepEqual(data.competitions, [
    { categoryId: bieg, name: 'Bieg 9 km', capacity: 50, isKids: false, paid: 3, free: 0, awaiting: 1 },
    { categoryId: marsz, name: 'Marsz 5 km', capacity: 30, isKids: false, paid: 1, free: 0, awaiting: 0 },
    { categoryId: dzieci, name: 'Dzieci 1 km', capacity: 20, isKids: false, paid: 0, free: 1, awaiting: 0 },
  ])
  const byName = Object.fromEntries(data.entries.map((e) => [e.name, e]))
  // P3-R14: the runner awaiting payment and the deleted account are not listed; only counted.
  assert.deepEqual(Object.keys(byName).sort(), ['Anna Zielna', 'Ewa Kijek', 'Kuba Młody', 'Zosia Mała'])
  assert.deepEqual(byName['Anna Zielna'], {
    name: 'Anna Zielna', town: 'Gliwice', club: 'ZATYRANI', categoryId: bieg, competition: 'Bieg 9 km', ageGroupLabel: 'K open',
    kidsGroupLabel: null, gender: 'K', payment: 'paid',
  })
  assert.equal(byName['Ewa Kijek'].competition, 'Marsz 5 km')
  assert.equal(byName['Ewa Kijek'].ageGroupLabel, 'K40')
  // P3-R14: no town for a runner under 18 on the event date; the club stays.
  assert.equal(byName['Kuba Młody'].town, null)
  assert.equal(byName['Kuba Młody'].club, 'UKS Sokół')
  assert.equal(byName['Kuba Młody'].payment, 'paid')
  // I1: a 0 zł entry of a paid event is free, never „opłacone”.
  assert.equal(byName['Zosia Mała'].payment, 'free')
  assert.equal(byName['Zosia Mała'].town, null)
  assert.ok(data.entries.every((e) => e.payment === 'paid' || e.payment === 'free'))

  // Nothing personal or financial at any depth, by key and by value.
  const keys = keysOf(data)
  for (const k of FORBIDDEN_KEYS) assert.ok(!keys.has(k), `start_list exposes ${k}`)
  const text = JSON.stringify(data)
  for (const p of Object.values(people)) assert.ok(!text.includes(p.email), 'an e-mail address leaked')
  for (const t of ['Gierałtowice', 'Pilchowice', 'Zabrze', 'Czekaj', 'Usunięte konto', 'Skasowany']) assert.ok(!text.includes(t), `${t} leaked`)
  assert.ok(!text.includes('500111222'), 'a phone number leaked')
  assert.ok(!text.includes('1985-03-14'), 'a birth date leaked')
  for (const o of Object.values(orders)) assert.ok(!text.includes(o.orderId), 'an order id leaked')
})

test('P-45 start_list: names sort in Polish (Ł after L, Ś after S, Ż after Z)', async () => {
  const event = await createPublishedPaidEvent(owner, { competitions: [BIEG], prices: { 'Bieg 9 km': 6000 } })
  for (const last of ['Żak', 'Sowa', 'Zieliński', 'Łuczak', 'Śliwa', 'Mazur', 'Lewandowski']) {
    const o = await orderOk(event, { people: [person(runnerEmail('sort'), { lastName: last })] })
    const { txn } = await attemptFor(o.orderId, o.total)
    await confirmOk(o.orderId, txn, o.total)
  }
  const { data } = await anon.rpc('start_list', { p_event_id: event.eventId })
  assert.deepEqual(data.entries.map((e) => e.name.split(' ')[1]),
    ['Lewandowski', 'Łuczak', 'Mazur', 'Sowa', 'Śliwa', 'Zieliński', 'Żak'])
})

test('P-45 start_list: hidden competitions left out; null for a draft; a closed event still listed; anon cannot read orders', async () => {
  const { event, marsz, dzieci } = await eventWithOrders()
  const { error: hErr } = await db().from('competitions').update({ hidden_at: new Date().toISOString() }).eq('category_id', marsz)
  assert.equal(hErr, null)
  const { error: h2 } = await db().from('competitions').update({ hidden_at: new Date().toISOString() }).eq('category_id', dzieci)
  assert.equal(h2, null)
  const hidden = (await anon.rpc('start_list', { p_event_id: event.eventId })).data
  assert.deepEqual(hidden.competitions.map((c) => c.name), ['Bieg 9 km'])
  assert.ok(hidden.entries.every((e) => e.competition === 'Bieg 9 km'))

  await setSettings(event.eventId, { state: 'closed' })
  assert.equal((await anon.rpc('start_list', { p_event_id: event.eventId })).data.entries.length, 2) // Anna and Kuba
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
  assert.equal(ok.body.entries.length, 4)
  assert.match(ok.headers['vercel-cdn-cache-control'], /max-age=60/)
  assert.equal(ok.headers.etag, `"${ok.body.version}"`)
  // The same data, the same version.
  assert.equal((await getStartList(`?event=${event.eventId}`)).body.version, ok.body.version)

  await setSettings(event.eventId, { state: 'draft' })
  const missing = await getStartList(`?event=${event.eventId}`)
  assert.equal(missing.status, 404)
  assert.match(missing.headers['vercel-cdn-cache-control'], /max-age=60/)
})

// What list-event-registrations reports as placesLeft: capacity minus confirmed entries over the
// visible competitions (P3-R15: entries awaiting payment hold no place).
async function placesLeft(eventId) {
  const { data, error } = await db().from('competitions').select('capacity, taken, hidden_at').eq('event_id', eventId)
  assert.ifError(error)
  return data.filter((c) => !c.hidden_at).reduce((n, c) => n + Math.max(0, c.capacity - c.taken), 0)
}

test('P-45 list-event-registrations: paymentStatus and expiresAt per row, counts beside data; owner and admin only', async () => {
  const { event, orders, people } = await eventWithOrders()
  assert.equal((await callFn('list-event-registrations', member, { eventId: event.eventId })).status, 404)
  const r = await callFn('list-event-registrations', owner, { eventId: event.eventId })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const left = await placesLeft(event.eventId)
  assert.deepEqual(r.body.counts, { paid: 4, awaiting: 1, free: 1, placesLeft: left, awaitingConsent: 0 })
  const { data: caps } = await db().from('competitions').select('capacity').eq('event_id', event.eventId)
  assert.equal(left, caps.reduce((n, c) => n + c.capacity, 0) - 5, 'the 5 confirmed entries, not the awaiting one')
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
  assert.deepEqual((await callFn('list-event-registrations', clubAdmin, { eventId: event.eventId })).body.counts, { paid: 4, awaiting: 1, free: 1, placesLeft: left, awaitingConsent: 0 })
})

test('P-45 a free event: list-event-registrations and the start list count its entries as free', async () => {
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
  assert.deepEqual(r.body.counts, { paid: 0, awaiting: 0, free: 1, placesLeft: await placesLeft(event.eventId), awaitingConsent: 0 })
  assert.equal(r.body.data[0].paymentStatus, 'free')
  assert.equal(r.body.data[0].expiresAt, null)

  // I1: the public list says the same — free, never „opłacone”.
  const { data: list } = await anon.rpc('start_list', { p_event_id: event.eventId })
  assert.deepEqual(list.competitions.map(({ paid, free, awaiting }) => ({ paid, free, awaiting })), [{ paid: 0, free: 1, awaiting: 0 }])
  assert.deepEqual(list.entries.map((e) => [e.name, e.payment]), [['Ola Leśna', 'free']])
})

// ---------------------------------------------------------------- Plan 4 task 7 (G-40, G-41)

const KIDS = { name: 'Bieg dzieci 1 km', discipline: 'run', distanceLabel: '1 km', startTime: '09:00', capacity: 20 }

/** A paid event with „Bieg 9 km” and a kids competition holding the kids group „Dzieci I”. */
async function familyEvent() {
  const event = await createPublishedPaidEvent(owner, {
    competitions: [BIEG, KIDS], prices: { 'Bieg 9 km': 6000, 'Bieg dzieci 1 km': 2000 },
  })
  const [bieg, kids] = event.categoryIds
  const { error: kErr } = await db().from('competitions').update({ is_kids: true }).eq('category_id', kids)
  if (kErr) throw kErr
  const { data: group, error: gErr } = await db().from('kids_groups')
    .insert({ category_id: kids, label: 'Dzieci I', birth_year_from: 2014, birth_year_to: 2019 }).select('id').single()
  if (gErr) throw gErr
  return { event, bieg, kids, kidsGroupId: group.id }
}

/** A family order (a parent in „Bieg 9 km”, a child in the kids group), paid when `pay`. */
async function familyOrder(f, { parent, child, added, pay }) {
  const buyerEmail = runnerEmail('family')
  const people = [
    adult(f.bieg, 'self', buyerEmail, parent),
    minor(f.kids, { kidsGroupId: f.kidsGroupId, ...child }),
    ...(added ? [adult(f.bieg, 'adult', runnerEmail('added'), added)] : []),
  ]
  const buyerName = `${parent.firstName} ${parent.lastName}`
  const o = await orderGroupOk(f.event, people, { meta: await groupMeta(f.event.eventId, { buyerName }) })
  if (pay) {
    const { txn } = await attemptFor(o.orderId, o.total)
    const r = await confirmOk(o.orderId, txn, o.total)
    assert.equal(r.outcome, 'confirmed')
  }
  return { ...o, buyerEmail, people }
}

/** Every string value at any depth of a JSON value. */
function valuesOf(value, out = []) {
  if (Array.isArray(value)) for (const v of value) valuesOf(v, out)
  else if (value && typeof value === 'object') for (const v of Object.values(value)) valuesOf(v, out)
  else if (value !== null && value !== undefined) out.push(String(value))
  return out
}

test('G-40 start_list: gender and the kids-group label; no birth, @, phone, bib, price, order, consent or guardian at any depth; a child whose guardian deleted their account stays listed', async () => {
  const f = await familyEvent()
  const fam = await familyOrder(f, {
    parent: { firstName: 'Marta', lastName: 'Opiekuńcza', city: 'Gliwice', club: 'ZATYRANI', phone: '+48500777888', birthDate: '1984-04-04', gender: 'K', ageGroupLabel: 'K40' },
    child: { firstName: 'Zosia', lastName: 'Wiśniewska', city: 'Pilchowice', club: 'UKS Sokół', birthDate: '2016-05-05', gender: 'K', ageGroupLabel: 'K dzieci', phone: '+48500999111' },
    added: { firstName: 'Jan', lastName: 'Dodany', city: 'Zabrze', gender: 'M', ageGroupLabel: 'M open', birthDate: '1979-09-09' },
    pay: true,
  })

  const { data, error } = await anon.rpc('start_list', { p_event_id: f.event.eventId })
  assert.equal(error, null, error?.message)
  const byName = Object.fromEntries(data.entries.map((e) => [e.name, e]))
  assert.deepEqual(byName['Zosia Wiśniewska'], {
    name: 'Zosia Wiśniewska', town: null, club: 'UKS Sokół', categoryId: f.kids, competition: 'Bieg dzieci 1 km',
    ageGroupLabel: 'K dzieci', kidsGroupLabel: 'Dzieci I', gender: 'K', payment: 'paid',
  })
  assert.equal(byName['Marta Opiekuńcza'].gender, 'K')
  assert.equal(byName['Marta Opiekuńcza'].kidsGroupLabel, null, 'not a kids competition')
  // Review F2: an added adult awaiting consent is counted, never listed by name.
  assert.equal(byName['Jan Dodany'], undefined)
  assert.equal(data.competitions.find((c) => c.categoryId === f.bieg).paid, 2)

  // The walk: no forbidden key, by substring, at any depth.
  for (const k of keysOf(data)) {
    for (const bad of ['birth', '@', 'phone', 'bib', 'price', 'order', 'consent', 'guardian']) {
      assert.ok(!k.includes(bad), `start_list has a key ${k}`)
    }
  }
  // …and no forbidden value.
  const { data: regs } = await db().from('registrations')
    .select('birth_date, phone, email, guardian_email, guardian_name, consent_state, price, list_price').eq('order_id', fam.orderId)
  const values = valuesOf(data)
  for (const v of values) {
    assert.ok(!v.includes('@'), `an address: ${v}`)
    assert.ok(!/^\d{4}-\d{2}-\d{2}/.test(v), `a date: ${v}`)
    assert.ok(!['accepted', 'awaiting', 'pending_payment', 'confirmed'].includes(v), `a status: ${v}`)
    assert.notEqual(v, fam.orderId)
  }
  const text = JSON.stringify(data)
  for (const r of regs) {
    for (const s of [r.birth_date, r.phone, r.email, r.guardian_email]) if (s) assert.ok(!text.includes(s), `${s} leaked`)
    for (const n of [r.price, r.list_price]) assert.ok(!values.includes(String(n)), `a price ${n} leaked`)
  }
  assert.ok(!text.includes('Pilchowice'), "a minor's town leaked")
  assert.ok(!text.includes('500777888') && !text.includes('500999111'), 'a phone number leaked')

  // The office records his consent: now he is listed.
  const { error: oErr } = await db().from('registrations').update({ consent_state: 'office' })
    .eq('order_id', fam.orderId).eq('first_name', 'Jan')
  assert.equal(oErr, null)
  const jan = (await anon.rpc('start_list', { p_event_id: f.event.eventId })).data.entries.find((e) => e.name === 'Jan Dodany')
  assert.equal(jan.gender, 'M')
  assert.equal(jan.town, 'Zabrze')

  // The parent deletes their account (what delete-my-account writes): their own entry is
  // anonymised and leaves the list; the child's entry only loses the guardian fields.
  const { error: d1 } = await db().from('registrations')
    .update({ first_name: 'Usunięte konto', last_name: 'Usunięte konto', email: null, phone: null, birth_date: null, city: null, club: null })
    .eq('order_id', fam.orderId).eq('email', fam.buyerEmail)
  assert.equal(d1, null)
  const { error: d2 } = await db().from('registrations')
    .update({ guardian_profile_id: null, guardian_name: 'Usunięte konto', guardian_email: null })
    .eq('order_id', fam.orderId).is('email', null)
  assert.equal(d2, null)

  const after = (await anon.rpc('start_list', { p_event_id: f.event.eventId })).data
  assert.deepEqual(after.entries.map((e) => e.name).sort(), ['Jan Dodany', 'Zosia Wiśniewska'])
  assert.equal(after.entries.find((e) => e.name === 'Zosia Wiśniewska').kidsGroupLabel, 'Dzieci I')
  assert.ok(!JSON.stringify(after).includes('Usunięte konto'))
  assert.ok(!JSON.stringify(after).includes('Opiekuńcza'))
  // Still counted: the deleted entry keeps its slot.
  assert.equal(after.competitions.find((c) => c.categoryId === f.bieg).paid, 2)
})

test('G-41 start_list counts after a family with one paid and one pending order: paid + free = taken, awaiting = 1 per competition, the pending people unlisted', async () => {
  const f = await familyEvent()
  await familyOrder(f, {
    parent: { firstName: 'Marta', lastName: 'Płacąca', city: 'Gliwice', gender: 'K' },
    child: { firstName: 'Ola', lastName: 'Płacąca', birthDate: '2015-01-01', gender: 'K' },
    pay: true,
  })
  const pending = await familyOrder(f, {
    parent: { firstName: 'Tomasz', lastName: 'Czekający', city: 'Zabrze', gender: 'M', ageGroupLabel: 'M open' },
    child: { firstName: 'Kuba', lastName: 'Czekający', birthDate: '2016-02-02', gender: 'M', ageGroupLabel: 'M dzieci' },
    pay: false,
  })
  assert.equal(pending.status ?? 'pending', 'pending')

  const { data } = await anon.rpc('start_list', { p_event_id: f.event.eventId })
  const { data: comps } = await db().from('competitions').select('category_id, taken').eq('event_id', f.event.eventId)
  const taken = Object.fromEntries(comps.map((c) => [c.category_id, c.taken]))
  for (const c of data.competitions) {
    assert.equal(c.paid + c.free, taken[c.categoryId], `${c.name}: paid + free is taken`)
    assert.equal(c.paid + c.free, 1, c.name)
    assert.equal(c.awaiting, 1, c.name)
  }
  assert.deepEqual(data.entries.map((e) => e.name).sort(), ['Marta Płacąca', 'Ola Płacąca'])
  assert.ok(!JSON.stringify(data).includes('Czekający'), 'a pending person is listed')
})

// ---------------------------------------------------------------- Task 7 review fix round 1 (G-50, G-51)

test('G-50 a 0 zł kids competition inside a paid family order: the child is free, the parent paid, on the start list and in Zgłoszenia', async () => {
  const event = await createPublishedPaidEvent(owner, {
    competitions: [BIEG, KIDS], prices: { 'Bieg 9 km': 6000, 'Bieg dzieci 1 km': 0 },
  })
  const [bieg, kids] = event.categoryIds
  const { error: kErr } = await db().from('competitions').update({ is_kids: true }).eq('category_id', kids)
  assert.equal(kErr, null)
  const o = await orderGroupOk(event, [
    adult(bieg, 'self', runnerEmail('fam0'), { firstName: 'Marta', lastName: 'Płatna', gender: 'K' }),
    minor(kids, { firstName: 'Ola', lastName: 'Darmowa', birthDate: '2016-03-03', gender: 'K' }),
  ], { meta: await groupMeta(event.eventId, { buyerName: 'Marta Płatna' }) })
  assert.ok(o.total > 0)
  const { txn } = await attemptFor(o.orderId, o.total)
  assert.equal((await confirmOk(o.orderId, txn, o.total)).outcome, 'confirmed')

  const { data } = await anon.rpc('start_list', { p_event_id: event.eventId })
  const byName = Object.fromEntries(data.entries.map((e) => [e.name, e]))
  assert.equal(byName['Marta Płatna'].payment, 'paid')
  assert.equal(byName['Ola Darmowa'].payment, 'free')
  assert.deepEqual(data.competitions.map(({ isKids, paid, free, awaiting }) => ({ isKids, paid, free, awaiting })), [
    { isKids: false, paid: 1, free: 0, awaiting: 0 },
    { isKids: true, paid: 0, free: 1, awaiting: 0 },
  ])

  const r = await callFn('list-event-registrations', owner, { eventId: event.eventId })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const org = Object.fromEntries(r.body.data.map((x) => [x.name, x]))
  assert.equal(org['Marta Płatna'].paymentStatus, 'paid')
  assert.equal(org['Ola Darmowa'].paymentStatus, 'free')
  assert.equal(r.body.counts.paid, 1)
  assert.equal(r.body.counts.free, 1)
  assert.ok(!('price' in org['Ola Darmowa']), 'the price is not returned')
})

test('G-51 an added adult is counted but listed only once they accept online or the office records consent', async () => {
  const f = await familyEvent()
  const fam = await familyOrder(f, {
    parent: { firstName: 'Ewa', lastName: 'Kupująca', city: 'Gliwice', gender: 'K' },
    child: { firstName: 'Ala', lastName: 'Kupująca', birthDate: '2016-04-04', gender: 'K' },
    added: { firstName: 'Piotr', lastName: 'Dopisany', city: 'Rybnik', gender: 'M', ageGroupLabel: 'M open' },
    pay: true,
  })
  const list = async () => (await anon.rpc('start_list', { p_event_id: f.event.eventId })).data
  const { data: comps } = await db().from('competitions').select('category_id, taken').eq('event_id', f.event.eventId)
  const taken = Object.fromEntries(comps.map((c) => [c.category_id, c.taken]))

  const before = await list()
  assert.ok(!JSON.stringify(before).includes('Dopisany'), 'listed before consent')
  for (const c of before.competitions) assert.equal(c.paid + c.free, taken[c.categoryId], c.name)
  assert.equal(before.competitions.find((c) => c.categoryId === f.bieg).paid, 2)

  for (const state of ['accepted', 'office']) {
    const { error } = await db().from('registrations').update({ consent_state: state })
      .eq('order_id', fam.orderId).eq('last_name', 'Dopisany')
    assert.equal(error, null)
    const after = await list()
    assert.equal(after.entries.find((e) => e.name === 'Piotr Dopisany')?.town, 'Rybnik', state)
    assert.equal(after.competitions.find((c) => c.categoryId === f.bieg).paid, 2)
  }
})
