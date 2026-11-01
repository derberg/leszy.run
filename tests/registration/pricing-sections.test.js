// Plan 7, task 3: tiered prices, extras and transfer settings in the wizard, and the post-publish
// tier and extra locks (V-16…V-19 in docs/registration/scenario-matrix.md). LOCAL stack only;
// every event and runner address is random, so reruns pass.
//
// Dates are relative to today (Warsaw): tier 1 ends in 10 days, tier 2 in 20, tier 3 runs to the
// close. The literal A3 label („od 16.11: 70 zł”) is checked against fixed instants in
// public/tests/unit/eventPageModel.test.js; here the label is built from the same relative days.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { admin, resetThrottle, sessionFor } from './helpers/stack.js'
import { startCapture } from './helpers/emailCapture.js'
import { acceptAgreement, callFn, createPublishedFreeEvent } from './helpers/registrationFixtures.js'
import { orderOk, person, runnerEmail } from './helpers/orders.js'
import { warsawToday } from '../../supabase/functions/_shared/registration/dates.js'
import { eventPageModel } from '../../public/src/lib/eventPageModel.js'
import { withFileUrls } from '../../public/src/lib/eventFiles.js'

const ZT = '00000000-0000-4000-8000-0000000000c1'
const rand = () => crypto.randomBytes(4).toString('hex')
const db = () => admin()

let owner, stopCapture
before(async () => {
  stopCapture = await startCapture()
  await resetThrottle()
  await acceptAgreement('zatyrani-test')
  owner = await sessionFor('owner@zatyrani-test.local')
})
after(async () => { if (stopCapture) await stopCapture() })

const TODAY = warsawToday()
function day(offset) {
  const [y, m, d] = TODAY.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + offset)).toISOString().slice(0, 10)
}
const T1_END = day(10)
const T2_END = day(20)
const EVENT_DATE = day(40)

const save = (eventId, section, value) => callFn('save-registration-section', owner, { eventId, section, value })
const stage = (eventId, section, value) =>
  db().rpc('stage_registration_section', { p_event_id: eventId, p_section: section, p_value: value, p_actor: owner.profileId })
const applyChanges = (eventId) =>
  db().rpc('publish_registration_changes', { p_event_id: eventId, p_actor: owner.profileId, p_expected_updated_at: null })

async function rows(table, filter, order) {
  let q = db().from(table).select('*')
  for (const [k, v] of Object.entries(filter)) q = Array.isArray(v) ? q.in(k, v) : q.eq(k, v)
  if (order) q = q.order(order)
  const { data, error } = await q
  if (error) throw error
  return data
}

const COMP = (i) => ({
  name: `Bieg ${i + 1} km`, kind: 'individual', discipline: 'run', distanceLabel: `${i + 1} km`, startTime: '10:00',
  capacity: 50, timed: true, isKids: false,
})

/** A draft with the registration window open from yesterday to the day before the race. */
async function draft(n = 1) {
  const club = { id: ZT }
  const r = await callFn('create-registration-event', owner, { clubId: club.id, name: `Bieg progów ${rand()}` })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  const { eventId } = r.body.data
  const b = await save(eventId, 'basics', { eventDate: EVENT_DATE, opensOn: day(-1), closesOn: day(39) })
  assert.equal(b.status, 200, JSON.stringify(b.body))
  const c = await save(eventId, 'competitions', { pricingMode: 'free', items: Array.from({ length: n }, (_, i) => COMP(i)) })
  assert.equal(c.status, 200, JSON.stringify(c.body))
  return { eventId, categoryIds: c.body.data.categoryIds }
}

const A3_TIERS = () => [{ endsOn: T1_END }, { endsOn: T2_END }, { endsOn: null }]
const A3_PRICES = { 'new:0': '60', 'new:1': '70', 'new:2': '80' }
const tieredItems = (event, prices = () => A3_PRICES) =>
  event.categoryIds.map((id, i) => ({ ...COMP(i), categoryId: id, prices: prices(i) }))

const tiersOf = (eventId) => rows('price_tiers', { event_id: eventId }, 'sort_order')
const pricesOf = (categoryIds) => rows('competition_prices', { category_id: categoryIds })

// ---------------------------------------------------------------- V-16

test('V-16 a draft save of 3 tiers writes 3 price_tiers and 18 competition_prices (6 competitions)', async () => {
  const event = await draft(6)
  const r = await save(event.eventId, 'competitions', { pricingMode: 'tiered', tiers: A3_TIERS(), items: tieredItems(event) })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const tiers = await tiersOf(event.eventId)
  assert.deepEqual(tiers.map((t) => [t.ends_on, t.sort_order]), [[T1_END, 0], [T2_END, 1], [null, 2]])
  assert.deepEqual(r.body.data.tierIds, tiers.map((t) => t.id))
  const prices = await pricesOf(event.categoryIds)
  assert.equal(prices.length, 18)
  const amountAt = (tierId) => [...new Set(prices.filter((p) => p.tier_id === tierId).map((p) => p.amount))]
  assert.deepEqual(tiers.map((t) => amountAt(t.id)), [[6000], [7000], [8000]])
  const { data: s } = await db().from('registration_settings').select('pricing_mode').eq('event_id', event.eventId).single()
  assert.equal(s.pricing_mode, 'tiered')
})

