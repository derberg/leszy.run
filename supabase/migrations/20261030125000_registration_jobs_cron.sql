-- Race registration, plan 3 task 7: the payment window jobs.
--
-- pg_cron (UTC):
--   registration-expire-orders          */5   expire_orders(): unpaid orders past their window
--   registration-release-orphan-orders  */5   release_orphan_orders(): pending orders that never got a
--                                              dpay transaction (P3-R7, a killed create-order isolate)
--   registration-jobs                   */15  pg_net POST to the registration-jobs edge function, URL and
--                                              x-jobs-secret from Vault (registration_jobs_url,
--                                              registration_jobs_secret); the operator sets both once in
--                                              production, supabase/seed.sql sets them locally
--   registration-purge-expired          45 1 purge_expired_registrations() (D3-8)
-- cron.schedule replaces a job of the same name, so re-running this file leaves one of each.
--
-- The edge function claims every item before acting on it, through the claim_* functions below:
-- one UPDATE … WHERE <stamp> IS NULL … RETURNING over rows locked FOR UPDATE SKIP LOCKED, so two
-- concurrent runs never take the same row. Claim-then-send is at-most-once by design.
--
-- P3-R10: refunds.requested_at is stamped right before every dpay refund call (the claim, one
-- UPDATE … WHERE requested_at IS NULL), so an automatic refund reaches dpay at most once; a row
-- still unstamped 10 minutes after it was recorded was never sent (a crash between confirm_order's
-- commit and the call) and is alerted. orders.confirmation_sent_at is stamped when the
-- confirmation e-mail goes out; a paid order still unstamped 10 minutes after payment gets it from
-- the job.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ---------------------------------------------------------------- columns

ALTER TABLE public.orders  ADD COLUMN confirmation_sent_at timestamptz;
ALTER TABLE public.refunds ADD COLUMN requested_at timestamptz;

-- Rows from before these columns existed were already handled synchronously: never resend or
-- alert on them.
UPDATE public.orders  SET confirmation_sent_at = paid_at WHERE status = 'paid' AND confirmation_sent_at IS NULL;
UPDATE public.refunds SET requested_at = created_at WHERE requested_at IS NULL;

CREATE INDEX orders_reminder_due_idx ON public.orders (created_at)
  WHERE status = 'pending' AND reminder_sent_at IS NULL;
CREATE INDEX orders_unconfirmed_mail_idx ON public.orders (paid_at)
  WHERE status = 'paid' AND confirmation_sent_at IS NULL;
CREATE INDEX refunds_unrequested_idx ON public.refunds (created_at)
  WHERE requested_at IS NULL;

-- ---------------------------------------------------------------- orphan release (P3-R7)

-- A pending order with no payment attempt 15 minutes after creation: create-order died between
-- create_order and handing out a dpay redirect (its own `finally` cancels every other such exit).
-- Released exactly as cancel_order releases, reason 'no_payment_attempt'. Orders another
-- transaction holds (add_payment_attempt locks the order) are skipped and seen by the next run.
-- One order at a time, each in its own subtransaction: an order that cannot be released (a
-- broken slot count) raises one deduplicated operator alert and stays pending, and never blocks
-- the others. Orders go in competition order, so the competition locks this transaction gathers
-- are taken in category_id order (D3-1), as registration_release_slots takes them.
CREATE FUNCTION public.release_orphan_orders(p_now timestamptz DEFAULT now()) RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  r     record;
  v_n   integer := 0;
BEGIN
  FOR r IN
    SELECT o.id FROM public.orders o
     WHERE o.status = 'pending' AND o.created_at <= p_now - interval '15 minutes'
       AND NOT EXISTS (SELECT 1 FROM public.payment_attempts a WHERE a.order_id = o.id)
     ORDER BY (SELECT min(g.category_id::text) FROM public.registrations g WHERE g.order_id = o.id), o.id
       FOR UPDATE OF o SKIP LOCKED
  LOOP
    BEGIN
      UPDATE public.orders o SET status = 'cancelled', cancelled_reason = 'no_payment_attempt'
       WHERE o.id = r.id AND o.status = 'pending'
         AND NOT EXISTS (SELECT 1 FROM public.payment_attempts a WHERE a.order_id = o.id);
      IF FOUND THEN
        PERFORM public.registration_release_slots(ARRAY[r.id], 'pending_payment');
        UPDATE public.registrations SET status = 'cancelled'
         WHERE order_id = r.id AND status = 'pending_payment';
        v_n := v_n + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO public.operator_alerts (kind, order_id, payload, dedupe_key)
      VALUES ('orphan_release_failed', r.id, jsonb_build_object('error', SQLERRM, 'sqlstate', SQLSTATE),
              'orphan_release_failed:' || r.id)
      ON CONFLICT (dedupe_key) DO NOTHING;
    END;
  END LOOP;
  RETURN v_n;
