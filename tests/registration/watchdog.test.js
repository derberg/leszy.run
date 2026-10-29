// P3-R18 (user request 2026-10-29): the registration jobs watchdog lives in Supabase. pg_cron job
// `registration-watchdog` (hourly) → pg_net → edge function registration-watchdog, which reads
// registration_job_heartbeats and e-mails PIPELINE_ALERT_EMAIL once per stale episode and once
// when the job is fresh again. Its own heartbeat is stamped only when pg_cron calls it; the daily
// GitHub Actions backstop reads that stamp. P-60 in docs/registration/scenario-matrix.md.
// LOCAL stack only. Every test leaves every heartbeat fresh and unalerted.
import { test, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import postgres from 'postgres'
import { admin, localEnv } from './helpers/stack.js'
import { messagesTo, startCapture } from './helpers/emailCapture.js'

const OPERATOR = 'operator@leszy.test' // PIPELINE_ALERT_EMAIL in functions.env
const ALERT = '[ALERT] LeszyRun registration jobs stopped'
const RECOVERED = '[OK] LeszyRun registration jobs running again'
const HOUR = 3_600_000
const SECRET = readFileSync(new URL('./functions.env', import.meta.url), 'utf8')
  .match(/^REGISTRATION_WATCHDOG_SECRET=(.*)$/m)?.[1]?.trim()

const db = () => admin()
const ago = (ms) => new Date(Date.now() - ms).toISOString()

async function watchdog({ secret = SECRET, method = 'POST', caller } = {}) {
  const res = await fetch(`${localEnv().functionsUrl}/registration-watchdog`, {
    method,
    headers: { 'content-type': 'application/json', ...(secret === null ? {} : { 'x-watchdog-secret': secret }) },
    body: method === 'POST' ? JSON.stringify(caller ? { caller } : {}) : undefined,
  })
  const text = await res.text()
  let body
  try { body = JSON.parse(text) } catch { body = { raw: text } }
  return { status: res.status, body }
}

async function heartbeat(job) {
  const { data, error } = await db().from('registration_job_heartbeats').select('*').eq('job', job).single()
  if (error) throw error
  return data
}

async function setBeat(job, values) {
  const { error } = await db().from('registration_job_heartbeats').update(values).eq('job', job)
  if (error) throw error
}

async function resetAll() {
  const { error } = await db().from('registration_job_heartbeats')
    .update({ last_ok_at: new Date().toISOString(), alerted_at: null }).neq('job', '')
  if (error) throw error
}

const watchdogMails = async () => (await messagesTo(OPERATOR)).filter((m) => m.subject === ALERT || m.subject === RECOVERED)

let stopCapture
before(async () => {
  assert.ok(SECRET, 'REGISTRATION_WATCHDOG_SECRET in functions.env')
  stopCapture = await startCapture()
  await resetAll()
})
afterEach(resetAll)
after(async () => { if (stopCapture) await stopCapture() })

test('P-60 a wrong, missing or empty secret and a GET get 404; the right one 200 { ok, stale }', async () => {
  for (const r of [await watchdog({ secret: 'wrong' }), await watchdog({ secret: null }), await watchdog({ secret: '' }),
    await watchdog({ method: 'GET' })]) {
    assert.equal(r.status, 404, JSON.stringify(r.body))
  }
  const ok = await watchdog()
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  assert.equal(ok.body.ok, true)
  assert.deepEqual(ok.body.stale, [])
})

test('P-60 the watchdog has its own heartbeat row (hourly); pg_cron stamps it, any other caller only reads it', async () => {
  const self = await heartbeat('registration-watchdog')
  assert.equal(self.interval_seconds, 3600)

  await setBeat('registration-watchdog', { last_ok_at: ago(2 * HOUR) })
  const gh = await watchdog({ caller: 'github' })
  assert.equal(gh.status, 200, JSON.stringify(gh.body))
  assert.ok(Date.now() - Date.parse(gh.body.watchdog.last_run_at) > 1.9 * HOUR, 'a GitHub call does not stamp')
  assert.ok(Date.now() - Date.parse((await heartbeat('registration-watchdog')).last_ok_at) > 1.9 * HOUR)

  const refused = await watchdog({ secret: 'wrong', caller: 'pg_cron' })
  assert.equal(refused.status, 404)
  assert.ok(Date.now() - Date.parse((await heartbeat('registration-watchdog')).last_ok_at) > 1.9 * HOUR, 'a refused call does not stamp')

  const cron = await watchdog({ caller: 'pg_cron' })
  assert.equal(cron.status, 200, JSON.stringify(cron.body))
  assert.ok(Date.now() - Date.parse(cron.body.watchdog.last_run_at) < 60_000, 'pg_cron stamps')
})

test('P-60 one alert per stale episode, one recovery mail, and a new episode alerts again', async () => {
  const before = (await watchdogMails()).length
  const mailsSince = async () => (await watchdogMails()).slice(before)

  await setBeat('registration-jobs', { last_ok_at: ago(46 * 60_000) }) // 3 × 15 min + 1 min
  const first = await watchdog()
  assert.equal(first.status, 200, JSON.stringify(first.body))
  assert.deepEqual(first.body.stale.map((j) => j.job), ['registration-jobs'])
  assert.deepEqual(first.body.alerted, ['registration-jobs'])
  let mails = await mailsSince()
  assert.deepEqual(mails.map((m) => m.subject), [ALERT])
  assert.match(mails[0].text, /registration-jobs/)
  assert.ok((await heartbeat('registration-jobs')).alerted_at)

  const second = await watchdog()
  assert.deepEqual(second.body.stale.map((j) => j.job), ['registration-jobs'], 'still stale')
  assert.deepEqual(second.body.alerted, [])
  assert.equal((await mailsSince()).length, 1, 'no second alert in the same episode')

  await setBeat('registration-jobs', { last_ok_at: new Date().toISOString() })
  const back = await watchdog()
  assert.deepEqual(back.body.recovered, ['registration-jobs'])
  mails = await mailsSince()
  assert.deepEqual(mails.map((m) => m.subject), [ALERT, RECOVERED])
  assert.match(mails[1].text, /registration-jobs/)
  assert.equal((await heartbeat('registration-jobs')).alerted_at, null)
  await watchdog()
  assert.equal((await mailsSince()).length, 2, 'one recovery mail only')

  // The job ran after the alert but died again before the watchdog saw it fresh: a new episode.
  await setBeat('registration-expire-orders', { last_ok_at: ago(20 * 60_000), alerted_at: ago(30 * 60_000) })
  const again = await watchdog()
  assert.deepEqual(again.body.alerted, ['registration-expire-orders'])
  assert.equal((await mailsSince()).length, 3)
})

test('P-60 two runs at once mail a stale job once', async () => {
  const before = (await watchdogMails()).length
  await setBeat('registration-release-orphan-orders', { last_ok_at: ago(HOUR) })
  const runs = await Promise.all([watchdog(), watchdog(), watchdog()])
  for (const r of runs) assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.deepEqual(runs.flatMap((r) => r.body.alerted), ['registration-release-orphan-orders'])
  assert.equal((await watchdogMails()).length - before, 1)
})

test('P-60 cron.job holds registration-watchdog: hourly, pg_net with the Vault secrets and caller pg_cron, inactive on a local stack', async (t) => {
  const sql = postgres(localEnv().dbUrl, { max: 1, onnotice: () => {} })
  try {
    const [has] = await sql`select to_regclass('cron.job') as t`
    if (!has.t) return t.skip('no cron.job on this stack')
    const [job] = await sql`select schedule, command, active from cron.job where jobname = 'registration-watchdog'`
    assert.ok(job, 'job defined')
    assert.match(job.schedule, /^\d{1,2} \* \* \* \*$/)
    assert.equal(job.active, false, 'seed.sql deactivates it locally')
    assert.match(job.command, /net\.http_post/)
    assert.match(job.command, /'registration_watchdog_url'/)
    assert.match(job.command, /'registration_watchdog_secret'/)
    assert.match(job.command, /x-watchdog-secret/)
    assert.match(job.command, /"caller"\s*:\s*"pg_cron"/)
    const vault = await sql`select name from vault.decrypted_secrets where name in ('registration_watchdog_url', 'registration_watchdog_secret') order by name`
    assert.deepEqual(vault.map((v) => v.name), ['registration_watchdog_secret', 'registration_watchdog_url'])
  } finally {
    await sql.end({ timeout: 1 })
  }
})

test('P-60 anon and authenticated cannot execute registration_watchdog_claim', async () => {
  const { url, anonKey, jwtSecret } = localEnv()
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const head = b64({ alg: 'HS256', typ: 'JWT' })
  const claims = b64({ role: 'authenticated', sub: crypto.randomUUID(), aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 600 })
  const sig = crypto.createHmac('sha256', jwtSecret).update(`${head}.${claims}`).digest('base64url')
  const opts = { auth: { autoRefreshToken: false, persistSession: false } }
  for (const client of [createClient(url, anonKey, opts),
    createClient(url, anonKey, { ...opts, global: { headers: { Authorization: `Bearer ${head}.${claims}.${sig}` } } })]) {
    const { error } = await client.rpc('registration_watchdog_claim')
    assert.match(error?.message ?? '', /permission denied/)
  }
})

const FAILING = '[ALERT] LeszyRun registration watchdog failing'

test('P-60 the heartbeats unreadable: 500, and the operator is mailed once for that error within the hour', async () => {
  const sql = postgres(localEnv().dbUrl, { max: 1, onnotice: () => {} })
  const key = `watchdog_error:heartbeats_unreadable:${new Date().toISOString().slice(0, 13)}`
  const before = (await messagesTo(OPERATOR)).filter((m) => m.subject === FAILING).length
  try {
    await sql`delete from public.operator_alerts where dedupe_key = ${key}`
    await sql`alter table public.registration_job_heartbeats rename to registration_job_heartbeats_away`
    const first = await watchdog()
    assert.equal(first.status, 500, JSON.stringify(first.body))
    assert.equal(first.body.error, 'heartbeats_unreadable')
    assert.equal(first.body.mailed, true)
    const second = await watchdog({ caller: 'pg_cron' })
    assert.equal(second.status, 500)
    assert.equal(second.body.mailed, false, 'the same error within the hour is not mailed again')
    let mails = []
    for (let i = 0; i < 20; i++) {
      mails = (await messagesTo(OPERATOR)).filter((m) => m.subject === FAILING)
      if (mails.length > before) break
      await new Promise((r) => setTimeout(r, 250))
    }
    assert.equal(mails.length - before, 1)
    assert.match(mails.at(-1).text, /heartbeats_unreadable/)
    const [row] = await sql`select kind, emailed_at from public.operator_alerts where dedupe_key = ${key}`
    assert.equal(row.kind, 'watchdog_error')
    assert.ok(row.emailed_at, 'stored as already e-mailed: the digest skips it')
  } finally {
    await sql`alter table if exists public.registration_job_heartbeats_away rename to registration_job_heartbeats`
    await sql`delete from public.operator_alerts where dedupe_key = ${key}`
    await sql.end()
  }
})
