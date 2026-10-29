// Plan 3, task 5: create-order, pay-order, order-status (P-20…P-24 in
// docs/registration/scenario-matrix.md). LOCAL stack plus the mocked dpay
// (helpers/dpayMock.js); never real dpay. Every event and address is random,
// so reruns on a stack holding earlier data still pass.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import postgres from 'postgres'
import { localEnv, resetThrottle, sessionFor } from './helpers/stack.js'
import { messagesTo, startCapture } from './helpers/emailCapture.js'
import { acceptAgreement, createPublishedPaidEvent } from './helpers/registrationFixtures.js'
import { dpayMode, dpayRefunds, dpayReset, dpayTransactions, payMock, startDpayMock } from './helpers/dpayControl.js'
import { DPAY_MOCK_PORT } from './helpers/dpayMock.js'
import {
  competitionOf, confirmOk, consentIds, db, expireNow, minutesFromNow, one, orderOf, orderOk, paidOrderOk, registrationsOf, rows,
  runnerEmail, setSettings, totalFor,
} from './helpers/orders.js'
import { formatDpayValue, formatPln, orderAmounts } from '../../supabase/functions/_shared/registration/money.js'

const CLOSED = 'Zapisy są zamknięte.'
const CONSENTS = 'Zaznacz wymagane zgody.'
const PRICE_CHANGED = 'Cena się zmieniła. Sprawdź podsumowanie.'
const DPAY_DOWN = 'Nie udało się połączyć z operatorem płatności. Spróbuj ponownie.'
const PAYING_CLOSED = 'Zapisy z płatnością online kończą się godzinę przed zamknięciem zapisów.'
const DUPLICATE = 'Ten adres e-mail jest już zapisany na te zawody.'
const PENDING_ORDER = 'Masz już nieopłacone zgłoszenie na te zawody.'

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

const paidEvent = (opts = {}) => createPublishedPaidEvent(owner, { prices: { 'Bieg 9 km': 6000 }, ...opts })

// A random documentation-range address per call keeps the per-IP throttle out of the way.
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
  return { status: res.status, body: json, setCookie: res.headers.get('set-cookie') }
}

const person = (email, over = {}) => ({
  firstName: 'Ola', lastName: 'Leśna', birthDate: '1990-05-01', gender: 'K', email, phone: '600100200', ...over,
})

async function orderBody(event, email, over = {}) {
  return {
    categoryId: event.categoryIds[0],
    person: person(email),
    acceptedConsentIds: await consentIds(event.eventId),
    serviceRegulamin: true,
    supportChoice: false,
    displayedTotal: totalFor(6000, 1, false),
    ...over,
  }
}

const ordersOf = (eventId) => rows('orders', { event_id: eventId })
const attemptsOf = (orderId) => rows('payment_attempts', { order_id: orderId })

async function participantsOf(registrationId) {
  return rows('participants', { registration_id: registrationId })
}

/** A pending order through create-order → { event, email, runner, orderId, redirectUrl }. */
async function pendingOrder(opts = {}) {
  const event = opts.event ?? await paidEvent(opts.eventOpts)
  const email = runnerEmail(opts.tag ?? 'co')
  const runner = await sessionFor(email)
  const r = await call('create-order', await orderBody(event, email, opts.body), runner)
  assert.equal(r.status, 201, JSON.stringify(r.body))
  return { event, email, runner, ...r.body.data }
}

/** Makes the order's attempts old enough for the poll and clears the poll stamp. */
async function pollable(orderId) {
  const old = new Date(Date.now() - 60_000).toISOString()
  let { error } = await db().from('payment_attempts').update({ created_at: old }).eq('order_id', orderId)
  if (error) throw error
  ;({ error } = await db().from('orders').update({ last_status_check_at: null }).eq('id', orderId))
  if (error) throw error
}

async function waitForMail(email, n = 1) {
  for (let i = 0; i < 20; i++) {
    const msgs = await messagesTo(email)
    if (msgs.length >= n) return msgs
    await new Promise((r) => setTimeout(r, 250))
  }
  return messagesTo(email)
}

// ---------------------------------------------------------------- P-20 refusals

