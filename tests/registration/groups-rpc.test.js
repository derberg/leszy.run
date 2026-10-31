// Plan 4, task 2: the group RPCs. register_free(p_people, p_profile_id, p_meta) and
// create_order(p_people, p_profile_id, …) take a group whose people each carry their own
// categoryId and role. Scenarios G-10…G-13, G-14 (f), G-15…G-17 in
// docs/registration/scenario-matrix.md. LOCAL stack only; every event and address is random.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { localEnv, sessionFor } from './helpers/stack.js'
import { acceptAgreement, callFn, createPublishedFreeEvent, createPublishedPaidEvent } from './helpers/registrationFixtures.js'
import {
  attemptFor, competitionOf, confirm, confirmOk, consentIds, createOrder, expireNow, liveSlots, orderOf,
  orderOk, paidOrderOk, person, profileFor, registrationsOf, rows, rpc, runnerEmail,
} from './helpers/orders.js'
import {
  BIEG, DZIECI, adult, groupMeta, groupTotal, minor, orderGroup, orderGroupOk, registerGroup,
} from './helpers/groups.js'

let owner
before(async () => {
  await acceptAgreement('zatyrani-test')
  owner = await sessionFor('owner@zatyrani-test.local')
})

const free2 = (c1 = 50, c2 = 50) => createPublishedFreeEvent(owner, { competitions: [BIEG(c1), DZIECI(c2)] })
const paid2 = (c1 = 50, c2 = 50) => createPublishedPaidEvent(owner, {
  prices: { 'Bieg 9 km': 6000, 'Bieg dzieci 1 km': 2000 }, competitions: [BIEG(c1), DZIECI(c2)],
})
const taken = async (cat) => (await competitionOf(cat)).taken
const byEvent = (eventId) => rows('registrations', { event_id: eventId })
const acceptancesOf = async (registrationId) => rows('consent_acceptances', { registration_id: registrationId })
const kinds = (list) => list.map((a) => a.consent_kind).sort()

// ---------------------------------------------------------------- G-10

test('G-10 a free family (self 9 km, adult 9 km, minor kids): roles, guardian fields, consents, slots, participants', async () => {
  const event = await free2()
  const [c9, kids] = event.categoryIds
  const me = runnerEmail('self')
  const partner = runnerEmail('adult')
  const profileId = await profileFor(me)
  const people = [
    adult(c9, 'self', me),
    adult(c9, 'adult', partner, { firstName: 'Jan', gender: 'M', ageGroupLabel: 'M open' }),
    minor(kids),
  ]
  const r = await registerGroup(event, people, { profileId })
  assert.equal(r.error, null, r.error?.message)

  const out = r.data.registrations
  assert.equal(out.length, 3)
  assert.deepEqual(out.map((x) => [x.index, x.role, x.categoryId]), [[0, 'self', c9], [1, 'adult', c9], [2, 'minor', kids]])
  assert.ok(out.every((x) => x.id && x.participantId), 'free → confirmed at once, every person has a participant')
  assert.deepEqual(Object.keys(out[0]).sort(), ['categoryId', 'id', 'index', 'participantId', 'role'])

  assert.equal(await taken(c9), 2)
  assert.equal(await taken(kids), 1)

  const regs = await byEvent(event.eventId)
  assert.equal(regs.length, 3)
  const reg = (i) => regs.find((x) => x.id === out[i].id)
  assert.ok(regs.every((x) => x.status === 'confirmed'))
  assert.ok(regs.every((x) => x.registered_by_profile_id === profileId), 'registered_by on every row')
  assert.deepEqual([0, 1, 2].map((i) => reg(i).consent_state), ['accepted', 'awaiting', 'accepted'])
  assert.equal(reg(0).profile_id, profileId, 'the self row belongs to the buyer')
  assert.equal(reg(1).profile_id, null, 'the added adult is not the buyer')

  const child = reg(2)
  assert.equal(child.email, null)
  assert.equal(child.profile_id, null)
  assert.equal(child.guardian_profile_id, profileId)
  assert.equal(child.guardian_email, me)
  assert.equal(child.guardian_name, 'Ola Leśna')
  assert.equal(child.first_name, 'Zosia')

  const parts = await rows('participants', { event_id: event.eventId })
  assert.equal(parts.length, 3)
  assert.equal(parts.find((p) => p.registration_id === child.id).email, null)

  assert.deepEqual(kinds(await acceptancesOf(out[0].id)), ['data_info', 'image', 'regulamin', 'service_regulamin'])
  assert.ok((await acceptancesOf(out[0].id)).every((a) => a.accepted_as === 'self'))
  assert.equal((await acceptancesOf(out[1].id)).length, 0, 'the added adult accepts later, by e-mail')
  const childAcc = await acceptancesOf(out[2].id)
  assert.deepEqual(kinds(childAcc), ['data_info', 'image', 'regulamin', 'service_regulamin'])
  assert.ok(childAcc.every((a) => a.accepted_as === 'guardian' && a.accepted_by_profile_id === profileId))
  await Promise.all([c9, kids].map(async (c) => assert.equal(await taken(c), await liveSlots(c))))
})

