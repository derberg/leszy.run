// Plan 3, task 6: the dpay IPN handler (P-30…P-35b in docs/registration/scenario-matrix.md).
// LOCAL stack plus the mocked dpay (helpers/dpayMock.js), which posts its signed IPNs to
// DPAY_IPN_URL = the local dpay-ipn function. Never real dpay. Every event and address is
// random, so reruns on a stack holding earlier data still pass.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { localEnv, resetThrottle, sessionFor } from './helpers/stack.js'
import { messagesTo, startCapture } from './helpers/emailCapture.js'
import { acceptAgreement, createPublishedPaidEvent } from './helpers/registrationFixtures.js'
import {
  dpayIpns, dpayMode, dpayRefunds, dpayReset, dpayTransactions, payMock, replayIpn, startDpayMock,
} from './helpers/dpayControl.js'
import { MOCK_SECRET } from './helpers/dpayMock.js'
import {
  competitionOf, consentIds, db, expireNow, liveSlots, orderOf, orderOk, registrationsOf, rows, runnerEmail, totalFor,
} from './helpers/orders.js'

const BIEG = (capacity) => [{ name: 'Bieg 9 km', discipline: 'run', distanceLabel: '9 km', startTime: '10:00', capacity }]
const PAYER = 'payer@mock.test' // the address the mock puts in its IPNs
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex')

let owner, stopCapture, stopMock
before(async () => {
  stopCapture = await startCapture()
  stopMock = await startDpayMock()
  await resetThrottle()
  await acceptAgreement('zatyrani-test')
  owner = await sessionFor('owner@zatyrani-test.local')
})
after(async () => {
  if (stopMock) await stopMock()
  if (stopCapture) await stopCapture()
})
beforeEach(async () => { await dpayReset() })

const paidEvent = (capacity = 50) =>
  createPublishedPaidEvent(owner, { prices: { 'Bieg 9 km': 6000 }, competitions: BIEG(capacity) })

const ip = () => `198.51.100.${crypto.randomInt(1, 255)}`