test('P-20 the support choice missing or not a boolean → 400; displayedTotal not an integer → 400; nothing created', async () => {
  const event = await paidEvent()
  const email = runnerEmail('nochoice')
  const runner = await sessionFor(email)
  for (const over of [{ supportChoice: undefined }, { supportChoice: null }, { supportChoice: 'tak' }]) {
    const body = await orderBody(event, email, over)
    if (over.supportChoice === undefined) delete body.supportChoice
    const r = await call('create-order', body, runner)
    assert.equal(r.status, 400, JSON.stringify(r.body))
    assert.equal(r.body.code, 'support_choice_required')
  }
  for (const displayedTotal of [undefined, '6055', 60.55, null]) {
    const body = await orderBody(event, email, { displayedTotal })
    const r = await call('create-order', body, runner)
    assert.equal(r.status, 400, JSON.stringify(r.body))
    assert.equal(r.body.code, 'invalid_total')
  }
  assert.equal((await ordersOf(event.eventId)).length, 0)
  assert.equal((await competitionOf(event.categoryIds[0])).taken, 0)
})

test('P-20 displayedTotal off by one → 409 price_changed with the server amounts, no order row, nothing claimed', async () => {
  const event = await paidEvent()
  const email = runnerEmail('price')
  const runner = await sessionFor(email)
  const right = totalFor(6000, 1, true)
  const r = await call('create-order', await orderBody(event, email, { supportChoice: true, displayedTotal: right - 1 }), runner)
  assert.equal(r.status, 409, JSON.stringify(r.body))
  assert.equal(r.body.code, 'price_changed')
  assert.equal(r.body.error, PRICE_CHANGED)
  const expected = orderAmounts({ entryPrices: [6000], supportChoice: true })
  assert.deepEqual(r.body.amounts, {
    entryTotal: expected.entryTotal, extrasTotal: 0, donation: 0,
    supportFee: expected.supportFee, paymentFee: expected.paymentFee, total: expected.total,
  })
  assert.equal(r.body.amounts.total, right)
  assert.equal((await ordersOf(event.eventId)).length, 0)
  assert.equal((await competitionOf(event.categoryIds[0])).taken, 0)
  assert.equal((await dpayTransactions()).length, 0, 'dpay never called')
})

test('P-20 the image acceptance left out → 400 consents_required; no phone → 400 invalid_person with fields.phone', async () => {
  const event = await paidEvent()
  const email = runnerEmail('consent')
  const runner = await sessionFor(email)
  const { data: image } = await db().from('event_consents').select('id').eq('event_id', event.eventId).eq('kind', 'image').single()
  const all = await consentIds(event.eventId)

  const noImage = await call('create-order', await orderBody(event, email, { acceptedConsentIds: all.filter((id) => id !== image.id) }), runner)
  assert.equal(noImage.status, 400, JSON.stringify(noImage.body))
  assert.equal(noImage.body.code, 'consents_required')
  assert.equal(noImage.body.error, CONSENTS)

  const noService = await call('create-order', await orderBody(event, email, { serviceRegulamin: false }), runner)
  assert.equal(noService.status, 400)
  assert.equal(noService.body.code, 'consents_required')

  const noPhone = await call('create-order', await orderBody(event, email, { person: person(email, { phone: '' }) }), runner)
  assert.equal(noPhone.status, 400, JSON.stringify(noPhone.body))
  assert.equal(noPhone.body.code, 'invalid_person')
  assert.ok(noPhone.body.fields?.phone, JSON.stringify(noPhone.body))

  assert.equal((await ordersOf(event.eventId)).length, 0)
})

test('P-20 no session and no code → 401 code_required; a free event → 409; an hour before closing → 409 paying_closed; closed → 409', async () => {
  const event = await paidEvent()
  const email = runnerEmail('nocode')
  const r = await call('create-order', await orderBody(event, email))
  assert.equal(r.status, 401, JSON.stringify(r.body))
  assert.equal(r.body.code, 'code_required')

  const runner = await sessionFor(email)
  await setSettings(event.eventId, { closes_at: minutesFromNow(30) })
  const late = await call('create-order', await orderBody(event, email), runner)
  assert.equal(late.status, 409, JSON.stringify(late.body))
  assert.equal(late.body.code, 'paying_closed')
  assert.equal(late.body.error, PAYING_CLOSED)

  await setSettings(event.eventId, { closes_at: minutesFromNow(-1) })
  const closed = await call('create-order', await orderBody(event, email), runner)
  assert.equal(closed.status, 409)
  assert.equal(closed.body.error, CLOSED)

  await setSettings(event.eventId, { closes_at: minutesFromNow(60 * 24), pricing_mode: 'free' })
  const free = await call('create-order', await orderBody(event, email), runner)
  assert.equal(free.status, 409, JSON.stringify(free.body))
  assert.equal(free.body.code, 'free_event')
  assert.equal((await ordersOf(event.eventId)).length, 0)
})