// ---------------------------------------------------------------- G-11

test('G-11 a paid group over two competitions, one without room for its people → full:<that id>, nothing created', async () => {
  const event = await paid2(5, 1)
  const [c9, kids] = event.categoryIds
  await paidOrderOk(event, { categoryId: kids, price: 2000, people: [person(runnerEmail('kid-paid'), { birthDate: '2015-01-01' })] })
  assert.equal(await taken(kids), 1)

  const me = runnerEmail('self')
  const r = await orderGroup(event, [adult(c9, 'self', me), adult(c9, 'adult'), minor(kids)])
  assert.equal(r.error?.message, `full:${kids}`)
  assert.equal(await taken(c9), 0)
  assert.equal(await taken(kids), 1)
  assert.equal((await rows('orders', { buyer_email: me })).length, 0, 'no order')
})

test('G-11 pending orders hold no place: 3 pending single orders with 2 places left do not stop a group of 2', async () => {
  const event = await paid2(3, 50)
  const [c9] = event.categoryIds
  await paidOrderOk(event, { categoryId: c9 })
  for (let i = 0; i < 3; i++) await orderOk(event, { categoryId: c9 })
  assert.equal(await taken(c9), 1)
  const out = await orderGroupOk(event, [adult(c9, 'self'), adult(c9, 'adult')])
  assert.equal(out.status, 'pending')
  assert.equal(await taken(c9), 1, 'a pending group claims nothing')
  assert.ok(out.registrations.every((x) => x.participantId === null), 'no participant while pending_payment')
})

test('G-11b two paid groups for the last places: both ordered, both pay → the first confirms, the second is refunded whole', async () => {
  const event = await paid2(1, 1)
  const [c9, kids] = event.categoryIds
  const g1 = await orderGroupOk(event, [adult(c9, 'self'), minor(kids)])
  const g2 = await orderGroupOk(event, [adult(c9, 'self'), minor(kids, { firstName: 'Kuba', gender: 'M' })])
  const a1 = await attemptFor(g1.orderId, g1.total)
  const a2 = await attemptFor(g2.orderId, g2.total)

  assert.equal((await confirmOk(g1.orderId, a1.txn, g1.total)).outcome, 'confirmed')
  const second = await confirmOk(g2.orderId, a2.txn, g2.total)
  assert.equal(second.outcome, 'late_refund')
  assert.equal(second.refund.reason, 'full')
  assert.equal(second.refund.grosze, g2.total, 'the whole order')
  assert.deepEqual((await registrationsOf(g2.orderId)).map((x) => x.status), ['cancelled', 'cancelled'], 'nobody of the group confirmed')
  assert.ok((await registrationsOf(g2.orderId)).every((x) => x.participant_id === null))
  assert.equal(await taken(c9), 1)
  assert.equal(await taken(kids), 1)
  assert.equal((await taken(c9)) + (await taken(kids)), 2)
})