async function call(fn, body, session = null) {
  const res = await fetch(`${localEnv().functionsUrl}/${fn}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip(), ...(session ? { cookie: session.cookie } : {}) },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { status: res.status, body: json }
}

/** POSTs a raw body to dpay-ipn the way dpay's server does (no Origin) → { status, text }. */
async function postIpn(raw, headers = {}) {
  const res = await fetch(`${localEnv().functionsUrl}/dpay-ipn`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw,
  })
  return { status: res.status, text: await res.text() }
}

// The IPN signature written from the dpay docs (obsluga-ipn), independent of the module under test.
function signedIpn({ id, amount, custom, email, type = 'transfer', attempt = 1, version = 1 }) {
  const ipn = { id, amount }
  if (email !== undefined) ipn.email = email
  Object.assign(ipn, { type, attempt, version })
  if (custom !== undefined) ipn.custom = custom
  const s = (v) => (v === undefined || v === null ? '' : String(v))
  const signature = sha256([s(id), MOCK_SECRET, s(amount), s(email), s(type), s(attempt), s(version), s(custom)].join(''))
  return JSON.stringify({ ...ipn, signature })
}

const dpayValue = (g) => `${Math.floor(g / 100)}.${String(g % 100).padStart(2, '0')}`

async function orderBody(event, email, over = {}) {
  return {
    categoryId: event.categoryIds[0],
    person: { firstName: 'Ola', lastName: 'Leśna', birthDate: '1990-05-01', gender: 'K', email, phone: '600100200' },
    acceptedConsentIds: await consentIds(event.eventId),
    serviceRegulamin: true,
    supportChoice: false,
    displayedTotal: totalFor(6000, 1, false),
    ...over,
  }
}

/** A pending order through create-order → { event, email, runner, orderId, txn }. */
async function pendingOrder({ event, tag = 'ipn' } = {}) {
  const ev = event ?? await paidEvent()
  const email = runnerEmail(tag)
  const runner = await sessionFor(email)
  const r = await call('create-order', await orderBody(ev, email), runner)
  assert.equal(r.status, 201, JSON.stringify(r.body))
  const { orderId } = r.body.data
  const [attempt] = await rows('payment_attempts', { order_id: orderId })
  return { event: ev, email, runner, orderId, txn: attempt.dpay_transaction_id }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(check, { ms = 15_000, step = 150, what = 'condition' } = {}) {
  const until = Date.now() + ms
  for (;;) {
    const v = await check()
    if (v) return v
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await sleep(step)
  }
}

async function waitForMail(email, n = 1) {
  for (let i = 0; i < 30; i++) {
    const msgs = await messagesTo(email)
    if (msgs.length >= n) return msgs
    await sleep(250)
  }
  return messagesTo(email)
}

const alertsOf = (orderId) => rows('operator_alerts', { order_id: orderId })
const ipnEventsOf = (orderId) => rows('payment_events', { order_id: orderId, kind: 'ipn' })
const participantsOf = (registrationId) => rows('participants', { registration_id: registrationId })
const subjects = (msgs) => msgs.map((m) => m.subject.split(' — ')[0]).sort()

/** Re-sends a transaction's IPN once, retrying while the mock has not stored it yet. */
async function replayOnce(txnId) {
  for (let i = 0; ; i++) {
    try {
      return await replayIpn(txnId, { times: 1 })
    } catch (err) {
      if (i > 40) throw err
      await sleep(25)
    }
  }
}

// ---------------------------------------------------------------- P-30 double payment

test('P-30 two attempts both paid → one confirmation, one participant, the second refunded in full, one refund e-mail, one alert', async () => {
  const { orderId, runner, email } = await pendingOrder({ tag: 'double' })
  assert.equal((await call('pay-order', { orderId }, runner)).status, 200)
  const txns = await dpayTransactions()
  assert.equal(txns.length, 2)
  for (const t of txns) await payMock(t.id, 'paid')

  const ipns = await dpayIpns()
  assert.equal(ipns.length, 2, JSON.stringify(ipns.map((i) => i.responseText)))
  assert.ok(ipns.every((i) => i.responseText === 'OK'))

  const order = await orderOf(orderId)
  assert.equal(order.status, 'paid')
  assert.equal(order.paid_transaction_id, txns[0].id)
  const [reg] = await registrationsOf(orderId)
  assert.equal(reg.status, 'confirmed')
  assert.equal((await participantsOf(reg.id)).length, 1)

  const refunds = await dpayRefunds()
  assert.deepEqual(refunds.map((r) => [r.txnId, r.grosze]), [[txns[1].id, order.total]])
  const [refund] = await rows('refunds', { order_id: orderId })
  assert.equal(refund.dpay_status, 'accepted')
  assert.equal(refund.amount, order.total)
  assert.equal(refund.reason, 'double_payment')

  const msgs = await waitForMail(email, 2)
  assert.deepEqual(subjects(msgs), ['Opłacone', 'Płatność zwrócona'])
  const alerts = await alertsOf(orderId)
  assert.deepEqual(alerts.map((a) => a.kind), ['double_payment'])
})

// ---------------------------------------------------------------- P-31 late payment

test('P-31 the IPN lands after expire_orders: the slot is re-claimed and the order confirmed', async () => {
  const { orderId, email, event, txn } = await pendingOrder({ tag: 'late' })
  const cat = event.categoryIds[0]
  await dpayMode({ ipnDelayMs: 1500 })
  await payMock(txn, 'paid')
  assert.equal(await expireNow(orderId), 1)
  assert.equal((await orderOf(orderId)).status, 'expired')
  assert.equal((await competitionOf(cat)).taken, 0)

  await waitFor(async () => (await orderOf(orderId)).status === 'paid', { what: 'late confirmation' })
  const [reg] = await registrationsOf(orderId)
  assert.equal(reg.status, 'confirmed')
  assert.equal((await participantsOf(reg.id)).length, 1)
  assert.equal((await competitionOf(cat)).taken, 1)
  assert.equal(await liveSlots(cat), 1)
  const msgs = await waitForMail(email)
  assert.deepEqual(subjects(msgs), ['Opłacone'])
  assert.equal((await dpayRefunds()).length, 0)
})

test('P-31 the IPN lands after expiry and someone took the slot: refunded in full including fees, „Płatność zwrócona”, taken unchanged', async () => {
  const event = await paidEvent(1)
  const cat = event.categoryIds[0]
  const { orderId, email, txn } = await pendingOrder({ event, tag: 'lateful' })
  await dpayMode({ ipnDelayMs: 1500 })
  await payMock(txn, 'paid')
  await expireNow(orderId)
  await orderOk(event) // another runner takes the only slot
  assert.equal((await competitionOf(cat)).taken, 1)

  await waitFor(async () => (await rows('refunds', { order_id: orderId }))[0]?.dpay_status === 'accepted', { what: 'late refund' })
  const order = await orderOf(orderId)
  assert.equal(order.status, 'expired')
  const [refund] = await rows('refunds', { order_id: orderId })
  assert.equal(refund.amount, order.total)
  assert.ok(order.payment_fee > 0)
  assert.equal(refund.reason, 'full')
  assert.deepEqual((await dpayRefunds()).map((r) => [r.txnId, r.grosze]), [[txn, order.total]])
  assert.equal((await competitionOf(cat)).taken, 1)
  assert.equal(await liveSlots(cat), 1)
  assert.deepEqual((await registrationsOf(orderId)).map((r) => r.status), ['expired'])
  const msgs = await waitForMail(email)
  assert.deepEqual(subjects(msgs), ['Płatność zwrócona'])
  assert.deepEqual((await alertsOf(orderId)).map((a) => a.kind), ['late_refund'])
})

// ---------------------------------------------------------------- P-32 bad signature

test('P-32 corruptSignature → 400 INVALID on every delivery, the order still pending, logged with checksum_ok=false', async () => {
  const { orderId, txn } = await pendingOrder({ tag: 'forged' })
  await dpayMode({ corruptSignature: true })
  await payMock(txn, 'paid')
  const ipns = await dpayIpns()
  assert.ok(ipns.length >= 2, 'the mock retried')
  assert.ok(ipns.every((i) => i.responseText === 'INVALID'), JSON.stringify(ipns.map((i) => i.responseText)))

  assert.equal((await orderOf(orderId)).status, 'pending')
  assert.deepEqual((await rows('payment_attempts', { order_id: orderId })).map((a) => a.status), ['created'])
  const events = await ipnEventsOf(orderId)
  assert.equal(events.length, ipns.length)
  assert.ok(events.every((e) => e.checksum_ok === false))
  assert.equal((await alertsOf(orderId)).length, 0)
})

test('P-32 an unparsable body or one over 8 KB → INVALID, nothing confirmed; a GET is refused', async () => {
  const garbage = await postIpn('{not json')
  assert.equal(garbage.status, 400)
  assert.equal(garbage.text, 'INVALID')
  const array = await postIpn('[1,2]')
  assert.equal(array.status, 400)
  assert.equal(array.text, 'INVALID')
  const big = await postIpn(JSON.stringify({ id: 'X', pad: 'a'.repeat(9000) }))
  assert.equal(big.status, 413)
  assert.equal(big.text, 'INVALID')
  const get = await fetch(`${localEnv().functionsUrl}/dpay-ipn`)
  assert.equal(get.status, 405)
  await get.text()
})

// ---------------------------------------------------------------- P-33 replays

test('P-33 five replays and three duplicate deliveries at once → every body OK, one confirmation e-mail, one participant', async () => {
  const { orderId, email, txn } = await pendingOrder({ tag: 'replay' })
  await dpayMode({ duplicateIpn: 3 })
  const paying = payMock(txn, 'paid')
  await Promise.all([paying, ...Array.from({ length: 5 }, () => replayOnce(txn))])

  const ipns = (await dpayIpns()).filter((i) => i.txnId === txn)
  assert.equal(ipns.length, 8, JSON.stringify(ipns.map((i) => i.responseText)))
  assert.ok(ipns.every((i) => i.responseText === 'OK'), JSON.stringify(ipns.map((i) => i.responseText)))
  assert.equal((await orderOf(orderId)).status, 'paid')
  const [reg] = await registrationsOf(orderId)
  assert.equal((await participantsOf(reg.id)).length, 1)
  await sleep(800)
  assert.deepEqual(subjects(await messagesTo(email)), ['Opłacone'])
  assert.equal((await dpayRefunds()).length, 0)
  assert.equal((await alertsOf(orderId)).length, 0)
  assert.equal((await ipnEventsOf(orderId)).length, 8, 'every delivery logged')
})

// ---------------------------------------------------------------- P-34 cross-order, mismatch, unknown

test('P-34 a signed IPN naming order B with order A\'s transaction → unknown_attempt, nothing confirmed, one alert however often it comes', async () => {
  const a = await pendingOrder({ tag: 'crossa' })
  const b = await pendingOrder({ tag: 'crossb', event: a.event })
  const total = (await orderOf(a.orderId)).total
  const body = signedIpn({ id: a.txn, amount: dpayValue(total), custom: b.orderId, email: PAYER })
  const answers = await Promise.all(Array.from({ length: 4 }, () => postIpn(body)))
  assert.deepEqual(answers.map((r) => r.text), ['OK', 'OK', 'OK', 'OK'])

  assert.equal((await orderOf(a.orderId)).status, 'pending')
  assert.equal((await orderOf(b.orderId)).status, 'pending')
  assert.deepEqual((await rows('payment_attempts', { order_id: a.orderId })).map((x) => x.status), ['created'])
  const alerts = await alertsOf(b.orderId)
  assert.deepEqual(alerts.map((x) => x.kind), ['unknown_attempt'])
  assert.equal(alerts[0].payload.txn, a.txn)
  assert.equal((await ipnEventsOf(b.orderId)).length, 4)
})

test('P-34 ipnAmountOverride → amount_mismatch alert once (replays too), still pending, never refunded', async () => {
  const { orderId, txn } = await pendingOrder({ tag: 'mismatch' })
  await dpayMode({ ipnAmountOverride: '1.00' })
  await payMock(txn, 'paid')
  await Promise.all(Array.from({ length: 3 }, () => replayOnce(txn)))
  const ipns = await dpayIpns()
  assert.ok(ipns.every((i) => i.responseText === 'OK'))
  assert.equal((await orderOf(orderId)).status, 'pending')
  assert.deepEqual((await rows('payment_attempts', { order_id: orderId })).map((x) => x.status), ['created'])
  assert.deepEqual((await alertsOf(orderId)).map((x) => x.kind), ['amount_mismatch'])
  assert.equal((await dpayRefunds()).length, 0)
})

test('P-34 custom not a uuid, or an order that does not exist → OK, one alert per transaction, logged without an order', async () => {
  const txnA = `TXN-${crypto.randomUUID()}`
  const unknown = signedIpn({ id: txnA, amount: '60.55', custom: crypto.randomUUID(), email: PAYER })
  const r1 = await Promise.all(Array.from({ length: 3 }, () => postIpn(unknown)))
  assert.deepEqual(r1.map((r) => r.text), ['OK', 'OK', 'OK'])
  const txnB = `TXN-${crypto.randomUUID()}`
  const junk = signedIpn({ id: txnB, amount: '60.55', custom: 'not-a-uuid' })
  assert.equal((await postIpn(junk)).text, 'OK')
  assert.equal((await postIpn(junk)).text, 'OK')

  for (const txn of [txnA, txnB]) {
    const { data, error } = await db().from('operator_alerts').select('kind, order_id').eq('payload->>txn', txn)
    assert.ifError(error)
    assert.deepEqual(data.map((x) => [x.kind, x.order_id]), [['unknown_attempt', null]], txn)
  }
  const { data: logged, error } = await db().from('payment_events').select('order_id, checksum_ok, email_sha256')
    .eq('kind', 'ipn').eq('payload->>id', txnA)
  assert.ifError(error)
  assert.equal(logged.length, 3)
  assert.ok(logged.every((e) => e.order_id === null && e.checksum_ok === true && e.email_sha256 === sha256(PAYER)))
})

test('P-34 a type other than transfer → logged, OK, nothing confirmed', async () => {
  const { orderId, txn } = await pendingOrder({ tag: 'dcb' })
  const total = (await orderOf(orderId)).total
  const r = await postIpn(signedIpn({ id: txn, amount: dpayValue(total), custom: orderId, type: 'refund' }))
  assert.equal(r.text, 'OK')
  assert.equal((await orderOf(orderId)).status, 'pending')
  assert.equal((await ipnEventsOf(orderId)).length, 1)
})

// ---------------------------------------------------------------- P-35 privacy, retries

test('P-35 no plaintext address in payment_events, the payer stored as email_sha256; a first non-OK answer is retried until OK', async () => {
  const { orderId, email, txn } = await pendingOrder({ tag: 'privacy' })
  // A scratch trigger fails the first confirm of this transaction only (a sequence is not
  // rolled back), so the first delivery gets a DB error and the mock retries.
  const postgres = (await import('postgres')).default
  const sql = postgres(localEnv().dbUrl, { max: 1, onnotice: () => {} })
  const tag = crypto.randomBytes(3).toString('hex')
  const fn = `zz_test_ipn_fail_once_${tag}`
  try {
    await sql.unsafe(`
      CREATE SEQUENCE public.${fn}_seq;
      CREATE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
      BEGIN
        IF NEW.dpay_transaction_id = '${txn}' AND nextval('public.${fn}_seq') = 1 THEN
          RAISE EXCEPTION 'test: transient failure';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER ${fn} BEFORE UPDATE ON public.payment_attempts FOR EACH ROW EXECUTE FUNCTION public.${fn}();`)
    await payMock(txn, 'paid')
  } finally {
    await sql.unsafe(`DROP TRIGGER IF EXISTS ${fn} ON public.payment_attempts; DROP FUNCTION IF EXISTS public.${fn}(); DROP SEQUENCE IF EXISTS public.${fn}_seq;`)
    await sql.end()
  }

  const ipns = await dpayIpns()
  assert.deepEqual(ipns.map((i) => i.responseText), ['ERROR', 'OK'])
  assert.equal((await orderOf(orderId)).status, 'paid')
  assert.deepEqual(subjects(await waitForMail(email)), ['Opłacone'])

  const events = await rows('payment_events', { order_id: orderId })
  assert.doesNotMatch(JSON.stringify(events), /@/)
  const ipnRows = events.filter((e) => e.kind === 'ipn')
  assert.equal(ipnRows.length, 2)
  assert.ok(ipnRows.every((e) => e.email_sha256 === sha256(PAYER) && e.checksum_ok === true))
  assert.ok(ipnRows.every((e) => e.payment_attempt_id))
})

test('P-35 ipnWithoutEmail → confirmed, email_sha256 null', async () => {
  const { orderId, txn } = await pendingOrder({ tag: 'noemail' })
  await dpayMode({ ipnWithoutEmail: true })
  await payMock(txn, 'paid')
  assert.equal((await orderOf(orderId)).status, 'paid')
  const [event] = await ipnEventsOf(orderId)
  assert.equal(event.email_sha256, null)
  assert.equal(event.checksum_ok, true)
})

// ---------------------------------------------------------------- P-35b refund idempotency and failures

test('P-35b the double-payment IPN delivered 5× at once and replayed 5× at once → exactly one mock refund', async () => {
  const { orderId, runner, email } = await pendingOrder({ tag: 'dblreplay' })
  assert.equal((await call('pay-order', { orderId }, runner)).status, 200)
  const [first, second] = await dpayTransactions()
  await payMock(first.id, 'paid')
  await dpayMode({ duplicateIpn: 5 })
  await payMock(second.id, 'paid')
  await Promise.all(Array.from({ length: 5 }, () => replayOnce(second.id)))

  const refunds = await dpayRefunds()
  assert.equal(refunds.length, 1, 'the mock does not deduplicate, so one call means one refund decision')
  assert.equal(refunds[0].txnId, second.id)
  assert.ok((await dpayIpns()).every((i) => i.responseText === 'OK'))
  assert.equal((await rows('refunds', { order_id: orderId })).length, 1)
  assert.deepEqual((await alertsOf(orderId)).map((a) => a.kind), ['double_payment'])
  await sleep(500)
  assert.deepEqual(subjects(await messagesTo(email)), ['Opłacone', 'Płatność zwrócona'])
})

test('P-35b refundInsufficient → refunds.dpay_status insufficient_balance, next_retry_at set, one alert, no refund e-mail', async () => {
  const { orderId, runner, email } = await pendingOrder({ tag: 'insuff' })
  assert.equal((await call('pay-order', { orderId }, runner)).status, 200)
  const [first, second] = await dpayTransactions()
  await payMock(first.id, 'paid')
  await dpayMode({ refundInsufficient: true })
  await payMock(second.id, 'paid')

  const [refund] = await rows('refunds', { order_id: orderId })
  assert.equal(refund.dpay_status, 'insufficient_balance')
  assert.ok(refund.next_retry_at)
  assert.equal((await dpayRefunds()).length, 0)
  assert.deepEqual((await alertsOf(orderId)).map((a) => a.kind), ['double_payment'])
  await sleep(500)
  assert.deepEqual(subjects(await messagesTo(email)), ['Opłacone'])
})

test('P-35b refundHang → refunds.dpay_status unknown, no retry scheduled, an alert naming the outcome; the IPN still ends OK', async () => {
  const { orderId, runner, email } = await pendingOrder({ tag: 'hang' })
  assert.equal((await call('pay-order', { orderId }, runner)).status, 200)
  const [first, second] = await dpayTransactions()
  await payMock(first.id, 'paid')
  await dpayMode({ refundHang: true })
  await payMock(second.id, 'paid')

  await waitFor(async () => (await rows('refunds', { order_id: orderId }))[0]?.dpay_status === 'unknown', { ms: 25_000, what: 'refund unknown' })
  const [refund] = await rows('refunds', { order_id: orderId })
  assert.equal(refund.next_retry_at, null)
  const kinds = (await alertsOf(orderId)).map((a) => a.kind).sort()
  assert.deepEqual(kinds, ['double_payment', 'refund_unknown'])
  const ipns = (await dpayIpns()).filter((i) => i.txnId === second.id)
  assert.equal(ipns.at(-1).responseText, 'OK')
  assert.equal((await dpayRefunds()).length, 0)
  assert.deepEqual(subjects(await messagesTo(email)), ['Opłacone'])
})