// ---------------------------------------------------------------- P-21 happy path

test('P-21 create-order → one dpay register for the total, redirect to the mock, order pending, no e-mail yet', async () => {
  const event = await paidEvent()
  const email = runnerEmail('happy')
  const runner = await sessionFor(email)
  const total = totalFor(6000, 1, true)
  const r = await call('create-order', await orderBody(event, email, { supportChoice: true, displayedTotal: total }), runner)
  assert.equal(r.status, 201, JSON.stringify(r.body))
  const { orderId, redirectUrl } = r.body.data

  const txns = await dpayTransactions()
  assert.equal(txns.length, 1)
  assert.equal(txns[0].request.value, formatDpayValue(total))
  assert.equal(txns[0].request.custom, orderId)
  assert.equal(txns[0].request.channel, undefined, 'never a preselected channel')
  assert.equal(txns[0].request.url_success, `http://localhost:5173/zamowienie/${orderId}`)
  assert.equal(redirectUrl, `http://localhost:${DPAY_MOCK_PORT}/pay/${txns[0].id}`)

  const order = await orderOf(orderId)
  assert.equal(order.status, 'pending')
  assert.equal(order.total, total)
  assert.equal(order.support_choice, true)
  assert.equal(order.buyer_profile_id, runner.profileId)
  const attempts = await attemptsOf(orderId)
  assert.deepEqual(attempts.map((a) => [a.dpay_transaction_id, a.grosze, a.status]), [[txns[0].id, total, 'created']])
  const regs = await registrationsOf(orderId)
  assert.deepEqual(regs.map((x) => x.status), ['pending_payment'])
  assert.equal((await participantsOf(regs[0].id)).length, 0)

  // The register call is logged, redacted, with no address anywhere.
  const events = await rows('payment_events', { order_id: orderId })
  assert.deepEqual(events.map((e) => e.kind), ['register'])
  assert.equal(events[0].payment_attempt_id, attempts[0].id)
  assert.doesNotMatch(JSON.stringify(events[0].payload), /@/)

  await new Promise((r2) => setTimeout(r2, 500))
  assert.equal((await messagesTo(email)).length, 0, 'no e-mail before payment')
})

test('P-21 a total-0 order (price 0) is paid at once without dpay: 201 { orderId, status: paid } and the participant', async () => {
  const event = await createPublishedPaidEvent(owner, { prices: { 'Bieg 9 km': 0 } })
  const email = runnerEmail('zero')
  const runner = await sessionFor(email)
  const r = await call('create-order', await orderBody(event, email, { displayedTotal: 0 }), runner)
  assert.equal(r.status, 201, JSON.stringify(r.body))
  assert.equal(r.body.data.status, 'paid')
  assert.equal(r.body.data.redirectUrl, undefined)
  assert.equal((await dpayTransactions()).length, 0)
  const regs = await registrationsOf(r.body.data.orderId)
  assert.equal(regs[0].status, 'confirmed')
  assert.equal((await participantsOf(regs[0].id)).length, 1)
  // P3-R9: nothing was paid, so the e-mail confirms the registration, not a payment.
  const msgs = await waitForMail(email)
  assert.equal(msgs.length, 1)
  assert.match(msgs[0].subject, /^Zapis potwierdzony — /)
  assert.doesNotMatch(msgs[0].text, /Opłacone|Razem|dpay|płatnoś/)
})

// ---------------------------------------------------------------- P-22 pay again

