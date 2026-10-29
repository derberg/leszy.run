-- Race registration, plan 3 task 7: the payment window jobs.
--
-- pg_cron (UTC):
--   registration-expire-orders          */5     expire_orders(): unpaid orders past their window
--   registration-release-orphan-orders  2-59/5  release_orphan_orders(): pending orders that never
--                                                got a dpay transaction (P3-R7, a killed create-order
--                                                isolate); offset from the expiry so the two never
--                                                contend for the same competitions
--   registration-jobs                   */15    pg_net POST to the registration-jobs edge function, URL
--                                                and x-jobs-secret from Vault (registration_jobs_url,
--                                                registration_jobs_secret); the operator sets both once
--                                                in production (docs/supabase-release-runbook.md);
--                                                supabase/seed.sql sets them locally and deactivates
--                                                every registration-* job on a test stack
--   registration-purge-expired          45 1    purge_expired_registrations() (D3-8, P3-R12)
-- cron.schedule replaces a job of the same name, so re-running this file leaves one of each.
--
-- The edge function claims every item before acting on it, through the claim_* functions below:
-- one UPDATE … WHERE <stamp> IS NULL … RETURNING over rows locked FOR UPDATE SKIP LOCKED, so two
-- concurrent runs never take the same row. Claim-then-send is at-most-once by design.
--
-- P3-R10: refunds.requested_at is stamped right before every dpay refund call (the claim), and
-- refunds.responded_at whenever settle_refund stores dpay's answer. stalled_refunds() finds an
-- automatic refund that was never sent (requested_at null 10 minutes on) or was sent and never
-- answered (requested_at 15 minutes old, no responded_at since, no retry scheduled): a crash
-- between the claim and the call. Both are alerted, never re-sent (ruling 8).
-- orders.confirmation_sent_at is stamped when the confirmation e-mail goes out; a paid order still
-- unstamped 10 minutes after payment gets it from the job.
-- orders.dpay_checked_at (Task 7 review I2) is stamped only when dpay definitively said that no
-- attempt of the order was paid: „Zgłoszenie wygasło” needs that proof for an order that holds an
-- unpaid dpay transaction.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ---------------------------------------------------------------- columns

ALTER TABLE public.orders
  ADD COLUMN confirmation_sent_at timestamptz,
  ADD COLUMN dpay_checked_at      timestamptz,
  ADD COLUMN cancelled_at         timestamptz;
ALTER TABLE public.refunds
  ADD COLUMN requested_at timestamptz,
  ADD COLUMN responded_at timestamptz;

-- Rows from before these columns existed were handled synchronously: never resend or alert on
-- them. A cancelled order's time is unknown; its creation is the closest lower bound.
UPDATE public.orders  SET confirmation_sent_at = paid_at WHERE status = 'paid' AND confirmation_sent_at IS NULL;
UPDATE public.orders  SET cancelled_at = created_at WHERE status = 'cancelled' AND cancelled_at IS NULL;
UPDATE public.refunds SET requested_at = created_at WHERE requested_at IS NULL;
UPDATE public.refunds SET responded_at = requested_at WHERE responded_at IS NULL;

CREATE INDEX orders_reminder_due_idx ON public.orders (created_at)
  WHERE status = 'pending' AND reminder_sent_at IS NULL;
CREATE INDEX orders_unconfirmed_mail_idx ON public.orders (paid_at)
  WHERE status = 'paid' AND confirmation_sent_at IS NULL;
CREATE INDEX orders_cancelled_at_idx ON public.orders (cancelled_at)
  WHERE status = 'cancelled';
CREATE INDEX refunds_unanswered_idx ON public.refunds (created_at)
  WHERE kind = 'automatic' AND dpay_status NOT IN ('accepted', 'rejected') AND next_retry_at IS NULL;

-- ---------------------------------------------------------------- shared

-- Internal: whether a failure is one the next run simply retries (deadlock, lock or statement
-- timeout, serialization), which is not worth a permanent alert (review M2).
CREATE FUNCTION public.registration_transient_error(p_sqlstate text) RETURNS boolean
  LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$ SELECT p_sqlstate IN ('40P01', '40001', '55P03', '57014') $$;
