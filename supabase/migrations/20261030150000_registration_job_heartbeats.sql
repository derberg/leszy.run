-- Race registration, plan 3 task 11 (ruling P3-R11, review I6): heartbeats for the payment jobs.
--
-- Nothing told anyone when the registration jobs stopped: a pg job cannot alert about pg_cron
-- being dead, and net.http_post records success whatever the function answered. So every job
-- stamps registration_job_heartbeats.last_ok_at when a run finishes, and the scheduler container
-- (scheduler/src/registrationWatchdog.js, every 15 minutes) reads the table through the service
-- role and e-mails `[ALERT]` when a heartbeat is older than 3 × interval_seconds.
--
--   registration-expire-orders, registration-release-orphan-orders, registration-purge-expired:
--     the cron command is the job's statement followed by registration_job_heartbeat(<name>).
--     pg_cron runs a multi-statement command as one transaction, so a failing job stamps nothing.
--   registration-jobs: the edge function stamps it at the end of a run (a run whose steps
--     failed still stamps: each failed step raises its own operator alert). A refused call
--     (wrong secret, unconfigured function) never reaches the stamp.
--
-- alerted_at is the watchdog's own bookkeeping: one e-mail per outage, repeated daily while it
-- lasts. Service role only, like every registration table.

CREATE TABLE public.registration_job_heartbeats (
  job              text PRIMARY KEY,
  interval_seconds integer NOT NULL CHECK (interval_seconds > 0),
  last_ok_at       timestamptz NOT NULL DEFAULT now(),
  alerted_at       timestamptz
);
ALTER TABLE public.registration_job_heartbeats ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.registration_job_heartbeats FROM anon, authenticated;

-- last_ok_at starts at the deploy, so the watchdog gives a fresh deploy the first three intervals.
INSERT INTO public.registration_job_heartbeats (job, interval_seconds) VALUES
  ('registration-expire-orders',         300),
  ('registration-release-orphan-orders', 300),
  ('registration-jobs',                  900),
  ('registration-purge-expired',         86400);

CREATE FUNCTION public.registration_job_heartbeat(p_job text) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
BEGIN
  UPDATE public.registration_job_heartbeats SET last_ok_at = now() WHERE job = p_job;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown_job' USING ERRCODE = '22023';
  END IF;
END $$;
REVOKE EXECUTE ON FUNCTION public.registration_job_heartbeat(text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.registration_job_heartbeat(text) TO service_role;

-- Same names and schedules as 20261030125000 (cron.schedule by name replaces the job).
SELECT cron.schedule('registration-expire-orders', '*/5 * * * *',
  $$SELECT public.expire_orders(); SELECT public.registration_job_heartbeat('registration-expire-orders')$$);
SELECT cron.schedule('registration-release-orphan-orders', '2-59/5 * * * *',
  $$SELECT public.release_orphan_orders(); SELECT public.registration_job_heartbeat('registration-release-orphan-orders')$$);
SELECT cron.schedule('registration-purge-expired', '45 1 * * *',
  $$SELECT public.purge_expired_registrations(); SELECT public.registration_job_heartbeat('registration-purge-expired')$$);
