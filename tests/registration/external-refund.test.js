// A refund the organizer made in the dpay merchant panel instead of through „Zwróć wpłatę”. dpay
// sends no IPN for a refund, so leszy.run learns about it only from the operator:
//   record_external_refund (O-45): records it as an accepted organizer refund (reason 'external'),
//     with the effects dpay's own answer has, and one admin_actions row;
//   backend/scripts/record-external-refund.js (O-46): dry run by default, --apply calls the RPC.
// The job step that finds such refunds (O-47) is in jobs.test.js. Scenarios in
// docs/registration/scenario-matrix.md. LOCAL stack plus the mocked dpay; every event is random.
import { after, afterEach, before, test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { localEnv, sessionFor } from './helpers/stack.js'
import { acceptAgreement, createPublishedPaidEvent } from './helpers/registrationFixtures.js'
import {
  attemptFor, competitionOf, confirmOk, minutesFromNow, one, orderOk, profileFor, rows, rpc, runnerEmail, setSettings,
} from './helpers/orders.js'
import { assertSlotInvariant } from './helpers/slotInvariant.js'
import { paidTeamEvent, teamOk } from './helpers/teams.js'
import { dpayMode, dpayReset, payMock, startDpayMock } from './helpers/dpayControl.js'
import { DPAY_MOCK_PORT } from './helpers/dpayMock.js'
import { dpayConfig, refundTransaction, registerTransaction } from '../../supabase/functions/_shared/dpay.js'
import { warsawToday } from '../../supabase/functions/_shared/registration/dates.js'

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const NOTE = 'LG 2026-11-02: panel dpay, zwrot widoczny'

let owner
let stopMock
let sqlClient
const sql = () => (sqlClient ??= postgres(localEnv().dbUrl, { max: 1, onnotice: () => {} }))
const seen = new Set()
const watch = (event) => { event.categoryIds.forEach((c) => seen.add(c)); return event }

before(async () => {
  stopMock = await startDpayMock()
  await acceptAgreement('zatyrani-test')
  owner = await sessionFor('owner@zatyrani-test.local')
})
after(async () => {
  if (sqlClient) await sqlClient.end()
  if (stopMock) await stopMock()
})
afterEach(async () => {
  for (const categoryId of seen) await assertSlotInvariant(categoryId)
  seen.clear()
})

const ok = (r) => { assert.equal(r.error, null, r.error?.message); return r.data }
const refused = (r, message) => assert.equal(r.error?.message, message, JSON.stringify(r))
const reg = (id) => one('registrations', { id })
const taken = async (cat) => (await competitionOf(cat)).taken
const paidEvent = async () => watch(await createPublishedPaidEvent(owner, { prices: { 'Bieg 9 km': 6000 } }))
const record = (lineId, grosze, note = NOTE, notify = false) =>
  rpc('record_external_refund', { p_line_id: lineId, p_grosze: grosze, p_note: note, p_notify: notify })
const actionsFor = (refundId) => rows('admin_actions', { target_id: refundId })

/** One paid, confirmed entry → its order, line, registration and attempt. */
async function paidEntry(event, txn) {
  const out = await orderOk(event, { emails: [runnerEmail('ext')] })
  const att = await attemptFor(out.orderId, out.total, txn)
  assert.equal((await confirmOk(out.orderId, att.txn, out.total)).outcome, 'confirmed')
  const [line] = await rows('order_lines', { order_id: out.orderId })
  return { orderId: out.orderId, line, registrationId: line.registration_id, attempt: att, total: out.total }
}

// ---------------------------------------------------------------- O-45 the RPC

test('O-45 a full external refund is an accepted organizer refund: line, entry, slot, participant and attempt as dpay\'s answer leaves them; one admin_actions row; no e-mail by default', async () => {
  const event = await paidEvent()
  const cat = event.categoryIds[0]
  const e = await paidEntry(event)
  const before = await taken(cat)
  const partId = (await reg(e.registrationId)).participant_id

  const out = ok(await record(e.line.id, 6000))
  assert.equal(out.replay, false)
  assert.equal(out.status, 'accepted')
  assert.deepEqual(out.cancelled, [e.registrationId])
  assert.equal(out.hostWithdraw, false)

  const f = await one('refunds', { id: out.refundId })
  assert.equal(f.kind, 'organizer')
  assert.equal(f.reason, 'external')
  assert.equal(f.dpay_status, 'accepted')
  assert.equal(f.amount, 6000)
  assert.equal(f.order_line_id, e.line.id)
  assert.equal(f.payment_attempt_id, e.attempt.id)
  assert.equal(f.requested_by, null)
  assert.equal(f.resolved_by, NOTE)
  assert.ok(f.requested_at && f.responded_at)
  assert.ok(f.runner_notified_at, 'stamped: the refund_emails job must not mail the runner')
  assert.equal(f.next_retry_at, null)

  assert.equal((await one('order_lines', { id: e.line.id })).refunded, 6000)
  const r = await reg(e.registrationId)
  assert.equal(r.refunded, 6000)
  assert.equal(r.status, 'cancelled')
  assert.equal(await taken(cat), before - 1)
  assert.ok((await one('participants', { id: partId })).removed_at)
  assert.equal((await one('payment_attempts', { id: e.attempt.id })).status, 'refunded')

  const actions = await actionsFor(out.refundId)
  assert.equal(actions.length, 1)
  assert.equal(actions[0].action, 'record_external_refund')
  assert.equal(actions[0].target_table, 'refunds')
  assert.equal(actions[0].admin_user_id, null)
  assert.equal(actions[0].payload.orderId, e.orderId)
  assert.equal(actions[0].payload.lineId, e.line.id)
  assert.equal(actions[0].payload.grosze, 6000)
  assert.equal(actions[0].payload.note, NOTE)
  assert.equal(actions[0].payload.notify, false)
  assert.equal((await one('orders', { id: e.orderId })).status, 'paid', 'the order keeps its payment')
})

test('O-45 a partial external refund leaves the entry confirmed; a second one that covers the line cancels it; --notify leaves runner_notified_at for the job', async () => {
  const event = await paidEvent()
  const e = await paidEntry(event)
  const first = ok(await record(e.line.id, 2000, NOTE, true))
  assert.deepEqual(first.cancelled, [])
  assert.equal((await reg(e.registrationId)).status, 'confirmed')
  assert.equal((await reg(e.registrationId)).refunded, 2000)
  assert.equal((await one('order_lines', { id: e.line.id })).refunded, 2000)
  assert.equal((await one('refunds', { id: first.refundId })).runner_notified_at, null, 'notify: the job sends the e-mail')
  assert.equal((await one('payment_attempts', { id: e.attempt.id })).status, 'paid')

  const second = ok(await record(e.line.id, 4000, `${NOTE} (druga część)`))
  assert.notEqual(second.refundId, first.refundId)
  assert.deepEqual(second.cancelled, [e.registrationId])
  assert.equal((await reg(e.registrationId)).status, 'cancelled')
  assert.equal((await one('payment_attempts', { id: e.attempt.id })).status, 'refunded')
})

test('O-45 refusals: over what is left on the line (a reservation counts), zero, no note, an unpaid order, an unknown line; nothing written', async () => {
  const event = await paidEvent()
  const e = await paidEntry(event)
  ok(await record(e.line.id, 2000))
  refused(await record(e.line.id, 4001), 'exceeds:4000')
  refused(await record(e.line.id, 0), 'invalid_amount')
  refused(await record(e.line.id, -1), 'invalid_amount')
  refused(await record(e.line.id, 1000, '   '), 'note_required')
  refused(await record(e.line.id, 1000, 'x'.repeat(501)), 'note_too_long')
  // A refund reserved through the panel holds its share of the line too.
  ok(await rpc('reserve_organizer_refund', {
    p_line_id: e.line.id, p_grosze: 3000, p_actor: await profileFor('owner@zatyrani-test.local'), p_request_key: crypto.randomUUID(),
  }))
  refused(await record(e.line.id, 1001), 'exceeds:1000')
  assert.equal((await one('order_lines', { id: e.line.id })).refunded, 5000)
  assert.equal((await rows('refunds', { order_line_id: e.line.id })).length, 2)

  const pending = await orderOk(event)
  const [pLine] = await rows('order_lines', { order_id: pending.orderId })
  refused(await record(pLine.id, 1000), 'not_paid')
  refused(await record(crypto.randomUUID(), 1000), 'not_found')
  assert.deepEqual(await rows('refunds', { order_line_id: pLine.id }), [])
})

test('O-45 an identical re-run is a replay: the same refund, nothing moved twice, one admin_actions row', async () => {
  const event = await paidEvent()
  const e = await paidEntry(event)
  const first = ok(await record(e.line.id, 2500))
  const again = ok(await record(e.line.id, 2500, `  ${NOTE}  `))
  assert.equal(again.replay, true)
  assert.equal(again.refundId, first.refundId)
  assert.equal(again.status, 'accepted')
  assert.equal((await one('order_lines', { id: e.line.id })).refunded, 2500)
  assert.equal((await reg(e.registrationId)).refunded, 2500)
  assert.equal((await rows('refunds', { order_line_id: e.line.id })).length, 1)
  assert.equal((await actionsFor(first.refundId)).length, 1)
  // Two at once: the order lock serialises them, one records and one replays.
  const e2 = await paidEntry(event)
  const both = await Promise.all([record(e2.line.id, 6000), record(e2.line.id, 6000)])
  const outs = both.map(ok)
  assert.equal(outs.filter((o) => o.replay).length, 1)
  assert.equal(outs[0].refundId, outs[1].refundId)
  assert.equal((await one('order_lines', { id: e2.line.id })).refunded, 6000)
})

test('O-45 a team line refunded in full cancels the whole team, one slot, the name released', async () => {
  const event = watch(await paidTeamEvent(owner))
  const cat = event.categoryIds[0]
  const out = await teamOk(event)
  const att = await attemptFor(out.orderId, out.total)
  assert.equal((await confirmOk(out.orderId, att.txn, out.total)).outcome, 'confirmed')
  const ids = out.registrations.map((r) => r.id)
  const before = await taken(cat)
  const [line] = await rows('order_lines', { order_id: out.orderId })
  const done = ok(await record(line.id, out.total))
  assert.deepEqual([...done.cancelled].sort(), [...ids].sort())
  for (const id of ids) assert.equal((await reg(id)).status, 'cancelled')
  assert.equal(await taken(cat), before - 1)
  assert.ok((await one('teams', { id: out.teamId })).released_at)
})

test('O-45 race day does not stop a record: the money already left at dpay', async () => {
  const event = await paidEvent()
  const e = await paidEntry(event)
  await setSettings(event.eventId, { closes_at: minutesFromNow(-1), event_date: warsawToday(new Date()) })
  const out = ok(await record(e.line.id, 6000))
  assert.equal(out.status, 'accepted')
  assert.deepEqual(out.cancelled, [e.registrationId])
})

test('O-45 record_external_refund and claim_external_refund_checks are service_role only, SECURITY DEFINER, search_path empty', async () => {
  const fns = ['record_external_refund', 'claim_external_refund_checks']
  const got = await sql()`
    SELECT p.proname, p.prosecdef, p.proconfig,
           has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
           has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = ANY (${fns})`
  assert.deepEqual(got.map((f) => f.proname).sort(), [...fns].sort())
  for (const f of got) {
    assert.equal(f.prosecdef, true, f.proname)
    assert.equal(f.anon, false, f.proname)
    assert.equal(f.auth, false, f.proname)
    assert.equal(f.svc, true, f.proname)
    assert.deepEqual(f.proconfig, ['search_path=""'], f.proname)
  }
})

// ---------------------------------------------------------------- O-46 the script

const mockEnv = {
  DPAY_SERVICE: 'mock-service', DPAY_SECRET: 'mock-secret',
  DPAY_API_BASE: `http://127.0.0.1:${DPAY_MOCK_PORT}`, DPAY_PANEL_BASE: `http://127.0.0.1:${DPAY_MOCK_PORT}`,
  DPAY_IPN_URL: 'http://127.0.0.1:9/ipn', PUBLIC_SITE_URL: 'http://localhost:5173',
}

function script(args, { dpay = true } = {}) {
  const { url, serviceKey } = localEnv()
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: serviceKey,
    ...(dpay ? mockEnv : {}),
  }
  return spawnSync(process.execPath, ['scripts/record-external-refund.js', ...args],
    { cwd: `${REPO}backend`, env, encoding: 'utf8', timeout: 30_000 })
}

