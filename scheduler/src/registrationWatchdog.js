import { createClient } from '@supabase/supabase-js';
import { sendRegistrationJobsAlert } from './mailer.js';

// The registration jobs watchdog (plan 3 task 11, ruling P3-R11 I6).
//
// The payment jobs run in Supabase: pg_cron expires unpaid orders and releases orphans every
// 5 minutes, purges expired registrations daily, and calls the registration-jobs edge function
// every 15 minutes (reminders, „Zgłoszenie wygasło”, refund retries, the operator digest). Each
// finished run stamps registration_job_heartbeats.last_ok_at. A job inside the database cannot
// report that pg_cron itself stopped, so the check lives here, out of band, and e-mails `[ALERT]`
// through the same SendGrid path as the pipeline watchdog.
//
// Stale: last_ok_at older than STALE_FACTOR × interval_seconds. One e-mail per outage (alerted_at,
// written back to the table), repeated every REPEAT_MS while it lasts. No rows, or a failed read,
// is an alert too: the jobs cannot be shown to be alive. Those are throttled in memory, since
// there is no row to stamp.

export const STALE_FACTOR = 3;
export const REPEAT_MS = 24 * 3_600_000;

const ms = (iso) => (iso ? Date.parse(iso) : null);

/** Rows whose heartbeat is older than STALE_FACTOR × their interval. */
export function staleJobs(rows, now = Date.now()) {
  return rows.filter((r) => now - ms(r.last_ok_at) > STALE_FACTOR * r.interval_seconds * 1000);
}

/** The stale rows not told yet in this outage, or told more than REPEAT_MS ago. */
export function dueAlerts(stale, now = Date.now()) {
  return stale.filter((r) => {
    const told = ms(r.alerted_at);
    return told === null || told < ms(r.last_ok_at) || now - told >= REPEAT_MS;
  });
}

const processState = {};

export async function runRegistrationWatchdog({
  supabase = defaultClient(), send = sendRegistrationJobsAlert, now = Date.now(), state = processState,
} = {}) {
  if (!supabase) {
    process.stdout.write('[registration-watchdog] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set, skipping\n');
    return { skipped: true };
  }

  const unreadable = async (reason) => {
    process.stdout.write(`[registration-watchdog] ${reason}\n`);
    if (state.lastReadAlertAt && now - state.lastReadAlertAt < REPEAT_MS) return { alerted: false, reason };
    await send({ reason, jobs: [] });
    state.lastReadAlertAt = now;
    return { alerted: true, reason };
  };

  const { data: rows, error } = await supabase.from('registration_job_heartbeats')
    .select('job, interval_seconds, last_ok_at, alerted_at');
  if (error) return unreadable(`cannot read registration_job_heartbeats: ${error.message}`);
  if (!rows?.length) return unreadable('no heartbeat rows in registration_job_heartbeats');
  state.lastReadAlertAt = null;

  const due = dueAlerts(staleJobs(rows, now), now);
  if (!due.length) {
    process.stdout.write('[registration-watchdog] every registration job is alive or already reported\n');
    return { alerted: false };
  }

  const jobs = due.map((r) => ({
    job: r.job,
    intervalSeconds: r.interval_seconds,
    lastOkAt: r.last_ok_at,
    ageMinutes: Math.round((now - ms(r.last_ok_at)) / 60_000),
  }));
  process.stdout.write(`[registration-watchdog] stale: ${jobs.map((j) => `${j.job} (${j.ageMinutes} min)`).join(', ')}\n`);
  await send({ reason: `${jobs.length} registration job(s) stopped`, jobs });
  const { error: upErr } = await supabase.from('registration_job_heartbeats')
    .update({ alerted_at: new Date(now).toISOString() })
    .in('job', jobs.map((j) => j.job));
  if (upErr) process.stdout.write(`[registration-watchdog] alerted_at not stamped: ${upErr.message}\n`);
  return { alerted: true, jobs: jobs.map((j) => j.job) };
}

function defaultClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}
