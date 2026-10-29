// Plan 3, task 7: the payment window jobs (P-36…P-39b in docs/registration/scenario-matrix.md).
//   pg_cron: expire_orders and release_orphan_orders every 5 min, registration-jobs every 15 min
//            (pg_net → the function, both Vault secrets), purge_expired_registrations daily.
//   registration-jobs: dpay check before expiry (M6), reminders, „Zgłoszenie wygasło”, lost
//            confirmations (P3-R10), refund retries after 406, never-sent refunds (P3-R10),
//            the operator alert digest.
// LOCAL stack plus the mocked dpay. Never real dpay, never production. Every event and address is
// random, and the job is drained before the tests, so a stack holding earlier data still passes.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import postgres from 'postgres'
import { admin, localEnv, resetThrottle, sessionFor } from './helpers/stack.js'
import { messagesTo, startCapture } from './helpers/emailCapture.js'
import { acceptAgreement, createPublishedPaidEvent } from './helpers/registrationFixtures.js'
import { dpayMode, dpayRefunds, dpayReset, payMock, startDpayMock } from './helpers/dpayControl.js'
import {
  attemptFor, competitionOf, confirm, confirmOk, consentIds, db, expireNow, orderOf, orderOk, registrationsOf, rows,
  runnerEmail, totalFor,
} from './helpers/orders.js'
import { dpayConfig } from '../../supabase/functions/_shared/dpay.js'
import { settleConfirmOutcome } from '../../supabase/functions/_shared/registration/orderFlow.js'

const OPERATOR = 'operator@leszy.test' // PIPELINE_ALERT_EMAIL in functions.env
const BIEG = (capacity) => [{ name: 'Bieg 9 km', discipline: 'run', distanceLabel: '9 km', startTime: '10:00', capacity }]
const HOUR = 3_600_000
const MIN = 60_000

// The value the local functions run with (functions.env), and the Vault seeds the same one.
const JOBS_SECRET = readFileSync(new URL('./functions.env', import.meta.url), 'utf8')
  .match(/^REGISTRATION_JOBS_SECRET=(.*)$/m)?.[1]?.trim()

// The same mock dpay the functions use, reached from the host.
const nodeCfg = () => dpayConfig({
  DPAY_SERVICE: 'mock-service', DPAY_SECRET: 'mock-secret',
  DPAY_API_BASE: 'http://127.0.0.1:54398', DPAY_PANEL_BASE: 'http://127.0.0.1:54398',
  DPAY_IPN_URL: 'http://127.0.0.1:54321/functions/v1/dpay-ipn', PUBLIC_SITE_URL: 'http://localhost:5173',
})

let owner, stopCapture, stopMock
before(async () => {
  stopCapture = await startCapture()
  stopMock = await startDpayMock()
  await resetThrottle()
  await acceptAgreement('zatyrani-test')
  owner = await sessionFor('owner@zatyrani-test.local')
  await drain()
})
after(async () => {
  if (stopMock) await stopMock()
  if (stopCapture) await stopCapture()
})
beforeEach(async () => { await dpayReset() })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ago = (ms) => new Date(Date.now() - ms).toISOString()
const paidEvent = (capacity = 50, paymentWindowHours = 168) =>
  createPublishedPaidEvent(owner, { prices: { 'Bieg 9 km': 6000 }, competitions: BIEG(capacity), paymentWindowHours })

async function jobs({ secret = JOBS_SECRET, method = 'POST', headers, body: payload = {} } = {}) {
  const res = await fetch(`${localEnv().functionsUrl}/registration-jobs`, {
    method,
    headers: headers ?? { 'content-type': 'application/json', ...(secret === null ? {} : { 'x-jobs-secret': secret }) },
    body: method === 'POST' ? JSON.stringify(payload) : undefined,
  })
  const text = await res.text()
  let body
  try { body = JSON.parse(text) } catch { body = { raw: text } }
  return { status: res.status, body }
}

async function jobsOk() {
  const r = await jobs()
  assert.equal(r.status, 200, JSON.stringify(r.body))
  return r.body.data
}

const CLAIMED = ['reminders', 'expiredNotices', 'confirmationsResent', 'refundRetries', 'alertsEmailed']
// Runs the job until a run claims nothing, so the backlog of earlier test runs is gone.
async function drain() {
  for (let i = 0; i < 80; i++) {
    const data = await jobsOk()
    if (CLAIMED.every((k) => !data[k])) return
  }
  throw new Error('registration-jobs never drained')
}

async function setOrder(orderId, values) {
  const { error } = await db().from('orders').update(values).eq('id', orderId)
  if (error) throw error
}

const subjects = (msgs) => msgs.map((m) => m.subject.split(' — ')[0]).sort()

async function waitForMail(email, n = 1) {
  for (let i = 0; i < 30; i++) {
    const msgs = await messagesTo(email)
    if (msgs.length >= n) return msgs
    await sleep(200)
  }
  return messagesTo(email)
}

