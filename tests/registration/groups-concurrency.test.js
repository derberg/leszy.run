// Plan 4, task 2: concurrency of the group RPCs (G-14 a–e in
// docs/registration/scenario-matrix.md). Every call runs on its own PostgREST
// connection at the same time. Invariants: competitions.taken never passes the
// capacity, equals the confirmed registrations, and no call ends in a deadlock
// (40P01). LOCAL stack only.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { sessionFor } from './helpers/stack.js'
import { acceptAgreement, createPublishedFreeEvent, createPublishedPaidEvent } from './helpers/registrationFixtures.js'
import {
  attemptFor, competitionOf, confirm, consentIds, liveSlots, person, rpc, runnerEmail,
} from './helpers/orders.js'
import { BIEG, DZIECI, adult, isDeadlock, minor, orderGroupOk, registerGroup } from './helpers/groups.js'

let owner
before(async () => {
  await acceptAgreement('zatyrani-test')
  owner = await sessionFor('owner@zatyrani-test.local')
})

const free = (competitions) => createPublishedFreeEvent(owner, { competitions })
const paid = (competitions) => createPublishedPaidEvent(owner, {
  prices: { 'Bieg 9 km': 6000, 'Bieg dzieci 1 km': 2000 }, competitions,
})
const taken = async (cat) => (await competitionOf(cat)).taken

async function assertInvariant(categoryId, label = '') {
  const c = await competitionOf(categoryId)
  assert.ok(c.taken <= c.capacity, `taken ${c.taken} <= capacity ${c.capacity} ${label}`)
  assert.equal(c.taken, await liveSlots(categoryId), `taken = confirmed registrations ${label}`)
}

const trio = (cat) => [adult(cat, 'self'), adult(cat, 'adult'), adult(cat, 'adult')]

// ---------------------------------------------------------------- (a)

test('G-14a capacity 10: 10 parallel free groups of 3 → exactly 3 succeed, the rest full, taken 9', async () => {
  const event = await free([BIEG(10)])
  const cat = event.categoryIds[0]
  const rs = await Promise.all(Array.from({ length: 10 }, () => registerGroup(event, trio(cat))))
  assert.equal(rs.filter((r) => !r.error).length, 3, JSON.stringify(rs.map((r) => r.error?.message)))
  assert.deepEqual([...new Set(rs.filter((r) => r.error).map((r) => r.error.message))], [`full:${cat}`])
  assert.equal(await taken(cat), 9)
  await assertInvariant(cat)
})

test('G-14a2 the same 10 groups paid: 10 orders, taken 0; 10 parallel payments → 3 confirmed, 7 refunded full, taken 9', async () => {
  const event = await paid([BIEG(10)])
  const cat = event.categoryIds[0]
  const orders = await Promise.all(Array.from({ length: 10 }, () => orderGroupOk(event, trio(cat))))
  assert.equal(orders.length, 10)
  assert.equal(await taken(cat), 0)
  const withAtt = await Promise.all(orders.map(async (o) => ({ ...o, att: await attemptFor(o.orderId, o.total) })))
  const rs = await Promise.all(withAtt.map((o) => confirm(o.orderId, o.att.txn, o.total)))
  assert.deepEqual(rs.filter((r) => r.error).map((r) => r.error.message), [])
  const outcomes = rs.map((r) => r.data.outcome)
  assert.equal(outcomes.filter((x) => x === 'confirmed').length, 3, JSON.stringify(outcomes))
  assert.equal(outcomes.filter((x) => x === 'late_refund').length, 7, JSON.stringify(outcomes))
  assert.ok(rs.filter((r) => r.data.outcome === 'late_refund').every((r) => r.data.refund.reason === 'full'))
  assert.equal(await taken(cat), 9)
  await assertInvariant(cat)
})

// ---------------------------------------------------------------- (b)