test('P-22 pay-order twice → two more attempts and two more mock transactions; another profile → 404; no session → 401', async () => {
  const { orderId, runner, event } = await pendingOrder({ tag: 'payagain' })
  const total = (await orderOf(orderId)).total

  const a = await call('pay-order', { orderId }, runner)
  assert.equal(a.status, 200, JSON.stringify(a.body))
  const b = await call('pay-order', { orderId }, runner)
  assert.equal(b.status, 200, JSON.stringify(b.body))
  assert.notEqual(a.body.data.redirectUrl, b.body.data.redirectUrl)

  const txns = await dpayTransactions()
  assert.equal(txns.length, 3)
  assert.ok(txns.every((t) => t.request.value === formatDpayValue(total) && t.request.custom === orderId))
  const attempts = await attemptsOf(orderId)
  assert.equal(attempts.length, 3)
  assert.deepEqual(new Set(attempts.map((x) => x.dpay_transaction_id)), new Set(txns.map((t) => t.id)))

  const stranger = await sessionFor(runnerEmail('stranger'))
  const other = await call('pay-order', { orderId }, stranger)
  assert.equal(other.status, 404)
  const notUuid = await call('pay-order', { orderId: 'nope' }, runner)
  assert.equal(notUuid.status, 404)
  const anon = await call('pay-order', { orderId })
  assert.equal(anon.status, 401)
  assert.equal((await attemptsOf(orderId)).length, 3)
  assert.equal((await competitionOf(event.categoryIds[0])).taken, 0, 'an unpaid order holds no place (P3-R15)')
})

test('P-22 pay-order on an expired order → 409 expired; after closes_at → 409 „Zapisy są zamknięte.”; a paid order → 409', async () => {
  const first = await pendingOrder({ tag: 'expired' })
  await expireNow(first.orderId)
  const r = await call('pay-order', { orderId: first.orderId }, first.runner)
  assert.equal(r.status, 409, JSON.stringify(r.body))
  assert.equal(r.body.code, 'expired')
  assert.equal((await attemptsOf(first.orderId)).length, 1)

  const second = await pendingOrder({ tag: 'closed' })
  await setSettings(second.event.eventId, { closes_at: minutesFromNow(-1) })
  const c = await call('pay-order', { orderId: second.orderId }, second.runner)
  assert.equal(c.status, 409, JSON.stringify(c.body))
  assert.equal(c.body.error, CLOSED)
  assert.equal((await attemptsOf(second.orderId)).length, 1)
  assert.equal((await dpayTransactions()).length, 2, 'no dpay call for a refused payment')
})

// ---------------------------------------------------------------- P-23 dpay down

test('P-23 dpay register fails → 502, the order cancelled; a retry succeeds', async () => {
  const event = await paidEvent()
  const email = runnerEmail('down')
  const runner = await sessionFor(email)
  await dpayMode({ registerFails: true })
  const r = await call('create-order', await orderBody(event, email), runner)
  assert.equal(r.status, 502, JSON.stringify(r.body))
  assert.equal(r.body.error, DPAY_DOWN)

  const [order] = await ordersOf(event.eventId)
  assert.equal(order.status, 'cancelled')
  assert.equal(order.cancelled_reason, 'dpay_register_failed')
  assert.deepEqual((await registrationsOf(order.id)).map((x) => x.status), ['cancelled'])
  assert.equal((await competitionOf(event.categoryIds[0])).taken, 0)

  // HTTP 200 with error:true is a failure too.
  await dpayMode({ registerFails: false, registerErrorBody: true })
  const r2 = await call('create-order', await orderBody(event, email), runner)
  assert.equal(r2.status, 502)
  assert.equal((await competitionOf(event.categoryIds[0])).taken, 0)

  await dpayMode({ registerErrorBody: false })
  const ok = await call('create-order', await orderBody(event, email), runner)
  assert.equal(ok.status, 201, JSON.stringify(ok.body))
  assert.equal((await orderOf(ok.body.data.orderId)).status, 'pending')
  assert.equal((await competitionOf(event.categoryIds[0])).taken, 0)
})

// ---------------------------------------------------------------- P-24 poll fallback

test('P-24 order-status: buyer only, with the event\'s closesAt; a fresh pending order is not polled', async () => {
  const { orderId, runner, event } = await pendingOrder({ tag: 'status' })
  const r = await call('order-status', { orderId }, runner)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const d = r.body.data
  assert.equal(d.status, 'pending')
  assert.ok(d.expiresAt)
  const [reg] = await registrationsOf(orderId)
  // Plan 4 task 5a (G-45): each line also names its registration, role and consent state.
  assert.deepEqual(d.lines, [{
    registrationId: reg.id, name: 'Ola Leśna', firstName: 'Ola', role: 'self', consentState: 'accepted',
    competition: 'Bieg 9 km', ageGroupLabel: 'K open', startTime: '10:00', amount: 6000,
  }])
  const expected = orderAmounts({ entryPrices: [6000], supportChoice: false })
  assert.deepEqual(d.amounts, {
    entryTotal: 6000, extrasTotal: 0, donation: 0, supportFee: 0, paymentFee: expected.paymentFee, total: expected.total,
  })
  assert.equal(d.event.slug, event.slug)
  assert.ok(d.event.name)
  // Task 9 review M1: the order page decides „Zapłać” from the server's closesAt, not the snapshot's.
  const settings = await one('registration_settings', { event_id: event.eventId })
  assert.equal(Date.parse(d.closesAt), Date.parse(settings.closes_at))
  assert.equal((await rows('payment_events', { order_id: orderId, kind: 'status_check' })).length, 0, 'attempt younger than 15 s')

  const stranger = await sessionFor(runnerEmail('peek'))
  assert.equal((await call('order-status', { orderId }, stranger)).status, 404)
  assert.equal((await call('order-status', { orderId })).status, 401)
})