test('V-16 a second save by tier id keeps the rows; a tier left out goes with its prices', async () => {
  const event = await draft(2)
  await save(event.eventId, 'competitions', { pricingMode: 'tiered', tiers: A3_TIERS(), items: tieredItems(event) })
  const [t1, , t3] = await tiersOf(event.eventId)
  const r = await save(event.eventId, 'competitions', {
    pricingMode: 'tiered', tiers: [{ id: t1.id, endsOn: T1_END }, { id: t3.id, endsOn: null }],
    items: tieredItems(event, () => ({ [t1.id]: '55', [t3.id]: '85' })),
  })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const tiers = await tiersOf(event.eventId)
  assert.deepEqual(tiers.map((t) => t.id), [t1.id, t3.id])
  const prices = await pricesOf(event.categoryIds)
  assert.equal(prices.length, 4)
  assert.deepEqual([...new Set(prices.filter((p) => p.tier_id === t3.id).map((p) => p.amount))], [8500])
})

test('V-16 a tier id of another event is refused', async () => {
  const [a, b] = await Promise.all([draft(1), draft(1)])
  await save(b.eventId, 'competitions', { pricingMode: 'tiered', tiers: A3_TIERS(), items: tieredItems(b) })
  const [foreign] = await tiersOf(b.eventId)
  const r = await save(a.eventId, 'competitions', {
    pricingMode: 'tiered', tiers: [{ id: foreign.id, endsOn: T1_END }, { endsOn: null }],
    items: tieredItems(a, () => ({ [foreign.id]: '60', 'new:1': '70' })),
  })
  assert.equal(r.status, 422, JSON.stringify(r.body))
})

test('V-16 switching back to fixed leaves one open tier, the current one, with the fixed prices', async () => {
  const event = await draft(2)
  await save(event.eventId, 'competitions', { pricingMode: 'tiered', tiers: A3_TIERS(), items: tieredItems(event) })
  const [t1] = await tiersOf(event.eventId)
  const r = await save(event.eventId, 'competitions', {
    pricingMode: 'fixed', items: event.categoryIds.map((id, i) => ({ ...COMP(i), categoryId: id, price: '60' })),
  })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const tiers = await tiersOf(event.eventId)
  assert.equal(tiers.length, 1)
  assert.equal(tiers[0].id, t1.id, 'the tier in force today stays')
  assert.equal(tiers[0].ends_on, null)
  const prices = await pricesOf(event.categoryIds)
  assert.deepEqual(prices.map((p) => [p.tier_id, p.amount]), [[t1.id, 6000], [t1.id, 6000]])
  // And free drops every tier.
  const free = await save(event.eventId, 'competitions', { pricingMode: 'free', items: event.categoryIds.map((id, i) => ({ ...COMP(i), categoryId: id })) })
  assert.equal(free.status, 200, JSON.stringify(free.body))
  assert.deepEqual(await tiersOf(event.eventId), [])
})

test('V-16 a tier ending on the last day of registration is refused (422, tiers)', async () => {
  const event = await draft(1)
  const r = await save(event.eventId, 'competitions', {
    pricingMode: 'tiered', tiers: [{ endsOn: day(39) }, { endsOn: null }], items: tieredItems(event, () => ({ 'new:0': '60', 'new:1': '70' })),
  })
  assert.equal(r.status, 422, JSON.stringify(r.body))
  assert.equal(r.body.fields.tiers, 'Daty progów muszą rosnąć i kończyć się przed zamknięciem zapisów.')
})

// ---------------------------------------------------------------- draft deletes and links

test('V-16 a draft competition a voucher or an extra points at is not deleted: 409 competition_linked', async () => {
  for (const link of ['voucher', 'extra']) {
    const event = await draft(2)
    const [keep, linked] = event.categoryIds
    if (link === 'voucher') {
      const { data: v, error } = await db().from('vouchers')
        .insert({ event_id: event.eventId, code: `KOD-${rand().toUpperCase()}`, percent: 10, max_uses: 5 }).select('id').single()
      if (error) throw error
      await db().from('voucher_competitions').insert({ voucher_id: v.id, category_id: linked }).throwOnError()
    } else {
      const x = await save(event.eventId, 'extras', { items: [{
        name: 'Koszulka', price: '45', orderUntil: EVENT_DATE, categoryIds: [linked], variants: [{ label: 'M', stock: 10 }],
      }] })
      assert.equal(x.status, 200, JSON.stringify(x.body))
    }
    const r = await save(event.eventId, 'competitions', { pricingMode: 'free', items: [{ ...COMP(0), categoryId: keep }] })
    assert.equal(r.status, 409, `${link}: ${JSON.stringify(r.body)}`)
    assert.equal(r.body.code, 'competition_linked')
    assert.equal((await rows('competitions', { event_id: event.eventId })).length, 2, `${link}: nothing deleted`)
  }
})