test('G-11c once the first group paid, the second cannot start a payment: order_fits false, order-status full, pay-order 409', async () => {
  const event = await paid2(1, 1)
  const [c9, kids] = event.categoryIds
  const first = runnerEmail('first')
  const second = runnerEmail('second')
  const g1 = await orderGroupOk(event, [adult(c9, 'self', first), minor(kids)])
  const g2 = await orderGroupOk(event, [adult(c9, 'self', second), minor(kids, { firstName: 'Kuba', gender: 'M' })])
  // While a window is open both competitions are in use (D4-17).
  for (const c of [c9, kids]) assert.equal((await rpc('registration_competition_in_use', { p_category_id: c })).data, true)
  assert.equal((await rpc('registration_order_fits', { p_order_id: g2.orderId })).data, true)

  const a1 = await attemptFor(g1.orderId, g1.total)
  assert.equal((await confirmOk(g1.orderId, a1.txn, g1.total)).outcome, 'confirmed')
  assert.equal((await rpc('registration_order_fits', { p_order_id: g2.orderId })).data, false)

  const session = await sessionFor(second)
  const status = await callFn('order-status', session, { orderId: g2.orderId })
  assert.equal(status.status, 200, JSON.stringify(status.body))
  assert.equal(status.body.data.full, true)
  const pay = await callFn('pay-order', session, { orderId: g2.orderId })
  assert.equal(pay.status, 409, JSON.stringify(pay.body))
  assert.equal(pay.body.code, 'full')
  assert.equal((await rows('payment_attempts', { order_id: g2.orderId })).length, 0, 'no dpay transaction')
})

// ---------------------------------------------------------------- G-12

test('G-12 person 2\'s address is already live → duplicate:1, no rows, taken unchanged', async () => {
  const event = await free2()
  const [c9, kids] = event.categoryIds
  const taken9 = runnerEmail('taken')
  assert.equal((await registerGroup(event, [adult(c9, 'self', taken9)])).error, null)
  assert.equal(await taken(c9), 1)

  const me = runnerEmail('self')
  const r = await registerGroup(event, [adult(c9, 'self', me), adult(c9, 'adult', taken9.toUpperCase()), minor(kids)])
  assert.equal(r.error?.message, 'duplicate:1')
  assert.equal((await byEvent(event.eventId)).length, 1)
  assert.equal(await taken(c9), 1)
  assert.equal(await taken(kids), 0)

  const paid = await paid2()
  assert.equal((await orderGroup(paid, [adult(paid.categoryIds[0], 'self'), adult(paid.categoryIds[0], 'adult', me), adult(paid.categoryIds[0], 'adult', me)])).error?.message,
    'duplicate:2', 'the same address twice in one paid group')
})

test('G-12 / G-17 the same child twice across requests (another case, trailing spaces) → duplicate', async () => {
  const event = await free2()
  const [c9, kids] = event.categoryIds
  assert.equal((await registerGroup(event, [adult(c9, 'self'), minor(kids)])).error, null)
  const r = await registerGroup(event, [adult(c9, 'self'), minor(kids, { firstName: 'ZOSIA  ', lastName: ' leśna' })])
  assert.equal(r.error?.message, 'duplicate:1')
  assert.equal(await taken(kids), 1)

  const paid = await paid2()
  const [p9, pkids] = paid.categoryIds
  await orderGroupOk(paid, [adult(p9, 'self'), minor(pkids)])
  assert.equal((await orderGroup(paid, [minor(pkids, { firstName: 'zosia ' })], { buyerEmail: runnerEmail('mum') })).error?.message,
    'duplicate:0', 'a pending child counts as live')
  // Another child of the same name with another birth date is somebody else.
  assert.equal((await orderGroup(paid, [minor(pkids, { birthDate: '2017-02-02' })], { buyerEmail: runnerEmail('mum') })).error, null)
})

// ---------------------------------------------------------------- G-13