END $$;
REVOKE EXECUTE ON FUNCTION public.release_orphan_orders(timestamptz) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_orphan_orders(timestamptz) TO service_role;

-- ---------------------------------------------------------------- claims

-- Reminder: a pending order whose window is at least 6 hours and has passed its half.
CREATE FUNCTION public.claim_payment_reminders(p_limit integer DEFAULT 100) RETURNS SETOF uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT o.id FROM public.orders o
     WHERE o.status = 'pending' AND o.reminder_sent_at IS NULL
       AND o.expires_at > now()
       AND o.expires_at - o.created_at >= interval '6 hours'
       AND now() >= o.created_at + (o.expires_at - o.created_at) / 2
     ORDER BY o.created_at
     LIMIT greatest(p_limit, 0)
       FOR UPDATE SKIP LOCKED
  )
  UPDATE public.orders o SET reminder_sent_at = now()
    FROM due WHERE o.id = due.id AND o.reminder_sent_at IS NULL
  RETURNING o.id;
END $$;

-- „Zgłoszenie wygasło”: an expired order not told yet. Never for an order whose late payment was
-- refunded (that runner got „Płatność zwrócona”), and not for p_skip: orders whose dpay check
-- failed in this run (a payment may have landed), retried by the next run.
CREATE FUNCTION public.claim_expired_notices(p_skip uuid[] DEFAULT '{}', p_limit integer DEFAULT 100)
  RETURNS SETOF uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT o.id FROM public.orders o
     WHERE o.status = 'expired' AND o.expired_notified_at IS NULL
       AND o.id <> ALL (coalesce(p_skip, '{}'))
       AND NOT EXISTS (SELECT 1 FROM public.refunds f WHERE f.order_id = o.id)
     ORDER BY o.expires_at
     LIMIT greatest(p_limit, 0)
       FOR UPDATE SKIP LOCKED
  )
  UPDATE public.orders o SET expired_notified_at = now()
    FROM due WHERE o.id = due.id AND o.expired_notified_at IS NULL AND o.status = 'expired'
  RETURNING o.id;
END $$;

-- P3-R10: a paid order whose confirmation e-mail was never stamped 10 minutes after payment.
CREATE FUNCTION public.claim_confirmation_resends(p_limit integer DEFAULT 50) RETURNS SETOF uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT o.id FROM public.orders o
     WHERE o.status = 'paid' AND o.confirmation_sent_at IS NULL
       AND o.paid_at <= now() - interval '10 minutes'
     ORDER BY o.paid_at
     LIMIT greatest(p_limit, 0)
       FOR UPDATE SKIP LOCKED
  )
  UPDATE public.orders o SET confirmation_sent_at = now()
    FROM due WHERE o.id = due.id AND o.confirmation_sent_at IS NULL
  RETURNING o.id;
END $$;

-- The operator digest: alerts not e-mailed yet.
CREATE FUNCTION public.claim_operator_alerts(p_limit integer DEFAULT 200) RETURNS SETOF public.operator_alerts
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT a.id FROM public.operator_alerts a
     WHERE a.emailed_at IS NULL
     ORDER BY a.created_at
     LIMIT greatest(p_limit, 0)
       FOR UPDATE SKIP LOCKED
  )
  UPDATE public.operator_alerts a SET emailed_at = now()
    FROM due WHERE a.id = due.id AND a.emailed_at IS NULL
  RETURNING a.*;
END $$;

-- Ruling 8: only a 406 (insufficient_balance) is retried, at most 24 times, an hour apart
-- (settle_refund sets next_retry_at). The claim clears next_retry_at, counts the attempt (this is
-- the only place refunds.attempts grows, P3-R6) and stamps requested_at for the call it is about to
-- make, in one statement: one dpay call per due retry however many runs overlap.
CREATE FUNCTION public.claim_refund_retries(p_limit integer DEFAULT 20)
  RETURNS TABLE (refund_id uuid, order_id uuid, attempt_id uuid, txn text, amount integer,
                 attempt_grosze integer, reason text, message_id text, attempts integer)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT f.id FROM public.refunds f
     WHERE f.dpay_status = 'insufficient_balance' AND f.next_retry_at <= now() AND f.attempts < 24
     ORDER BY f.next_retry_at
     LIMIT greatest(p_limit, 0)
       FOR UPDATE SKIP LOCKED
  ), up AS (
    UPDATE public.refunds f
       SET next_retry_at = NULL, attempts = f.attempts + 1, requested_at = now()
      FROM due
     WHERE f.id = due.id AND f.dpay_status = 'insufficient_balance' AND f.next_retry_at <= now()
    RETURNING f.*
  )
  SELECT up.id, up.order_id, up.payment_attempt_id, a.dpay_transaction_id, up.amount,
         a.grosze, up.reason, up.message_id, up.attempts
    FROM up JOIN public.payment_attempts a ON a.id = up.payment_attempt_id;