test('V-16 draft extras: saved with variants and links, replaced, then removed with their variants first', async () => {
  const event = await draft(2)
  const r = await save(event.eventId, 'extras', { items: [
    { name: 'Koszulka', price: '45', orderUntil: EVENT_DATE, categoryIds: [event.categoryIds[1]], variants: [{ label: 'M', stock: 10 }, { label: 'L', stock: 100000 }] },
    { name: 'Medal', price: '0', orderUntil: EVENT_DATE, categoryIds: [], variants: [{ label: 'Jeden', stock: 5 }] },
  ] })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const extras = await rows('extras', { event_id: event.eventId }, 'sort_order')
  assert.deepEqual(extras.map((x) => [x.name, x.price, x.order_until]), [['Koszulka', 4500, EVENT_DATE], ['Medal', 0, EVENT_DATE]])
  assert.deepEqual(r.body.data.extraIds, extras.map((x) => x.id))
  const variants = await rows('extra_variants', { extra_id: extras[0].id }, 'sort_order')
  assert.deepEqual(variants.map((v) => [v.label, v.stock, v.sold]), [['M', 10, 0], ['L', 100000, 0]])
  assert.deepEqual((await rows('extra_competitions', { extra_id: extras[0].id })).map((l) => l.category_id), [event.categoryIds[1]])

  // By id: the variant M keeps its row, L goes, XL is new, and the link is replaced.
  const again = await save(event.eventId, 'extras', { items: [
    { id: extras[0].id, name: 'Koszulka', price: '50', orderUntil: EVENT_DATE, categoryIds: [event.categoryIds[0]],
      variants: [{ id: variants[0].id, label: 'M', stock: 12 }, { label: 'XL', stock: 3 }] },
  ] })
  assert.equal(again.status, 200, JSON.stringify(again.body))
  assert.deepEqual((await rows('extras', { event_id: event.eventId })).map((x) => [x.id, x.price]), [[extras[0].id, 5000]])
  const after = await rows('extra_variants', { extra_id: extras[0].id }, 'sort_order')
  assert.deepEqual(after.map((v) => [v.label, v.stock]), [['M', 12], ['XL', 3]])
  assert.equal(after[0].id, variants[0].id)
  assert.deepEqual((await rows('extra_competitions', { extra_id: extras[0].id })).map((l) => l.category_id), [event.categoryIds[0]])

  const none = await save(event.eventId, 'extras', { items: [] })
  assert.equal(none.status, 200, JSON.stringify(none.body))
  assert.deepEqual(await rows('extras', { event_id: event.eventId }), [])
  assert.deepEqual(await rows('extra_variants', { extra_id: [extras[0].id, extras[1].id] }), [])
})

test('V-16 an extra naming another event\'s competition or variant is refused', async () => {
  const [a, b] = await Promise.all([draft(1), draft(1)])
  const r = await save(a.eventId, 'extras', { items: [{ name: 'Koszulka', price: '45', orderUntil: EVENT_DATE, categoryIds: b.categoryIds, variants: [{ label: 'M', stock: 1 }] }] })
  assert.equal(r.status, 422, JSON.stringify(r.body))
  const x = await save(b.eventId, 'extras', { items: [{ name: 'Koszulka', price: '45', orderUntil: EVENT_DATE, categoryIds: [], variants: [{ label: 'M', stock: 1 }] }] })
  const [foreignVariant] = await rows('extra_variants', { extra_id: x.body.data.extraIds[0] })
  const v = await save(a.eventId, 'extras', { items: [{ name: 'Koszulka', price: '45', orderUntil: EVENT_DATE, categoryIds: [], variants: [{ id: foreignVariant.id, label: 'M', stock: 1 }] }] })
  assert.equal(v.status, 422, JSON.stringify(v.body))
})

test('V-16 transfer settings are saved through the payments section', async () => {
  const event = await draft(1)
  const r = await save(event.eventId, 'payments', { transferEnabled: true, transferUntil: day(39) })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const { data } = await db().from('registration_settings').select('transfer_enabled, transfer_until').eq('event_id', event.eventId).single()
  assert.deepEqual(data, { transfer_enabled: true, transfer_until: day(39) })
  const late = await save(event.eventId, 'payments', { transferEnabled: true, transferUntil: EVENT_DATE })
  assert.equal(late.status, 422, JSON.stringify(late.body))
  assert.equal(late.body.fields.transferUntil, 'Przekazanie możliwe najpóźniej dzień przed zawodami.')
})

// ---------------------------------------------------------------- V-17

/**
 * A published event switched to tiered pricing (LOCAL only, like makeEventPaid: a paid publish is
 * refused while PAID_REGISTRATION_ENABLED is false). → the event plus its tiers in order.
 */