async function call(fn, body, session) {
  const res = await fetch(`${localEnv().functionsUrl}/${fn}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${crypto.randomInt(1, 255)}`,
      ...(session ? { cookie: session.cookie } : {}),
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { status: res.status, body: json }
}

/** A pending order through create-order (a real mock transaction) → { event, email, runner, orderId, txn }. */
async function pendingOrder({ event, tag = 'job' } = {}) {
  const ev = event ?? await paidEvent()
  const email = runnerEmail(tag)
  const runner = await sessionFor(email)
  const r = await call('create-order', {
    categoryId: ev.categoryIds[0],
    person: { firstName: 'Ola', lastName: 'Leśna', birthDate: '1990-05-01', gender: 'K', email, phone: '600100200' },
    acceptedConsentIds: await consentIds(ev.eventId),
    serviceRegulamin: true,
    supportChoice: false,
    displayedTotal: totalFor(6000, 1, false),
  }, runner)
  assert.equal(r.status, 201, JSON.stringify(r.body))
  const { orderId } = r.body.data
  const [attempt] = await rows('payment_attempts', { order_id: orderId })
  return { event: ev, email, runner, orderId, txn: attempt.dpay_transaction_id }
}

/**
 * A paid order whose second paid transaction was recorded for refund by confirm_order but never
 * sent to dpay (the IPN never reached us: dropIpn) → { orderId, email, refund, outcome, second }.
 */
async function recordedDoubleRefund(tag) {
  const { orderId, runner, email } = await pendingOrder({ tag })
  assert.equal((await call('pay-order', { orderId }, runner)).status, 200)
  await dpayMode({ dropIpn: true })
  const { data: attempts, error } = await db().from('payment_attempts').select('dpay_transaction_id')
    .eq('order_id', orderId).order('created_at')
  assert.ifError(error)
  const [first, second] = attempts.map((a) => ({ id: a.dpay_transaction_id }))
  await payMock(first.id, 'paid')
  await payMock(second.id, 'paid')
  const total = (await orderOf(orderId)).total
  assert.equal((await confirmOk(orderId, first.id, total)).outcome, 'confirmed')
  const outcome = await confirmOk(orderId, second.id, total)
  assert.equal(outcome.outcome, 'double_payment')
  const [refund] = await rows('refunds', { order_id: orderId })
  return { orderId, email, refund, outcome, second }
}

const alertsOf = async (orderId) => (await rows('operator_alerts', { order_id: orderId })).map((a) => a.kind).sort()

// ---------------------------------------------------------------- P-36 schedules

test('P-36 cron.job holds the expiry, orphan release, jobs call and purge with their schedules (where pg_cron is installed)', async (t) => {
  const sql = postgres(localEnv().dbUrl, { max: 1, onnotice: () => {} })
  try {
    const [has] = await sql`select to_regclass('cron.job') as t`
    if (!has.t) return t.skip('no cron.job on this stack')
    const jobsRows = await sql`select jobname, schedule, command, active from cron.job where jobname like 'registration-%' order by jobname`
    const byName = Object.fromEntries(jobsRows.map((j) => [j.jobname, j]))
    assert.equal(byName['registration-expire-orders']?.schedule, '*/5 * * * *')
    assert.match(byName['registration-expire-orders'].command, /public\.expire_orders\(\)/)
    assert.equal(byName['registration-release-orphan-orders']?.schedule, '2-59/5 * * * *')
    assert.match(byName['registration-release-orphan-orders'].command, /public\.release_orphan_orders\(\)/)
    assert.equal(byName['registration-jobs']?.schedule, '*/15 * * * *')
    assert.match(byName['registration-jobs'].command, /net\.http_post/)
    assert.match(byName['registration-jobs'].command, /registration_jobs_url/)
    assert.match(byName['registration-jobs'].command, /registration_jobs_secret/)
    assert.match(byName['registration-jobs'].command, /x-jobs-secret/)
    assert.equal(byName['registration-purge-expired']?.schedule, '45 1 * * *')
    assert.match(byName['registration-purge-expired'].command, /public\.purge_expired_registrations\(\)/)
    // cron.schedule by name replaces: each job exactly once.
    assert.equal(jobsRows.filter((j) => j.jobname === 'registration-jobs').length, 1)
    // seed.sql deactivates them on a test stack (production keeps them active).
    const flags = await sql`select jobname, active from cron.job where jobname like 'registration-%'`
    assert.ok(flags.every((j) => j.active === false), JSON.stringify(flags))
  } finally {
    await sql.end({ timeout: 1 })
  }
})

test('P-36 the registration-jobs cron command, run by hand, reaches the function through pg_net and the Vault secrets', async (t) => {
  const sql = postgres(localEnv().dbUrl, { max: 1, onnotice: () => {} })
  try {
    const [has] = await sql`select to_regclass('cron.job') as t`
    if (!has.t) return t.skip('no cron.job on this stack')
    const [job] = await sql`select command from cron.job where jobname = 'registration-jobs'`
    assert.ok(job, 'the job exists')
    const [{ id }] = await sql.unsafe(job.command.trim().replace(/;?\s*$/, '').replace(/^select\s+/i, 'select ') + ' as id')
    let response
    for (let i = 0; i < 120 && !response; i++) {
      const [row] = await sql`select status_code, content from net._http_response where id = ${id}`
      if (row?.status_code) response = row
      else await sleep(500)
    }
    assert.ok(response, 'pg_net got an answer')
    assert.equal(response.status_code, 200, response.content)
    assert.ok('reminders' in JSON.parse(response.content).data)
  } finally {
    await sql.end({ timeout: 1 })
  }
})

// ---------------------------------------------------------------- P3-R7 orphan release

test('P3-R7 release_orphan_orders cancels a pending order with no payment attempt after 15 min and gives the slot back; younger or attempted orders stay', async () => {
  const event = await paidEvent()
  const cat = event.categoryIds[0]
  const orphan = await orderOk(event)
  const young = await orderOk(event)
  const attempted = await orderOk(event)
  await attemptFor(attempted.orderId, attempted.total)
  await setOrder(orphan.orderId, { created_at: ago(16 * MIN) })
  await setOrder(young.orderId, { created_at: ago(14 * MIN) })
  await setOrder(attempted.orderId, { created_at: ago(16 * MIN) })
  assert.equal((await competitionOf(cat)).taken, 3)

  const r = await db().rpc('release_orphan_orders')
  assert.ifError(r.error)
  assert.ok(r.data >= 1)

  const o = await orderOf(orphan.orderId)
  assert.equal(o.status, 'cancelled')
  assert.equal(o.cancelled_reason, 'no_payment_attempt')
  assert.deepEqual((await registrationsOf(orphan.orderId)).map((x) => x.status), ['cancelled'])
  assert.equal((await orderOf(young.orderId)).status, 'pending')
  assert.equal((await orderOf(attempted.orderId)).status, 'pending')
  assert.equal((await competitionOf(cat)).taken, 2)

  await db().rpc('release_orphan_orders')
  assert.equal((await competitionOf(cat)).taken, 2, 'a second run releases nothing twice')
})

test('P3-R7 an orphan whose slot count is broken stays pending with one orphan_release_failed alert, and never blocks the others', async () => {
  const brokenEvent = await paidEvent()
  const broken = await orderOk(brokenEvent)
  const fine = await orderOk(await paidEvent())
  await setOrder(broken.orderId, { created_at: ago(16 * MIN) })
  await setOrder(fine.orderId, { created_at: ago(16 * MIN) })
  // A slot count below what the order holds (only a hand edit can do that): releasing it would go negative.
  const { error } = await db().from('competitions').update({ taken: 0 }).eq('category_id', brokenEvent.categoryIds[0])
  assert.ifError(error)

  for (let i = 0; i < 2; i++) assert.ifError((await db().rpc('release_orphan_orders')).error)
  assert.equal((await orderOf(broken.orderId)).status, 'pending')
  assert.equal((await orderOf(fine.orderId)).status, 'cancelled')
  assert.deepEqual(await alertsOf(broken.orderId), ['orphan_release_failed'])
  // Leave the stack consistent for later runs.
  await db().from('competitions').update({ taken: 1 }).eq('category_id', brokenEvent.categoryIds[0])
})

// ---------------------------------------------------------------- P-37 reminders

test('P-37 a 168 h window: no reminder at 83 h, one at 84 h, none on the next run; a 4 h window never gets one', async () => {
  const event = await paidEvent()
  const { orderId, email } = await pendingOrder({ event, tag: 'remind' })
  const created = Date.now() - 83 * HOUR
  await setOrder(orderId, { created_at: new Date(created).toISOString(), expires_at: new Date(created + 168 * HOUR).toISOString() })
  await jobsOk()
  assert.equal((await orderOf(orderId)).reminder_sent_at, null)
  assert.deepEqual(await messagesTo(email), [])

  const created84 = Date.now() - 84 * HOUR - MIN
  await setOrder(orderId, { created_at: new Date(created84).toISOString(), expires_at: new Date(created84 + 168 * HOUR).toISOString() })
  await Promise.all([jobsOk(), jobsOk()])
  await jobsOk()
  const msgs = await waitForMail(email)
  await sleep(300)
  assert.deepEqual(subjects(await messagesTo(email)), ['Zgłoszenie czeka na wpłatę'])
  assert.match(msgs[0].text, new RegExp(`/zamowienie/${orderId}`))
  assert.ok((await orderOf(orderId)).reminder_sent_at)

  const short = await pendingOrder({ event: await paidEvent(50, 4), tag: 'short' })
  const c4 = Date.now() - 3 * HOUR - 50 * MIN
  await setOrder(short.orderId, { created_at: new Date(c4).toISOString(), expires_at: new Date(c4 + 4 * HOUR).toISOString() })
  await jobsOk()
  assert.equal((await orderOf(short.orderId)).reminder_sent_at, null)
  assert.deepEqual(await messagesTo(short.email), [])
})

// ---------------------------------------------------------------- P-38 expired notices

test('P-38 an expired order → one „Zgłoszenie wygasło” with a link to register again, even with two concurrent runs', async () => {
  const { orderId, email, event, txn } = await pendingOrder({ tag: 'expired' })
  await payMock(txn, 'declined') // dpay says 'expired': the proof the notice needs
  await db().from('payment_attempts').update({ created_at: ago(MIN) }).eq('dpay_transaction_id', txn)
  assert.ok(await expireNow(orderId) >= 1)
  assert.equal((await orderOf(orderId)).status, 'expired')
  await Promise.all([jobsOk(), jobsOk(), jobsOk()])
  await jobsOk()
  const msgs = await waitForMail(email)
  await sleep(300)
  assert.deepEqual(subjects(await messagesTo(email)), ['Zgłoszenie wygasło'])
  const { data: settings } = await db().from('registration_settings').select('slug').eq('event_id', event.eventId).single()
  assert.match(msgs[0].text, new RegExp(`/events/${settings.slug}`))
  assert.ok((await orderOf(orderId)).expired_notified_at)
})

test('P-38 an expired order whose late payment was refunded gets no „Zgłoszenie wygasło”', async () => {
  const event = await paidEvent(1)
  const { orderId, txn, email } = await pendingOrder({ event, tag: 'exprefund' })
  await dpayMode({ dropIpn: true })
  await payMock(txn, 'paid')
  await expireNow(orderId)
  await orderOk(event) // the only slot is taken meanwhile
  const out = await confirm(orderId, txn, (await orderOf(orderId)).total, 'ipn')
  assert.ifError(out.error)
  assert.equal(out.data.outcome, 'late_refund')
  await jobsOk()
  await sleep(300)
  assert.ok(!subjects(await messagesTo(email)).includes('Zgłoszenie wygasło'))
})

// ---------------------------------------------------------------- M6 dpay check before expiry

test('M6 a pending order about to expire whose payment IPN was lost is confirmed by the job, not expired', async () => {
  const { orderId, txn, email } = await pendingOrder({ tag: 'lostipn' })
  await dpayMode({ dropIpn: true })
  await payMock(txn, 'paid')
  await setOrder(orderId, { expires_at: new Date(Date.now() + 10 * MIN).toISOString() })
  // The dpay check skips an attempt younger than 15 s, as order-status does.
  await db().from('payment_attempts').update({ created_at: ago(MIN) }).eq('dpay_transaction_id', txn)
  await jobsOk()
  assert.equal((await orderOf(orderId)).status, 'paid')
  await waitForMail(email)
  assert.deepEqual(subjects(await messagesTo(email)), ['Opłacone'])
})

test('M6 an expired order whose payment IPN was lost is confirmed late by the job, and gets no „Zgłoszenie wygasło”', async () => {
  const { orderId, txn, email } = await pendingOrder({ tag: 'lostexp' })
  await dpayMode({ dropIpn: true })
  await payMock(txn, 'paid')
  await db().from('payment_attempts').update({ created_at: ago(MIN) }).eq('dpay_transaction_id', txn)
  await expireNow(orderId)
  await jobsOk()
  assert.equal((await orderOf(orderId)).status, 'paid')
  await waitForMail(email)
  await sleep(300)
  assert.deepEqual(subjects(await messagesTo(email)), ['Opłacone'])
})

// ---------------------------------------------------------------- P-39 secret

test('P-39 a wrong or missing secret, or a GET → 404 and no e-mail', async () => {
  const { orderId, email } = await pendingOrder({ tag: 'secret' })
  await expireNow(orderId)
  for (const r of [await jobs({ secret: 'wrong' }), await jobs({ secret: null }), await jobs({ secret: `${JOBS_SECRET}x` }),
    await jobs({ method: 'GET', headers: { 'x-jobs-secret': JOBS_SECRET } })]) {
    assert.equal(r.status, 404, JSON.stringify(r.body))
  }
  await sleep(300)
  assert.deepEqual(await messagesTo(email), [])
  assert.equal((await orderOf(orderId)).expired_notified_at, null)
})

// ---------------------------------------------------------------- P-39 operator alerts

test('P-39 an alert from a double payment (P-30) → one operator e-mail naming the order; the next run sends it again to nobody', async () => {
  const { orderId } = await recordedDoubleRefund('alertmail')
  assert.ok((await alertsOf(orderId)).includes('double_payment'))
  await jobsOk()
  await jobsOk()
  await jobsOk()
  const digests = (await messagesTo(OPERATOR)).filter((m) => m.text.includes(orderId))
  assert.equal(digests.length, 1)
  assert.match(digests[0].text, /double_payment/)
  const alerts = await rows('operator_alerts', { order_id: orderId })
  assert.ok(alerts.every((a) => a.emailed_at))
})

// ---------------------------------------------------------------- P-39b refund retry

test('P-39b a 406 refund is retried after next_retry_at with the mock now accepting → accepted; two concurrent runs → one dpay refund', async () => {
  const { orderId, email, second } = await recordedDoubleRefund('retry')
  // The first dpay call happened (406): send it the way the IPN path would.
  await dpayMode({ refundInsufficient: true })
  const [refund0] = await rows('refunds', { order_id: orderId })
  await settleConfirmOutcome(db(), nodeCfg(), {
    outcome: 'double_payment', orderId, txn: second.id,
    refund: { refundId: refund0.id, messageId: refund0.message_id, grosze: refund0.amount, reason: refund0.reason, attemptId: refund0.payment_attempt_id },
  })
  let [refund] = await rows('refunds', { order_id: orderId })
  assert.equal(refund.dpay_status, 'insufficient_balance')
  assert.ok(refund.requested_at)
  assert.ok(refund.next_retry_at)

  await jobsOk()
  assert.equal((await rows('refunds', { order_id: orderId }))[0].attempts, 0, 'not retried before next_retry_at')

  await dpayMode({ refundInsufficient: false })
  const { error } = await db().from('refunds').update({ next_retry_at: ago(MIN) }).eq('id', refund.id)
  assert.ifError(error)
  await Promise.all([jobsOk(), jobsOk(), jobsOk()])
  ;[refund] = await rows('refunds', { order_id: orderId })
  assert.equal(refund.dpay_status, 'accepted')
  assert.equal(refund.attempts, 1)
  assert.equal(refund.next_retry_at, null)
  assert.deepEqual((await dpayRefunds()).map((r) => [r.txnId, r.grosze]), [[second.id, refund.amount]])
  await waitForMail(email, 1)
  await sleep(300)
  assert.ok(subjects(await messagesTo(email)).includes('Płatność zwrócona'))
})

test('P-39b the 24th failed retry raises refund_retry_exhausted and nothing retries it again', async () => {
  const { orderId, second } = await recordedDoubleRefund('exhaust')
  await dpayMode({ refundInsufficient: true })
  const [r0] = await rows('refunds', { order_id: orderId })
  const { error } = await db().from('refunds')
    .update({ dpay_status: 'insufficient_balance', attempts: 23, next_retry_at: ago(MIN), requested_at: ago(HOUR) }).eq('id', r0.id)
  assert.ifError(error)
  await jobsOk()
  let [refund] = await rows('refunds', { order_id: orderId })
  assert.equal(refund.attempts, 24)
  assert.equal(refund.dpay_status, 'insufficient_balance')
  assert.equal(refund.next_retry_at, null, 'an exhausted refund no longer looks due (M4)')
  assert.ok((await alertsOf(orderId)).includes('refund_retry_exhausted'))

  await dpayMode({ refundInsufficient: false })
  await db().from('refunds').update({ next_retry_at: ago(MIN) }).eq('id', refund.id)
  await jobsOk()
  ;[refund] = await rows('refunds', { order_id: orderId })
  assert.equal(refund.attempts, 24)
  assert.equal(refund.dpay_status, 'insufficient_balance')
  assert.equal((await dpayRefunds()).filter((r) => r.txnId === second.id).length, 0)
})

// ---------------------------------------------------------------- P3-R10 refund claim

test('P3-R10 settleConfirmOutcome claims refunds.requested_at before dpay: two concurrent calls → one dpay refund; an already claimed refund → none', async () => {
  const { orderId, outcome, second } = await recordedDoubleRefund('claim')
  const args = { ...outcome, orderId, txn: second.id }
  await Promise.all([settleConfirmOutcome(db(), nodeCfg(), args), settleConfirmOutcome(db(), nodeCfg(), args)])
  assert.equal((await dpayRefunds()).filter((r) => r.txnId === second.id).length, 1)
  const [refund] = await rows('refunds', { order_id: orderId })
  assert.ok(refund.requested_at)
  assert.equal(refund.dpay_status, 'accepted')

  const other = await recordedDoubleRefund('claimed')
  await db().from('refunds').update({ requested_at: new Date().toISOString() }).eq('id', other.refund.id)
  await settleConfirmOutcome(db(), nodeCfg(), { ...other.outcome, orderId: other.orderId, txn: other.second.id })
  assert.equal((await dpayRefunds()).filter((r) => r.txnId === other.second.id).length, 0)
  assert.equal((await rows('refunds', { order_id: other.orderId }))[0].dpay_status, 'pending')
})

test('P3-R10 an automatic refund never sent to dpay for 10 min → one refund_never_sent alert however often the job runs; a younger one → none', async () => {
  const old = await recordedDoubleRefund('neversent')
  const young = await recordedDoubleRefund('notyet')
  await db().from('refunds').update({ created_at: ago(11 * MIN) }).eq('id', old.refund.id)
  await db().from('refunds').update({ created_at: ago(5 * MIN) }).eq('id', young.refund.id)
  await Promise.all([jobsOk(), jobsOk()])
  await jobsOk()
  assert.equal((await alertsOf(old.orderId)).filter((k) => k === 'refund_never_sent').length, 1)
  assert.equal((await alertsOf(young.orderId)).filter((k) => k === 'refund_never_sent').length, 0)
  assert.equal((await rows('refunds', { order_id: old.orderId }))[0].requested_at, null, 'the sweep alerts, it never sends')
})

// ---------------------------------------------------------------- P3-R10 lost confirmation

test('P3-R10 the IPN path stamps confirmation_sent_at; a confirmed order with no stamp after 10 min gets one confirmation from concurrent runs', async () => {
  const sent = await pendingOrder({ tag: 'stamped' })
  await payMock(sent.txn, 'paid')
  await waitForMail(sent.email)
  assert.ok((await orderOf(sent.orderId)).confirmation_sent_at)

  const event = await paidEvent()
  const lost = await orderOk(event)
  const { txn } = await attemptFor(lost.orderId, lost.total)
  assert.equal((await confirmOk(lost.orderId, txn, lost.total)).outcome, 'confirmed')
  const { data: reg } = await db().from('registrations').select('email').eq('order_id', lost.orderId).single()
  assert.equal((await orderOf(lost.orderId)).confirmation_sent_at, null)
  await jobsOk()
  assert.deepEqual(await messagesTo(reg.email), [], 'not before 10 min')

  await setOrder(lost.orderId, { paid_at: ago(11 * MIN) })
  await Promise.all([jobsOk(), jobsOk(), jobsOk()])
  await jobsOk()
  await waitForMail(reg.email)
  await sleep(300)
  assert.deepEqual(subjects(await messagesTo(reg.email)), ['Opłacone'])
  assert.ok((await orderOf(lost.orderId)).confirmation_sent_at)
  await sleep(300)
  assert.deepEqual(subjects(await messagesTo(sent.email)), ['Opłacone'], 'the stamped one is never resent')
})

// ---------------------------------------------------------------- D3-8 purge

test('D3-8 purge_expired_registrations anonymises registrations of orders expired 30+ days ago; 29 days, confirmed and freshly cancelled untouched; a second run returns 0', async () => {
  const event = await paidEvent()
  const old = await orderOk(event)
  const recent = await orderOk(event)
  const paid = await orderOk(event)
  const cancelled = await orderOk(event)
  const { txn } = await attemptFor(old.orderId, old.total)
  await expireNow(old.orderId)
  await expireNow(recent.orderId)
  const p = await attemptFor(paid.orderId, paid.total)
  await confirmOk(paid.orderId, p.txn, paid.total)
  assert.ifError((await db().rpc('cancel_order', { p_order_id: cancelled.orderId, p_reason: 'test' })).error)
  await setOrder(old.orderId, { expires_at: ago(30 * 24 * HOUR + HOUR) })
  await setOrder(recent.orderId, { expires_at: ago(29 * 24 * HOUR) })
  for (const o of [paid, cancelled]) await setOrder(o.orderId, { expires_at: ago(40 * 24 * HOUR) })

  const before = {}
  for (const o of [old, recent, paid, cancelled]) before[o.orderId] = (await registrationsOf(o.orderId))[0]
  const oldOrderBefore = await orderOf(old.orderId)

  const first = await db().rpc('purge_expired_registrations')
  assert.ifError(first.error)
  assert.ok(first.data >= 1)

  const [r] = await registrationsOf(old.orderId)
  assert.equal(r.first_name, 'Usunięte zgłoszenie')
  assert.equal(r.last_name, 'Usunięte zgłoszenie')
  for (const k of ['email', 'phone', 'birth_date', 'city', 'club', 'ice_name', 'ice_phone', 'nationality', 'guardian_name', 'guardian_email', 'profile_id']) {
    assert.equal(r[k], null, k)
  }
  assert.equal(r.status, 'expired')
  const acc = await rows('consent_acceptances', { registration_id: r.id })
  assert.ok(acc.length > 0)
  assert.ok(acc.every((a) => a.ip === null && a.user_agent === null))
  // No money moved (the attempt was never paid): the buyer's address goes too, nothing else (P3-R12).
  assert.deepEqual(await orderOf(old.orderId), { ...oldOrderBefore, buyer_email: null })
  assert.equal((await rows('payment_attempts', { dpay_transaction_id: txn })).length, 1)

  for (const o of [recent, paid, cancelled]) {
    const [x] = await registrationsOf(o.orderId)
    assert.deepEqual(x, before[o.orderId], `${o.orderId} untouched`)
    const a = await rows('consent_acceptances', { registration_id: x.id })
    assert.ok(a.every((y) => y.ip !== null), 'device traces kept')
  }

  const second = await db().rpc('purge_expired_registrations')
  assert.ifError(second.error)
  assert.equal(second.data, 0)
})

test('P3-R12 the purge anonymises cancelled unpaid registrations 30 days after cancellation and nulls buyer_email only where no money moved', async () => {
  const event = await paidEvent()
  const orphan = await orderOk(event)
  const fresh = await orderOk(event)
  const moved = await orderOk(event)
  await setOrder(orphan.orderId, { created_at: ago(31 * 24 * HOUR) })
  assert.equal(await (async () => { const r = await db().rpc('release_orphan_orders'); assert.ifError(r.error); return (await orderOf(orphan.orderId)).cancelled_reason })(), 'no_payment_attempt')
  assert.ifError((await db().rpc('cancel_order', { p_order_id: fresh.orderId, p_reason: 'test' })).error)
  // An expired order whose late payment was refunded: money moved, the order is an accounting record.
  const a = await attemptFor(moved.orderId, moved.total)
  await expireNow(moved.orderId)
  assert.ifError((await db().from('payment_attempts').update({ status: 'refunded', paid_at: ago(31 * 24 * HOUR) }).eq('id', a.id)).error)
  await setOrder(orphan.orderId, { cancelled_at: ago(30 * 24 * HOUR + HOUR) })
  await setOrder(fresh.orderId, { cancelled_at: ago(29 * 24 * HOUR) })
  await setOrder(moved.orderId, { expires_at: ago(31 * 24 * HOUR) })
  const freshReg = (await registrationsOf(fresh.orderId))[0]
  const movedBuyer = (await orderOf(moved.orderId)).buyer_email

  assert.ifError((await db().rpc('purge_expired_registrations')).error)

  const [o] = await registrationsOf(orphan.orderId)
  assert.equal(o.status, 'cancelled')
  assert.equal(o.first_name, 'Usunięte zgłoszenie')
  assert.equal(o.email, null)
  assert.ok((await rows('consent_acceptances', { registration_id: o.id })).every((x) => x.ip === null && x.user_agent === null))
  assert.equal((await orderOf(orphan.orderId)).buyer_email, null)

  assert.deepEqual((await registrationsOf(fresh.orderId))[0], freshReg, '29 days after cancellation: untouched')
  assert.ok((await orderOf(fresh.orderId)).buyer_email)

  assert.equal((await registrationsOf(moved.orderId))[0].first_name, 'Usunięte zgłoszenie')
  assert.equal((await orderOf(moved.orderId)).buyer_email, movedBuyer, 'money moved: the buyer stays')
})

// ---------------------------------------------------------------- C1 expire_orders isolation

test('C1 expire_orders: one order whose competition count is broken stays pending with one expire_failed alert; every other due order expires', async () => {
  const brokenEvent = await paidEvent()
  const healthyEvent = await paidEvent()
  const broken = await orderOk(brokenEvent)
  const healthy = await orderOk(healthyEvent)
  await setOrder(broken.orderId, { expires_at: ago(MIN) })
  await setOrder(healthy.orderId, { expires_at: ago(MIN) })
  assert.ifError((await db().from('competitions').update({ taken: 0 }).eq('category_id', brokenEvent.categoryIds[0])).error)
  try {
    for (let i = 0; i < 2; i++) {
      const r = await db().rpc('expire_orders')
      assert.ifError(r.error)
    }
    assert.equal((await orderOf(healthy.orderId)).status, 'expired')
    assert.equal((await competitionOf(healthyEvent.categoryIds[0])).taken, 0)
    assert.deepEqual((await registrationsOf(healthy.orderId)).map((x) => x.status), ['expired'])
    assert.equal((await orderOf(broken.orderId)).status, 'pending')
    assert.deepEqual(await alertsOf(broken.orderId), ['expire_failed'])
  } finally {
    await db().from('competitions').update({ taken: 1 }).eq('category_id', brokenEvent.categoryIds[0])
  }
  assert.ifError((await db().rpc('expire_orders')).error)
  assert.equal((await orderOf(broken.orderId)).status, 'expired', 'expires once the count is repaired')
})

// ---------------------------------------------------------------- I1 stalled refunds

test('I1 a refund claimed 15+ min ago with no dpay answer → one refund_stalled alert, no dpay call; a 406 whose retry claim crashed → one alert; a real 409 → none', async () => {
  const crashed = await recordedDoubleRefund('stall')
  const retry = await recordedDoubleRefund('stallretry')
  const answered = await recordedDoubleRefund('stall409')
  const set = (id, v) => db().from('refunds').update(v).eq('id', id)
  assert.ifError((await set(crashed.refund.id, { created_at: ago(20 * MIN), requested_at: ago(16 * MIN), responded_at: null })).error)
  assert.ifError((await set(retry.refund.id, {
    created_at: ago(3 * HOUR), dpay_status: 'insufficient_balance', next_retry_at: null, attempts: 3,
    requested_at: ago(16 * MIN), responded_at: ago(HOUR),
  })).error)
  assert.ifError((await set(answered.refund.id, { created_at: ago(20 * MIN), requested_at: ago(16 * MIN), responded_at: ago(16 * MIN - 2000) })).error)

  for (let i = 0; i < 3; i++) await jobsOk()
  assert.equal((await alertsOf(crashed.orderId)).filter((k) => k === 'refund_stalled').length, 1)
  assert.equal((await alertsOf(retry.orderId)).filter((k) => k === 'refund_stalled').length, 1)
  assert.equal((await alertsOf(answered.orderId)).filter((k) => k.startsWith('refund_stalled') || k === 'refund_never_sent').length, 0)
  assert.equal((await dpayRefunds()).length, 0, 'a stall is alerted, never re-sent')
  assert.equal((await rows('refunds', { order_id: crashed.orderId }))[0].dpay_status, 'pending')
})

// ---------------------------------------------------------------- I2 notices need proof

test('I2 an expired order checked by order-status 2 min ago and paid at dpay with the IPN lost gets no „Zgłoszenie wygasło”; the next check confirms it late', async () => {
  const { orderId, txn, email } = await pendingOrder({ tag: 'recent' })
  await dpayMode({ dropIpn: true })
  await payMock(txn, 'paid')
  await db().from('payment_attempts').update({ created_at: ago(MIN) }).eq('dpay_transaction_id', txn)
  await expireNow(orderId)
  await setOrder(orderId, { last_status_check_at: ago(2 * MIN) })
  await jobsOk()
  let o = await orderOf(orderId)
  assert.equal(o.status, 'expired')
  assert.equal(o.expired_notified_at, null)
  assert.equal(o.dpay_checked_at, null)

  await setOrder(orderId, { last_status_check_at: ago(11 * MIN) })
  for (let i = 0; i < 3; i++) await jobsOk()
  o = await orderOf(orderId)
  assert.equal(o.status, 'paid')
  await waitForMail(email)
  await sleep(300)
  assert.deepEqual(subjects(await messagesTo(email)), ['Opłacone'])
})

test('I2 dpay answering processing → no notice and no proof; once dpay says expired, one notice', async () => {
  const { orderId, txn, email } = await pendingOrder({ tag: 'processing' })
  await db().from('payment_attempts').update({ created_at: ago(MIN) }).eq('dpay_transaction_id', txn)
  await expireNow(orderId)
  await dpayMode({ detailsStatus: 'processing' })
  await jobsOk()
  let o = await orderOf(orderId)
  assert.equal(o.expired_notified_at, null)
  assert.equal(o.dpay_checked_at, null)
  await sleep(300)
  assert.deepEqual(await messagesTo(email), [])

  await dpayMode({ detailsStatus: null })
  await payMock(txn, 'declined')
  await setOrder(orderId, { last_status_check_at: ago(11 * MIN) })
  await jobsOk()
  o = await orderOf(orderId)
  assert.ok(o.dpay_checked_at)
  assert.ok(o.expired_notified_at)
  await waitForMail(email)
  assert.deepEqual(subjects(await messagesTo(email)), ['Zgłoszenie wygasło'])
})

test('I2-a an order with 4 unpaid attempts, the oldest paid with the IPN lost: the 3 checked are declined, yet no proof and no „Zgłoszenie wygasło”', async () => {
  const { orderId, runner, email } = await pendingOrder({ tag: 'fourattempts' })
  for (let i = 0; i < 3; i++) assert.equal((await call('pay-order', { orderId }, runner)).status, 200)
  await dpayMode({ dropIpn: true })
  const { data: attempts, error } = await db().from('payment_attempts').select('dpay_transaction_id')
    .eq('order_id', orderId).order('created_at')
  assert.ifError(error)
  assert.equal(attempts.length, 4)
  const [oldest, ...newer] = attempts.map((a) => a.dpay_transaction_id)
  await payMock(oldest, 'paid')
  for (const txn of newer) await payMock(txn, 'declined')
  // Oldest first, a minute apart, all past the 15 s age filter.
  for (const [i, txn] of [oldest, ...newer].entries()) {
    await db().from('payment_attempts').update({ created_at: ago((10 - i) * MIN) }).eq('dpay_transaction_id', txn)
  }
  await expireNow(orderId)
  await jobsOk()
  const o = await orderOf(orderId)
  assert.ok(o.last_status_check_at, 'checked this run')
  assert.equal(o.dpay_checked_at, null, 'three of four attempts is no proof')
  assert.equal(o.expired_notified_at, null)
  await sleep(300)
  assert.deepEqual(await messagesTo(email), [])
})

// ---------------------------------------------------------------- I3 time budget

test('I3 a hanging dpay: the run answers inside its budget, the operator digest and reminders still go out, unchecked orders get no notice', async () => {
  await dpayMode({ detailsHang: true })
  const event = await paidEvent()
  const waiting = []
  for (let i = 0; i < 12; i++) {
    const o = await orderOk(event)
    const { txn } = await attemptFor(o.orderId, o.total)
    await db().from('payment_attempts').update({ created_at: ago(MIN) }).eq('dpay_transaction_id', txn)
    await expireNow(o.orderId)
    const { data: reg } = await db().from('registrations').select('email').eq('order_id', o.orderId).single()
    waiting.push({ orderId: o.orderId, email: reg.email })
  }
  const remind = await orderOk(event)
  const created = Date.now() - 84 * HOUR - MIN
  await setOrder(remind.orderId, { created_at: new Date(created).toISOString(), expires_at: new Date(created + 168 * HOUR).toISOString() })
  const { data: remindReg } = await db().from('registrations').select('email').eq('order_id', remind.orderId).single()
  assert.ifError((await db().from('operator_alerts').insert({ kind: 'budget_probe', order_id: remind.orderId, payload: { probe: true } })).error)

  const t0 = Date.now()
  const r = await jobs({ body: { budgetMs: 30_000 } })
  const took = Date.now() - t0
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.ok(took < 40_000, `answered in ${took} ms`)
  assert.ok(r.body.data.deferred.includes('dpay_check'), JSON.stringify(r.body.data))

  await waitForMail(remindReg.email)
  assert.deepEqual(subjects(await messagesTo(remindReg.email)), ['Zgłoszenie czeka na wpłatę'])
  assert.ok((await messagesTo(OPERATOR)).some((m) => m.text.includes('budget_probe') && m.text.includes(remind.orderId)))
  for (const w of waiting) {
    assert.equal((await orderOf(w.orderId)).expired_notified_at, null)
    assert.deepEqual(await messagesTo(w.email), [])
  }
})

// ---------------------------------------------------------------- grants

test('P-36 anon and authenticated cannot execute the new job functions', async () => {
  const { url, anonKey, jwtSecret } = localEnv()
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const head = b64({ alg: 'HS256', typ: 'JWT' })
  const claims = b64({ role: 'authenticated', sub: crypto.randomUUID(), aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 600 })
  const sig = crypto.createHmac('sha256', jwtSecret).update(`${head}.${claims}`).digest('base64url')
  const anon = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const authed = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${head}.${claims}.${sig}` } },
  })
  const calls = [
    ['release_orphan_orders', {}], ['purge_expired_registrations', {}], ['claim_payment_reminders', {}],
    ['claim_expired_notices', {}], ['claim_confirmation_resends', {}], ['stalled_refunds', {}],
    ['claim_refund_retries', {}],
  ]
  for (const client of [anon, authed]) {
    for (const [fn, args] of calls) {
      const { error } = await client.rpc(fn, args)
      assert.ok(error, `${fn} refused`)
      assert.match(error.message, /permission denied/, fn)
    }
  }
  // service_role may (the claims are exercised through the function above).
  assert.ifError((await admin().rpc('release_orphan_orders')).error)
  assert.ifError((await admin().rpc('purge_expired_registrations')).error)
})
