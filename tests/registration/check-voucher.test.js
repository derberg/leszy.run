// Plan 7, task 8a: check-voucher, RA2's „Sprawdź” on a discount code. Scenarios V-67 and V-68 in
// docs/registration/scenario-matrix.md. LOCAL stack only.
import { test, before, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { localEnv, resetThrottle, sessionFor, EDGE_PROXY, fillThrottle } from './helpers/stack.js'
import { acceptAgreement, createPublishedPaidEvent } from './helpers/registrationFixtures.js'
import { db, one } from './helpers/orders.js'
import { makeVoucher, setTiers, vouchersMade, warsawDay } from './helpers/cart.js'
import { assertVoucherInvariant } from './helpers/voucherInvariant.js'

const NINE = { name: 'Bieg 9 km', discipline: 'run', distanceLabel: '9 km', startTime: '10:00', capacity: 50 }
const KIDS = { name: 'Bieg 1 km', discipline: 'run', distanceLabel: '1 km', startTime: '11:00', capacity: 50 }
const COPY = {
  voucher_invalid: 'Nieprawidłowy kod.',
  voucher_expired: 'Kod stracił ważność.',
  voucher_used_up: 'Kod został już wykorzystany.',
  voucher_category: 'Ten kod nie obejmuje tej konkurencji.',
}

let owner
before(async () => {
  await acceptAgreement('zatyrani-test')
  owner = await sessionFor('owner@zatyrani-test.local')
})
beforeEach(async () => { await resetThrottle() })
afterEach(async () => {
  const ids = [...vouchersMade]
  vouchersMade.clear()
  for (const id of ids) await assertVoucherInvariant(id)
})

// A fresh client address per call site (beforeEach clears the throttles).
let lastIp = crypto.randomInt(1, 100)
const someIp = () => `198.51.100.${(lastIp++ % 254) + 1}`

async function check(body, { ip = someIp(), origin = null } = {}) {
  const res = await fetch(`${localEnv().functionsUrl}/check-voucher`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...EDGE_PROXY, ...(origin ? { origin } : {}) },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { status: res.status, body: json }
}

const twoEvents = async () => {
  const event = await createPublishedPaidEvent(owner, { competitions: [NINE, KIDS], prices: { 'Bieg 9 km': 6000, 'Bieg 1 km': 0 } })
  const { slug } = await one('registration_settings', { event_id: event.eventId })
  return { ...event, slug }
}

function refused(r, code) {
  assert.equal(r.status, 422, JSON.stringify(r.body))
  assert.deepEqual(r.body, { error: COPY[code] ?? r.body.error, code, field: 'voucherCode' })
}

test('V-67 check-voucher: an accepted code answers only percent and price; each refusal its copy, no use claimed', async () => {
  const event = await twoEvents()
  const [c9, c1] = event.categoryIds
  const v = await makeVoucher(event.eventId, { percent: 15, max_uses: 2 })

  // No session needed; any case and spaces around it.
  const ok = await check({ slug: event.slug, categoryId: c9, code: ` ${v.code.toLowerCase()} ` })
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  assert.deepEqual(ok.body, { data: { percent: 15, price: 5100 } })
  // A check is not a use.
  assert.equal((await one('vouchers', { id: v.id })).used, 0)

  refused(await check({ slug: event.slug, categoryId: c9, code: 'NIEMA-TAKIEGO' }), 'voucher_invalid')
  refused(await check({ slug: event.slug, categoryId: c9, code: 'ß!' }), 'voucher_invalid')
  refused(await check({ slug: event.slug, categoryId: c9, code: null }), 'voucher_invalid')

  // Another event's code is just an unknown code here.
  const other = await twoEvents()
  const foreign = await makeVoucher(other.eventId, { percent: 50, max_uses: 5 })
  refused(await check({ slug: event.slug, categoryId: c9, code: foreign.code }), 'voucher_invalid')

  const disabled = await makeVoucher(event.eventId, { disabled_at: new Date().toISOString() })
  refused(await check({ slug: event.slug, categoryId: c9, code: disabled.code }), 'voucher_invalid')
  const expired = await makeVoucher(event.eventId, { valid_until: new Date(Date.now() - 1000).toISOString() })
  refused(await check({ slug: event.slug, categoryId: c9, code: expired.code }), 'voucher_expired')
  const usedUp = await makeVoucher(event.eventId, { max_uses: 1 })
  await db().from('vouchers').update({ used: 1 }).eq('id', usedUp.id)
  vouchersMade.delete(usedUp.id) // used by hand, held by no registration
  refused(await check({ slug: event.slug, categoryId: c9, code: usedUp.code }), 'voucher_used_up')
  const elsewhere = await makeVoucher(event.eventId, { categoryIds: [c1] })
  refused(await check({ slug: event.slug, categoryId: c9, code: elsewhere.code }), 'voucher_category')
  // A 0 zł competition: the code would discount nothing (ruling M-2).
  const r = await check({ slug: event.slug, categoryId: c1, code: v.code })
  refused(r, 'voucher_not_applicable')
  assert.equal(r.body.error, 'Ten kod nie obniży ceny: start w tej konkurencji jest bezpłatny.')

  // Unknown event or competition, or a competition of another event: 404.
  assert.equal((await check({ slug: 'nie-ma-takiego-biegu', categoryId: c9, code: v.code })).status, 404)
  assert.equal((await check({ slug: event.slug, categoryId: other.categoryIds[0], code: v.code })).status, 404)
  assert.equal((await check({ slug: event.slug, categoryId: 'abc', code: v.code })).status, 404)
  await db().from('competitions').update({ hidden_at: new Date().toISOString() }).eq('category_id', c1)
  assert.equal((await check({ slug: event.slug, categoryId: c1, code: v.code })).status, 404)

  // A foreign origin is refused before anything runs (guardRequest).
  assert.equal((await check({ slug: event.slug, categoryId: c9, code: v.code }, { origin: 'https://evil.example' })).status, 403)
  assert.equal((await one('vouchers', { id: v.id })).used, 0)
})

test('V-67 check-voucher prices at the current tier (Warsaw day), as create_order does', async () => {
  const event = await twoEvents()
  const [c9, c1] = event.categoryIds
  await setTiers(event.eventId, [
    { endsOn: warsawDay(0), prices: { [c9]: 6000, [c1]: 1000 } },
    { endsOn: null, prices: { [c9]: 7000, [c1]: 1000 } },
  ])
  const v = await makeVoucher(event.eventId, { percent: 15, max_uses: 5 })
  assert.deepEqual((await check({ slug: event.slug, categoryId: c9, code: v.code })).body, { data: { percent: 15, price: 5100 } })
  await setTiers(event.eventId, [
    { endsOn: warsawDay(-1), prices: { [c9]: 6000, [c1]: 1000 } },
    { endsOn: null, prices: { [c9]: 7000, [c1]: 1000 } },
  ])
  assert.deepEqual((await check({ slug: event.slug, categoryId: c9, code: v.code })).body, { data: { percent: 15, price: 5950 } })
  // 4999 at 15 %: the discount rounds down (749), the price up.
  await setTiers(event.eventId, [{ endsOn: null, prices: { [c9]: 4999, [c1]: 1000 } }])
  assert.deepEqual((await check({ slug: event.slug, categoryId: c9, code: v.code })).body, { data: { percent: 15, price: 4250 } })
})

test('V-68 check-voucher throttles per client IP, one bucket each (C-1): 100 refused codes and 300 checks an hour, CGNAT-sized; an accepted code costs no wrong slot', async () => {
  const event = await twoEvents()
  const [c9] = event.categoryIds
  const v = await makeVoucher(event.eventId, { percent: 15, max_uses: 5 })

  // One address that already spent its refused codes: even the right code waits.
  const guesser = someIp()
  await fillThrottle(`voucher-wrong-ip:${guesser}`, 100)
  const blocked = await check({ slug: event.slug, categoryId: c9, code: v.code }, { ip: guesser })
  assert.equal(blocked.status, 429, JSON.stringify(blocked.body))
  assert.equal(blocked.body.error, 'Zbyt wiele prób. Spróbuj ponownie później.')
  // Another address has its own bucket.
  const other = someIp()
  assert.equal((await check({ slug: event.slug, categoryId: c9, code: v.code }, { ip: other })).status, 200)
  const keys = (await db().from('otp_throttle').select('key').in('key', [`voucher-ip:${guesser}`, `voucher-ip:${other}`])).data.map((r) => r.key).sort()
  assert.deepEqual(keys, [`voucher-ip:${guesser}`, `voucher-ip:${other}`].sort(), 'the bucket is keyed on the real address')

  // Accepted codes do not use up the wrong allowance: 12 right, then 9 wrong still answer 422.
  const honest = someIp()
  for (let i = 0; i < 12; i++) assert.equal((await check({ slug: event.slug, categoryId: c9, code: v.code }, { ip: honest })).status, 200)
  for (let i = 0; i < 9; i++) assert.equal((await check({ slug: event.slug, categoryId: c9, code: `ZLY-${i}-X` }, { ip: honest })).status, 422)
  const wrongSlots = (await db().from('otp_throttle').select('attempts').eq('key', `voucher-wrong-ip:${honest}`).single()).data.attempts
  assert.equal(wrongSlots, 9)

  // 300 checks an hour, whatever their answer: the next one waits.
  const busy = someIp()
  await fillThrottle(`voucher-ip:${busy}`, 299)
  assert.equal((await check({ slug: event.slug, categoryId: c9, code: v.code }, { ip: busy })).status, 200)
  assert.equal((await check({ slug: event.slug, categoryId: c9, code: v.code }, { ip: busy })).status, 429)
})

test('V-68 (I-1) a guesser rotating x-forwarded-for meets the event cap: 50 refused codes an hour per event, then 429 for everyone there; another event is unaffected', async () => {
  const event = await twoEvents()
  const other = await twoEvents()
  const [c9] = event.categoryIds
  const v = await makeVoucher(event.eventId, { percent: 15, max_uses: 5 })
  const w = await makeVoucher(other.eventId, { percent: 15, max_uses: 5 })

  // An accepted code and a request that judged no code (404) spend no event slot.
  assert.equal((await check({ slug: event.slug, categoryId: c9, code: v.code })).status, 200)
  assert.equal((await check({ slug: event.slug, categoryId: other.categoryIds[0], code: 'ZLY-KOD' })).status, 404)

  // Every guess from a fresh address, as a direct caller of the function can send.
  const statuses = []
  for (let i = 0; i < 50; i++) statuses.push((await check({ slug: event.slug, categoryId: c9, code: `ZGADUJE-${i}` })).status)
  assert.deepEqual(statuses, Array(50).fill(422))
  const locked = await check({ slug: event.slug, categoryId: c9, code: `ZGADUJE-X` })
  assert.equal(locked.status, 429, JSON.stringify(locked.body))
  assert.equal((await check({ slug: event.slug, categoryId: c9, code: v.code })).status, 429)
  // The cap is per event.
  assert.deepEqual((await check({ slug: other.slug, categoryId: other.categoryIds[0], code: w.code })).body, { data: { percent: 15, price: 5100 } })
  assert.equal((await one('vouchers', { id: v.id })).used, 0)
})
