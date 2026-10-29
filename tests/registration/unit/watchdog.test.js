// P3-R18: the registration jobs watchdog runs in Supabase (edge function registration-watchdog,
// called hourly by pg_cron). Pure parts: the stale rule, the e-mails, the secret compare, and the
// run itself over a fake client (claim → mail → revert on a failed mail; the self heartbeat only
// when pg_cron called). P-60 in docs/registration/scenario-matrix.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  STALE_FACTOR, WATCHDOG_JOB, runWatchdog, staleJobs, watchdogAlertEmail, watchdogRecoveryEmail,
} from '../../../supabase/functions/_shared/registration/watchdog.js'
import { sameSecret } from '../../../supabase/functions/_shared/sameSecret.js'

const NOW = Date.parse('2026-10-29T12:00:00Z')
const MIN = 60_000
const iso = (ms) => new Date(ms).toISOString()
const row = (job, intervalSeconds, ageMs, alertedAt = null) =>
  ({ job, interval_seconds: intervalSeconds, last_ok_at: iso(NOW - ageMs), alerted_at: alertedAt })

test('P-60 staleJobs: older than 3 × interval is stale, exactly 3 × is not', () => {
  assert.equal(STALE_FACTOR, 3)
  const rows = [
    row('registration-expire-orders', 300, 15 * MIN),
    row('registration-jobs', 900, 45 * MIN + 1),
    row(WATCHDOG_JOB, 3600, 2 * 60 * MIN),
  ]
  const stale = staleJobs(rows, NOW)
  assert.deepEqual(stale.map((j) => j.job), ['registration-jobs'])
  assert.deepEqual(stale[0], {
    job: 'registration-jobs', intervalSeconds: 900, lastOkAt: rows[1].last_ok_at, ageMinutes: 45,
  })
})

test('P-60 the alert names every stale job and the checks; the recovery mail names the jobs back', () => {
  const jobs = [{ job: 'registration-jobs', intervalSeconds: 900, lastOkAt: iso(NOW - 50 * MIN), ageMinutes: 50 }]
  const a = watchdogAlertEmail({ jobs, now: NOW })
  assert.equal(a.subject, '[ALERT] LeszyRun registration jobs stopped')
  for (const part of [a.text, a.html]) {
    assert.match(part, /registration-jobs/)
    assert.match(part, /50 min/)
    assert.match(part, /cron\.job/)
  }
  const self = watchdogAlertEmail({ jobs: [{ job: WATCHDOG_JOB, intervalSeconds: 3600, lastOkAt: iso(NOW - 4 * 60 * MIN), ageMinutes: 240 }], now: NOW })
  assert.match(self.text, /pg_cron/)
  const r = watchdogRecoveryEmail({ jobs: [{ job: 'registration-jobs', lastOkAt: iso(NOW - MIN) }], now: NOW })
  assert.equal(r.subject, '[OK] LeszyRun registration jobs running again')
  assert.match(r.text, /registration-jobs/)
  assert.doesNotMatch(a.html, /<script/i)
})

test('P-60 sameSecret: equal only for the same value; an empty or missing configured secret never matches', async () => {
  assert.equal(await sameSecret('abc', 'abc'), true)
  assert.equal(await sameSecret('abd', 'abc'), false)
  assert.equal(await sameSecret('', 'abc'), false)
  assert.equal(await sameSecret(undefined, 'abc'), false)
  assert.equal(await sameSecret('', ''), false)
  assert.equal(await sameSecret('x', undefined), false)
})

// A fake service-role client: the claim RPC hands out transitions, the heartbeat RPC records
// stamps, the table read returns rows, updates are recorded.
function fakeAdmin({ claims = [], rows = [], claimError = null, readError = null } = {}) {
  const calls = { rpc: [], updates: [] }
  return {
    calls,
    rpc: async (fn, args) => {
      calls.rpc.push([fn, args])
      if (fn === 'registration_watchdog_claim') return claimError ? { data: null, error: claimError } : { data: claims, error: null }
      return { data: null, error: null }
    },
    from: (table) => ({
      select: async () => (readError ? { data: null, error: readError } : { data: rows, error: null }),
      update: (values) => ({
        eq: async (col, val) => { calls.updates.push({ table, values, [col]: val }); return { error: null } },
      }),
    }),
  }
}

const claim = (job, transition, previous = null, interval = 900, age = 60 * MIN) =>
  ({ job, interval_seconds: interval, last_ok_at: iso(NOW - age), previous_alerted_at: previous, transition })