test('G-13 every person at their own price: 60 + 60 + 20 → entry_total 14000, one line per person', async () => {
  const event = await paid2()
  const [c9, kids] = event.categoryIds
  const people = [adult(c9, 'self'), adult(c9, 'adult'), minor(kids)]
  const out = await orderGroupOk(event, people)
  assert.equal(out.amounts.entryTotal, 14000)
  assert.equal(out.total, groupTotal(event, people))
  const order = await orderOf(out.orderId)
  assert.equal(order.entry_total, 14000)
  assert.equal(order.status, 'pending')
  const regs = await registrationsOf(out.orderId)
  assert.deepEqual(regs.map((x) => x.price).sort(), [2000, 6000, 6000])
  assert.ok(regs.every((x) => x.status === 'pending_payment'))
  const lines = await rows('order_lines', { order_id: out.orderId })
  assert.deepEqual(lines.map((l) => l.amount).sort(), [2000, 6000, 6000])
  assert.deepEqual(Object.keys(out).sort(), ['amounts', 'expiresAt', 'orderId', 'registrations', 'status', 'total'])
  assert.deepEqual(out.registrations.map((x) => [x.index, x.role, x.categoryId]), [[0, 'self', c9], [1, 'adult', c9], [2, 'minor', kids]])

  // A stale displayed total names the server's.
  assert.equal((await orderGroup(event, [adult(c9, 'self'), minor(kids)], { displayed: 1 })).error?.message,
    `price_changed:${groupTotal(event, [{ categoryId: c9 }, { categoryId: kids }])}`)
})

test('G-13 an uppercase categoryId is priced like a lowercase one (no 500)', async () => {
  const event = await paid2()
  const [c9, kids] = event.categoryIds
  const people = [adult(c9.toUpperCase(), 'self'), minor(kids.toUpperCase())]
  const r = await orderGroup(event, people, { displayed: groupTotal(event, [{ categoryId: c9 }, { categoryId: kids }]) })
  assert.equal(r.error, null, r.error?.message)
  assert.equal(r.data.amounts.entryTotal, 8000)
  assert.deepEqual(r.data.registrations.map((x) => x.categoryId), [c9, kids])
  const lines = await rows('order_lines', { order_id: r.data.orderId })
  assert.deepEqual(lines.map((l) => l.amount).sort(), [2000, 6000])
})

test('G-13 a 0 zł group claims like a free one and is paid at once', async () => {
  const event = await createPublishedPaidEvent(owner, {
    prices: { 'Bieg 9 km': 0, 'Bieg dzieci 1 km': 0 }, competitions: [BIEG(), DZIECI()],
  })
  const [c9, kids] = event.categoryIds
  const out = await orderGroupOk(event, [adult(c9, 'self'), adult(c9, 'adult'), minor(kids)])
  assert.equal(out.status, 'paid')
  assert.equal(out.total, 0)
  assert.ok(out.registrations.every((x) => x.participantId))
  assert.equal(await taken(c9), 2)
  assert.equal(await taken(kids), 1)
})

// ---------------------------------------------------------------- G-14 (f)