async function publishedTiered(competitions = [COMP(0)]) {
  const event = await createPublishedFreeEvent(owner, { competitions, eventDate: EVENT_DATE, opensOn: day(-1), closesOn: day(39) })
  const tiers = []
  for (const [i, endsOn] of [T1_END, T2_END, null].entries()) {
    const { data, error } = await db().from('price_tiers').insert({ event_id: event.eventId, ends_on: endsOn, sort_order: i }).select('*').single()
    if (error) throw error
    tiers.push(data)
  }
  for (const categoryId of event.categoryIds) {
    await db().from('competition_prices').insert(tiers.map((t, i) => ({ category_id: categoryId, tier_id: t.id, amount: 6000 + i * 1000 }))).throwOnError()
  }
  await db().from('registration_settings').update({ pricing_mode: 'tiered', payment_window_hours: 168 }).eq('event_id', event.eventId).throwOnError()
  return { ...event, tiers, prices: Object.fromEntries(event.categoryIds.map((id) => [id, 6000])) }
}

/** The staged competitions value of a tiered event: tiers as given, every competition at `amounts`. */
function stagedTiered(event, tiers, amounts) {
  return {
    pricing_mode: 'tiered',
    tiers: tiers.map((t) => ({ id: t.id ?? null, ends_on: t.ends_on })),
    items: event.categoryIds.map((id, i) => ({
      category_id: id, name: COMP(i).name, kind: 'individual', discipline: 'run', distance_label: COMP(i).distanceLabel,
      start_time: '10:00', capacity: 50, min_age: null, max_age: null, is_kids: false, timed: true, gpx_upload_id: null,
      price: null, prices: Object.fromEntries(tiers.map((t, k) => [t.id ?? `new:${k}`, amounts[k]])),
    })),
  }
}
const amountsOf = async (event, categoryId = event.categoryIds[0]) => {
  const tiers = await tiersOf(event.eventId)
  const prices = await pricesOf([categoryId])
  return tiers.map((t) => prices.find((p) => p.tier_id === t.id)?.amount ?? null)
}
const inUse = (event, categoryId = event.categoryIds[0]) =>
  db().from('competitions').update({ taken: 1 }).eq('category_id', categoryId).throwOnError()

test('V-17 published, in use, today in tier 1: a tier-2 amount applies; a tier-1 amount and moving tier 1 are price_locked', async () => {
  const event = await publishedTiered()
  await inUse(event)
  const [t1, t2, t3] = event.tiers

  let r = await stage(event.eventId, 'competitions', stagedTiered(event, [t1, t2, t3], [6000, 7500, 8000]))
  assert.equal(r.error, null, r.error?.message)
  r = await applyChanges(event.eventId)
  assert.equal(r.error, null, r.error?.message)
  assert.deepEqual(await amountsOf(event), [6000, 7500, 8000])

  r = await stage(event.eventId, 'competitions', stagedTiered(event, [t1, t2, t3], [6500, 7500, 8000]))
  assert.equal(r.error?.message, 'price_locked', 'a tier-1 amount')
  r = await stage(event.eventId, 'competitions', stagedTiered(event, [{ ...t1, ends_on: day(12) }, t2, t3], [6000, 7500, 8000]))
  assert.equal(r.error?.message, 'price_locked', 'tier 1 moved')
  r = await stage(event.eventId, 'competitions', stagedTiered(event, [t2, t3], [7500, 8000]))
  assert.equal(r.error?.message, 'price_locked', 'tier 1 removed')
  assert.deepEqual(await amountsOf(event), [6000, 7500, 8000])
})

test('V-17 published, in use: a tier added between 1 and 2 applies; a future tier may not move before the current one', async () => {
  const event = await publishedTiered()
  await inUse(event)
  const [t1, t2, t3] = event.tiers
  const added = { id: null, ends_on: day(15) }
  let r = await stage(event.eventId, 'competitions', stagedTiered(event, [t1, added, t2, t3], [6000, 6500, 7000, 8000]))
  assert.equal(r.error, null, r.error?.message)
  r = await applyChanges(event.eventId)
  assert.equal(r.error, null, r.error?.message)
  const tiers = await tiersOf(event.eventId)
  assert.deepEqual(tiers.map((t) => t.ends_on), [T1_END, day(15), T2_END, null])
  assert.deepEqual(await amountsOf(event), [6000, 6500, 7000, 8000])

  // A new dated tier on or before tier 1's end would become the current price.
  r = await stage(event.eventId, 'competitions', stagedTiered(event, [{ id: null, ends_on: day(5) }, ...tiers], [5000, 6000, 6500, 7000, 8000]))
  assert.equal(r.error?.message, 'price_locked')
})

