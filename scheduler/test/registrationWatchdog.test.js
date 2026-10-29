// The registration jobs watchdog (plan 3 task 11, ruling P3-R11 I6): reads the heartbeats the
// jobs stamp in Supabase and alerts when one is older than 3 × its interval. P-55 in
// docs/registration/scenario-matrix.md. No network: Supabase and the mailer are fakes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dueAlerts, runRegistrationWatchdog, staleJobs } from '../src/registrationWatchdog.js'

const NOW = Date.parse('2026-10-29T12:00:00Z')
const MIN = 60_000
const at = (msAgo) => new Date(NOW - msAgo).toISOString()
const row = (job, intervalSeconds, lastOkAgoMs, alertedAgoMs = null) => ({
  job, interval_seconds: intervalSeconds, last_ok_at: at(lastOkAgoMs),
  alerted_at: alertedAgoMs === null ? null : at(alertedAgoMs),
})

test('P-55 staleJobs: older than 3 × interval is stale, exactly 3 × is not', () => {
  const rows = [
    row('registration-expire-orders', 300, 15 * MIN),
    row('registration-release-orphan-orders', 300, 15 * MIN + 1),
    row('registration-jobs', 900, 44 * MIN),
    row('registration-purge-expired', 86400, 73 * 60 * MIN),
  ]
  assert.deepEqual(staleJobs(rows, NOW).map((r) => r.job), ['registration-release-orphan-orders', 'registration-purge-expired'])
})

test('P-55 dueAlerts: once per outage, again after 24 h, and again for a new outage after a recovery', () => {
  const never = row('a', 300, 60 * MIN)
  const justTold = row('b', 300, 60 * MIN, 10 * MIN)
  const toldYesterday = row('c', 300, 48 * 60 * MIN, 24 * 60 * MIN)
  const toldBeforeRecovery = row('d', 300, 60 * MIN, 120 * MIN) // last_ok_at is after alerted_at
  assert.deepEqual(dueAlerts([never, justTold, toldYesterday, toldBeforeRecovery], NOW).map((r) => r.job), ['a', 'c', 'd'])
})

function fakeSupabase(rows, { readError = null } = {}) {
  const updates = []
  return {
    updates,
    from(table) {
      assert.equal(table, 'registration_job_heartbeats')
      return {
        select: async () => (readError ? { data: null, error: readError } : { data: rows, error: null }),
        update(values) {
          return { in: async (col, ids) => { updates.push({ values, col, ids }); return { error: null } } }
        },
      }
    },
  }
}

test('P-55 runRegistrationWatchdog: one [ALERT] e-mail naming every stale job, then alerted_at stamped', async () => {
  const supabase = fakeSupabase([
    row('registration-expire-orders', 300, 40 * MIN),
    row('registration-jobs', 900, 50 * MIN),
    row('registration-purge-expired', 86400, 60 * MIN),
  ])
  const sent = []
  const r = await runRegistrationWatchdog({ supabase, send: async (m) => { sent.push(m) }, now: NOW })
  assert.equal(r.alerted, true)
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0].jobs.map((j) => j.job), ['registration-expire-orders', 'registration-jobs'])
  assert.equal(supabase.updates.length, 1)
  assert.deepEqual(supabase.updates[0].ids, ['registration-expire-orders', 'registration-jobs'])
  assert.equal(supabase.updates[0].col, 'job')
  assert.equal(supabase.updates[0].values.alerted_at, new Date(NOW).toISOString())
})

test('P-55 runRegistrationWatchdog: fresh heartbeats, or stale ones already told, send nothing', async () => {
  const sent = []
  const send = async (m) => { sent.push(m) }
  const fresh = fakeSupabase([row('registration-jobs', 900, 5 * MIN)])
  assert.equal((await runRegistrationWatchdog({ supabase: fresh, send, now: NOW })).alerted, false)
  const told = fakeSupabase([row('registration-jobs', 900, 60 * MIN, 10 * MIN)])
  assert.equal((await runRegistrationWatchdog({ supabase: told, send, now: NOW })).alerted, false)
  assert.equal(sent.length, 0)
  assert.equal(told.updates.length, 0)
})

test('P-55 runRegistrationWatchdog: no rows, or a failed read, is itself an alert (the jobs cannot be shown alive)', async () => {
  const sent = []
  const send = async (m) => { sent.push(m) }
  const empty = await runRegistrationWatchdog({ supabase: fakeSupabase([]), send, now: NOW, state: {} })
  assert.equal(empty.alerted, true)
  assert.match(sent[0].reason, /no heartbeat rows/)
  const failed = await runRegistrationWatchdog({ supabase: fakeSupabase([], { readError: { message: 'boom' } }), send, now: NOW + 1, state: {} })
  assert.equal(failed.alerted, true)
  assert.match(sent[1].reason, /boom/)
})

test('P-55 runRegistrationWatchdog: a failed read alerts once a day, not every 15 minutes', async () => {
  const sent = []
  const send = async (m) => { sent.push(m) }
  const state = {}
  const broken = fakeSupabase([], { readError: { message: 'down' } })
  await runRegistrationWatchdog({ supabase: broken, send, now: NOW, state })
  await runRegistrationWatchdog({ supabase: broken, send, now: NOW + 15 * MIN, state })
  await runRegistrationWatchdog({ supabase: broken, send, now: NOW + 24 * 60 * MIN, state })
  assert.equal(sent.length, 2)
})

test('P-55 runRegistrationWatchdog: without Supabase configured it skips and sends nothing', async () => {
  const sent = []
  const r = await runRegistrationWatchdog({ supabase: null, send: async (m) => { sent.push(m) }, now: NOW })
  assert.deepEqual(r, { skipped: true })
  assert.equal(sent.length, 0)
})