test('G-14f a paid group over two competitions: expiry releases nothing; payment +2 / +1; a buyer cancel frees every address', async () => {
  const event = await paid2()
  const [c9, kids] = event.categoryIds

  const expiring = await orderGroupOk(event, [adult(c9, 'self'), adult(c9, 'adult'), minor(kids)])
  assert.ok(await expireNow(expiring.orderId) >= 1)
  assert.equal((await orderOf(expiring.orderId)).status, 'expired')
  assert.equal(await taken(c9), 0)
  assert.equal(await taken(kids), 0)

  const paying = await orderGroupOk(event, [adult(c9, 'self'), adult(c9, 'adult'), minor(kids, { firstName: 'Kuba' })])
  const att = await attemptFor(paying.orderId, paying.total)
  assert.equal((await confirmOk(paying.orderId, att.txn, paying.total)).outcome, 'confirmed')
  assert.equal(await taken(c9), 2)
  assert.equal(await taken(kids), 1)
  assert.ok((await registrationsOf(paying.orderId)).every((x) => x.status === 'confirmed' && x.participant_id))

  const me = runnerEmail('self')
  const partner = runnerEmail('adult')
  const child = { firstName: 'Ala', birthDate: '2018-03-03' }
  const group = [adult(c9, 'self', me), adult(c9, 'adult', partner), minor(kids, child)]
  const cancelled = await orderGroupOk(event, group)
  const buyer = await profileFor(me)
  assert.equal((await rpc('buyer_cancel_order', { p_order_id: cancelled.orderId, p_profile_id: buyer })).data, 'cancelled')
  assert.deepEqual((await registrationsOf(cancelled.orderId)).map((x) => x.status), ['cancelled', 'cancelled', 'cancelled'])
  assert.equal(await taken(c9), 2)
  assert.equal(await taken(kids), 1)
  // Every address (and the child) may register again at once (D4-18).
  const again = await orderGroupOk(event, group)
  assert.equal(again.status, 'pending')
  await Promise.all([c9, kids].map(async (c) => assert.equal(await taken(c), await liveSlots(c))))
})

// ---------------------------------------------------------------- G-15

test('G-15 categories of two events in one request → mixed_events, nothing written', async () => {
  const a = await free2()
  const b = await free2()
  const me = runnerEmail('self')
  const r = await registerGroup(a, [adult(a.categoryIds[0], 'self', me), adult(b.categoryIds[0], 'adult')])
  assert.equal(r.error?.message, 'mixed_events')
  assert.equal((await byEvent(a.eventId)).length + (await byEvent(b.eventId)).length, 0)

  const p = await paid2()
  const q = await paid2()
  const o = await orderGroup(p, [adult(p.categoryIds[0], 'self'), adult(q.categoryIds[0], 'adult')],
    { displayed: 0 })
  assert.equal(o.error?.message, 'mixed_events')
})

test('G-15 malformed groups are refused: no categoryId, an unknown role, an adult with no address, a child with no birth date', async () => {
  const event = await free2()
  const [c9, kids] = event.categoryIds
  const { categoryId: _c, ...noCategory } = adult(c9, 'self')
  for (const [people, code] of [
    [[], 'invalid_people'],
    [[noCategory], 'invalid_people'],
    [[{ ...adult(c9, 'self'), categoryId: 'nie-uuid' }], 'invalid_people'],
    [[{ ...adult(c9, 'self'), role: 'kid' }], 'invalid_people'],
    [[adult(c9, 'self'), { ...adult(c9, 'adult'), email: '' }], 'invalid_people'],
    [[adult(c9, 'self'), { ...minor(kids), birthDate: null }], 'invalid_people'],
    [[adult(crypto.randomUUID(), 'self')], 'not_found'],
  ]) {
    const r = await registerGroup(event, people, { buyerEmail: runnerEmail('b') })
    assert.equal(r.error?.message, code, JSON.stringify(people))
  }
  // A child needs a signed-in guardian.
  const r = await registerGroup(event, [minor(kids)], { profileId: null })
  assert.equal(r.error?.message, 'session_required')
  assert.equal((await byEvent(event.eventId)).length, 0)
})

// ---------------------------------------------------------------- G-16