test('V-17 a tier-2 edit staged in tier 1, then tier 1 ended yesterday before „Opublikuj zmiany” → price_locked at apply (D7-3)', async () => {
  const event = await publishedTiered()
  await inUse(event)
  const [t1, t2, t3] = event.tiers
  let r = await stage(event.eventId, 'competitions', stagedTiered(event, [t1, t2, t3], [6000, 7500, 8000]))
  assert.equal(r.error, null, r.error?.message)
  await db().from('price_tiers').update({ ends_on: day(-1) }).eq('id', t1.id).throwOnError()
  r = await applyChanges(event.eventId)
  assert.equal(r.error?.message, 'price_locked')
  assert.deepEqual(await amountsOf(event), [6000, 7000, 8000], 'nothing applied')
})

test('V-17 switching fixed ↔ tiered with a competition in use → price_locked; with every competition unused → applied', async () => {
  const event = await publishedTiered([COMP(0), COMP(1)])
  const fixed = {
    pricing_mode: 'fixed',
    items: stagedTiered(event, event.tiers, [6000, 7000, 8000]).items.map(({ prices, ...i }) => ({ ...i, price: 6000 })),
  }
  await inUse(event, event.categoryIds[1])
  let r = await stage(event.eventId, 'competitions', fixed)
  assert.equal(r.error?.message, 'price_locked')

  const unused = await publishedTiered([COMP(0), COMP(1)])
  r = await stage(unused.eventId, 'competitions', {
    ...fixed, items: fixed.items.map((i, k) => ({ ...i, category_id: unused.categoryIds[k] })),
  })
  assert.equal(r.error, null, r.error?.message)
  r = await applyChanges(unused.eventId)
  assert.equal(r.error, null, r.error?.message)
  const tiers = await tiersOf(unused.eventId)
  assert.deepEqual(tiers.map((t) => [t.id, t.ends_on]), [[unused.tiers[0].id, null]])

  // And back to tiered, still unused: applied.
  r = await stage(unused.eventId, 'competitions', stagedTiered(unused, [{ id: tiers[0].id, ends_on: T1_END }, { id: null, ends_on: null }], [6000, 9000]))
  assert.equal(r.error, null, r.error?.message)
  r = await applyChanges(unused.eventId)
  assert.equal(r.error, null, r.error?.message)
  assert.deepEqual(await amountsOf(unused), [6000, 9000])
})

test('V-17 a competition with only a pending order is in use: a tier-1 edit → price_locked; the order keeps its frozen total', async () => {
  const event = await publishedTiered()
  const order = await orderOk(event, { people: [person(runnerEmail('tier'))], price: 6000 })
  const { data: before } = await db().from('orders').select('total, tier_id, status').eq('id', order.orderId).single()
  assert.deepEqual([before.total, before.tier_id, before.status], [6000, event.tiers[0].id, 'pending'])
  const { data: c } = await db().from('competitions').select('taken').eq('category_id', event.categoryIds[0]).single()
  assert.equal(c.taken, 0, 'an unpaid order holds no slot')

  const [t1, t2, t3] = event.tiers
  let r = await stage(event.eventId, 'competitions', stagedTiered(event, [t1, t2, t3], [5000, 7000, 8000]))
  assert.equal(r.error?.message, 'price_locked')
  r = await stage(event.eventId, 'competitions', stagedTiered(event, [t1, t2, t3], [6000, 7700, 8000]))
  assert.equal(r.error, null, r.error?.message)
  r = await applyChanges(event.eventId)
  assert.equal(r.error, null, r.error?.message)
  const { data: after } = await db().from('orders').select('total, tier_id').eq('id', order.orderId).single()
  assert.deepEqual([after.total, after.tier_id], [6000, t1.id])
})

test('V-17 the edge function answers a locked tier with 409 price_locked', async () => {
  const event = await publishedTiered()
  await inUse(event)
  const [t1, t2, t3] = event.tiers
  const r = await save(event.eventId, 'competitions', {
    pricingMode: 'tiered',
    tiers: [{ id: t1.id, endsOn: t1.ends_on }, { id: t2.id, endsOn: t2.ends_on }, { id: t3.id, endsOn: null }],
    items: [{ ...COMP(0), categoryId: event.categoryIds[0], prices: { [t1.id]: '65', [t2.id]: '70', [t3.id]: '80' } }],
  })
  assert.equal(r.status, 409, JSON.stringify(r.body))
  assert.equal(r.body.code, 'price_locked')
})

// ---------------------------------------------------------------- V-18

const extrasValue = (extras) => ({ items: extras })
const shirt = (over = {}) => ({
  id: null, name: 'Koszulka', image_upload_id: null, price: 4500, order_until: EVENT_DATE, category_ids: [],
  variants: [{ id: null, label: 'M', stock: 30 }, { id: null, label: 'L', stock: 30 }], ...over,
})

