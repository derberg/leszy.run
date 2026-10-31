// Plan 5, task 3: concurrency of create_team_registration (T-25 in
// docs/registration/scenario-matrix.md). Every call runs on its own PostgREST connection at the
// same time. Invariants: taken never passes the capacity, equals the confirmed teams, and no call
// ends in a deadlock (40P01). LOCAL stack only.
import { afterEach, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { sessionFor } from './helpers/stack.js'
import { acceptAgreement } from './helpers/registrationFixtures.js'
import { attemptFor, competitionOf, confirm, db, orderOf, registrationsOf, rows, rpc, runnerEmail } from './helpers/orders.js'
import { adult, isDeadlock } from './helpers/groups.js'
import { assertSlotInvariant } from './helpers/slotInvariant.js'
import { captain, createTeam, freeTeamEvent, paidTeamEvent, teamName, teamOk } from './helpers/teams.js'

let owner
const seen = new Set()
const watch = (event) => { event.categoryIds.forEach((c) => seen.add(c)); return event }

before(async () => {
  await acceptAgreement('zatyrani-test')
  owner = await sessionFor('owner@zatyrani-test.local')
})
afterEach(async () => {
  for (const categoryId of seen) {
    await assertSlotInvariant(categoryId)
    const c = await competitionOf(categoryId)
    assert.ok(c.taken <= c.capacity, `taken ${c.taken} <= capacity ${c.capacity}`)
  }
  seen.clear()
})

const free = async (opts) => watch(await freeTeamEvent(owner, opts))
const paid = async (opts) => watch(await paidTeamEvent(owner, opts))
const taken = async (cat) => (await competitionOf(cat)).taken
const pair = (cat) => [captain(), adult(cat, 'adult')]
const parallel = (n, fn) => Promise.all(Array.from({ length: n }, (_, i) => fn(i)))
const messages = (rs) => rs.filter((r) => r.error).map((r) => r.error.message)

test('T-25a capacity 3: 10 parallel free teams → exactly 3 succeed, 7 full, taken 3', async () => {
  const event = await free({ capacity: 3 })
  const cat = event.categoryIds[0]
  const rs = await parallel(10, () => createTeam(event, { members: pair(cat) }))
  assert.equal(rs.filter((r) => !r.error).length, 3, JSON.stringify(messages(rs)))
  assert.deepEqual([...new Set(messages(rs))], ['full'])
  assert.equal(await taken(cat), 3)
  assert.equal((await rows('teams', { category_id: cat })).length, 3)
})

test('T-25a2 the same 10 paid: 10 pending, taken 0; 10 parallel payments → 3 confirmed, 7 refunded full, taken 3', async () => {
  const event = await paid({ capacity: 3 })
  const cat = event.categoryIds[0]
  const orders = await parallel(10, () => teamOk(event, { members: pair(cat) }))
  assert.equal((await rows('teams', { category_id: cat })).length, 10)
  assert.equal(await taken(cat), 0)
  const withAtt = await Promise.all(orders.map(async (o) => ({ ...o, att: await attemptFor(o.orderId, o.total) })))
  const rs = await Promise.all(withAtt.map((o) => confirm(o.orderId, o.att.txn, o.total)))
  assert.deepEqual(messages(rs), [])
  const outcomes = rs.map((r) => r.data.outcome)
  assert.equal(outcomes.filter((x) => x === 'confirmed').length, 3, JSON.stringify(outcomes))
  assert.equal(outcomes.filter((x) => x === 'late_refund').length, 7, JSON.stringify(outcomes))
  assert.ok(rs.filter((r) => r.data.outcome === 'late_refund').every((r) => r.data.refund.reason === 'full'))
  assert.equal(await taken(cat), 3)
  const refunded = withAtt.filter((_, i) => outcomes[i] === 'late_refund')
  for (const o of refunded) {
    assert.deepEqual((await registrationsOf(o.orderId)).map((r) => r.status), ['cancelled', 'cancelled'])
    assert.equal((await orderOf(o.orderId)).status, 'cancelled')
  }
})

test('T-25b two parallel teams with one name key → one team_name_taken', async () => {
  const event = await free()
  const cat = event.categoryIds[0]
  for (let i = 0; i < 10; i++) {
    const name = teamName()
    const rs = await Promise.all([
      createTeam(event, { name, members: pair(cat) }),
      createTeam(event, { name: `  ${name.toUpperCase().replace(' ', '   ')} `, members: pair(cat) }),
    ])
    assert.deepEqual(messages(rs), ['team_name_taken'], JSON.stringify(rs))
  }
  assert.equal(await taken(cat), 10)
})

test('T-25c two parallel teams sharing a member → one duplicate, the other team whole', async () => {
  const event = await free()
  const cat = event.categoryIds[0]
  for (let i = 0; i < 10; i++) {
    const shared = runnerEmail('shared')
    const rs = await Promise.all([
      createTeam(event, { members: [captain(), adult(cat, 'adult', shared)] }),
      createTeam(event, { members: [captain(), adult(cat, 'adult', shared)] }),
    ])
    assert.deepEqual(messages(rs), ['duplicate:1'], JSON.stringify(rs))
  }
  assert.equal(await taken(cat), 10)
  assert.equal((await rows('teams', { category_id: cat })).length, 10)
})

const ITEM = (categoryId, over = {}) => ({
  category_id: categoryId, name: 'Sztafeta', kind: 'team', discipline: 'run', distance_label: '4 x 5 km',
  start_time: '10:00', capacity: 50, min_age: null, max_age: null, is_kids: false, timed: true,
  gpx_upload_id: null, price: null, team_min: 2, team_max: 6, ...over,
})
const stage = (event, value) => rpc('stage_registration_section', {
  p_event_id: event.eventId, p_section: 'competitions', p_actor: owner.profileId, p_value: value,
})
const publishChanges = (event) =>
  rpc('publish_registration_changes', { p_event_id: event.eventId, p_actor: owner.profileId, p_expected_updated_at: null })
const setCapacity = async (cat, capacity) => {
  const { error } = await db().from('competitions').update({ capacity }).eq('category_id', cat)
  assert.ifError(error)
}
/** Starts the two calls together, the first one first on even rounds and last on odd ones. */
const bothOrders = async (round, a, b) => (round % 2
  ? (await Promise.all([b(), a()])).reverse()
  : Promise.all([a(), b()]))
/** The publish lost to the entry, which made `taken` pass the staged limit: a clean refusal. */
const publishOk = (pub, round) => {
  assert.ok(!isDeadlock(pub), `round ${round} publish: ${pub.error?.message}`)
  if (pub.error) assert.match(pub.error.message, /^capacity_below_taken:/, `round ${round}`)
}

test('T-25d 20 rounds: a free team racing „Opublikuj zmiany” lowering the limit to taken → no 40P01, the limit holds', async () => {
  const event = await free({ capacity: 100 })
  const cat = event.categoryIds[0]
  await teamOk(event, { members: pair(cat) }) // a limit is at least 1, so taken starts there
  for (let i = 0; i < 20; i++) {
    await setCapacity(cat, 100)
    const s = await stage(event, { pricing_mode: 'free', items: [ITEM(cat, { capacity: await taken(cat) })] })
    assert.equal(s.error, null, s.error?.message)
    const [pub, t] = await bothOrders(i, () => publishChanges(event), () => createTeam(event, { members: pair(cat) }))
    publishOk(pub, i)
    assert.ok(!isDeadlock(t), `round ${i} team: ${t.error?.message}`)
    if (t.error) assert.equal(t.error.message, 'full', `round ${i}`)
    assert.ok(Boolean(pub.error) === !t.error, `round ${i}: exactly one wins`)
    const c = await competitionOf(cat)
    assert.ok(c.taken <= c.capacity || pub.error, `round ${i}: taken ${c.taken}, capacity ${c.capacity}`)
    await assertSlotInvariant(cat)
  }
})

test('T-25d 20 rounds: a paid team\'s confirm_order racing „Opublikuj zmiany” → no 40P01, the limit holds', async () => {
  const event = await paid({ capacity: 100 })
  const cat = event.categoryIds[0]
  const seed = await teamOk(event, { members: pair(cat) }) // a limit is at least 1, so taken starts there
  await confirm(seed.orderId, (await attemptFor(seed.orderId, seed.total)).txn, seed.total)
  for (let i = 0; i < 20; i++) {
    await setCapacity(cat, 100)
    const o = await teamOk(event, { members: pair(cat) })
    const att = await attemptFor(o.orderId, o.total)
    const s = await stage(event, { pricing_mode: 'fixed', items: [ITEM(cat, { capacity: await taken(cat), price: 24000 })] })
    assert.equal(s.error, null, s.error?.message)
    const [pub, c] = await bothOrders(i, () => publishChanges(event), () => confirm(o.orderId, att.txn, o.total))
    publishOk(pub, i)
    assert.ok(!isDeadlock(c), `round ${i} confirm: ${c.error?.message}`)
    assert.equal(c.error, null, c.error?.message)
    if (c.data.outcome === 'late_refund') assert.equal(c.data.refund.reason, 'full', `round ${i}`)
    else assert.equal(c.data.outcome, 'confirmed', JSON.stringify(c.data))
    assert.ok(Boolean(pub.error) === (c.data.outcome === 'confirmed'), `round ${i}: exactly one wins`)
    await assertSlotInvariant(cat)
  }
})