test('G-16 both overloads of register_free and create_order: SECURITY DEFINER, empty search_path, service_role only; the internal helpers executable by nobody', async () => {
  const postgres = (await import('postgres')).default
  const sql = postgres(localEnv().dbUrl, { max: 1, onnotice: () => {} })
  try {
    const fns = await sql`
      select p.oid::regprocedure::text as sig, p.prosecdef, p.proconfig,
             has_function_privilege('anon', p.oid, 'execute') as anon,
             has_function_privilege('authenticated', p.oid, 'execute') as authd,
             has_function_privilege('service_role', p.oid, 'execute') as svc
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname in ('register_free', 'create_order')
       order by 1`
    assert.deepEqual(fns.map((f) => f.sig), [
      'create_order(jsonb,uuid,text,integer,jsonb)',
      'create_order(uuid,jsonb,uuid,text,integer,jsonb)',
      'register_free(jsonb,uuid,jsonb)',
      'register_free(uuid,jsonb,uuid,jsonb)',
    ])
    for (const f of fns) {
      assert.equal(f.prosecdef, true, `${f.sig} security definer`)
      assert.deepEqual(f.proconfig, ['search_path=""'], `${f.sig} search_path`)
      assert.equal(f.anon, false, `${f.sig} anon`)
      assert.equal(f.authd, false, `${f.sig} authenticated`)
      assert.equal(f.svc, true, `${f.sig} service_role`)
    }
    // The internal helpers run only inside the SECURITY DEFINER RPCs: nobody else may call them.
    const helpers = await sql`
      select p.oid::regprocedure::text as sig,
             has_function_privilege('anon', p.oid, 'execute') as anon,
             has_function_privilege('authenticated', p.oid, 'execute') as authd,
             has_function_privilege('service_role', p.oid, 'execute') as svc
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname in ('registration_group_lock', 'registration_group_insert', 'registration_group_claim')`
    assert.equal(helpers.length, 3, helpers.map((f) => f.sig).join())
    for (const f of helpers) {
      assert.equal(f.anon, false, `${f.sig} anon`)
      assert.equal(f.authd, false, `${f.sig} authenticated`)
      assert.equal(f.svc, false, `${f.sig} service_role`)
    }
  } finally {
    await sql.end()
  }

  const { createClient } = await import('@supabase/supabase-js')
  const { url, anonKey } = localEnv()
  const anon = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const f = await anon.rpc('register_free', { p_people: [], p_profile_id: null, p_meta: {} })
  assert.match(f.error?.message ?? '', /permission denied/)
  const o = await anon.rpc('create_order', {
    p_people: [], p_profile_id: null, p_buyer_email: null, p_displayed_total: 0, p_meta: {},
  })
  assert.match(o.error?.message ?? '', /permission denied/)
})

test('G-16 registered_by_profile_id references profiles (on delete set null) and is indexed', async () => {
  const postgres = (await import('postgres')).default
  const sql = postgres(localEnv().dbUrl, { max: 1, onnotice: () => {} })
  try {
    const [fk] = await sql`
      select confdeltype, confrelid::regclass::text as target from pg_constraint
       where conrelid = 'public.registrations'::regclass and contype = 'f'
         and conkey = array[(select attnum from pg_attribute where attrelid = 'public.registrations'::regclass
                                                          and attname = 'registered_by_profile_id')]`
    assert.equal(fk?.target, 'profiles')
    assert.equal(fk?.confdeltype, 'n')
    const idx = await sql`select indexdef from pg_indexes where schemaname = 'public' and tablename = 'registrations'`
    assert.ok(idx.some((i) => /\(registered_by_profile_id\)/.test(i.indexdef)), 'indexed')
    assert.ok(idx.some((i) => /UNIQUE/.test(i.indexdef) && /lower\(btrim\(first_name\)\)/.test(i.indexdef) && /email IS NULL/.test(i.indexdef)),
      'the minors\' unique index')
  } finally {
    await sql.end()
  }
})

// ---------------------------------------------------------------- G-17

