import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { guardRequest } from '../_shared/cors.js'
import { sameSecret } from '../_shared/sameSecret.js'
import { sendEmail } from '../_shared/email.js'
import { json, NOT_FOUND } from '../_shared/registration/registrationRequest.js'
import { reportWatchdogError, runWatchdog } from '../_shared/registration/watchdog.js'

// The registration jobs watchdog (P3-R18). pg_cron POSTs here every hour through pg_net (job
// `registration-watchdog`, body { caller: 'pg_cron' }), and a daily GitHub Actions run
// (.github/workflows/registration-watchdog.yml, body { caller: 'github' }) checks that pg_cron
// still does. Both send x-watchdog-secret = REGISTRATION_WATCHDOG_SECRET; anything else gets 404,
// as if the function did not exist (also when the secret is not configured).
// It needs no dpay settings: it only reads registration_job_heartbeats and e-mails
// PIPELINE_ALERT_EMAIL (SendGrid, through _shared/email.js). What a run does:
// _shared/registration/watchdog.js.
// → 200 { ok: true, stale, alerted, recovered, watchdog: { last_run_at } }; 502 when an alert
//   could not be sent; 500 when the heartbeats could not be read or anything else failed, after
//   mailing the operator (once per error kind and hour, reportWatchdogError); 503 without
//   PIPELINE_ALERT_EMAIL.

Deno.serve(async (req) => {
  const guard = guardRequest(req)
  if (guard) return guard

  const secret = Deno.env.get('REGISTRATION_WATCHDOG_SECRET')
  if (!secret) console.error('registration-watchdog: REGISTRATION_WATCHDOG_SECRET is not set')
  if (!secret || req.method !== 'POST' || !(await sameSecret(req.headers.get('x-watchdog-secret') ?? '', secret))) {
    return json(NOT_FOUND, 404, req)
  }

  const alertTo = Deno.env.get('PIPELINE_ALERT_EMAIL')?.trim()
  if (!alertTo) {
    console.error('registration-watchdog: PIPELINE_ALERT_EMAIL is not set')
    return json({ ok: false, error: 'Service unavailable' }, 503, req)
  }

  let body = {}
  try { body = await req.json() } catch { /* no body: a plain check */ }

  const admin = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } })
  try {
    const { status, body: out } = await runWatchdog(admin, { alertTo, send: sendEmail, caller: body?.caller })
    return json(out, status, req)
  } catch (err) {
    console.error('registration-watchdog error:', err?.message)
    const { mailed } = await reportWatchdogError(admin, { alertTo, send: sendEmail, kind: 'internal_error', message: err?.message ?? null })
    return json({ ok: false, error: 'Internal server error', mailed }, 500, req)
  }
})