REVOKE EXECUTE ON FUNCTION public.registration_transient_error(text) FROM public, anon, authenticated;

-- ---------------------------------------------------------------- cancel_order (from 20261030110000)

-- Unchanged apart from stamping cancelled_at, which the 30-day purge counts from (P3-R12).
CREATE OR REPLACE FUNCTION public.cancel_order(p_order_id uuid, p_reason text) RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
BEGIN
  UPDATE public.orders SET status = 'cancelled', cancelled_reason = left(p_reason, 500), cancelled_at = now()
   WHERE id = p_order_id AND status = 'pending';
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  PERFORM public.registration_release_slots(ARRAY[p_order_id], 'pending_payment');
  UPDATE public.registrations SET status = 'cancelled'
   WHERE order_id = p_order_id AND status = 'pending_payment';
  RETURN true;
END $$;

-- ---------------------------------------------------------------- expire_orders (from 20261030110000)

-- Review C1: one order whose release fails (a slot count that would go below 0) used to roll back
-- the whole batch, run after run, so nothing expired anywhere and nobody was told. The set-based
-- path of 20261030110000 is kept unchanged as the fast path, inside a subtransaction. When it
-- fails, the due orders are expired one at a time, each in its own subtransaction; an order that
-- still fails stays pending and raises one `expire_failed` alert per order and sqlstate (a
-- transient failure raises none: the next run retries it).
--
-- Lock order (D3-1): per order, orders → competitions → registrations, as before. Across orders
-- the fallback walks orders by their lowest category_id, so while every order holds a single
-- competition (all of plan 3: create_order takes one category) the competition locks it gathers
-- are taken in ascending category_id, the order create_order, confirm_order and
-- publish_registration_changes use. A multi-competition order (plan 4) breaks that argument:
-- the fallback must then go per competition, ascending.
CREATE OR REPLACE FUNCTION public.expire_orders(p_now timestamptz DEFAULT now()) RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_ids uuid[];
  v_n   integer := 0;
  r     record;
BEGIN
  BEGIN
    WITH due AS (
      SELECT o.id FROM public.orders o
       WHERE o.status = 'pending' AND o.expires_at <= p_now
       ORDER BY o.id
         FOR UPDATE SKIP LOCKED
    ), flipped AS (
      UPDATE public.orders o SET status = 'expired'
        FROM due WHERE o.id = due.id AND o.status = 'pending'
      RETURNING o.id
    )
    SELECT coalesce(array_agg(id ORDER BY id), '{}') INTO v_ids FROM flipped;

    IF cardinality(v_ids) = 0 THEN
      RETURN 0;
    END IF;
    PERFORM public.registration_release_slots(v_ids, 'pending_payment');
    UPDATE public.registrations SET status = 'expired'
     WHERE order_id = ANY (v_ids) AND status = 'pending_payment';
    RETURN cardinality(v_ids);
  EXCEPTION WHEN OTHERS THEN
    NULL; -- rolled back as a unit: go one order at a time
  END;

  FOR r IN
    SELECT o.id FROM public.orders o
     WHERE o.status = 'pending' AND o.expires_at <= p_now
     ORDER BY (SELECT min(g.category_id::text) FROM public.registrations g WHERE g.order_id = o.id), o.id
       FOR UPDATE OF o SKIP LOCKED
  LOOP
    BEGIN
      UPDATE public.orders SET status = 'expired' WHERE id = r.id AND status = 'pending';
      IF FOUND THEN
        PERFORM public.registration_release_slots(ARRAY[r.id], 'pending_payment');
        UPDATE public.registrations SET status = 'expired'
         WHERE order_id = r.id AND status = 'pending_payment';
        v_n := v_n + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      IF NOT public.registration_transient_error(SQLSTATE) THEN
        INSERT INTO public.operator_alerts (kind, order_id, payload, dedupe_key)
        VALUES ('expire_failed', r.id, jsonb_build_object('error', SQLERRM, 'sqlstate', SQLSTATE),
                'expire_failed:' || r.id || ':' || SQLSTATE)
        ON CONFLICT (dedupe_key) DO NOTHING;
      END IF;
    END;
  END LOOP;
  RETURN v_n;