test('P-24 poll fallback with dropIpn: paid at dpay → order-status confirms, one confirmation e-mail, the participant; a second poll sends nothing', async () => {
  const event = await paidEvent()
  const email = runnerEmail('poll')
  const runner = await sessionFor(email)
  const total = totalFor(6000, 1, true)
  const created = await call('create-order', await orderBody(event, email, { supportChoice: true, displayedTotal: total }), runner)
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const { orderId } = created.body.data

  await dpayMode({ dropIpn: true })
  const [txn] = await dpayTransactions()
  await payMock(txn.id, 'paid')
  await pollable(orderId)

  const r = await call('order-status', { orderId }, runner)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.data.status, 'paid')

  const order = await orderOf(orderId)
  assert.equal(order.status, 'paid')
  assert.equal(order.paid_transaction_id, txn.id)
  assert.ok(order.last_status_check_at)
  const [reg] = await registrationsOf(orderId)
  assert.equal(reg.status, 'confirmed')
  assert.equal((await participantsOf(reg.id)).length, 1)
  const checks = await rows('payment_events', { order_id: orderId, kind: 'status_check' })
  assert.equal(checks.length, 1)
  assert.doesNotMatch(JSON.stringify(checks[0].payload), /@/)

  const msgs = await waitForMail(email)
  assert.equal(msgs.length, 1)
  const m = msgs[0]
  assert.equal(m.subject, `Opłacone — ${(await one('registration_settings', { event_id: event.eventId })).name}`)
  const amounts = orderAmounts({ entryPrices: [6000], supportChoice: true })
  for (const [label, grosze] of [
    ['Opłaty startowe', amounts.entryTotal], ['Wsparcie LESZY.RUN', amounts.supportFee],
    ['Obsługa płatności dpay', amounts.paymentFee], ['Razem', amounts.total],
  ]) {
    assert.ok(m.text.includes(label), label)
    assert.ok(m.text.includes(formatPln(grosze)), `${label} ${formatPln(grosze)}`)
  }
  assert.ok(m.text.includes(txn.id))
  assert.ok(m.html)

  await pollable(orderId)
  const again = await call('order-status', { orderId }, runner)
  assert.equal(again.body.data.status, 'paid')
  await new Promise((r2) => setTimeout(r2, 500))
  assert.equal((await messagesTo(email)).length, 1, 'no second e-mail')
  assert.equal((await participantsOf(reg.id)).length, 1)
})

test('P-24 the poll claim: two order-status calls at once check dpay once; within 10 s of a check nothing is polled', async () => {
  const { orderId, runner } = await pendingOrder({ tag: 'claim' })
  await pollable(orderId)
  const [a, b] = await Promise.all([call('order-status', { orderId }, runner), call('order-status', { orderId }, runner)])
  assert.equal(a.status, 200)
  assert.equal(b.status, 200)
  assert.equal((await rows('payment_events', { order_id: orderId, kind: 'status_check' })).length, 1)
  await call('order-status', { orderId }, runner)
  assert.equal((await rows('payment_events', { order_id: orderId, kind: 'status_check' })).length, 1)
  assert.equal((await orderOf(orderId)).status, 'pending', 'created at dpay → still pending')
})