test('G-17 the old register_free(cat, people, profile, meta) still works: same rows, same shape, bare errors', async () => {
  const event = await createPublishedFreeEvent(owner, { competitions: [BIEG(1)] })
  const cat = event.categoryIds[0]
  const email = runnerEmail('old')
  const profileId = await profileFor(email)
  const meta = { consentIds: await consentIds(event.eventId), ip: '203.0.113.9', userAgent: 'test' }
  const call = (e, profile = profileId) => rpc('register_free', {
    p_category_id: cat, p_people: [person(e)], p_profile_id: profile, p_meta: meta,
  })
  const r = await call(email)
  assert.equal(r.error, null, r.error?.message)
  assert.equal(r.data.registrations.length, 1)
  assert.deepEqual(Object.keys(r.data.registrations[0]).sort(), ['email', 'id', 'participantId'])
  assert.equal(r.data.registrations[0].email, email)
  const [row] = await byEvent(event.eventId)
  assert.equal(row.consent_state, 'accepted')
  assert.equal(row.profile_id, profileId)
  assert.equal(row.registered_by_profile_id, profileId)
  const acc = await acceptancesOf(row.id)
  assert.deepEqual(kinds(acc), ['data_info', 'image', 'regulamin', 'service_regulamin'])
  assert.ok(acc.every((a) => a.accepted_as === 'self'))

  assert.equal((await call(email.toUpperCase())).error?.message, 'duplicate')
  assert.equal((await call(runnerEmail('late'), null)).error?.message, 'full')
  assert.equal((await rpc('register_free', { p_category_id: cat, p_people: [], p_profile_id: null, p_meta: meta })).error?.message,
    'invalid_people')
})

test('G-17 the old create_order(cat, …) still works: Plan 3\'s object, bare full / duplicate', async () => {
  const event = await paid2(1, 50)
  const [c9] = event.categoryIds
  const email = runnerEmail('old')
  const out = await orderOk(event, { categoryId: c9, emails: [email] })
  assert.deepEqual(Object.keys(out).sort(), ['amounts', 'expiresAt', 'orderId', 'status', 'total'])
  assert.equal(out.amounts.entryTotal, 6000)
  const [reg] = await registrationsOf(out.orderId)
  assert.equal(reg.consent_state, 'accepted')
  assert.equal(reg.registered_by_profile_id, await profileFor(email))
  assert.deepEqual(kinds(await acceptancesOf(reg.id)), ['data_info', 'image', 'regulamin', 'service_regulamin'])
  assert.equal((await createOrder(event, { categoryId: c9, emails: [email] })).error?.message, 'duplicate')
  const att = await attemptFor(out.orderId, out.total)
  await confirmOk(out.orderId, att.txn, out.total)
  assert.equal((await createOrder(event, { categoryId: c9 })).error?.message, 'full')
})

test('G-17 a minor-only group: one service_regulamin acceptance per minor row, by the buyer as guardian', async () => {
  const event = await free2()
  const [, kids] = event.categoryIds
  const mum = runnerEmail('mum')
  const profileId = await profileFor(mum)
  const r = await registerGroup(event, [minor(kids), minor(kids, { firstName: 'Kuba', gender: 'M' })],
    { profileId, meta: await groupMeta(event.eventId, { buyerName: 'Anna Leśna' }) })
  assert.equal(r.error, null, r.error?.message)
  for (const x of r.data.registrations) {
    const acc = await acceptancesOf(x.id)
    const service = acc.filter((a) => a.consent_kind === 'service_regulamin')
    assert.equal(service.length, 1)
    assert.equal(service[0].accepted_by_profile_id, profileId)
    assert.equal(service[0].accepted_as, 'guardian')
    const row = await rows('registrations', { id: x.id })
    assert.equal(row[0].guardian_name, 'Anna Leśna')
    assert.equal(row[0].guardian_email, mum)
  }
  assert.equal(await taken(kids), 2)
  // Nothing was written for the buyer, who does not run.
  assert.equal((await rows('registrations', { email: mum })).length, 0)
})

test('G-17 old-signature confirmations are unchanged: a single pending order confirms, a second into a full competition is refunded', async () => {
  const event = await paid2(1, 50)
  const [c9] = event.categoryIds
  const a = await orderOk(event, { categoryId: c9 })
  const b = await orderOk(event, { categoryId: c9 })
  const aa = await attemptFor(a.orderId, a.total)
  const bb = await attemptFor(b.orderId, b.total)
  assert.equal((await confirmOk(a.orderId, aa.txn, a.total)).outcome, 'confirmed')
  const r = await confirm(b.orderId, bb.txn, b.total)
  assert.equal(r.data.outcome, 'late_refund')
  assert.equal(await taken(c9), 1)
})
