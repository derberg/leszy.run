-- Race registration, plan 4 task 4b: the consent e-mails that never went out.
--
-- issue_consent_request claims a request before its e-mail is sent (at most once), so two
-- gaps lose the link for good unless something looks again:
--   (a) the function dies after register_free / confirm_order committed and before it issued
--       the request: a confirmed adult awaiting consent with no consent_requests row;
--   (b) the request was issued but the e-mail was not accepted by the sender.
-- The registration-jobs step consent_reminders closes both (a ruling of 2026-10-29):
--
--   consent_requests.emailed_at          stamped after any e-mail for this request was accepted
--                                        by the sender (first, re-send, manual or automatic
--                                        reminder); NULL means no e-mail for this request was ever
--                                        accepted. Non-NULL does not promise a working link: a
--                                        reminder that rotated the token and then failed leaves
--                                        the delivered link dead (at most once, alerted)
--   consent_requests.resend_claimed_at   the one re-send of a first e-mail, claimed at most once
--   consent_issue_failures               (a) rows the job tried and failed to issue, counted per
--                                        registration: the 3rd failure is alerted once, and a row
--                                        failing that often is swept after the others
--   consent_requests_missing(limit)      (a): ids to hand to issueConsentRequests (idempotent),
--                                        oldest first, rows with 3+ failures last
--   consent_issue_failed(registration)   (a): counts one failure → the count
--   claim_consent_resends(limit)         (b): claims requests never e-mailed, issued over
--                                        10 minutes ago (so a first send still in flight is
--                                        left alone); the job rotates the token and re-sends
--   release_throttle_slot(key)           gives back one claim_throttle_slot slot: remind-consent
--                                        calls it when the link went meanwhile (409); a refused
--                                        e-mail (502) keeps its slot
--
-- All are read, claimed and written by the service role only.

ALTER TABLE public.consent_requests
  ADD COLUMN emailed_at        timestamptz,
  ADD COLUMN resend_claimed_at timestamptz;

-- Ids and counts only, no personal data.
CREATE TABLE public.consent_issue_failures (
  registration_id uuid PRIMARY KEY REFERENCES public.registrations(id) ON DELETE CASCADE,
  failures        integer NOT NULL CHECK (failures > 0),
  last_failed_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.consent_issue_failures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.consent_issue_failures FROM anon, authenticated;

CREATE FUNCTION public.consent_issue_failed(p_registration_id uuid) RETURNS integer
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = ''
AS $$
  INSERT INTO public.consent_issue_failures AS f (registration_id, failures)
  VALUES (p_registration_id, 1)
  ON CONFLICT (registration_id) DO UPDATE SET failures = f.failures + 1, last_failed_at = now()
  RETURNING failures
$$;
REVOKE EXECUTE ON FUNCTION public.consent_issue_failed(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consent_issue_failed(uuid) TO service_role;

-- (a) Read-only: issue_consent_request is the claim (ON CONFLICT DO NOTHING), so two runs
-- handing the same id to issueConsentRequests send one e-mail. Only events whose race day
-- has not passed: a request issued later would already be expired. Oldest first, except that a
-- row which failed 3 times or more (alerted) goes after every other row, so it cannot hold the
-- limit against newer ones.
CREATE FUNCTION public.consent_requests_missing(p_limit integer DEFAULT 50) RETURNS SETOF uuid
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = ''
AS $$
  SELECT r.id
    FROM public.registrations r
    JOIN public.registration_settings rs ON rs.event_id = r.event_id
    LEFT JOIN public.consent_issue_failures f ON f.registration_id = r.id
   WHERE r.status = 'confirmed'
     AND r.consent_state = 'awaiting'
     AND r.email IS NOT NULL
     AND (rs.event_date IS NULL OR rs.event_date >= (now() AT TIME ZONE 'Europe/Warsaw')::date)
     AND NOT EXISTS (SELECT 1 FROM public.consent_requests c WHERE c.registration_id = r.id)
   ORDER BY coalesce(f.failures, 0) >= 3, r.created_at, r.id
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

-- One slot back, for a counter claim_throttle_slot keeps (otp_throttle). Never below zero; a window
-- that restarted meanwhile loses nothing it should keep.
CREATE FUNCTION public.release_throttle_slot(p_key text) RETURNS void
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = ''
AS $$
  UPDATE public.otp_throttle SET attempts = attempts - 1 WHERE key = p_key AND attempts > 0
$$;
REVOKE EXECUTE ON FUNCTION public.release_throttle_slot(text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_throttle_slot(text) TO service_role;