END $$;

-- ---------------------------------------------------------------- orphan release (P3-R7)

-- A pending order with no payment attempt 15 minutes after creation: create-order died between
-- create_order and handing out a dpay redirect (its own `finally` cancels every other such exit).
-- Released exactly as cancel_order releases, reason 'no_payment_attempt'. Orders another
-- transaction holds (add_payment_attempt locks the order) are skipped and seen by the next run.
-- One order at a time, each in its own subtransaction, like expire_orders' fallback (same lock
-- order argument, same plan 4 caveat): an order that cannot be released stays pending and raises
-- one `orphan_release_failed` alert per order and sqlstate, and never blocks the others.
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
      UPDATE public.orders o
         SET status = 'cancelled', cancelled_reason = 'no_payment_attempt', cancelled_at = now()
       WHERE o.id = r.id AND o.status = 'pending'
         AND NOT EXISTS (SELECT 1 FROM public.payment_attempts a WHERE a.order_id = o.id);
      IF FOUND THEN
        PERFORM public.registration_release_slots(ARRAY[r.id], 'pending_payment');
        UPDATE public.registrations SET status = 'cancelled'
         WHERE order_id = r.id AND status = 'pending_payment';
        v_n := v_n + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      IF NOT public.registration_transient_error(SQLSTATE) THEN
        INSERT INTO public.operator_alerts (kind, order_id, payload, dedupe_key)
        VALUES ('orphan_release_failed', r.id, jsonb_build_object('error', SQLERRM, 'sqlstate', SQLSTATE),
                'orphan_release_failed:' || r.id || ':' || SQLSTATE)
        ON CONFLICT (dedupe_key) DO NOTHING;
      END IF;
    END;
  END LOOP;
  RETURN v_n;
END $$;
REVOKE EXECUTE ON FUNCTION public.release_orphan_orders(timestamptz) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_orphan_orders(timestamptz) TO service_role;

-- ---------------------------------------------------------------- settle_refund (from 20261030110000)

-- Unchanged apart from responded_at: every stored dpay answer stamps it, so a refund whose claim
-- (requested_at) is newer than its last answer was sent and never answered (stalled_refunds).
CREATE OR REPLACE FUNCTION public.settle_refund(p_refund_id uuid, p_outcome text) RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_attempt uuid;
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('pending', 'accepted', 'rejected', 'insufficient_balance', 'unknown') THEN
    RAISE EXCEPTION 'invalid_outcome';
  END IF;
  UPDATE public.refunds
     SET dpay_status = p_outcome,
         next_retry_at = CASE WHEN p_outcome = 'insufficient_balance' THEN now() + interval '1 hour' END,
         responded_at = now()
   WHERE id = p_refund_id AND dpay_status NOT IN ('accepted', 'rejected')
  RETURNING payment_attempt_id INTO v_attempt;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.refunds WHERE id = p_refund_id) THEN
      RETURN 'already_settled';
    END IF;
    RAISE EXCEPTION 'not_found';
  END IF;
  IF p_outcome = 'accepted' THEN
    UPDATE public.payment_attempts SET status = 'refunded' WHERE id = v_attempt;
  END IF;
  RETURN 'settled';
END $$;

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
-- refunded (that runner got „Płatność zwrócona”). An order holding an unpaid dpay transaction
-- needs proof first (review I2): dpay_checked_at at or after expiry, i.e. dpay said no attempt was
-- paid. Past 2 hours after expiry it is told without that proof; a payment that lands later still
-- reaches confirm_order through the IPN retries (about 17 h).
CREATE FUNCTION public.claim_expired_notices(p_limit integer DEFAULT 100) RETURNS SETOF uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT o.id FROM public.orders o
     WHERE o.status = 'expired' AND o.expired_notified_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.refunds f WHERE f.order_id = o.id)
       AND (o.dpay_checked_at >= o.expires_at
            OR o.expires_at < now() - interval '2 hours'
            OR NOT EXISTS (SELECT 1 FROM public.payment_attempts a
                            WHERE a.order_id = o.id AND a.status = 'created'))
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

