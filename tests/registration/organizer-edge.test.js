// Plan 6, task 4: the organizer panel's edge functions (O-30…O-36 in docs/registration/scenario-matrix.md):
// list-event-registrations (widened), organizer-entry-action, organizer-refund, export-event-registrations,
// send-organizer-message, and team-squad's organizer path. Every call goes through the served function,
// against the mocked dpay and the e-mail capture server. LOCAL stack only.
import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import postgres from 'postgres'
import { localEnv, resetThrottle, sessionFor, EDGE_PROXY } from './helpers/stack.js'
import { captureRequests, clearMessages, messagesTo, startCapture } from './helpers/emailCapture.js'
import { acceptAgreement, callFn, createPublishedFreeEvent, createPublishedPaidEvent } from './helpers/registrationFixtures.js'
import { dpayMode, dpayReset, payMock, startDpayMock } from './helpers/dpayControl.js'
import {
  attemptFor, confirmOk, db, expireNow, minutesFromNow, one, orderOf, orderOk, overdue, paidOrderOk, person,
  profileFor, rows, rpc, runnerEmail, setSettings,
} from './helpers/orders.js'
import { adult, minor, orderGroupOk, registerGroup } from './helpers/groups.js'
import { captain, createTeam, paidTeamEvent, squadEdit, teamOk } from './helpers/teams.js'
import { makeExtra } from './helpers/cart.js'
import { nodeDpay } from './helpers/organizerRefund.js'
import { registerTransaction } from '../../supabase/functions/_shared/dpay.js'

const BIEG = (capacity = 200) => [{ name: 'Bieg 9 km', discipline: 'run', distanceLabel: '9 km', startTime: '10:00', capacity }]
const PRICE = 6000
const CONTACT = 'zapisy@klub.example' // createPublishedFreeEvent's contact address
const OWNER = 'owner@zatyrani-test.local'
const ADMIN = 'admin@zatyrani-test.local'
const ALL = { status: 'all', teams: 'members' }
const UNCONFIRMED = 'Zwrot niepotwierdzony.'
const THROTTLED = 'Limit wiadomości wyczerpany. Spróbuj później.'

let owner, adminS, member, outsider, innyAdmin, ownerId, clubId, clubName, stopCapture, stopMock

before(async () => {
  stopCapture = await startCapture()
  stopMock = await startDpayMock()
  await resetThrottle()
  clubId = await acceptAgreement('zatyrani-test')
  clubName = (await one('clubs', { id: clubId })).name
  owner = await sessionFor(OWNER)
  adminS = await sessionFor(ADMIN)
  member = await sessionFor('member@zatyrani-test.local')
  outsider = await sessionFor(runnerEmail('outsider'))
  innyAdmin = await sessionFor('admin@inny-klub.local')
  ownerId = await profileFor(OWNER)
})
after(async () => {
  if (stopMock) await stopMock()
  if (stopCapture) await stopCapture()
})
beforeEach(async () => { await dpayReset() })

const key = () => crypto.randomUUID()
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })
const paidEvent = (opts = {}) => createPublishedPaidEvent(owner, { prices: { 'Bieg 9 km': PRICE }, competitions: BIEG(), ...opts })
const eventName = async (eventId) => (await one('registration_settings', { event_id: eventId })).name
const actions = (eventId, action) => rows('organizer_actions', { event_id: eventId, action })