async function publishedWithExtras() {
  const event = await createPublishedFreeEvent(owner, { eventDate: EVENT_DATE, opensOn: day(-1), closesOn: day(39) })
  const s = await save(event.eventId, 'extras', {
    items: [
      { name: 'Koszulka', price: '45', orderUntil: EVENT_DATE, categoryIds: [], variants: [{ label: 'M', stock: 30 }, { label: 'L', stock: 30 }] },
      { name: 'Czapka', price: '30', orderUntil: EVENT_DATE, categoryIds: [], variants: [{ label: 'Uni', stock: 10 }] },
    ],
  })
  assert.equal(s.status, 200, JSON.stringify(s.body))
  const r = await applyChanges(event.eventId)
  assert.equal(r.error, null, r.error?.message)
  const extras = await rows('extras', { event_id: event.eventId }, 'sort_order')
  const variants = await rows('extra_variants', { extra_id: extras.map((x) => x.id) }, 'sort_order')
  const of = (x) => variants.filter((v) => v.extra_id === x.id).sort((a, b) => a.sort_order - b.sort_order)
  return { ...event, extras, shirtVariants: of(extras[0]), capVariants: of(extras[1]) }
}

function liveValue(event, edit = {}) {
  const [x0, x1] = event.extras
  return extrasValue([
    shirt({ id: x0.id, variants: event.shirtVariants.map((v) => ({ id: v.id, label: v.label, stock: v.stock })), ...(edit.shirt ?? {}) }),
    shirt({ id: x1.id, name: 'Czapka', price: 3000, variants: event.capVariants.map((v) => ({ id: v.id, label: v.label, stock: v.stock })), ...(edit.cap ?? {}) }),
  ])
}

test('V-18 extras after publish are staged and applied by „Opublikuj zmiany”', async () => {
  const event = await publishedWithExtras()
  assert.deepEqual(event.extras.map((x) => [x.name, x.price]), [['Koszulka', 4500], ['Czapka', 3000]])
  assert.deepEqual(event.shirtVariants.map((v) => [v.label, v.stock]), [['M', 30], ['L', 30]])
})

test('V-18 sold > 0: stock below sold, a price change and removing a sold variant are extra_locked', async () => {
  const event = await publishedWithExtras()
  const [m, l] = event.shirtVariants
  await db().from('extra_variants').update({ sold: 5 }).eq('id', m.id).throwOnError()

  const variants = (stockM) => [{ id: m.id, label: 'M', stock: stockM }, { id: l.id, label: 'L', stock: 30 }]
  let r = await stage(event.eventId, 'extras', liveValue(event, { shirt: { variants: variants(4) } }))
  assert.equal(r.error?.message, 'extra_locked', 'stock below sold')
  r = await stage(event.eventId, 'extras', liveValue(event, { shirt: { price: 5000 } }))
  assert.equal(r.error?.message, 'extra_locked', 'price with sold > 0')
  r = await stage(event.eventId, 'extras', liveValue(event, { shirt: { variants: [{ id: l.id, label: 'L', stock: 30 }] } }))
  assert.equal(r.error?.message, 'extra_locked', 'a sold variant removed')
  r = await stage(event.eventId, 'extras', extrasValue([liveValue(event).items[1]]))
  assert.equal(r.error?.message, 'extra_locked', 'an extra with sales removed')

  // Stock down to exactly sold, and a new variant, are fine.
  r = await stage(event.eventId, 'extras', liveValue(event, { shirt: { variants: [...variants(5), { id: null, label: 'XL', stock: 3 }] } }))
  assert.equal(r.error, null, r.error?.message)
  r = await applyChanges(event.eventId)
  assert.equal(r.error, null, r.error?.message)
  assert.deepEqual((await rows('extra_variants', { extra_id: event.extras[0].id }, 'sort_order')).map((v) => [v.label, v.stock, v.sold]),
    [['M', 5, 5], ['L', 30, 0], ['XL', 3, 0]])
})

test('V-18 sold = 0: a price change, a stock change and removing the extra apply', async () => {
  const event = await publishedWithExtras()
  let r = await stage(event.eventId, 'extras', liveValue(event, { cap: { price: 3500, variants: [{ id: event.capVariants[0].id, label: 'Uni', stock: 0 }] } }))
  assert.equal(r.error, null, r.error?.message)
  r = await applyChanges(event.eventId)
  assert.equal(r.error, null, r.error?.message)
  const cap = (await rows('extras', { id: event.extras[1].id }))[0]
  assert.equal(cap.price, 3500)
  assert.equal((await rows('extra_variants', { id: event.capVariants[0].id }))[0].stock, 0)

  r = await stage(event.eventId, 'extras', extrasValue([liveValue(event).items[0]]))
  assert.equal(r.error, null, r.error?.message)
  r = await applyChanges(event.eventId)
  assert.equal(r.error, null, r.error?.message)
  assert.deepEqual((await rows('extras', { event_id: event.eventId })).map((x) => x.name), ['Koszulka'])
  assert.deepEqual(await rows('extra_variants', { extra_id: event.extras[1].id }), [])
})