-- Ruling 8: only a 406 (insufficient_balance) is retried, at most 24 times, an hour apart
-- (settle_refund sets next_retry_at). The claim clears next_retry_at, counts the attempt (this is
-- the only place refunds.attempts grows, P3-R6) and stamps requested_at for the call it is about to
-- make, in one statement: one dpay call per due retry however many runs overlap. A crash after the
-- claim leaves requested_at newer than responded_at with no retry scheduled: stalled_refunds.
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

-- P3-R10 + review I1: automatic refunds a person must look at, each with the alert to raise.
--   refund_never_sent  recorded 10+ minutes ago and never claimed (requested_at null): a crash
--                      between confirm_order's commit and the claim
--   refund_stalled     claimed 15+ minutes ago with no dpay answer stored since (responded_at
--                      null or older than requested_at) and no retry scheduled: a crash between
--                      the claim and the call, or during it
-- The dedupe key of a stall names the claim (requested_at), so a later retry that stalls again is
-- alerted again. Rows whose current key already has an alert are left out, so the limit never
-- starves newer rows behind old ones.
CREATE FUNCTION public.stalled_refunds(p_limit integer DEFAULT 100)
  RETURNS TABLE (refund_id uuid, order_id uuid, attempt_id uuid, amount integer, reason text,
                 alert_kind text, dedupe_key text, requested_at timestamptz, created_at timestamptz)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = ''
AS $$
  SELECT s.* FROM (
    SELECT f.id, f.order_id, f.payment_attempt_id, f.amount, f.reason,
           CASE WHEN f.requested_at IS NULL THEN 'refund_never_sent' ELSE 'refund_stalled' END AS alert_kind,
           CASE WHEN f.requested_at IS NULL THEN 'refund_never_sent:' || f.id
                ELSE 'refund_stalled:' || f.id || ':' || floor(extract(epoch FROM f.requested_at))::bigint END AS dedupe_key,
           f.requested_at, f.created_at
      FROM public.refunds f
     WHERE f.kind = 'automatic'
       AND f.dpay_status NOT IN ('accepted', 'rejected')
       AND f.next_retry_at IS NULL
       AND ((f.requested_at IS NULL AND f.created_at < now() - interval '10 minutes')
         OR (f.requested_at < now() - interval '15 minutes'
             AND (f.responded_at IS NULL OR f.responded_at < f.requested_at)))
  ) s
  WHERE NOT EXISTS (SELECT 1 FROM public.operator_alerts al WHERE al.dedupe_key = s.dedupe_key)
  ORDER BY s.created_at
  LIMIT greatest(p_limit, 0)
$$;

REVOKE EXECUTE ON FUNCTION public.claim_payment_reminders(integer)       FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_expired_notices(integer)         FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_confirmation_resends(integer)    FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_refund_retries(integer)          FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.stalled_refunds(integer)               FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.claim_payment_reminders(integer)       TO service_role;
GRANT  EXECUTE ON FUNCTION public.claim_expired_notices(integer)         TO service_role;
GRANT  EXECUTE ON FUNCTION public.claim_confirmation_resends(integer)    TO service_role;
GRANT  EXECUTE ON FUNCTION public.claim_refund_retries(integer)          TO service_role;
GRANT  EXECUTE ON FUNCTION public.stalled_refunds(integer)               TO service_role;

-- ---------------------------------------------------------------- purge (D3-8, P3-R12)