END $$;

REVOKE EXECUTE ON FUNCTION public.claim_payment_reminders(integer)            FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_expired_notices(uuid[], integer)      FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_confirmation_resends(integer)         FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_operator_alerts(integer)              FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_refund_retries(integer)               FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.claim_payment_reminders(integer)            TO service_role;
GRANT  EXECUTE ON FUNCTION public.claim_expired_notices(uuid[], integer)      TO service_role;
GRANT  EXECUTE ON FUNCTION public.claim_confirmation_resends(integer)         TO service_role;
GRANT  EXECUTE ON FUNCTION public.claim_operator_alerts(integer)              TO service_role;
GRANT  EXECUTE ON FUNCTION public.claim_refund_retries(integer)               TO service_role;

-- ---------------------------------------------------------------- purge (D3-8)

-- The runner data information promises that an unpaid registration's data goes 30 days after the
-- order expired (spec 5.5, 9). Anonymised as delete-my-account anonymises a registration: the
-- person's fields go, status/price/competition stay, and the consent acceptances lose their device
-- traces while the acceptance itself stays as the record. Orders, attempts, payment_events and
-- refunds are accounting records and are not touched. Only rows still holding something are
-- changed, so a second run returns 0. → rows changed (registrations + acceptances).
CREATE FUNCTION public.purge_expired_registrations() RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_regs integer;
  v_acc  integer;
  v_gone constant text := 'Usunięte zgłoszenie';
BEGIN
  UPDATE public.registrations r
     SET first_name = v_gone, last_name = v_gone,
         email = NULL, phone = NULL, birth_date = NULL, city = NULL, club = NULL,
         ice_name = NULL, ice_phone = NULL, nationality = NULL,
         guardian_profile_id = NULL, guardian_name = NULL, guardian_email = NULL
    FROM public.orders o
   WHERE o.id = r.order_id
     AND r.status = 'expired' AND o.status = 'expired'
     AND o.expires_at <= now() - interval '30 days'
     AND (r.first_name, r.last_name, r.email, r.phone, r.birth_date, r.city, r.club, r.ice_name,
          r.ice_phone, r.nationality, r.guardian_profile_id, r.guardian_name, r.guardian_email)
         IS DISTINCT FROM
         (v_gone, v_gone, NULL::text, NULL::text, NULL::date, NULL::text, NULL::text, NULL::text,
          NULL::text, NULL::text, NULL::uuid, NULL::text, NULL::text);
  GET DIAGNOSTICS v_regs = ROW_COUNT;

  UPDATE public.consent_acceptances ca
     SET ip = NULL, user_agent = NULL
    FROM public.registrations r
    JOIN public.orders o ON o.id = r.order_id
   WHERE ca.registration_id = r.id
     AND r.status = 'expired' AND o.status = 'expired'
     AND o.expires_at <= now() - interval '30 days'
     AND (ca.ip IS NOT NULL OR ca.user_agent IS NOT NULL);
  GET DIAGNOSTICS v_acc = ROW_COUNT;

  RETURN v_regs + v_acc;
END $$;
REVOKE EXECUTE ON FUNCTION public.purge_expired_registrations() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_expired_registrations() TO service_role;

-- ---------------------------------------------------------------- schedules

SELECT cron.schedule('registration-expire-orders', '*/5 * * * *', $$SELECT public.expire_orders()$$);
SELECT cron.schedule('registration-release-orphan-orders', '*/5 * * * *', $$SELECT public.release_orphan_orders()$$);
-- 01:45 UTC = 02:45 Warsaw in winter, 03:45 in summer.
SELECT cron.schedule('registration-purge-expired', '45 1 * * *', $$SELECT public.purge_expired_registrations()$$);
-- A missing Vault secret makes the call fail (url NULL); cron.job_run_details records it.
SELECT cron.schedule('registration-jobs', '*/15 * * * *', $$SELECT net.http_post(
  url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'registration_jobs_url'),
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-jobs-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'registration_jobs_secret')),
  body := '{}'::jsonb,
  timeout_milliseconds := 120000
)$$);