/** A paid entry whose transaction lives at the mock, refunded `grosze` in the dpay panel. */
async function panelRefunded(event, grosze) {
  await dpayReset()
  await dpayMode({ dropIpn: true })
  const out = await orderOk(event, { emails: [runnerEmail('extscript')] })
  const cfg = dpayConfig(mockEnv)
  const { transactionId } = await registerTransaction(cfg, { orderId: out.orderId, grosze: out.total })
  await payMock(transactionId, 'paid')
  const att = await attemptFor(out.orderId, out.total, transactionId)
  assert.equal((await confirmOk(out.orderId, att.txn, out.total)).outcome, 'confirmed')
  assert.equal((await refundTransaction(cfg, { transactionId, grosze, messageId: 'panel' })).outcome, 'accepted')
  const [line] = await rows('order_lines', { order_id: out.orderId })
  return { orderId: out.orderId, line, txn: transactionId, registrationId: line.registration_id }
}

const snapshot = async (e) => ({
  refunds: await rows('refunds', { order_id: e.orderId }),
  line: await one('order_lines', { id: e.line.id }),
  reg: await reg(e.registrationId),
})

test('O-46 record-external-refund.js: a dry run prints the order, its line, dpay\'s refunded amount and the plan, and writes nothing; --apply records it once', async () => {
  const event = await paidEvent()
  const e = await panelRefunded(event, 6000)
  const before = await snapshot(e)

  const dry = script(['--order', e.orderId, '--amount', '60', '--note', NOTE])
  assert.equal(dry.status, 0, dry.stderr + dry.stdout)
  for (const s of [e.orderId, e.line.id, e.txn, e.registrationId, '60,00 zł', 'refunded_amount', 'DRY RUN', 'cancel']) {
    assert.ok(dry.stdout.includes(s), `${s} in:\n${dry.stdout}`)
  }
  assert.match(dry.stdout, /refunded_amount\s+60,00 zł/)
  assert.deepEqual(await snapshot(e), before, 'a dry run writes nothing')

  // Bad input: exit 2, nothing written. A flag where a value belongs counts as missing.
  for (const bad of [
    ['--order', e.orderId, '--amount', '60'],
    ['--order', e.orderId, '--amount', '60', '--note', '--apply'],
    ['--order', e.orderId, '--amount', 'abc', '--note', NOTE],
    ['--order', e.orderId, '--amount', '0', '--note', NOTE],
    ['--order', e.orderId, '--amount', '1,005', '--note', NOTE],
    ['--order', 'nope', '--amount', '60', '--note', NOTE],
    ['--amount', '60', '--note', NOTE],
    ['--email', 'a@b.c', '--amount', '60', '--note', NOTE],
  ]) {
    const r = script([...bad, '--apply'])
    assert.equal(r.status, 2, `${bad.join(' ')}\n${r.stdout}${r.stderr}`)
  }
  const applied = script(['--order', e.orderId, '--amount', '60,00', '--line', e.line.id, '--note', NOTE, '--apply'])
  assert.equal(applied.status, 0, applied.stderr + applied.stdout)
  assert.match(applied.stdout, /Recorded/)
  const after = await snapshot(e)
  assert.equal(after.refunds.length, 1)
  assert.equal(after.refunds[0].reason, 'external')
  assert.equal(after.refunds[0].dpay_status, 'accepted')
  assert.equal(after.refunds[0].amount, 6000)
  assert.equal(after.reg.status, 'cancelled')
  assert.ok(after.refunds[0].runner_notified_at)

  const again = script(['--order', e.orderId, '--amount', '60', '--note', NOTE, '--apply'])
  assert.notEqual(again.status, 0, 'nothing is left on the line')
  assert.match(again.stdout + again.stderr, /nothing left|0,00 zł/i)
  assert.equal((await rows('refunds', { order_id: e.orderId })).length, 1)
})