test('P-24 the poll finds two paid attempts: one confirmation, the other refunded in full (settleConfirmOutcome), one refund e-mail', async () => {
  const { orderId, runner, email } = await pendingOrder({ tag: 'twice' })
  assert.equal((await call('pay-order', { orderId }, runner)).status, 200)
  await dpayMode({ dropIpn: true })
  const txns = await dpayTransactions()
  assert.equal(txns.length, 2)
  for (const t of txns) await payMock(t.id, 'paid')
  await pollable(orderId)

  const r = await call('order-status', { orderId }, runner)
  assert.equal(r.body.data.status, 'paid')
  const order = await orderOf(orderId)
  const other = txns.find((t) => t.id !== order.paid_transaction_id)
  const refunds = await dpayRefunds()
  assert.deepEqual(refunds.map((x) => [x.txnId, x.grosze]), [[other.id, order.total]])
  const [refund] = await rows('refunds', { order_id: orderId })
  assert.equal(refund.dpay_status, 'accepted')
  assert.equal(refund.amount, order.total)
  assert.equal(refunds[0].messageId, refund.message_id)
  const logged = await rows('payment_events', { order_id: orderId, kind: 'refund' })
  assert.equal(logged.length, 1)

  const msgs = await waitForMail(email, 2)
  assert.deepEqual(msgs.map((m) => m.subject.split(' — ')[0]).sort(), ['Opłacone', 'Płatność zwrócona'])
  const [reg] = await registrationsOf(orderId)
  assert.equal((await participantsOf(reg.id)).length, 1)
})

// ---------------------------------------------------------------- P-23b (P3-R7) no redirect → cancelled

let sqlClient
const sql = () => (sqlClient ??= postgres(localEnv().dbUrl, { max: 1, onnotice: () => {} }))
after(async () => { if (sqlClient) await sqlClient.end() })

test('P-23b a failure after create_order with no redirect handed out (add_payment_attempt errors) → 500, the order cancelled, the slot back', async () => {
  // LOCAL stack only: a trigger refuses the attempt of orders whose buyer address carries the
  // marker, so nothing else running against this stack is touched; it is dropped afterwards.
  await sql().unsafe(`
    CREATE OR REPLACE FUNCTION public.test_inject_attempt_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM public.orders o WHERE o.id = NEW.order_id AND o.buyer_email LIKE 'inject-fail-%') THEN
        RAISE EXCEPTION 'injected_failure';
      END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS test_inject_attempt_failure ON public.payment_attempts;
    CREATE TRIGGER test_inject_attempt_failure BEFORE INSERT ON public.payment_attempts
      FOR EACH ROW EXECUTE FUNCTION public.test_inject_attempt_failure();`)
  try {
    const event = await paidEvent()
    const email = `inject-fail-${crypto.randomBytes(4).toString('hex')}@test.local`
    const runner = await sessionFor(email)
    const r = await call('create-order', await orderBody(event, email), runner)
    assert.equal(r.status, 500, JSON.stringify(r.body))
    assert.equal(r.body.error, 'Internal server error', 'not „Zapisy są zamknięte.”')

    const [order] = await ordersOf(event.eventId)
    assert.equal(order.status, 'cancelled')
    assert.equal(order.cancelled_reason, 'create_order_aborted')
    assert.deepEqual((await registrationsOf(order.id)).map((x) => x.status), ['cancelled'])
    assert.equal((await competitionOf(event.categoryIds[0])).taken, 0)
    assert.equal((await attemptsOf(order.id)).length, 0)
  } finally {
    await sql().unsafe(`
      DROP TRIGGER IF EXISTS test_inject_attempt_failure ON public.payment_attempts;
      DROP FUNCTION IF EXISTS public.test_inject_attempt_failure();`)
  }
})

// ---------------------------------------------------------------- P-21b (P3-R8) the buyer's own pending order

test('P-21b submitting again while the first order is unpaid → 409 pending_order with that order id; one order', async () => {
  const { event, email, runner, orderId } = await pendingOrder({ tag: 'again' })
  const r = await call('create-order', await orderBody(event, email), runner)
  assert.equal(r.status, 409, JSON.stringify(r.body))
  assert.equal(r.body.code, 'pending_order')
  assert.equal(r.body.error, PENDING_ORDER)
  assert.equal(r.body.orderId, orderId)
  assert.equal((await ordersOf(event.eventId)).length, 1)
  assert.equal((await competitionOf(event.categoryIds[0])).taken, 0)
})

