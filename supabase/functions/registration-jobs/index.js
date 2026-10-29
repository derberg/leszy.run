import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { guardRequest } from '../_shared/cors.js'
import { sameSecret } from '../_shared/sameSecret.js'
import { json, NOT_FOUND } from '../_shared/registration/registrationRequest.js'
import { jobsSettings, runJobsAndBeat } from '../_shared/registration/jobsRun.js'

// pg_cron POSTs here every 15 minutes through pg_net (job `registration-jobs`) with the header
// x-jobs-secret = REGISTRATION_JOBS_SECRET; anything else gets 404, as if the function did not
// exist (also when the secret is not configured). What a run does: _shared/registration/jobsRun.js.

Deno.serve(async (req) => {
  const guard = guardRequest(req)
  if (guard) return guard

  const secret = Deno.env.get('REGISTRATION_JOBS_SECRET')
  if (!secret) console.error('registration-jobs: REGISTRATION_JOBS_SECRET is not set')
  if (!secret || req.method !== 'POST' || !(await sameSecret(req.headers.get('x-jobs-secret') ?? '', secret))) {
    return json(NOT_FOUND, 404, req)
  }

  const settings = jobsSettings(Deno.env)
  if (settings.error) {
    console.error('registration-jobs:', settings.error)
    return json({ error: 'Service unavailable' }, 503, req)
  }
  // No dpay settings (paid registration not switched on yet, P3-R16): the dpay steps are skipped
  // and reported, the rest runs and the heartbeat is stamped, so the watchdog stays quiet.
  if (settings.dpayMissing) console.log('registration-jobs: dpay not configured, dpay steps skipped')

  let body = {}
  try { body = await req.json() } catch { /* cron sends {}; anything else means the defaults */ }

  const admin = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } })
  try {
    const data = await runJobsAndBeat(admin, settings, { budgetMs: body?.budgetMs })
    return json({ data }, 200, req)
  } catch (err) {
    console.error('registration-jobs error:', err?.message)
    return json({ error: 'Internal server error' }, 500, req)
  }
})