test('V-18 sales landing between staging and „Opublikuj zmiany” are checked at apply', async () => {
  const event = await publishedWithExtras()
  const [m, l] = event.shirtVariants
  let r = await stage(event.eventId, 'extras', liveValue(event, { shirt: { variants: [{ id: m.id, label: 'M', stock: 10 }, { id: l.id, label: 'L', stock: 30 }] } }))
  assert.equal(r.error, null, r.error?.message)
  await db().from('extra_variants').update({ sold: 12 }).eq('id', m.id).throwOnError()
  r = await applyChanges(event.eventId)
  assert.equal(r.error?.message, 'extra_locked')
  assert.equal((await rows('extra_variants', { id: m.id }))[0].stock, 30, 'nothing applied')
})

test('V-18 the edge function answers a locked extra with 409 extra_locked', async () => {
  const event = await publishedWithExtras()
  await db().from('extra_variants').update({ sold: 1 }).eq('id', event.shirtVariants[0].id).throwOnError()
  const r = await save(event.eventId, 'extras', { items: [
    { id: event.extras[0].id, name: 'Koszulka', price: '50', orderUntil: EVENT_DATE, categoryIds: [],
      variants: event.shirtVariants.map((v) => ({ id: v.id, label: v.label, stock: v.stock })) },
    { id: event.extras[1].id, name: 'Czapka', price: '30', orderUntil: EVENT_DATE, categoryIds: [],
      variants: event.capVariants.map((v) => ({ id: v.id, label: v.label, stock: v.stock })) },
  ] })
  assert.equal(r.status, 409, JSON.stringify(r.body))
  assert.equal(r.body.code, 'extra_locked')
})

// ---------------------------------------------------------------- V-19

/** Every key at every depth of a JSON value. */
function keysDeep(v, out = new Set()) {
  if (Array.isArray(v)) for (const x of v) keysDeep(x, out)
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keysDeep(x, out) }
  return out
}

test('V-19 the tiered A3 fixture saved through save-registration-section: registration_raw gives RA1 the next tier label', async () => {
  const event = await draft(1)
  const r = await save(event.eventId, 'competitions', { pricingMode: 'tiered', tiers: A3_TIERS(), items: tieredItems(event) })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const { data: raw, error } = await db().rpc('registration_raw', { p_event_id: event.eventId })
  if (error) throw error
  assert.equal(raw.competitions[0].priceGrosze, 6000)
  const from = day(11)
  assert.deepEqual(raw.competitions[0].nextPrice, { grosze: 7000, from })
  const m = eventPageModel(withFileUrls(raw, 'http://127.0.0.1'), new Date())
  const [, mm, dd] = from.split('-').map(Number)
  assert.equal(m.competitions[0].nextPriceLabel, `od ${dd}.${mm}: 70 zł`)
})

test('V-19 registration_raw carries extras (a sold-out variant kept with left 0) and the transfer window; no voucher or partner data', async () => {
  const event = await draft(2)
  await save(event.eventId, 'payments', { transferEnabled: true, transferUntil: day(39) })
  const x = await save(event.eventId, 'extras', { items: [
    { name: 'Koszulka', price: '45', orderUntil: EVENT_DATE, categoryIds: [event.categoryIds[1]], variants: [{ label: 'M', stock: 2 }, { label: 'L', stock: 0 }] },
  ] })
  assert.equal(x.status, 200, JSON.stringify(x.body))
  const [variantM] = await rows('extra_variants', { extra_id: x.body.data.extraIds[0], label: 'M' })
  await db().from('extra_variants').update({ sold: 1 }).eq('id', variantM.id).throwOnError()
  // A partner and a voucher with a note exist, and must not show.
  const { data: p } = await db().from('registration_partners').insert({ event_id: event.eventId, name: `Sklep ${rand()}`, note: 'tajne' }).select('id').single()
  await db().from('vouchers').insert({ event_id: event.eventId, code: `P-${rand().toUpperCase()}`, percent: 15, max_uses: 3, partner_id: p.id, note: 'dla sklepu' }).throwOnError()

  const { data: raw, error } = await db().rpc('registration_raw', { p_event_id: event.eventId })
  if (error) throw error
  assert.deepEqual(raw.transfer, { enabled: true, until: day(39) })
  assert.deepEqual(raw.extras, [{
    id: x.body.data.extraIds[0], name: 'Koszulka', imagePath: null, price: 4500, orderUntil: EVENT_DATE, categoryIds: [event.categoryIds[1]],
    variants: [{ id: variantM.id, label: 'M', left: 1 }, { id: raw.extras[0].variants[1].id, label: 'L', left: 0 }],
  }])
  const keys = keysDeep(raw)
  for (const k of ['voucher', 'vouchers', 'voucherId', 'partner', 'partners', 'partnerId', 'note', 'used', 'sold', 'stock']) {
    assert.ok(!keys.has(k), `no ${k} key`)
  }
  const text = JSON.stringify(raw)
  assert.ok(!text.includes('tajne') && !text.includes('dla sklepu') && !text.includes('Sklep '), 'no partner name or note')
})