/** POST a function and keep the response headers (callFn drops them). */
async function callRaw(fn, session, body) {
  const res = await fetch(`${localEnv().functionsUrl}/${fn}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...EDGE_PROXY, 'x-forwarded-for': '203.0.113.9', cookie: session.cookie },
    body: JSON.stringify(body),
  })
  return { status: res.status, headers: res.headers, body: await res.json() }
}

/** A paid entry the mock holds as paid (its IPN dropped, confirm_order called here) → ids and txn. */
async function paidEntry(event, { email = runnerEmail('org') } = {}) {
  const out = await orderOk(event, { emails: [email] })
  const { transactionId } = await registerTransaction(nodeDpay(), { orderId: out.orderId, grosze: out.total })
  await attemptFor(out.orderId, out.total, transactionId)
  await dpayMode({ dropIpn: true })
  await payMock(transactionId, 'paid')
  await dpayMode({ dropIpn: false })
  assert.equal((await confirmOk(out.orderId, transactionId, out.total)).outcome, 'confirmed')
  const [l] = await rows('order_lines', { order_id: out.orderId })
  return { orderId: out.orderId, txn: transactionId, email, registrationId: l.registration_id, lineId: l.id }
}

async function waitForMail(email, n) {
  for (let i = 0; i < 40; i++) {
    const msgs = await messagesTo(email)
    if (msgs.length >= n) return msgs
    await sleep(250)
  }
  return messagesTo(email)
}

/** No header of an organizer e-mail may carry the owner's or an admin's own address (P2-R19). */
function assertClubSender(m) {
  assert.equal(m.fromName, `${clubName} przez LESZY.RUN`)
  assert.equal(m.replyTo, CONTACT)
  const headers = JSON.stringify({ to: m.to, fromName: m.fromName, replyTo: m.replyTo })
  for (const personal of [OWNER, ADMIN]) assert.ok(!headers.includes(personal), `${personal} in ${headers}`)
  assert.ok(!m.html, 'plain text only')
}

// ---------------------------------------------------------------- O-30

const READS = ['list-event-registrations', 'export-event-registrations']
const WRITES = ['organizer-entry-action', 'organizer-refund', 'send-organizer-message']

function bodies(event, e) {
  return {
    'list-event-registrations': () => ({ eventId: event.eventId }),
    'export-event-registrations': () => ({ eventId: event.eventId, filter: {} }),
    'organizer-entry-action': () => ({ action: 'edit', registrationId: e.registrationId, fields: { city: 'Gliwice' } }),
    'organizer-refund': () => ({ lineId: e.lineId, grosze: 100, requestKey: key() }),
    'send-organizer-message': () => ({ eventId: event.eventId, audience: ALL, mode: 'preview' }),
  }
}

test('O-30 outsider, another club\'s admin and a disabled club get 404 from all five; a member 404 on the reads and 403 on the writes; owner and admin 200', async () => {
  const event = await paidEvent()
  const e = await paidEntry(event)
  const body = bodies(event, e)
  for (const [who, session] of [['outsider', outsider], ['innyAdmin', innyAdmin]]) {
    for (const fn of [...READS, ...WRITES]) {
      const r = await callFn(fn, session, body[fn]())
      assert.equal(r.status, 404, `${who} ${fn}: ${JSON.stringify(r.body)}`)
    }
  }
  for (const fn of READS) assert.equal((await callFn(fn, member, body[fn]())).status, 404, `member ${fn}`)
  for (const fn of WRITES) assert.equal((await callFn(fn, member, body[fn]())).status, 403, `member ${fn}`)
  for (const [who, session] of [['owner', owner], ['admin', adminS]]) {
    for (const fn of [...READS, ...WRITES]) {
      const r = await callFn(fn, session, body[fn]())
      assert.equal(r.status, 200, `${who} ${fn}: ${JSON.stringify(r.body)}`)
    }
  }
  // The club switched off: its own owner gets 404 everywhere.
  await db().from('clubs').update({ registration_enabled: false }).eq('id', clubId)
  try {
    for (const fn of [...READS, ...WRITES]) {
      assert.equal((await callFn(fn, owner, body[fn]())).status, 404, `disabled ${fn}`)
    }
  } finally {
    await db().from('clubs').update({ registration_enabled: true }).eq('id', clubId)
  }
  // An unknown target: 404, never a 500.
  assert.equal((await callFn('organizer-refund', owner, { lineId: crypto.randomUUID(), grosze: 100, requestKey: key() })).status, 404)
  assert.equal((await callFn('organizer-entry-action', owner, { action: 'cancel', registrationId: crypto.randomUUID() })).status, 404)
})

test('O-30 the list row contract: person fields, lines, paidAmount, statusKey, visible competitions, event, no-store', async () => {
  const event = await paidEvent()
  const e = await paidEntry(event)
  const pending = await orderOk(event, { emails: [runnerEmail('pend')] })
  const r = await callRaw('list-event-registrations', owner, { eventId: event.eventId })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.headers.get('cache-control'), 'no-store')
  const paid = r.body.data.find((x) => x.id === e.registrationId)
  assert.equal(paid.categoryId, event.categoryIds[0])
  assert.equal(paid.firstName, 'Ola')
  assert.equal(paid.lastName, 'Leśna')
  assert.equal(paid.birthDate, '1990-01-01')
  assert.equal(paid.email, e.email)
  assert.equal(paid.orderId, e.orderId)
  assert.equal(paid.paymentStatus, 'paid')
  assert.equal(paid.statusKey, 'paid')
  assert.equal(paid.paidAmount, PRICE)
  assert.equal(paid.refunded, 0)
  assert.equal(paid.refundUnconfirmed, 0)
  assert.equal(paid.bib, null)
  assert.equal(paid.partnerName, null)
  assert.equal(paid.autoRefundReason, null)
  assert.deepEqual(paid.lines, [{ id: e.lineId, kind: 'entry', amount: PRICE, refunded: 0 }])
  const [pReg] = await rows('registrations', { order_id: pending.orderId })
  const awaiting = r.body.data.find((x) => x.id === pReg.id)
  assert.equal(awaiting.statusKey, 'awaiting')
  assert.equal(awaiting.paidAmount, 0)
  assert.ok(awaiting.expiresAt)
  assert.equal(awaiting.guardianEmail, undefined, 'the panel never gets a guardian address')
  assert.deepEqual(r.body.competitions.map((c) => [c.id, c.kind]), [[event.categoryIds[0], 'individual']])
  assert.equal(r.body.event.name, await eventName(event.eventId))
  assert.equal(r.body.event.state, 'published')
})

// ---------------------------------------------------------------- O-31

test('O-31 „Wszyscy zgłoszeni”: a family on one address with two children, cancelled, expired and lapsed entries → each address once, preview = sent, sent as the club, plain text', async () => {
  const event = await paidEvent()
  const cat = event.categoryIds[0]
  const parent = runnerEmail('rodzic')
  const spouse = runnerEmail('malzonek')
  const family = await orderGroupOk(event, [
    adult(cat, 'self', parent), adult(cat, 'adult', spouse),
    minor(cat, { firstName: `Zosia${crypto.randomBytes(2).toString('hex')}` }),
    minor(cat, { firstName: `Staś${crypto.randomBytes(2).toString('hex')}`, gender: 'M' }),
  ], { buyerEmail: parent })
  const att = await attemptFor(family.orderId, family.total)
  assert.equal((await confirmOk(family.orderId, att.txn, family.total)).outcome, 'confirmed')
  const other = runnerEmail('inny')
  await paidOrderOk(event, { emails: [other] })
  const waiting = runnerEmail('czeka')
  await orderOk(event, { emails: [waiting] })
  const cancelled = runnerEmail('anul')
  const c = await orderOk(event, { emails: [cancelled] })
  assert.equal((await rpc('organizer_cancel_order', { p_order_id: c.orderId, p_actor: ownerId })).data, 'cancelled')
  const expired = runnerEmail('wygasl')
  await expireNow((await orderOk(event, { emails: [expired] })).orderId)
  const lapsed = runnerEmail('minal')
  await overdue((await orderOk(event, { emails: [lapsed] })).orderId)

  const send = (over = {}) => callFn('send-organizer-message', owner, {
    eventId: event.eventId, audience: ALL, subject: 'Zmiana godziny startu', body: 'Start o 10:30.\nDo zobaczenia!', mode: 'send', ...over,
  })
  const preview = await callFn('send-organizer-message', owner, { eventId: event.eventId, audience: ALL, mode: 'preview' })
  assert.equal(preview.status, 200, JSON.stringify(preview.body))
  assert.equal(preview.body.data.count, 4)

  await clearMessages()
  const sent = await send()
  assert.equal(sent.status, 200, JSON.stringify(sent.body))
  assert.deepEqual(sent.body.data, { recipientCount: 4, failed: 0 })
  const requests = await captureRequests()
  assert.deepEqual(requests.map((q) => q.recipients), [4], 'one request, 4 personalizations')
  for (const address of [parent, spouse, other, waiting]) {
    const got = await messagesTo(address)
    assert.equal(got.length, 1, address)
    assert.equal(got[0].subject, 'Zmiana godziny startu')
    assert.equal(got[0].text, 'Start o 10:30.\nDo zobaczenia!')
    assertClubSender(got[0])
  }
  for (const address of [cancelled, expired, lapsed]) assert.equal((await messagesTo(address)).length, 0, address)
  const [stored] = await rows('organizer_messages', { event_id: event.eventId })
  assert.equal(stored.recipient_count, 4)
  assert.equal(stored.filter.kind, 'organizer_message')
  const [logged] = await actions(event.eventId, 'message_sent')
  assert.equal(logged.target, stored.id)
  assert.equal(logged.payload.recipientCount, 4)

  // Narrowed: only those awaiting payment.
  const awaiting = await callFn('send-organizer-message', owner, { eventId: event.eventId, audience: { status: 'awaiting', teams: 'members' }, mode: 'preview' })
  assert.equal(awaiting.body.data.count, 1)

  // „Napisz do zawodnika” to a child reaches the guardian.
  const kid = (await rows('registrations', { order_id: family.orderId })).find((r) => r.guardian_name)
  const one1 = await callFn('send-organizer-message', adminS, { registrationId: kid.id, mode: 'preview' })
  assert.equal(one1.body.data.count, 1)
  await clearMessages()
  const toKid = await callFn('send-organizer-message', adminS, { registrationId: kid.id, subject: 'Numer startowy', body: 'Odbierz w biurze.', mode: 'send' })
  assert.equal(toKid.status, 200, JSON.stringify(toKid.body))
  const [kidMail] = await messagesTo(parent)
  assert.equal(kidMail.subject, 'Numer startowy')
  assertClubSender(kidMail)

  // A test goes to the caller only.
  await clearMessages()
  const t = await callFn('send-organizer-message', owner, { eventId: event.eventId, audience: ALL, subject: 'Próba', body: 'Treść', mode: 'test' })
  assert.equal(t.status, 200, JSON.stringify(t.body))
  assert.deepEqual((await captureRequests()).map((q) => q.recipients), [1])
  const [testMail] = await messagesTo(OWNER)
  assert.equal(testMail.replyTo, CONTACT)
  assert.equal(testMail.fromName, `${clubName} przez LESZY.RUN`)
  assert.equal((await actions(event.eventId, 'message_test_sent')).length, 1)

  // Bad input: 422 with the field.
  const long = await send({ subject: 'x'.repeat(151) })
  assert.equal(long.status, 422)
  assert.ok(long.body.fields.subject)
  assert.equal((await send({ audience: { status: 'everyone', teams: 'members' } })).status, 422)

  // The bulk limit: 5 per event per 24 h, the 6th refused.
  for (let i = 2; i <= 5; i++) assert.equal((await send()).status, 200, `send ${i}`)
  const sixth = await send()
  assert.equal(sixth.status, 429)
  assert.equal(sixth.body.error, THROTTLED)
  assert.equal((await rows('organizer_messages', { event_id: event.eventId })).filter((m) => m.filter.kind === 'organizer_message').length, 5)
})

// ---------------------------------------------------------------- O-32

test('O-32 CSV of 1 250 registrations: 1 251 lines (paging past 1000), no-store, one csv_exported with rows 1250', async () => {
  const event = await createPublishedFreeEvent(owner, { competitions: BIEG(2000) })
  const cat = event.categoryIds[0]
  const first = runnerEmail('csv')
  const r = await registerGroup(event, [adult(cat, 'self', first)])
  assert.equal(r.error, null, r.error?.message)
  const [seed] = await rows('registrations', { event_id: event.eventId })
  const tag = crypto.randomBytes(4).toString('hex')
  const sql = postgres(localEnv().dbUrl, { max: 1, onnotice: () => {} })
  try {
    await sql`
      INSERT INTO public.registrations
      SELECT (jsonb_populate_record(NULL::public.registrations, to_jsonb(r) || jsonb_build_object(
        'id', gen_random_uuid(), 'email', 'csv-' || g || '-' || ${tag} || '@test.local',
        'profile_id', NULL, 'participant_id', NULL, 'created_at', r.created_at + make_interval(secs => g)))).*
        FROM public.registrations r, generate_series(1, 1249) g
       WHERE r.id = ${seed.id}`
  } finally {
    await sql.end()
  }
  const res = await callRaw('export-event-registrations', owner, { eventId: event.eventId, filter: {} })
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300))
  assert.equal(res.headers.get('cache-control'), 'no-store')
  const { filename, csv } = res.body.data
  assert.match(filename, /^zgloszenia-[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.csv$/)
  assert.equal(csv.split('\r\n').length, 1251)
  assert.ok(csv.startsWith('﻿"Nr";"Imię"'))
  const logged = await actions(event.eventId, 'csv_exported')
  assert.equal(logged.length, 1)
  assert.equal(logged[0].payload.rows, 1250)

  // The panel's filter narrows the export the same way: a search finds the one seeded row.
  const one1 = await callFn('export-event-registrations', adminS, { eventId: event.eventId, filter: { q: first } })
  assert.equal(one1.body.data.csv.split('\r\n').length, 2)
  assert.deepEqual((await actions(event.eventId, 'csv_exported')).map((a) => a.payload.rows).sort(), [1, 1250])
})

// ---------------------------------------------------------------- O-33, O-34

test('O-33 refund 2000 → 200, one „Zwrot 20,00 zł — …” e-mail from the club, refund_requested + refund_settled; the rest cancels the entry', async () => {
  const event = await paidEvent()
  const name = await eventName(event.eventId)
  const e = await paidEntry(event)
  const r = await callFn('organizer-refund', owner, { lineId: e.lineId, grosze: 2000, requestKey: key() })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.data.status, 'accepted')
  assert.deepEqual(r.body.data.cancelled, [])
  const mails = await waitForMail(e.email, 1)
  assert.equal(mails.length, 1)
  assert.equal(mails[0].subject, `Zwrot 20,00 zł — ${name}`)
  assert.ok(!mails[0].text.includes('anulowane'))
  assertClubSender(mails[0])
  const refund = await one('refunds', { id: r.body.data.refundId })
  assert.equal(refund.dpay_status, 'accepted')
  assert.ok(refund.runner_notified_at)
  for (const action of ['refund_requested', 'refund_settled']) {
    const logged = await actions(event.eventId, action)
    assert.equal(logged.length, 1, action)
    assert.equal(logged[0].target, refund.id)
  }
  assert.equal((await one('registrations', { id: e.registrationId })).status, 'confirmed')

  const rest = await callFn('organizer-refund', adminS, { lineId: e.lineId, grosze: PRICE - 2000, requestKey: key() })
  assert.equal(rest.status, 200, JSON.stringify(rest.body))
  assert.deepEqual(rest.body.data.cancelled, [e.registrationId])
  const second = (await waitForMail(e.email, 2))[1]
  assert.equal(second.subject, `Zwrot 40,00 zł — ${name}`)
  assert.match(second.text, /Zgłoszenie zostało anulowane\./)

  // Nothing left: 409 with what is left, and no dpay call.
  const over = await callFn('organizer-refund', owner, { lineId: e.lineId, grosze: 1, requestKey: key() })
  assert.equal(over.status, 409)
  assert.equal(over.body.code, 'exceeds')
  assert.equal(over.body.error, 'Kwota przekracza możliwą do zwrotu: 0,00 zł.')
  assert.equal((await callFn('organizer-refund', owner, { lineId: e.lineId, grosze: 0, requestKey: key() })).status, 422)
})

test('O-34 dpay 500 → 202 „Zwrot niepotwierdzony.”, no runner e-mail', async () => {
  const event = await paidEvent()
  const e = await paidEntry(event)
  await dpayMode({ refundFails: true })
  const r = await callFn('organizer-refund', owner, { lineId: e.lineId, grosze: 2000, requestKey: key() })
  assert.equal(r.status, 202, JSON.stringify(r.body))
  assert.equal(r.body.message, UNCONFIRMED)
  assert.equal(r.body.data.status, 'unknown')
  await sleep(500)
  assert.equal((await messagesTo(e.email)).length, 0)
  const refund = await one('refunds', { id: r.body.data.refundId })
  assert.equal(refund.dpay_status, 'unknown')
  assert.equal(refund.runner_notified_at, null)
  assert.equal((await rows('operator_alerts', { order_id: e.orderId, kind: 'refund_unknown' })).length, 1)
  assert.equal((await actions(event.eventId, 'refund_settled'))[0].payload.status, 'unknown')
})

test('O-34 dpay never answers → 202 after the function\'s dpay timeout, no runner e-mail', async () => {
  const event = await paidEvent()
  const e = await paidEntry(event)
  await dpayMode({ refundHang: true })
  const r = await callFn('organizer-refund', owner, { lineId: e.lineId, grosze: 2000, requestKey: key() })
  assert.equal(r.status, 202, JSON.stringify(r.body))
  assert.equal(r.body.message, UNCONFIRMED)
  await dpayMode({ refundHang: false })
  assert.equal((await messagesTo(e.email)).length, 0)
  assert.equal((await one('order_lines', { id: e.lineId })).refunded, 2000, 'the reservation is kept')
})

test('O-34b dpay 400 although the refund went through → /pbl/details shows it → 200 accepted, the club\'s e-mail, no alert', async () => {
  const event = await paidEvent()
  const e = await paidEntry(event)
  await dpayMode({ refundFailedButDone: true })
  const r = await callFn('organizer-refund', owner, { lineId: e.lineId, grosze: 2000, requestKey: key() })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.data.status, 'accepted')
  assert.equal((await one('refunds', { id: r.body.data.refundId })).dpay_status, 'accepted')
  assert.equal((await waitForMail(e.email, 1)).length, 1)
  assert.deepEqual((await rows('operator_alerts', { order_id: e.orderId })).map((a) => a.kind), [])

  // A 400 with nothing refunded at dpay is a refusal: the reservation goes back.
  await dpayMode({ refundFailedButDone: false, refundRejected: true })
  const no = await callFn('organizer-refund', owner, { lineId: e.lineId, grosze: 1000, requestKey: key() })
  assert.equal(no.status, 409, JSON.stringify(no.body))
  assert.equal(no.body.code, 'rejected')
  assert.equal((await one('order_lines', { id: e.lineId })).refunded, 2000)
})

test('O-34c dpay 409 (a refund form blocks the transaction) → 409 refund_blocked, the reservation freed, one refund_blocked alert', async () => {
  const event = await paidEvent()
  const e = await paidEntry(event)
  await dpayMode({ refundPending: true })
  const r = await callFn('organizer-refund', owner, { lineId: e.lineId, grosze: 2000, requestKey: key() })
  assert.equal(r.status, 409, JSON.stringify(r.body))
  assert.equal(r.body.code, 'refund_blocked')
  assert.match(r.body.error, /blokuje zwroty tej wpłaty/)
  assert.equal((await one('refunds', { id: r.body.refundId })).dpay_status, 'rejected')
  assert.equal((await one('order_lines', { id: e.lineId })).refunded, 0)
  const alerts = await rows('operator_alerts', { order_id: e.orderId, kind: 'refund_blocked' })
  assert.equal(alerts.length, 1)
  assert.equal(alerts[0].payload.txn, e.txn)
  await sleep(300)
  assert.equal((await messagesTo(e.email)).length, 0)
})

test('O-34d one refund of a payment at a time: another one awaiting dpay\'s answer → 409 refund_in_progress, nothing reserved', async () => {
  const event = await paidEvent()
  const e = await paidEntry(event)
  // A reservation not yet answered by dpay (as between reserve and dpay's answer).
  await rpc('reserve_organizer_refund', { p_line_id: e.lineId, p_grosze: 1000, p_actor: ownerId, p_request_key: key() })
  const r = await callFn('organizer-refund', owner, { lineId: e.lineId, grosze: 2000, requestKey: key() })
  assert.equal(r.status, 409, JSON.stringify(r.body))
  assert.equal(r.body.code, 'refund_in_progress')
  assert.equal((await one('order_lines', { id: e.lineId })).refunded, 1000)
  assert.equal((await rows('refunds', { order_id: e.orderId })).length, 1)
})

// ---------------------------------------------------------------- O-35

test('O-35 extend, remind (a second within 24 h → 429), cancel, edit and rename each write one organizer_actions row naming the target', async () => {
  const event = await paidEvent()
  const action = (session, body) => callFn('organizer-entry-action', session, body)

  // extend
  const pend = await orderOk(event, { emails: [runnerEmail('ext')] })
  const until = minutesFromNow(10 * 24 * 60)
  const ext = await action(owner, { action: 'extend', orderId: pend.orderId, until })
  assert.equal(ext.status, 200, JSON.stringify(ext.body))
  assert.equal(new Date(ext.body.data.expiresAt).toISOString(), new Date(until).toISOString())
  const tooFar = await action(owner, { action: 'extend', orderId: pend.orderId, until: minutesFromNow(40 * 24 * 60) })
  assert.equal(tooFar.status, 422)
  assert.equal(tooFar.body.error, 'Termin wpłaty nie może przekroczyć zamknięcia zapisów.')
  const extended = await actions(event.eventId, 'window_extended')
  assert.equal(extended.length, 1)
  assert.equal(extended[0].target, pend.orderId)

  // remind
  const [pendReg] = await rows('registrations', { order_id: pend.orderId })
  const remind = await action(adminS, { action: 'remind_payment', registrationId: pendReg.id })
  assert.equal(remind.status, 200, JSON.stringify(remind.body))
  const [reminder] = await waitForMail(pendReg.email, 1)
  assert.match(reminder.subject, /^Zgłoszenie czeka na wpłatę — /)
  const again = await action(owner, { action: 'remind_payment', orderId: pend.orderId })
  assert.equal(again.status, 429)
  const reminded = await actions(event.eventId, 'payment_reminded')
  assert.equal(reminded.length, 1)
  assert.equal(reminded[0].target, pend.orderId)

  // An order that can no longer be paid is not reminded.
  const lapsed = await orderOk(event, { emails: [runnerEmail('lapsed')] })
  await overdue(lapsed.orderId)
  const late = await action(owner, { action: 'remind_payment', orderId: lapsed.orderId })
  assert.equal(late.status, 409)
  assert.equal(late.body.error, 'Zgłoszenie wygasło.')
  assert.equal((await action(owner, { action: 'extend', orderId: lapsed.orderId, until })).body.error, 'Zgłoszenie wygasło.')

  // edit
  const e = await paidEntry(event)
  const bad = await action(owner, { action: 'edit', registrationId: e.registrationId, fields: { phone: 'abc' } })
  assert.equal(bad.status, 422)
  assert.ok(bad.body.fields.phone)
  const noEmail = await action(owner, { action: 'edit', registrationId: e.registrationId, fields: { email: 'x@test.local' } })
  assert.equal(noEmail.status, 422, 'the e-mail is never editable')
  const edit = await action(owner, { action: 'edit', registrationId: e.registrationId, fields: { city: 'Rybnik', birthDate: '1960-03-03', gender: 'M' } })
  assert.equal(edit.status, 200, JSON.stringify(edit.body))
  assert.equal(edit.body.data.changed, true)
  const stored = await one('registrations', { id: e.registrationId })
  assert.equal(stored.city, 'Rybnik')
  assert.equal(stored.age_group_label, edit.body.data.ageGroupLabel)
  const edited = await actions(event.eventId, 'registration_edited')
  assert.equal(edited.length, 1)
  assert.equal(edited[0].target, e.registrationId)
  assert.deepEqual(edited[0].payload.fields.sort(), ['birthDate', 'city', 'gender'])
  assert.ok(!JSON.stringify(edited[0].payload).includes('Rybnik'), 'no personal value in the audit')

  // cancel: a confirmed entry, without a refund
  const cancel = await action(owner, { action: 'cancel', registrationId: e.registrationId })
  assert.equal(cancel.status, 200, JSON.stringify(cancel.body))
  assert.deepEqual(cancel.body.data.cancelled, [e.registrationId])
  assert.equal((await one('registrations', { id: e.registrationId })).status, 'cancelled')
  const twice = await action(adminS, { action: 'cancel', registrationId: e.registrationId })
  assert.equal(twice.status, 409)
  // a pending entry cancels its order
  const cancelPending = await action(owner, { action: 'cancel', registrationId: pendReg.id })
  assert.equal(cancelPending.status, 200, JSON.stringify(cancelPending.body))
  assert.equal((await orderOf(pend.orderId)).status, 'cancelled')
  const cancelledLog = await actions(event.eventId, 'registration_cancelled')
  assert.deepEqual(cancelledLog.map((a) => a.target).sort(), [e.registrationId, pendReg.id].sort())

  // rename
  const teamEvent = await paidTeamEvent(owner)
  const a = await teamOk(teamEvent)
  const b = await teamOk(teamEvent)
  const newName = `Leśne Wilki ${crypto.randomBytes(3).toString('hex')}`
  const rename = await action(owner, { action: 'rename_team', teamId: a.teamId, name: `  ${newName}  ` })
  assert.equal(rename.status, 200, JSON.stringify(rename.body))
  assert.equal(rename.body.data.name, newName)
  const taken = await action(owner, { action: 'rename_team', teamId: b.teamId, name: newName.toUpperCase() })
  assert.equal(taken.status, 409)
  assert.equal(taken.body.error, 'Ta nazwa drużyny jest już zajęta.')
  const renamed = await actions(teamEvent.eventId, 'team_renamed')
  assert.equal(renamed.length, 1)
  assert.equal(renamed[0].target, a.teamId)

  // edits_closed after closes_at
  const late2 = await paidEntry(event)
  await setSettings(event.eventId, { closes_at: minutesFromNow(-1) })
  const closed = await action(owner, { action: 'edit', registrationId: late2.registrationId, fields: { city: 'Opole' } })
  assert.equal(closed.status, 409)
  assert.equal(closed.body.error, 'Po zamknięciu zapisów dane zmienia się w panelu pomiaru.')
})

// ---------------------------------------------------------------- O-36

test('O-36 the organizer swaps a member of a team whose captain deleted the account → 200; one team_squad_edit, the captain path still works', async () => {
  const event = await paidTeamEvent(owner)
  const team = await teamOk(event)
  const members = await rows('registrations', { team_id: team.teamId })
  const { captain_registration_id: captainId } = await one('teams', { id: team.teamId })
  const captainReg = members.find((m) => m.id === captainId)
  const swapOut = members.find((m) => m.id !== captainReg.id && m.email)
  // The captain deleted the account: the entry is anonymised, the profile soft-deleted.
  await db().from('registrations').update({ first_name: 'Usunięte konto', last_name: 'Usunięte konto', email: null })
    .eq('id', captainReg.id)
  await db().from('profiles').update({ deleted_at: new Date().toISOString() }).eq('id', captainReg.profile_id)

  const incoming = runnerEmail('nowy')
  const swap = { teamId: team.teamId, action: 'swap', registrationId: swapOut.id, person: person(incoming, { firstName: 'Ewa' }) }
  assert.equal((await callFn('team-squad', outsider, swap)).status, 404)
  assert.equal((await callFn('team-squad', member, swap)).status, 403)
  assert.equal((await callFn('team-squad', member, { teamId: team.teamId, action: 'get' })).status, 404)
  const kid = await callFn('team-squad', owner, { ...swap, person: { firstName: 'Kuba', lastName: 'Leśny', birthDate: '2016-04-04', gender: 'M', phone: '+48500100200' }, guardianConsent: true })
  assert.equal(kid.status, 422)
  assert.equal(kid.body.code, 'minor_by_organizer')

  const r = await callFn('team-squad', owner, swap)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.ok(r.body.data.members.some((m) => m.firstName === 'Ewa'))
  assert.equal((await one('registrations', { id: swapOut.id })).status, 'cancelled')
  const logged = await actions(event.eventId, 'squad_edited_by_organizer')
  assert.equal(logged.length, 1)
  assert.equal(logged[0].target, team.teamId)
  assert.equal((await callFn('team-squad', adminS, { teamId: team.teamId, action: 'get' })).status, 200)

  const sql = postgres(localEnv().dbUrl, { max: 1, onnotice: () => {} })
  try {
    const procs = await sql`SELECT oid::regprocedure::text AS sig FROM pg_proc WHERE proname = 'team_squad_edit'`
    assert.deepEqual(procs.map((p) => p.sig), ['team_squad_edit(uuid,uuid,jsonb,jsonb,boolean)'])
  } finally {
    await sql.end()
  }
  // The captain's own call, four named arguments, still goes through (and an outsider's is not_captain).
  const other = await teamOk(event)
  const capId = (await one('registrations', { id: (await one('teams', { id: other.teamId })).captain_registration_id })).profile_id
  const add = await squadEdit(event, other.teamId, capId, { op: 'add', person: { role: 'adult', ...person(runnerEmail('dodany')) } })
  assert.equal(add.error, null, add.error?.message)
  const stranger = await squadEdit(event, other.teamId, ownerId, { op: 'add', person: { role: 'adult', ...person(runnerEmail('obcy')) } })
  assert.equal(stranger.error?.message, 'not_captain')
})

// ---------------------------------------------------------------- record_refund

test('O-37 record_refund refuses p_kind organizer: only reserve_organizer_refund writes an organizer refund', async () => {
  const event = await paidEvent()
  const e = await paidEntry(event)
  const [att] = await rows('payment_attempts', { order_id: e.orderId })
  const r = await rpc('record_refund', { p_attempt_id: att.id, p_grosze: 100, p_kind: 'organizer', p_reason: 'x' })
  assert.equal(r.error?.message, 'organizer_refund')
  assert.equal((await rows('refunds', { order_id: e.orderId })).length, 0)
})

// ---------------------------------------------------------------- fix round 1 (task 4 review)

const throttleAttempts = async (k) => (await db().from('otp_throttle').select('attempts').eq('key', k).maybeSingle()).data?.attempts ?? 0

/**
 * Runs fn while a test trigger on `table` refuses the rows `condition` (plpgsql, NEW/OLD) names,
 * so a function's write there fails as a database error would. Dropped afterwards, whatever happens.
 */
async function whileRefusing(table, when, condition, fn) {
  const name = `test_refuse_${crypto.randomBytes(4).toString('hex')}`
  const sql = postgres(localEnv().dbUrl, { max: 1, onnotice: () => {} })
  try {
    await sql.unsafe(`CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN IF ${condition} THEN RAISE EXCEPTION 'test_refused'; END IF; RETURN NEW; END $f$`)
    await sql.unsafe(`CREATE TRIGGER ${name} BEFORE ${when} ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.${name}()`)
    return await fn()
  } finally {
    await sql.unsafe(`DROP TRIGGER IF EXISTS ${name} ON public.${table}`)
    await sql.unsafe(`DROP FUNCTION IF EXISTS public.${name}()`)
    await sql.end()
  }
}

/** A group order the mock holds as paid → its order id and each person's line, by e-mail or first name. */
async function paidGroup(event, people, buyerEmail) {
  const out = await orderGroupOk(event, people, { buyerEmail })
  const { transactionId } = await registerTransaction(nodeDpay(), { orderId: out.orderId, grosze: out.total })
  await attemptFor(out.orderId, out.total, transactionId)
  await dpayMode({ dropIpn: true })
  await payMock(transactionId, 'paid')
  await dpayMode({ dropIpn: false })
  assert.equal((await confirmOk(out.orderId, transactionId, out.total)).outcome, 'confirmed')
  const regs = await rows('registrations', { order_id: out.orderId })
  const lines = await rows('order_lines', { order_id: out.orderId })
  const lineOf = (pred) => lines.find((l) => l.registration_id === regs.find(pred).id)
  return { orderId: out.orderId, regs, lineOf }
}

test('O-30 M6 a list row carries exactly the D6-11 key set, so a field added later fails here first', async () => {
  const event = await paidEvent()
  const e = await paidEntry(event)
  const r = await callFn('list-event-registrations', owner, { eventId: event.eventId })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const row = r.body.data.find((x) => x.id === e.registrationId)
  assert.deepEqual(Object.keys(row).sort(), [
    // Plans 2–5
    'id', 'name', 'competition', 'ageGroupLabel', 'status', 'createdAt', 'paymentStatus', 'expiresAt', 'role',
    'consentState', 'guardianName', 'guardianRemoved', 'registeredBy', 'team',
    // Plan 6 (D6-11, plus categoryId from Task 1)
    'categoryId', 'firstName', 'lastName', 'birthDate', 'gender', 'phone', 'city', 'club', 'nationality', 'iceName',
    'icePhone', 'email', 'bib', 'orderId', 'price', 'lines', 'paidAmount', 'refunded', 'refundUnconfirmed',
    'statusKey', 'autoRefundReason',
    // Plan 7: the partner (organizer-only, V-33), the voucher's code (CSV), TransferDialog's
    // same-price competitions (V-86) and a refund in flight that hides the transfer (V-87)
    'partnerId', 'partnerName', 'voucherCode', 'transferTo', 'refundPending',
    // A team member's details still to fill on /zgoda (memberDetails.js)
    'missingFields',
  ].sort())
})

test('O-35 M1–M3 remind_payment: a send that did not go out → 502 and no allowance spent; refused once online payment stopped and when the competition is full', async () => {
  const event = await paidEvent({ competitions: BIEG(1) })
  const action = (body) => callFn('organizer-entry-action', owner, body)

  // M1: the sender refuses the e-mail.
  const bounce = await orderOk(event, { emails: [runnerEmail('bounce')] })
  const failed = await action({ action: 'remind_payment', orderId: bounce.orderId })
  assert.equal(failed.status, 502, JSON.stringify(failed.body))
  assert.equal(failed.body.code, 'email_failed')
  assert.equal(failed.body.error, 'Nie udało się wysłać przypomnienia. Spróbuj ponownie za chwilę.')
  assert.equal(await throttleAttempts(`pay-remind:${bounce.orderId}`), 0, 'a failed send spends no allowance')
  assert.equal((await actions(event.eventId, 'payment_reminded')).length, 0)
  // The address is fixed: the organizer may try again at once.
  const fixed = runnerEmail('fixed')
  await db().from('orders').update({ buyer_email: fixed }).eq('id', bounce.orderId)
  const ok = await action({ action: 'remind_payment', orderId: bounce.orderId })
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  assert.equal(ok.body.data.sent, true)
  assert.equal((await waitForMail(fixed, 1)).length, 1)
  assert.equal(await throttleAttempts(`pay-remind:${bounce.orderId}`), 1)

  // M3 (D6-27): another order paid the only place → nobody can pay this one.
  await paidOrderOk(event, { emails: [runnerEmail('paid')] })
  await db().from('otp_throttle').delete().eq('key', `pay-remind:${bounce.orderId}`)
  const full = await action({ action: 'remind_payment', orderId: bounce.orderId })
  assert.equal(full.status, 409, JSON.stringify(full.body))
  assert.equal(full.body.code, 'full')
  assert.equal(full.body.error, 'Brak wolnych miejsc w tej konkurencji.')
  assert.equal(await throttleAttempts(`pay-remind:${bounce.orderId}`), 0)

  // M2: online payment stops an hour before closes_at, and so does the reminder.
  const roomy = await paidEvent()
  const late = await orderOk(roomy, { emails: [runnerEmail('late')] })
  await setSettings(roomy.eventId, { closes_at: minutesFromNow(30) })
  const closed = await callFn('organizer-entry-action', owner, { action: 'remind_payment', orderId: late.orderId })
  assert.equal(closed.status, 409, JSON.stringify(closed.body))
  assert.equal(closed.body.code, 'paying_closed')
  assert.equal(closed.body.error, 'Płatność online jest już zamknięta: kończy się godzinę przed zamknięciem zapisów.')
  assert.equal(await throttleAttempts(`pay-remind:${late.orderId}`), 0)
})

test('O-35 M5 a refusal of organizer_edit_registration answers 422 with `fields`', async () => {
  const event = await paidEvent()
  const e = await paidEntry(event)
  // Nationality is off on this event: validatePerson ignores it, the SQL refuses it (edit_invalid).
  const r = await callFn('organizer-entry-action', owner, { action: 'edit', registrationId: e.registrationId, fields: { nationality: 'DE' } })
  assert.equal(r.status, 422, JSON.stringify(r.body))
  assert.equal(r.body.code, 'edit_invalid')
  assert.deepEqual(Object.keys(r.body.fields), ['nationality'])
})

test('O-31 M4 a subject with a line break → 422 on subject, nothing sent, no allowance spent', async () => {
  const event = await paidEvent()
  await paidOrderOk(event, { emails: [runnerEmail('nl')] })
  await clearMessages()
  for (const subject of ['Zmiana\nstartu', 'Zmiana\r\nstartu', 'Zmiana\rstartu']) {
    const r = await callFn('send-organizer-message', owner, { eventId: event.eventId, audience: ALL, subject, body: 'Treść', mode: 'send' })
    assert.equal(r.status, 422, JSON.stringify(r.body))
    assert.ok(r.body.fields.subject)
  }
  assert.equal(await throttleAttempts(`message:${event.eventId}`), 0)
  assert.deepEqual(await captureRequests(), [])
})

test('O-32 I1 M8 the csv_exported row names the filter keys and whether there was a search, never the text; no audit row, no CSV', async () => {
  const event = await createPublishedFreeEvent(owner, { competitions: BIEG() })
  const cat = event.categoryIds[0]
  const email = runnerEmail('szukany')
  assert.equal((await registerGroup(event, [adult(cat, 'self', email)])).error, null)
  const found = await callFn('export-event-registrations', owner, { eventId: event.eventId, filter: { q: email, categoryId: cat } })
  assert.equal(found.status, 200, JSON.stringify(found.body))
  assert.equal(found.body.data.csv.split('\r\n').length, 2)
  const [logged] = await actions(event.eventId, 'csv_exported')
  assert.deepEqual(logged.payload, { rows: 1, filter: { keys: ['categoryId'], search: true } })
  assert.ok(!JSON.stringify(logged).includes(email.split('@')[0]), 'the search text is not stored')

  // M8: the audit row cannot be written → the export does not leave.
  const refused = await whileRefusing('organizer_actions', 'INSERT',
    `NEW.action = 'csv_exported' AND NEW.event_id = '${event.eventId}'`,
    () => callFn('export-event-registrations', owner, { eventId: event.eventId, filter: {} }))
  assert.equal(refused.status, 503, JSON.stringify(refused.body))
  assert.equal(refused.body.code, 'audit_failed')
  assert.equal(refused.body.data, undefined, 'no CSV')
  assert.equal((await actions(event.eventId, 'csv_exported')).length, 1)
})

test('O-33 I2 dpay accepted and the refund stored: a failed runner_notified_at claim still answers 200 with the refund, and alerts', async () => {
  const event = await paidEvent()
  const e = await paidEntry(event)
  const r = await whileRefusing('refunds', 'UPDATE',
    `OLD.runner_notified_at IS NULL AND NEW.runner_notified_at IS NOT NULL AND NEW.order_id = '${e.orderId}'`,
    () => callFn('organizer-refund', owner, { lineId: e.lineId, grosze: 2000, requestKey: key() }))
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.data.status, 'accepted')
  const refund = await one('refunds', { id: r.body.data.refundId })
  assert.equal(refund.dpay_status, 'accepted')
  assert.equal(refund.runner_notified_at, null, 'left for the job to send')
  assert.equal((await rows('operator_alerts', { order_id: e.orderId, kind: 'refund_email_failed' })).length, 1)
  assert.equal((await actions(event.eventId, 'refund_settled')).length, 1)
})

test('O-33 S2 the refund e-mail goes to the payer and to the entry\'s own adult runner when the address differs', async () => {
  const event = await paidEvent()
  const cat = event.categoryIds[0]
  const payer = runnerEmail('platnik')
  const spouse = runnerEmail('malzonka')
  const g = await paidGroup(event, [
    adult(cat, 'self', payer), adult(cat, 'adult', spouse),
    minor(cat, { firstName: `Zosia${crypto.randomBytes(2).toString('hex')}` }),
  ], payer)
  await clearMessages()

  const toSpouse = await callFn('organizer-refund', owner, { lineId: g.lineOf((x) => x.email === spouse).id, grosze: 1000, requestKey: key() })
  assert.equal(toSpouse.status, 200, JSON.stringify(toSpouse.body))
  const [p1] = await waitForMail(payer, 1)
  const [s1] = await waitForMail(spouse, 1)
  assert.match(p1.subject, /^Zwrot 10,00 zł — /)
  assert.equal(s1.subject, p1.subject)
  assertClubSender(s1)
  assert.deepEqual((await captureRequests()).map((q) => q.recipients), [2], 'one request, one personalization each')

  // The payer's own entry: one address, one e-mail. A child's: the payer only.
  await callFn('organizer-refund', owner, { lineId: g.lineOf((x) => x.email === payer).id, grosze: 1000, requestKey: key() })
  await callFn('organizer-refund', owner, { lineId: g.lineOf((x) => x.guardian_name).id, grosze: 1000, requestKey: key() })
  assert.equal((await waitForMail(payer, 3)).length, 3)
  assert.equal((await messagesTo(spouse)).length, 1)
})

test('O-33b a team\'s refund e-mail goes to the captain only: a member\'s extra and the whole team line, never the member (user decision 2026-11-02)', async () => {
  const event = await paidTeamEvent(owner)
  const cat = event.categoryIds[0]
  const { variants: { M } } = await makeExtra(event)
  const capEmail = runnerEmail('kapitan')
  const mateEmail = runnerEmail('druzyna')
  const created = await createTeam(event, {
    members: [captain(capEmail), { ...adult(cat, 'adult', mateEmail), extras: [{ variantId: M.id, qty: 1 }] }],
    displayed: 24000 + 4500,
  })
  assert.equal(created.error, null, created.error?.message)
  const { orderId } = created.data
  const total = 24000 + 4500
  const { transactionId } = await registerTransaction(nodeDpay(), { orderId, grosze: total })
  await attemptFor(orderId, total, transactionId)
  await dpayMode({ dropIpn: true })
  await payMock(transactionId, 'paid')
  await dpayMode({ dropIpn: false })
  assert.equal((await confirmOk(orderId, transactionId, total)).outcome, 'confirmed')
  const lines = await rows('order_lines', { order_id: orderId })
  const extra = lines.find((l) => l.kind === 'extra')
  const entry = lines.find((l) => l.kind === 'entry')
  const mate = await one('registrations', { email: mateEmail })
  assert.equal(extra.registration_id, mate.id, 'the extra line is the member\'s')
  await clearMessages()

  // The member's own extra: the captain hears of it, the member does not.
  const r1 = await callFn('organizer-refund', owner, { lineId: extra.id, grosze: 4500, requestKey: key() })
  assert.equal(r1.status, 200, JSON.stringify(r1.body))
  const [c1] = await waitForMail(capEmail, 1)
  assert.match(c1.subject, /^Zwrot 45,00 zł — /)
  assertClubSender(c1)

  // The whole team line: the team is cancelled, and still only the captain is told.
  const r2 = await callFn('organizer-refund', owner, { lineId: entry.id, grosze: 24000, requestKey: key() })
  assert.equal(r2.status, 200, JSON.stringify(r2.body))
  assert.equal((await waitForMail(capEmail, 2)).length, 2)
  await sleep(500)
  assert.deepEqual(await messagesTo(mateEmail), [], 'no refund e-mail to a member who is not the captain')
  assert.ok((await one('refunds', { id: r1.body.data.refundId })).runner_notified_at, 'claimed')
})

test('O-36 M7 the organizer\'s squad edit spends an organizer allowance, never their own register-people one', async () => {
  const event = await paidTeamEvent(owner)
  const team = await teamOk(event)
  const members = await rows('registrations', { team_id: team.teamId })
  const { captain_registration_id: captainId } = await one('teams', { id: team.teamId })
  const swapOut = members.find((m) => m.id !== captainId && m.email)
  const personal = await throttleAttempts(`register-people:${OWNER}`)
  const r = await callFn('team-squad', owner, {
    teamId: team.teamId, action: 'swap', registrationId: swapOut.id, person: person(runnerEmail('zmiana'), { firstName: 'Iga' }),
  })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(await throttleAttempts(`register-people:${OWNER}`), personal)
  assert.equal(await throttleAttempts(`organizer-people:${event.eventId}`), 1)
})
