// The registration jobs watchdog (P3-R18; replaces the scheduler-container check of P3-R11 I6),
// run by the registration-watchdog edge function. Pure apart from the client and the mailer it is
// handed, so node:test runs it with fakes.
//
// Every registration job stamps registration_job_heartbeats.last_ok_at when a run finishes. A job
// is stale when its stamp is older than STALE_FACTOR × interval_seconds. The watchdog's own row
// (WATCHDOG_JOB, hourly) is stamped only when pg_cron called it (body { caller: 'pg_cron' }), so
// its age proves pg_cron and pg_net are alive; the daily GitHub Actions backstop
// (.github/workflows/registration-watchdog.yml) calls with another caller and reads it.
//
// One e-mail per stale episode, one „running again” e-mail when it ends. The bookkeeping is
// registration_job_heartbeats.alerted_at, claimed by registration_watchdog_claim() in one
// statement (rows locked SKIP LOCKED), so two overlapping runs never mail the same transition:
//   stale     → last_ok_at older than 3 × interval and alerted_at null or older than last_ok_at
//               (the job ran since the last alert: a new episode); alerted_at := now()
//   recovered → fresh again with alerted_at set; alerted_at := null
// A mail that did not go out puts the claimed alerted_at back and answers 502, so the next run
// tries again (and the GitHub run, if it was the caller, fails).
//
// When the watchdog cannot do its own job (the heartbeats unreadable, no rows, any internal
// error) it still mails the operator before answering 500: a watchdog that only answers 500 to
// pg_cron is heard by nobody until the daily GitHub run. One mail per error kind and UTC hour,
// deduped on operator_alerts.dedupe_key (`watchdog_error:<kind>:<YYYY-MM-DDTHH>`, stored with
// emailed_at set so the operator digest does not mail it again). When that table cannot be
// written either (the database is the problem), it mails anyway: pg_cron calls hourly, so that
// is still about one mail an hour.

export const STALE_FACTOR = 3
export const WATCHDOG_JOB = 'registration-watchdog'
const TABLE = 'registration_job_heartbeats'

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const iso = (ms) => new Date(ms).toISOString()
const ageMinutes = (lastOkAt, now) => Math.floor((now - Date.parse(lastOkAt)) / 60_000)

/** Rows (snake_case, as read) whose heartbeat is older than STALE_FACTOR × their interval. */
export function staleJobs(rows, now = Date.now()) {
  return rows
    .filter((r) => now - Date.parse(r.last_ok_at) > STALE_FACTOR * r.interval_seconds * 1000)
    .map((r) => ({ job: r.job, intervalSeconds: r.interval_seconds, lastOkAt: r.last_ok_at, ageMinutes: ageMinutes(r.last_ok_at, now) }))
}

const CHECKS = [
  "SELECT jobname, schedule, active FROM cron.job WHERE jobname LIKE 'registration-%';",
  'SELECT job, interval_seconds, last_ok_at, alerted_at FROM registration_job_heartbeats ORDER BY job;',
  'SELECT jobid, status, return_message, start_time FROM cron.job_run_details ORDER BY start_time DESC LIMIT 20;',
  'SELECT created, status_code, left(content, 300) FROM net._http_response ORDER BY created DESC LIMIT 10;',
]

function jobLine(j) {
  const every = j.intervalSeconds >= 3600 ? `${Math.round(j.intervalSeconds / 3600)} h` : `${Math.round(j.intervalSeconds / 60)} min`
  const what = j.job === WATCHDOG_JOB ? ' — pg_cron is not calling the watchdog (pg_cron, pg_net or the Vault secrets)' : ''
  return `${j.job}: last run ${j.lastOkAt} (${j.ageMinutes} min ago, runs every ${every})${what}`
}

