-- Race registration, plan 3 (user request P3-R18, 2026-10-29): the registration jobs watchdog
-- moves off the operator's machine into Supabase. Replaces the scheduler container's check
-- (scheduler/src/registrationWatchdog.js, removed) that 20261030150000 describes.
--
--   pg_cron `registration-watchdog` (hourly, UTC minute 17) → pg_net POST to the
--   registration-watchdog edge function, URL and x-watchdog-secret from Vault
--   (registration_watchdog_url, registration_watchdog_secret; the operator sets both once in
--   production, docs/supabase-release-runbook.md; supabase/seed.sql sets them locally and
--   deactivates every registration-* job on a test stack). The body says caller pg_cron.
--
-- The function reads registration_job_heartbeats and e-mails PIPELINE_ALERT_EMAIL through
-- SendGrid: once when a job goes stale (last_ok_at older than 3 × interval_seconds), once when it
-- runs again. alerted_at is that bookkeeping, claimed by registration_watchdog_claim() below.
--
-- The watchdog has its own heartbeat row, stamped only when pg_cron called it. A dead pg_cron or
-- pg_net cannot report itself, so a daily GitHub Actions run
-- (.github/workflows/registration-watchdog.yml) calls the function too and fails when it does
-- not answer 200 or this row is older than 3 hours.

-- last_ok_at starts at the deploy: the first three hours are given to the operator to set Vault.
INSERT INTO public.registration_job_heartbeats (job, interval_seconds)
VALUES ('registration-watchdog', 3600)
ON CONFLICT (job) DO NOTHING;

-- One statement claims every transition the watchdog must mail, over rows locked SKIP LOCKED,
-- so overlapping runs never mail the same one:
--   stale     last_ok_at older than 3 × interval, and not alerted in this episode (alerted_at
--             null, or older than last_ok_at: the job ran after the last alert) → alerted_at = now
--   recovered fresh again while alerted_at is set → alerted_at = null
-- previous_alerted_at lets the caller put the claim back when its e-mail did not go out.
CREATE FUNCTION public.registration_watchdog_claim()
RETURNS TABLE (job text, interval_seconds integer, last_ok_at timestamptz,
               previous_alerted_at timestamptz, transition text)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT h.job AS d_job, h.alerted_at AS prev,
           CASE WHEN h.last_ok_at < now() - make_interval(secs => 3 * h.interval_seconds)
                THEN 'stale' ELSE 'recovered' END AS t
      FROM public.registration_job_heartbeats h
     WHERE (h.last_ok_at < now() - make_interval(secs => 3 * h.interval_seconds)
            AND (h.alerted_at IS NULL OR h.alerted_at < h.last_ok_at))
        OR (h.last_ok_at >= now() - make_interval(secs => 3 * h.interval_seconds)
            AND h.alerted_at IS NOT NULL)
     ORDER BY h.job
       FOR UPDATE SKIP LOCKED
  )
  UPDATE public.registration_job_heartbeats h
     SET alerted_at = CASE WHEN due.t = 'stale' THEN now() END
    FROM due
   WHERE h.job = due.d_job
  RETURNING h.job, h.interval_seconds, h.last_ok_at, due.prev, due.t;
END $$;
REVOKE EXECUTE ON FUNCTION public.registration_watchdog_claim() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.registration_watchdog_claim() TO service_role;

-- net.http_post only queues the request; the outcome is in net._http_response, and the GitHub
-- backstop notices when the function's own heartbeat stops moving.
SELECT cron.schedule('registration-watchdog', '17 * * * *', $$SELECT net.http_post(
  url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'registration_watchdog_url'),
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-watchdog-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'registration_watchdog_secret')),
  body := '{"caller":"pg_cron"}'::jsonb,
  timeout_milliseconds := 30000
)$$);