-- The runner data information promises that an unpaid registration's data goes 30 days after the
-- order expired (spec 5.5, 9). P3-R12 extends it to unpaid registrations that were cancelled
-- (create-order's own compensation, P3-R7 orphans), 30 days after cancellation.
--   registrations of an expired or cancelled order: anonymised as delete-my-account anonymises a
--     registration (the person's fields, profile_id and the guardian go; status, price and
--     competition stay); their consent acceptances lose ip and user_agent, the acceptance stays
--   orders.buyer_email: nulled only where no money ever moved (no paid or refunded attempt, no
--     refund row). An order that moved money keeps its buyer for the accounting retention.
-- Attempts, payment_events and refunds are not touched. Only rows still holding something change,
-- so a second run returns 0. → rows changed (registrations + acceptances + orders).
CREATE FUNCTION public.purge_expired_registrations() RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_regs   integer;
  v_acc    integer;
  v_orders integer;
  v_gone   constant text := 'Usunięte zgłoszenie';
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS pg_temp.purge_orders (id uuid PRIMARY KEY) ON COMMIT DROP;
  TRUNCATE pg_temp.purge_orders;
  INSERT INTO pg_temp.purge_orders (id)
  SELECT o.id FROM public.orders o
   WHERE (o.status = 'expired' AND o.expires_at <= now() - interval '30 days')
      OR (o.status = 'cancelled' AND o.cancelled_at <= now() - interval '30 days');

  UPDATE public.registrations r
     SET first_name = v_gone, last_name = v_gone, profile_id = NULL,
         email = NULL, phone = NULL, birth_date = NULL, city = NULL, club = NULL,
         ice_name = NULL, ice_phone = NULL, nationality = NULL,
         guardian_profile_id = NULL, guardian_name = NULL, guardian_email = NULL
    FROM pg_temp.purge_orders p
   WHERE r.order_id = p.id
     AND r.status IN ('expired', 'cancelled')
     AND (r.first_name, r.last_name, r.profile_id, r.email, r.phone, r.birth_date, r.city, r.club,
          r.ice_name, r.ice_phone, r.nationality, r.guardian_profile_id, r.guardian_name, r.guardian_email)
         IS DISTINCT FROM
         (v_gone, v_gone, NULL::uuid, NULL::text, NULL::text, NULL::date, NULL::text, NULL::text,
          NULL::text, NULL::text, NULL::text, NULL::uuid, NULL::text, NULL::text);
  GET DIAGNOSTICS v_regs = ROW_COUNT;

  UPDATE public.consent_acceptances ca
     SET ip = NULL, user_agent = NULL
    FROM public.registrations r
    JOIN pg_temp.purge_orders p ON p.id = r.order_id
   WHERE ca.registration_id = r.id
     AND r.status IN ('expired', 'cancelled')
     AND (ca.ip IS NOT NULL OR ca.user_agent IS NOT NULL);
  GET DIAGNOSTICS v_acc = ROW_COUNT;

  UPDATE public.orders o
     SET buyer_email = NULL
    FROM pg_temp.purge_orders p
   WHERE o.id = p.id
     AND o.buyer_email IS NOT NULL
     AND o.paid_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.payment_attempts a
                      WHERE a.order_id = o.id AND a.status IN ('paid', 'refunded'))
     AND NOT EXISTS (SELECT 1 FROM public.refunds f WHERE f.order_id = o.id);
  GET DIAGNOSTICS v_orders = ROW_COUNT;

  RETURN v_regs + v_acc + v_orders;
END $$;
REVOKE EXECUTE ON FUNCTION public.purge_expired_registrations() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_expired_registrations() TO service_role;

-- ---------------------------------------------------------------- schedules

SELECT cron.schedule('registration-expire-orders', '*/5 * * * *', $$SELECT public.expire_orders()$$);
SELECT cron.schedule('registration-release-orphan-orders', '2-59/5 * * * *', $$SELECT public.release_orphan_orders()$$);
-- 01:45 UTC = 02:45 Warsaw in winter, 03:45 in summer.
SELECT cron.schedule('registration-purge-expired', '45 1 * * *', $$SELECT public.purge_expired_registrations()$$);
-- net.http_post only queues the request: a wrong secret (404) or an unconfigured function (503)
-- still records the cron run as succeeded. The outcome is in net._http_response (the runbook's
-- check). The function keeps its own run under 90 s, well inside this timeout.
SELECT cron.schedule('registration-jobs', '*/15 * * * *', $$SELECT net.http_post(
  url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'registration_jobs_url'),
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-jobs-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'registration_jobs_secret')),
  body := '{}'::jsonb,
  timeout_milliseconds := 120000
)$$);