test('G-14b 50 rounds: group X claims A then B, group Y B then A, in parallel (free) → no deadlock, capacities respected', async () => {
  const event = await free([BIEG(50), DZIECI(50)])
  const [a, b] = event.categoryIds
  const errors = []
  for (let i = 0; i < 50; i++) {
    const rs = await Promise.all([
      registerGroup(event, [adult(a, 'self'), minor(b, { firstName: `X${i}` })]),
      registerGroup(event, [minor(b, { firstName: `Y${i}` }), adult(a, 'self')]),
    ])
    for (const r of rs) {
      assert.ok(!isDeadlock(r), `round ${i}: ${r.error?.message}`)
      if (r.error) errors.push(r.error.message)
    }
  }
  assert.ok(errors.every((m) => m === `full:${a}` || m === `full:${b}`), errors.join())
  await assertInvariant(a)
  await assertInvariant(b)
  assert.equal(await taken(a), 50)
  assert.equal(await taken(b), 50)
})

test('G-14b 50 rounds of two paid group orders over A and B in opposite orders, confirmed in parallel → no deadlock', async () => {
  // 99 places: in the last round both orders are accepted (98 paid + 1 fits) and race for the last place.
  const event = await paid([BIEG(99), DZIECI(99)])
  const [a, b] = event.categoryIds
  const outcomes = {}
  for (let i = 0; i < 50; i++) {
    const x = await orderGroupOk(event, [adult(a, 'self'), minor(b, { firstName: `X${i}` })])
    const y = await orderGroupOk(event, [minor(b, { firstName: `Y${i}` }), adult(a, 'self')])
    const [ax, ay] = await Promise.all([attemptFor(x.orderId, x.total), attemptFor(y.orderId, y.total)])
    const rs = await Promise.all([confirm(x.orderId, ax.txn, x.total), confirm(y.orderId, ay.txn, y.total)])
    for (const r of rs) {
      assert.ok(!isDeadlock(r), `round ${i}: ${r.error?.message}`)
      assert.equal(r.error, null, r.error?.message)
      outcomes[r.data.outcome] = (outcomes[r.data.outcome] ?? 0) + 1
    }
  }
  assert.equal(outcomes.confirmed, 99, JSON.stringify(outcomes))
  assert.equal(outcomes.late_refund, 1, JSON.stringify(outcomes))
  assert.equal(await taken(a), 99)
  await assertInvariant(a)
  await assertInvariant(b)
})

// ---------------------------------------------------------------- (c)

test('G-14c a group of 3 against 3 singles for the last 3 places: one side wins, taken never above capacity', async () => {
  for (let round = 0; round < 5; round++) {
    const event = await free([BIEG(3)])
    const cat = event.categoryIds[0]
    const ids = await consentIds(event.eventId)
    const single = () => rpc('register_free', {
      p_category_id: cat, p_people: [person(runnerEmail('single'))], p_profile_id: null,
      p_meta: { consentIds: ids, ip: null, userAgent: 'test' },
    })
    const [group, ...singles] = await Promise.all([registerGroup(event, trio(cat)), single(), single(), single()])
    for (const r of [group, ...singles]) assert.ok(!isDeadlock(r), r.error?.message)
    const singlesIn = singles.filter((r) => !r.error).length
    if (!group.error) {
      assert.equal(singlesIn, 0, 'the group won: no single got in')
      assert.deepEqual([...new Set(singles.map((r) => r.error?.message))], ['full'])
    } else {
      assert.equal(group.error.message, `full:${cat}`)
      assert.ok(singlesIn >= 1, 'the singles won')
    }
    assert.ok(await taken(cat) <= 3)
    await assertInvariant(cat, `round ${round}`)
  }
})

// ---------------------------------------------------------------- (d)