test('O-46 record-external-refund.js refuses an amount above what dpay shows refunded, finds the order by e-mail and event, and runs without dpay settings', async () => {
  const event = await paidEvent()
  const e = await panelRefunded(event, 1000)
  const over = script(['--order', e.orderId, '--amount', '20', '--note', NOTE, '--apply'])
  assert.equal(over.status, 1, over.stdout + over.stderr)
  assert.match(over.stderr, /dpay shows 10,00 zł refunded/)
  assert.deepEqual(await rows('refunds', { order_id: e.orderId }), [])

  const o = await one('orders', { id: e.orderId })
  const rs = await one('registration_settings', { event_id: event.eventId })
  const byEmail = script(['--email', o.buyer_email.toUpperCase(), '--event', rs.slug, '--amount', '10', '--note', NOTE])
  assert.equal(byEmail.status, 0, byEmail.stderr + byEmail.stdout)
  assert.ok(byEmail.stdout.includes(e.orderId), byEmail.stdout)

  const noDpay = script(['--order', e.orderId, '--amount', '10', '--note', NOTE, '--notify', '--apply'], { dpay: false })
  assert.equal(noDpay.status, 0, noDpay.stderr + noDpay.stdout)
  assert.match(noDpay.stdout, /dpay not configured/)
  const [f] = await rows('refunds', { order_id: e.orderId })
  assert.equal(f.amount, 1000)
  assert.equal(f.runner_notified_at, null, '--notify: the job sends the refund e-mail')
  assert.equal((await reg(e.registrationId)).status, 'confirmed')
})