test('P-21b a double submit at once → one 201 and one 409 pending_order naming the same order', async () => {
  const event = await paidEvent()
  const email = runnerEmail('double')
  const runner = await sessionFor(email)
  const b = await orderBody(event, email)
  const results = await Promise.all([call('create-order', b, runner), call('create-order', b, runner)])
  const ok = results.filter((x) => x.status === 201)
  const pending = results.filter((x) => x.status === 409)
  assert.equal(ok.length, 1, JSON.stringify(results.map((x) => x.body)))
  assert.equal(pending.length, 1)
  assert.equal(pending[0].body.code, 'pending_order')
  assert.equal(pending[0].body.orderId, ok[0].body.data.orderId)
  assert.equal((await ordersOf(event.eventId)).length, 1)
})

test('P-21b a confirmed registration, or the address on someone else\'s order → 409 duplicate, never pending_order', async () => {
  const { event, email, runner, orderId } = await pendingOrder({ tag: 'paidalready' })
  const [attempt] = await attemptsOf(orderId)
  await confirmOk(orderId, attempt.dpay_transaction_id, attempt.grosze)
  const paid = await call('create-order', await orderBody(event, email), runner)
  assert.equal(paid.status, 409, JSON.stringify(paid.body))
  assert.equal(paid.body.code, 'duplicate')
  assert.equal(paid.body.error, DUPLICATE)

  const other = await paidEvent()
  const victim = runnerEmail('victim')
  await orderOk(other, { emails: [victim], buyerEmail: runnerEmail('someone') })
  const mine = await call('create-order', await orderBody(other, victim), await sessionFor(victim))
  assert.equal(mine.status, 409, JSON.stringify(mine.body))
  assert.equal(mine.body.code, 'duplicate')
  assert.equal(mine.body.orderId, undefined)
})

// ---------------------------------------------------------------- refund outcomes nobody may retry

test('P-24b a refund dpay does not confirm (HTTP 500 → unknown) → refund_unknown alert, no refund e-mail', async () => {
  const { orderId, runner, email } = await pendingOrder({ tag: 'refundfail' })
  assert.equal((await call('pay-order', { orderId }, runner)).status, 200)
  await dpayMode({ dropIpn: true, refundFails: true })
  for (const t of await dpayTransactions()) await payMock(t.id, 'paid')
  await pollable(orderId)

  const r = await call('order-status', { orderId }, runner)
  assert.equal(r.body.data.status, 'paid')
  const [refund] = await rows('refunds', { order_id: orderId })
  assert.equal(refund.dpay_status, 'unknown')
  assert.equal(refund.next_retry_at, null, 'never retried automatically')
  assert.equal((await rows('operator_alerts', { order_id: orderId, kind: 'refund_unknown' })).length, 1)
  const msgs = await waitForMail(email)
  await new Promise((r2) => setTimeout(r2, 500))
  assert.deepEqual((await messagesTo(email)).map((m) => m.subject.split(' — ')[0]), ['Opłacone'])
  assert.equal(msgs.length, 1)
})

// ---------------------------------------------------------------- P-58 (P3-R15) the limit counts paid entries only

test('P-58 the paid entries fill the competition: order-status says full, pay-order is 409 full with no dpay call, create-order is 409 full', async () => {
  const BIEG1 = [{ name: 'Bieg 9 km', discipline: 'run', distanceLabel: '9 km', startTime: '10:00', capacity: 1 }]
  const event = await paidEvent({ competitions: BIEG1 })
  const first = await pendingOrder({ event, tag: 'fullwait' })
  // A second runner's order is accepted although the first is unpaid: it holds no place.
  const second = await pendingOrder({ event, tag: 'fullwait2' })
  let st = await call('order-status', { orderId: first.orderId }, first.runner)
  assert.equal(st.body.data.full, false)

  await paidOrderOk(event) // a third runner pays for the only place
  st = await call('order-status', { orderId: first.orderId }, first.runner)
  assert.equal(st.status, 200)
  assert.equal(st.body.data.full, true)
  assert.equal(st.body.data.cancelledReason, null)

  const before = (await dpayTransactions()).length
  const r = await call('pay-order', { orderId: second.orderId }, second.runner)
  assert.equal(r.status, 409, JSON.stringify(r.body))
  assert.equal(r.body.code, 'full')
  assert.equal(r.body.error, 'Brak wolnych miejsc w tej konkurencji.')
  assert.equal((await dpayTransactions()).length, before, 'no dpay transaction for a full competition')

  const email = runnerEmail('fullnew')
  const c = await call('create-order', await orderBody(event, email), await sessionFor(email))
  assert.equal(c.status, 409, JSON.stringify(c.body))
  assert.equal(c.body.code, 'full')
})