test('P-60 runWatchdog: one alert mail for the new stale jobs, one recovery mail, 200 { ok, stale }', async () => {
  const sent = []
  const admin = fakeAdmin({
    claims: [claim('registration-jobs', 'stale'), claim('registration-expire-orders', 'recovered', iso(NOW - 3 * 60 * MIN), 300, MIN)],
    rows: [row('registration-jobs', 900, 60 * MIN, iso(NOW)), row('registration-expire-orders', 300, MIN), row(WATCHDOG_JOB, 3600, 0)],
  })
  const r = await runWatchdog(admin, { alertTo: 'op@x.test', caller: 'pg_cron', now: NOW, send: async (m) => { sent.push(m); return { ok: true } } })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.deepEqual(r.body.stale.map((j) => j.job), ['registration-jobs'])
  assert.deepEqual(r.body.alerted, ['registration-jobs'])
  assert.deepEqual(r.body.recovered, ['registration-expire-orders'])
  assert.equal(r.body.watchdog.last_run_at, iso(NOW))
  assert.deepEqual(sent.map((m) => [m.to, m.subject]), [
    ['op@x.test', '[ALERT] LeszyRun registration jobs stopped'],
    ['op@x.test', '[OK] LeszyRun registration jobs running again'],
  ])
  assert.deepEqual(admin.calls.updates, [], 'nothing reverted')
})

test('P-60 runWatchdog: pg_cron stamps its own heartbeat before the check; any other caller does not', async () => {
  const send = async () => ({ ok: true })
  const cron = fakeAdmin({ rows: [row(WATCHDOG_JOB, 3600, 0)] })
  await runWatchdog(cron, { alertTo: 'op@x.test', caller: 'pg_cron', now: NOW, send })
  assert.deepEqual(cron.calls.rpc.map(([fn]) => fn), ['registration_job_heartbeat', 'registration_watchdog_claim'])
  assert.deepEqual(cron.calls.rpc[0][1], { p_job: WATCHDOG_JOB })
  for (const caller of ['github', undefined, 'anything']) {
    const other = fakeAdmin({ rows: [row(WATCHDOG_JOB, 3600, 0)] })
    await runWatchdog(other, { alertTo: 'op@x.test', caller, now: NOW, send })
    assert.deepEqual(other.calls.rpc.map(([fn]) => fn), ['registration_watchdog_claim'], String(caller))
  }
})

test('P-60 runWatchdog: a mail that did not go out reverts its claim and answers 502, so the next run retries', async () => {
  const prev = iso(NOW - 5 * 60 * MIN)
  const admin = fakeAdmin({ claims: [claim('registration-jobs', 'stale', null), claim('registration-purge-expired', 'recovered', prev, 86400, MIN)], rows: [row(WATCHDOG_JOB, 3600, 0)] })
  const r = await runWatchdog(admin, { alertTo: 'op@x.test', caller: 'github', now: NOW, send: async () => ({ ok: false, status: 500 }) })
  assert.equal(r.status, 502)
  assert.equal(r.body.ok, false)
  assert.deepEqual(admin.calls.updates, [
    { table: 'registration_job_heartbeats', values: { alerted_at: null }, job: 'registration-jobs' },
    { table: 'registration_job_heartbeats', values: { alerted_at: prev }, job: 'registration-purge-expired' },
  ])
  const thrown = fakeAdmin({ claims: [claim('registration-jobs', 'stale')], rows: [row(WATCHDOG_JOB, 3600, 0)] })
  const t = await runWatchdog(thrown, { alertTo: 'op@x.test', now: NOW, send: async () => { throw new Error('network') } })
  assert.equal(t.status, 502)
  assert.equal(thrown.calls.updates.length, 1)
})

test('P-60 runWatchdog: a failed claim or read is 500 and sends nothing', async () => {
  const send = async () => { throw new Error('must not send') }
  const a = await runWatchdog(fakeAdmin({ claimError: { message: 'boom' } }), { alertTo: 'op@x.test', now: NOW, send })
  assert.equal(a.status, 500)
  const b = await runWatchdog(fakeAdmin({ readError: { message: 'boom' } }), { alertTo: 'op@x.test', now: NOW, send })
  assert.equal(b.status, 500)
  const c = await runWatchdog(fakeAdmin({ rows: [] }), { alertTo: 'op@x.test', now: NOW, send })
  assert.equal(c.status, 500, 'no heartbeat rows at all')
})
