-- Refunds the organizer made in the dpay merchant panel instead of through „Zwróć wpłatę”.
--
-- dpay sends an IPN for a payment, never for a refund, so such a refund leaves the order `paid`,
-- the entry live and no `refunds` row. Two pieces close that gap:
--
-- 1. record_external_refund(line, grosze, note, notify): the operator's record of it
--    (backend/scripts/record-external-refund.js, after the dpay panel). It is an accepted
--    organizer refund in every respect: kind 'organizer', reason 'external', the row inserted and
--    then settled through finish_organizer_refund(…, 'accepted'), so the line, the registration,
--    the attempt, the entry (cancelled once the line is covered; a team line takes the team) and
--    the slot move exactly as dpay's own answer moves them. kind stays 'organizer' rather than a new
--    'external' kind because every reader already treats organizer refunds correctly (the
--    refund_emails job, stalled_refunds, B3's refunded sums, registration_attempt_refunds_held,
--    export-my-data, refundNotice): a new kind would mean a CHECK change and an audit of every
--    `kind = 'organizer'` filter, for nothing the reason column does not already say.
--    It never calls dpay (the money already left). The runner is told nothing unless p_notify:
--    runner_notified_at is stamped at once, so the refund_emails job skips it; with p_notify it is
--    left NULL and the job sends the club's usual refund e-mail within 15 minutes.
--    Not refused on race day: the cutoff stops new refunds, and this one already happened.
--    Idempotent: one (line, amount, note) is one refund (request_key 'external:' || md5(…)); an
--    identical re-run returns the first row with replay = true and moves nothing.
--    Refused: invalid_amount, note_required, note_too_long, not_found, not_paid, exceeds:<left>
--    (what is left on the line and on the attempt, reservations included).
--    One admin_actions row (action 'record_external_refund', admin_user_id NULL: the operator
--    runs a script, the note names them).
--    Locks: orders → payment_attempts → order_lines, then finish_organizer_refund and
--    cancel_registration continue the documented order (competitions → settings → teams →
--    vouchers → registrations → participants → transfers).
--
-- 2. claim_external_refund_checks(limit): the registration-jobs step `external_refunds` asks dpay
--    (/pbl/details refunded_amount) about each paid order at most once a day, while its event is
--    no more than 60 days past (Warsaw). One UPDATE claims the rows (SKIP LOCKED), so overlapping
--    runs never ask twice. Never-checked orders first, the newest payment first among them.

ALTER TABLE public.orders ADD COLUMN external_refund_checked_at timestamptz;

-- ---------------------------------------------------------------- record_external_refund

CREATE FUNCTION public.record_external_refund(p_line_id uuid, p_grosze integer, p_note text,
                                              p_notify boolean DEFAULT false)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  f      public.refunds%ROWTYPE;
  l      public.order_lines%ROWTYPE;
  o      public.orders%ROWTYPE;
  a      public.payment_attempts%ROWTYPE;
  v_note text := btrim(p_note);
  v_key  text;
  v_left integer;
  v_id   uuid := gen_random_uuid();
  v_msg  text := left(replace(v_id::text, '-', ''), 24);
  v_out  jsonb;
