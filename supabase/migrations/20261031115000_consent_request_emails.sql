-- Race registration, plan 4 task 4b: the consent e-mails that never went out.
--
-- issue_consent_request claims a request before its e-mail is sent (at most once), so two
-- gaps lose the link for good unless something looks again:
--   (a) the function dies after register_free / confirm_order committed and before it issued
--       the request: a confirmed adult awaiting consent with no consent_requests row;
--   (b) the request was issued but the e-mail was not accepted by the sender.
-- The registration-jobs step consent_reminders closes both (a ruling of 2026-10-29):
--
--   consent_requests.emailed_at          stamped after any e-mail carrying a working link was
--                                        accepted (first, re-send, manual or automatic
--                                        reminder); NULL means nobody has the link yet
--   consent_requests.resend_claimed_at   the one re-send of a first e-mail, claimed at most once
--   consent_requests_missing(limit)      (a): ids to hand to issueConsentRequests (idempotent)
--   claim_consent_resends(limit)         (b): claims requests never e-mailed, issued over
--                                        10 minutes ago (so a first send still in flight is
--                                        left alone); the job rotates the token and re-sends
--
-- Both are read and claimed by the service role only.

ALTER TABLE public.consent_requests
  ADD COLUMN emailed_at        timestamptz,
  ADD COLUMN resend_claimed_at timestamptz;

-- (a) Read-only: issue_consent_request is the claim (ON CONFLICT DO NOTHING), so two runs
-- handing the same id to issueConsentRequests send one e-mail. Only events whose race day
-- has not passed: a request issued later would already be expired.
CREATE FUNCTION public.consent_requests_missing(p_limit integer DEFAULT 50) RETURNS SETOF uuid
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = ''
AS $$
  SELECT r.id
    FROM public.registrations r
    JOIN public.registration_settings rs ON rs.event_id = r.event_id
   WHERE r.status = 'confirmed'
     AND r.consent_state = 'awaiting'
     AND r.email IS NOT NULL
     AND (rs.event_date IS NULL OR rs.event_date >= (now() AT TIME ZONE 'Europe/Warsaw')::date)
     AND NOT EXISTS (SELECT 1 FROM public.consent_requests c WHERE c.registration_id = r.id)
   ORDER BY r.created_at, r.id
   LIMIT greatest(coalesce(p_limit, 50), 0)
$$;
REVOKE EXECUTE ON FUNCTION public.consent_requests_missing(integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consent_requests_missing(integer) TO service_role;

-- (b) One statement claims; SKIP LOCKED splits the rows between parallel runs. A claimed
-- re-send that fails is not retried: the automatic reminder or a manual one is the next try.
CREATE FUNCTION public.claim_consent_resends(p_limit integer DEFAULT 50) RETURNS SETOF uuid
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = ''
AS $$
  UPDATE public.consent_requests cr
     SET resend_claimed_at = now()
   WHERE cr.id IN (
           SELECT c.id
             FROM public.consent_requests c
             JOIN public.registrations r ON r.id = c.registration_id
            WHERE c.emailed_at IS NULL
              AND c.resend_claimed_at IS NULL
              AND c.used_at IS NULL
              AND c.expires_at > now()
              AND c.sent_at <= now() - interval '10 minutes'
              AND coalesce(c.last_reminded_at, c.sent_at) <= now() - interval '10 minutes'
              AND r.status = 'confirmed'
              AND r.consent_state = 'awaiting'
            ORDER BY c.sent_at, c.id
            LIMIT greatest(coalesce(p_limit, 50), 0)
              FOR UPDATE OF c SKIP LOCKED)
     AND cr.resend_claimed_at IS NULL
  RETURNING cr.registration_id
$$;
REVOKE EXECUTE ON FUNCTION public.claim_consent_resends(integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_consent_resends(integer) TO service_role;