// ---------------------------------------------------------------- fix round 1 (I-1, M-1, M-4)

const publish = (eventId) => callFn('publish-registration-event', owner, { eventId, action: 'publish' })
const publishChanges = (eventId) => callFn('publish-registration-event', owner, { eventId, action: 'publish_changes', notify: { send: false } })
const blockingKeys = (r) => (r.body.blocking ?? []).map((b) => b.key)

test('I-1 the race moved earlier in Podstawy: the stored transfer window and an extra ordered after the new race day block publish', async () => {
  const event = await draft(1)
  let r = await save(event.eventId, 'payments', { transferEnabled: true, transferUntil: day(39) })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  r = await save(event.eventId, 'extras', { items: [{ name: 'Medal', price: '0', orderUntil: EVENT_DATE, categoryIds: [], variants: [{ label: 'Jeden', stock: 5 }] }] })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  r = await save(event.eventId, 'basics', { eventDate: day(30), opensOn: day(-1), closesOn: day(29) })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  r = await publish(event.eventId)
  assert.equal(r.status, 409, JSON.stringify(r.body))
  assert.ok(blockingKeys(r).includes('transfer_until'), JSON.stringify(r.body))
  assert.ok(blockingKeys(r).includes('extras_order_until'), JSON.stringify(r.body))
})

test('I-1 published: a race date staged earlier than the transfer window → 409 with the transfer item, nothing applied', async () => {
  const event = await createPublishedFreeEvent(owner, { eventDate: EVENT_DATE, opensOn: day(-1), closesOn: day(39) })
  await db().from('registration_settings').update({ transfer_enabled: true, transfer_until: day(39) }).eq('event_id', event.eventId).throwOnError()
  const r0 = await save(event.eventId, 'basics', { eventDate: day(30), opensOn: day(-1), closesOn: day(29) })
  assert.equal(r0.status, 200, JSON.stringify(r0.body))
  const r = await publishChanges(event.eventId)
  assert.equal(r.status, 409, JSON.stringify(r.body))
  assert.deepEqual(blockingKeys(r), ['transfer_until'])
  const { data } = await db().from('registration_settings').select('event_date').eq('event_id', event.eventId).single()
  assert.equal(data.event_date, EVENT_DATE)
})

test('I-1 {transferUntil: null} alone while transfers are on is refused, in a draft and staged after publish', async () => {
  const event = await draft(1)
  let r = await save(event.eventId, 'payments', { transferEnabled: true, transferUntil: day(39) })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  r = await save(event.eventId, 'payments', { transferUntil: null })
  assert.equal(r.status, 422, JSON.stringify(r.body))
  assert.equal(r.body.fields.transferUntil, 'Podaj, do kiedy można przekazać pakiet.')

  const pub = await createPublishedFreeEvent(owner, { eventDate: EVENT_DATE, opensOn: day(-1), closesOn: day(39) })
  r = await save(pub.eventId, 'payments', { transferEnabled: true, transferUntil: day(39) })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  r = await save(pub.eventId, 'payments', { transferUntil: null })
  assert.equal(r.status, 422, 'the staged value counts: ' + JSON.stringify(r.body))
})

test('M-1 a stage back to fixed drops the earlier staged tiers from the pending payload', async () => {
  const event = await publishedTiered()
  const [t1, t2, t3] = event.tiers
  let r = await stage(event.eventId, 'competitions', stagedTiered(event, [t1, t2, t3], [6000, 7500, 8000]))
  assert.equal(r.error, null, r.error?.message)
  const fixed = stagedTiered(event, [t1, t2, t3], [6000, 7500, 8000])
  r = await stage(event.eventId, 'competitions', {
    pricing_mode: 'fixed', items: fixed.items.map(({ prices, ...i }) => ({ ...i, price: 6000 })),
  })
  assert.equal(r.error, null, r.error?.message)
  const { data } = await db().from('registration_pending_changes').select('payload, changed_fields').eq('event_id', event.eventId).single()
  assert.equal('tiers' in data.payload.competitions, false)
  assert.equal(data.payload.competitions.pricing_mode, 'fixed')
  assert.ok(!data.changed_fields.includes('competitions.tiers'))
})

test('M-4 the window shortened after the tiers were saved: publish names the tiers', async () => {
  const event = await draft(1)
  let r = await save(event.eventId, 'competitions', { pricingMode: 'tiered', tiers: A3_TIERS(), items: tieredItems(event) })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  r = await save(event.eventId, 'basics', { closesOn: day(15), opensOn: day(-1) })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  r = await publish(event.eventId)
  assert.equal(r.status, 409, JSON.stringify(r.body))
  const item = r.body.blocking.find((b) => b.key === 'tiers')
  assert.equal(item?.label, 'Progi cenowe: Daty progów muszą rosnąć i kończyć się przed zamknięciem zapisów.')
})