/** [ALERT] for jobs that went stale: [{ job, intervalSeconds, lastOkAt, ageMinutes }]. */
export function watchdogAlertEmail({ jobs, now = Date.now() }) {
  const lines = jobs.map(jobLine)
  const consequence = 'While they are stopped no reminders, „Zgłoszenie wygasło” notices, refund retries or operator digests go out, and unpaid orders are not expired.'
  const text = [
    `Registration jobs are not running (${jobs.length}):`, '',
    ...lines.map((l) => `- ${l}`), '',
    consequence, '',
    'Check in the Supabase SQL editor (production):', ...CHECKS, '',
    'See docs/supabase-release-runbook.md, „Registration jobs”.',
    `LeszyRun registration watchdog · ${iso(now)}`,
  ].join('\n')
  const html = [
    `<p><strong>Registration jobs are not running (${jobs.length}):</strong></p>`,
    `<ul>${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`,
    `<p>${escapeHtml(consequence)}</p>`,
    '<p>Check in the Supabase SQL editor (production):</p>',
    `<pre>${escapeHtml(CHECKS.join('\n'))}</pre>`,
    '<p>See docs/supabase-release-runbook.md, „Registration jobs”.</p>',
    `<p style="color:#666;font-size:12px">LeszyRun registration watchdog · ${iso(now)}</p>`,
  ].join('')
  return { subject: '[ALERT] LeszyRun registration jobs stopped', text, html }
}

/** [OK] for jobs that ran again after an alert: [{ job, lastOkAt }]. */
export function watchdogRecoveryEmail({ jobs, now = Date.now() }) {
  const lines = jobs.map((j) => `${j.job}: last run ${j.lastOkAt}`)
  const text = [
    `Registration jobs are running again (${jobs.length}):`, '',
    ...lines.map((l) => `- ${l}`), '',
    `LeszyRun registration watchdog · ${iso(now)}`,
  ].join('\n')
  const html = [
    `<p><strong>Registration jobs are running again (${jobs.length}):</strong></p>`,
    `<ul>${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`,
    `<p style="color:#666;font-size:12px">LeszyRun registration watchdog · ${iso(now)}</p>`,
  ].join('')
  return { subject: '[OK] LeszyRun registration jobs running again', text, html }
}

const ERROR_CHECKS = [
  'SELECT job, interval_seconds, last_ok_at, alerted_at FROM registration_job_heartbeats ORDER BY job;',
  "SELECT jobname, schedule, active FROM cron.job WHERE jobname LIKE 'registration-%';",
]

/** [ALERT] the watchdog itself failed: kind (heartbeats_unreadable / no_heartbeats / internal_error) and the error text. */
export function watchdogErrorEmail({ kind, message, now = Date.now() }) {
  const what = `The registration watchdog could not check the registration jobs: ${kind}${message ? ` (${message})` : ''}.`
  const consequence = 'Until it can, nobody is told when a registration job stops. It answers 500, and it mails again at most once an hour for the same error.'
  const text = [
    what, '', consequence, '',
    'Check in the Supabase SQL editor (production):', ...ERROR_CHECKS, '',
    'and the registration-watchdog function logs. See docs/supabase-release-runbook.md, „Registration jobs”.',
    `LeszyRun registration watchdog · ${iso(now)}`,
  ].join('\n')
  const html = [
    `<p><strong>${escapeHtml(what)}</strong></p>`,
    `<p>${escapeHtml(consequence)}</p>`,
    '<p>Check in the Supabase SQL editor (production):</p>',
    `<pre>${escapeHtml(ERROR_CHECKS.join('\n'))}</pre>`,
    '<p>and the registration-watchdog function logs. See docs/supabase-release-runbook.md, „Registration jobs”.</p>',
    `<p style="color:#666;font-size:12px">LeszyRun registration watchdog · ${iso(now)}</p>`,
  ].join('')
  return { subject: '[ALERT] LeszyRun registration watchdog failing', text, html }
}

/**
 * Mails the operator that the watchdog failed, at most once per kind and UTC hour.
 * → { mailed, deduped }. Never throws.
 */
export async function reportWatchdogError(admin, { alertTo, send, kind, message = null, now = Date.now() }) {
  const dedupeKey = `watchdog_error:${kind}:${iso(now).slice(0, 13)}`
  let claimed = false
  try {
    const { data, error } = await admin.from('operator_alerts').upsert(
      { kind: 'watchdog_error', payload: { kind, message }, dedupe_key: dedupeKey, emailed_at: iso(now) },
      { onConflict: 'dedupe_key', ignoreDuplicates: true },
    ).select('id')
    if (error) {
      console.error('registration-watchdog: error dedupe not stored, mailing anyway:', error.message)
    } else if (!data?.length) {
      return { mailed: false, deduped: true }
    } else {
      claimed = true
    }
  } catch (err) {
    console.error('registration-watchdog: error dedupe failed, mailing anyway:', err?.message)
  }

  const ok = await mailed(send, { to: alertTo, ...watchdogErrorEmail({ kind, message, now }) })
  if (!ok && claimed) {
    try {
      const { error } = await admin.from('operator_alerts').delete().eq('dedupe_key', dedupeKey)
      if (error) console.error('registration-watchdog: error dedupe not released:', error.message)
    } catch (err) {
      console.error('registration-watchdog: error dedupe not released:', err?.message)
    }
  }
  return { mailed: ok, deduped: false }
}

