// P3-R18: the registration jobs watchdog runs in Supabase (edge function registration-watchdog,
// called hourly by pg_cron). Pure parts: the stale rule, the e-mails, the secret compare, and the
// run itself over a fake client (claim → mail → revert on a failed mail; the self heartbeat only
// when pg_cron called). P-60 in docs/registration/scenario-matrix.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  STALE_FACTOR, WATCHDOG_JOB, reportWatchdogError, runWatchdog, staleJobs, watchdogAlertEmail, watchdogRecoveryEmail,
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
// operator_alerts holds the error-mail dedupe keys (`dedupeKeys`, shared between runs to model
// one database); `alertsError` makes that table fail too.
function fakeAdmin({ claims = [], rows = [], claimError = null, readError = null, dedupeKeys = new Set(), alertsError = null } = {}) {
  const calls = { rpc: [], updates: [], alerts: [], deletes: [] }
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
      upsert: (row, opts) => ({
        select: async () => {
          calls.alerts.push({ table, row, opts })
          if (alertsError) return { data: null, error: alertsError }
          if (dedupeKeys.has(row.dedupe_key)) return { data: [], error: null }
          dedupeKeys.add(row.dedupe_key)
          return { data: [{ id: 'a1' }], error: null }
        },
      }),
      delete: () => ({
        eq: async (col, val) => { calls.deletes.push({ table, [col]: val }); dedupeKeys.delete(val); return { error: null } },
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

const ERROR_SUBJECT = '[ALERT] LeszyRun registration watchdog failing'

test('P-60 runWatchdog: a failed claim or read is 500 and still mails the operator, once per error kind and hour', async () => {
  const sent = []
  const send = async (m) => { sent.push(m); return { ok: true } }
  const keys = new Set()
  const a = await runWatchdog(fakeAdmin({ claimError: { message: 'boom' }, dedupeKeys: keys }), { alertTo: 'op@x.test', now: NOW, send })
  assert.equal(a.status, 500)
  assert.equal(a.body.error, 'heartbeats_unreadable')
  assert.equal(a.body.mailed, true)
  assert.deepEqual(sent.map((m) => [m.to, m.subject]), [['op@x.test', ERROR_SUBJECT]])
  assert.match(sent[0].text, /heartbeats_unreadable/)
  assert.match(sent[0].text, /boom/)
  assert.match(sent[0].text, /registration_job_heartbeats/)
  assert.doesNotMatch(sent[0].html, /<script/i)

  // The same kind within the hour (a read failure is the same kind as a claim failure): no mail.
  const b = await runWatchdog(fakeAdmin({ readError: { message: 'boom' }, dedupeKeys: keys }), { alertTo: 'op@x.test', now: NOW + 20 * MIN, send })
  assert.equal(b.status, 500)
  assert.equal(b.body.mailed, false)
  assert.equal(sent.length, 1)
  // Another kind in the same hour mails; the first kind mails again in the next hour.
  const c = await runWatchdog(fakeAdmin({ rows: [], dedupeKeys: keys }), { alertTo: 'op@x.test', now: NOW + 20 * MIN, send })
  assert.equal(c.status, 500, 'no heartbeat rows at all')
  assert.equal(c.body.error, 'no_heartbeats')
  assert.equal(sent.length, 2)
  const d = await runWatchdog(fakeAdmin({ claimError: { message: 'boom' }, dedupeKeys: keys }), { alertTo: 'op@x.test', now: NOW + 61 * MIN, send })
  assert.equal(d.status, 500)
  assert.equal(sent.length, 3)
})

test('P-60 reportWatchdogError: the dedupe key is the kind and the UTC hour, stored already e-mailed so the digest skips it', async () => {
  const admin = fakeAdmin()
  const r = await reportWatchdogError(admin, { alertTo: 'op@x.test', kind: 'internal_error', message: 'x', now: NOW, send: async () => ({ ok: true }) })
  assert.equal(r.mailed, true)
  const [{ table, row, opts }] = admin.calls.alerts
  assert.equal(table, 'operator_alerts')
  assert.equal(row.kind, 'watchdog_error')
  assert.equal(row.dedupe_key, 'watchdog_error:internal_error:2026-10-29T12')
  assert.equal(row.order_id, undefined)
  assert.ok(row.emailed_at, 'the operator digest must not mail it a second time')
  assert.deepEqual(row.payload, { kind: 'internal_error', message: 'x' })
  assert.deepEqual(opts, { onConflict: 'dedupe_key', ignoreDuplicates: true })
})

test('P-60 reportWatchdogError: a mail that did not go out drops its dedupe key (the next run retries); a dedupe table that fails still mails', async () => {
  const keys = new Set()
  const failed = fakeAdmin({ dedupeKeys: keys })
  const r = await reportWatchdogError(failed, { alertTo: 'op@x.test', kind: 'internal_error', message: 'x', now: NOW, send: async () => ({ ok: false }) })
  assert.equal(r.mailed, false)
  assert.deepEqual(failed.calls.deletes, [{ table: 'operator_alerts', dedupe_key: 'watchdog_error:internal_error:2026-10-29T12' }])
  assert.equal(keys.size, 0)
  const sent = []
  const thrown = await reportWatchdogError(fakeAdmin({ dedupeKeys: keys }), { alertTo: 'op@x.test', kind: 'internal_error', message: 'x', now: NOW, send: async () => { throw new Error('network') } })
  assert.equal(thrown.mailed, false)
  const down = fakeAdmin({ alertsError: { message: 'relation does not exist' } })
  const d = await reportWatchdogError(down, { alertTo: 'op@x.test', kind: 'heartbeats_unreadable', message: 'x', now: NOW, send: async (m) => { sent.push(m); return { ok: true } } })
  assert.equal(d.mailed, true, 'better a second mail than silence')
  assert.equal(sent.length, 1)
})