test('G-14d the same group submitted twice at once → one succeeds, one duplicate', async () => {
  const event = await free([BIEG(50), DZIECI(50)])
  const [a, b] = event.categoryIds
  const people = [adult(a, 'self'), adult(a, 'adult'), minor(b)]
  const rs = await Promise.all([registerGroup(event, people), registerGroup(event, people)])
  assert.equal(rs.filter((r) => !r.error).length, 1, JSON.stringify(rs.map((r) => r.error?.message)))
  assert.match(rs.find((r) => r.error).error.message, /^duplicate:\d$/)
  assert.equal(await taken(a), 2)
  assert.equal(await taken(b), 1)
  await assertInvariant(a)
  await assertInvariant(b)
})

// ---------------------------------------------------------------- (e)

const ITEM = (categoryId, over = {}) => ({
  category_id: categoryId, name: 'Bieg 9 km', kind: 'individual', discipline: 'run', distance_label: '9 km',
  start_time: '10:00', capacity: 50, min_age: null, max_age: null, is_kids: false, timed: true,
  gpx_upload_id: null, price: null, ...over,
})
const KIDS = (categoryId, over = {}) => ITEM(categoryId, {
  name: 'Bieg dzieci 1 km', distance_label: '1 km', start_time: '09:00', ...over,
})
const stage = (event, value) => rpc('stage_registration_section', {
  p_event_id: event.eventId, p_section: 'competitions', p_actor: owner.profileId, p_value: value,
})
const publishChanges = (event) =>
  rpc('publish_registration_changes', { p_event_id: event.eventId, p_actor: owner.profileId, p_expected_updated_at: null })

test('G-14e 20 rounds: a two-competition free group racing „Opublikuj zmiany” (capacity on both) → no 40P01', async () => {
  const event = await free([BIEG(200), DZIECI(200)])
  const [a, b] = event.categoryIds
  for (let i = 0; i < 20; i++) {
    const cap = 200 + i + 1
    const s = await stage(event, { pricing_mode: 'free', items: [ITEM(a, { capacity: cap }), KIDS(b, { capacity: cap })] })
    assert.equal(s.error, null, s.error?.message)
    const [pub, g] = await Promise.all([
      publishChanges(event),
      registerGroup(event, [adult(a, 'self'), minor(b, { firstName: `R${i}` })]),
    ])
    assert.ok(!isDeadlock(pub), `round ${i} publish: ${pub.error?.message}`)
    assert.ok(!isDeadlock(g), `round ${i} group: ${g.error?.message}`)
    assert.equal(pub.error, null, pub.error?.message)
    assert.equal(g.error, null, g.error?.message)
  }
  assert.equal((await competitionOf(a)).capacity, 220)
  await assertInvariant(a)
  await assertInvariant(b)
})

test('G-14e 20 rounds: a paid two-competition group\'s confirm_order racing „Opublikuj zmiany” → no 40P01', async () => {
  const event = await paid([BIEG(200), DZIECI(200)])
  const [a, b] = event.categoryIds
  for (let i = 0; i < 20; i++) {
    const cap = 200 + i + 1
    const s = await stage(event, {
      pricing_mode: 'fixed', items: [ITEM(a, { capacity: cap, price: 6000 }), KIDS(b, { capacity: cap, price: 2000 })],
    })
    assert.equal(s.error, null, s.error?.message)
    const o = await orderGroupOk(event, [adult(a, 'self'), minor(b, { firstName: `R${i}` })])
    const att = await attemptFor(o.orderId, o.total)
    const [pub, c] = await Promise.all([publishChanges(event), confirm(o.orderId, att.txn, o.total)])
    assert.ok(!isDeadlock(pub), `round ${i} publish: ${pub.error?.message}`)
    assert.ok(!isDeadlock(c), `round ${i} confirm: ${c.error?.message}`)
    assert.equal(pub.error, null, pub.error?.message)
    assert.equal(c.data?.outcome, 'confirmed', JSON.stringify(c))
  }
  assert.equal(await taken(a), 20)
  assert.equal(await taken(b), 20)
  await assertInvariant(a)
  await assertInvariant(b)
})