async function mailed(send, message) {
  try {
    const res = await send(message)
    return !(res && res.ok === false)
  } catch (err) {
    console.error('registration-watchdog: mail failed:', err?.message)
    return false
  }
}

/**
 * One watchdog run. admin: a service-role client; alertTo: PIPELINE_ALERT_EMAIL; send: the
 * mailer ({ to, subject, text, html } → { ok }); caller: 'pg_cron' stamps the watchdog's own
 * heartbeat first, anything else only checks.
 * → { status, body }: 200 { ok: true, stale, alerted, recovered, watchdog: { last_run_at } },
 *   502 the same with ok: false and error 'alert_not_sent', 500 { ok: false, error, mailed } when
 *   the heartbeats could not be read (after reportWatchdogError).
 */
export async function runWatchdog(admin, { alertTo, send, caller, now = Date.now() }) {
  if (caller === 'pg_cron') {
    const { error } = await admin.rpc('registration_job_heartbeat', { p_job: WATCHDOG_JOB })
    if (error) console.error('registration-watchdog: own heartbeat not stamped:', error.message)
  }

  const { data: claims, error: claimErr } = await admin.rpc('registration_watchdog_claim')
  const failure = async (error, message) => {
    const { mailed: sent } = await reportWatchdogError(admin, { alertTo, send, kind: error, message, now })
    return { status: 500, body: { ok: false, error, mailed: sent } }
  }
  if (claimErr) {
    console.error('registration-watchdog: claim failed:', claimErr.message)
    return failure('heartbeats_unreadable', claimErr.message)
  }
  const { data: rows, error: readErr } = await admin.from(TABLE).select('job, interval_seconds, last_ok_at, alerted_at')
  if (readErr || !rows?.length) {
    console.error('registration-watchdog: heartbeats unreadable:', readErr?.message ?? 'no rows')
    // Put back what was claimed: nothing was mailed.
    for (const c of claims ?? []) await admin.from(TABLE).update({ alerted_at: c.previous_alerted_at }).eq('job', c.job)
    return readErr ? failure('heartbeats_unreadable', readErr.message) : failure('no_heartbeats', null)
  }

  const stale = staleJobs(rows, now)
  const self = rows.find((r) => r.job === WATCHDOG_JOB)
  const wentStale = (claims ?? []).filter((c) => c.transition === 'stale')
  const recovered = (claims ?? []).filter((c) => c.transition === 'recovered')
  const failed = []

  if (wentStale.length) {
    const jobs = wentStale.map((c) => ({
      job: c.job, intervalSeconds: c.interval_seconds, lastOkAt: c.last_ok_at, ageMinutes: ageMinutes(c.last_ok_at, now),
    }))
    if (!(await mailed(send, { to: alertTo, ...watchdogAlertEmail({ jobs, now }) }))) failed.push(...wentStale)
  }
  if (recovered.length) {
    const jobs = recovered.map((c) => ({ job: c.job, lastOkAt: c.last_ok_at }))
    if (!(await mailed(send, { to: alertTo, ...watchdogRecoveryEmail({ jobs, now }) }))) failed.push(...recovered)
  }
  for (const c of failed) {
    const { error } = await admin.from(TABLE).update({ alerted_at: c.previous_alerted_at }).eq('job', c.job)
    if (error) console.error(`registration-watchdog: claim of ${c.job} not reverted:`, error.message)
  }

  const sentJobs = (list) => list.filter((c) => !failed.includes(c)).map((c) => c.job)
  const body = {
    ok: failed.length === 0,
    stale,
    alerted: sentJobs(wentStale),
    recovered: sentJobs(recovered),
    watchdog: { last_run_at: self?.last_ok_at ?? null },
  }
  if (failed.length) {
    body.error = 'alert_not_sent'
    console.error(`registration-watchdog: mail not sent for ${failed.map((c) => c.job).join(', ')}`)
  }
  if (stale.length) console.log(`registration-watchdog: stale: ${stale.map((j) => `${j.job} (${j.ageMinutes} min)`).join(', ')}`)
  return { status: failed.length ? 502 : 200, body }
}