BEGIN
  IF p_grosze IS NULL OR p_grosze <= 0 THEN
    RAISE EXCEPTION 'invalid_amount';
  END IF;
  IF nullif(v_note, '') IS NULL THEN
    RAISE EXCEPTION 'note_required';
  END IF;
  IF char_length(v_note) > 500 THEN
    RAISE EXCEPTION 'note_too_long';
  END IF;
  SELECT * INTO l FROM public.order_lines WHERE id = p_line_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  v_key := 'external:' || md5(p_line_id::text || ':' || p_grosze::text || ':' || v_note);

  SELECT * INTO o FROM public.orders WHERE id = l.order_id FOR UPDATE;
  -- Under the order lock, so an identical run at the same time sees the committed row.
  SELECT * INTO f FROM public.refunds WHERE request_key = v_key;
  IF FOUND THEN
    RETURN jsonb_build_object('refundId', f.id, 'replay', true, 'status', f.dpay_status,
                              'cancelled', '[]'::jsonb, 'hostWithdraw', false);
  END IF;

  IF o.status <> 'paid' OR o.paid_transaction_id IS NULL THEN
    RAISE EXCEPTION 'not_paid';
  END IF;
  SELECT * INTO a FROM public.payment_attempts
   WHERE order_id = o.id AND dpay_transaction_id = o.paid_transaction_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_paid';
  END IF;
  SELECT * INTO l FROM public.order_lines WHERE id = p_line_id FOR UPDATE;

  v_left := least(l.amount - l.refunded, a.grosze - public.registration_attempt_refunds_held(a.id));
  IF p_grosze > v_left THEN
    RAISE EXCEPTION 'exceeds:%', greatest(v_left, 0);
  END IF;
  UPDATE public.order_lines SET refunded = refunded + p_grosze
   WHERE id = p_line_id AND refunded + p_grosze <= amount;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'exceeds:%', greatest(l.amount - l.refunded, 0);
  END IF;
  IF l.kind = 'entry' THEN
    UPDATE public.registrations SET refunded = refunded + p_grosze WHERE id = l.registration_id;
  END IF;

  INSERT INTO public.refunds (id, order_id, payment_attempt_id, order_line_id, amount, kind, reason,
                              requested_by, message_id, request_key, requested_at, resolved_by,
                              runner_notified_at)
  VALUES (v_id, o.id, a.id, l.id, p_grosze, 'organizer', 'external', NULL, v_msg, v_key, now(), v_note,
          CASE WHEN coalesce(p_notify, false) THEN NULL ELSE now() END);

  -- The same effects as dpay's own `accepted`: responded_at, the attempt, the entry and its slot.
  v_out := public.finish_organizer_refund(v_id, 'accepted');

  INSERT INTO public.admin_actions (admin_user_id, action, target_table, target_id, payload)
  VALUES (NULL, 'record_external_refund', 'refunds', v_id::text, jsonb_build_object(
    'orderId', o.id, 'lineId', l.id, 'attemptId', a.id, 'grosze', p_grosze, 'note', v_note,
    'notify', coalesce(p_notify, false), 'cancelled', coalesce(v_out->'cancelled', '[]'::jsonb)));

  RETURN jsonb_build_object('refundId', v_id, 'replay', false, 'status', v_out->>'status',
                            'cancelled', coalesce(v_out->'cancelled', '[]'::jsonb),
                            'hostWithdraw', coalesce((v_out->>'hostWithdraw')::boolean, false),
                            'remaining', v_left - p_grosze);
END $$;
REVOKE EXECUTE ON FUNCTION public.record_external_refund(uuid, integer, text, boolean) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_external_refund(uuid, integer, text, boolean) TO service_role;

-- ---------------------------------------------------------------- claim_external_refund_checks

CREATE FUNCTION public.claim_external_refund_checks(p_limit integer)
  RETURNS TABLE (order_id uuid, txn text)
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = ''
AS $$
  WITH due AS (
    SELECT o.id
      FROM public.orders o
      JOIN public.registration_settings rs ON rs.event_id = o.event_id
     WHERE o.status = 'paid'
       AND o.paid_transaction_id IS NOT NULL
       AND rs.event_date >= (now() AT TIME ZONE 'Europe/Warsaw')::date - 60
       AND (o.external_refund_checked_at IS NULL OR o.external_refund_checked_at < now() - interval '24 hours')
     ORDER BY o.external_refund_checked_at ASC NULLS FIRST, o.paid_at DESC NULLS LAST, o.id
     LIMIT greatest(coalesce(p_limit, 0), 0)
       FOR UPDATE OF o SKIP LOCKED
  )
  UPDATE public.orders o SET external_refund_checked_at = now()
    FROM due
   WHERE o.id = due.id
  RETURNING o.id, o.paid_transaction_id
$$;
REVOKE EXECUTE ON FUNCTION public.claim_external_refund_checks(integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_external_refund_checks(integer) TO service_role;
