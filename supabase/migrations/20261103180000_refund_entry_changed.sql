-- Plan 7, task 10b fix round 1.
--
-- 1. reserve_organizer_refund takes the registration the organizer's refund dialog was opened for
--    (p_registration_id, optional so a Plan 6 caller keeps working). When the line no longer
--    belongs to it, because a package transfer moved the line to the new holder after the dialog
--    opened, it raises entry_changed and reserves nothing (V-89). The check runs with the order and
--    the line locked, the locks apply_transfer holds while it moves the line, so either the refund
--    is reserved first and the accept meets refund_pending (V-87), or the transfer lands first and
--    the reservation meets entry_changed (V-47h). The rest of the body is 20261102102000's.
-- 2. registration_refunds_in_flight(ids) → the ids among them with a refund in flight, for the read
--    models (B3's rows, the runner's transfer block, the RA7 preview): the same rule as
--    registration_refund_in_flight, applied per id. service_role only.

DROP FUNCTION public.reserve_organizer_refund(uuid, integer, uuid, text);

CREATE FUNCTION public.reserve_organizer_refund(p_line_id uuid, p_grosze integer, p_actor uuid, p_request_key text,
                                                p_registration_id uuid DEFAULT NULL)
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
  v_date date;
  v_left integer;
  v_id   uuid := gen_random_uuid();
  v_msg  text := left(replace(v_id::text, '-', ''), 24);
BEGIN
  IF p_grosze IS NULL OR p_grosze <= 0 THEN
    RAISE EXCEPTION 'invalid_amount';
  END IF;
  IF p_request_key IS NOT NULL AND (char_length(p_request_key) NOT BETWEEN 8 AND 100) THEN
    RAISE EXCEPTION 'invalid_request_key';
  END IF;
  SELECT * INTO l FROM public.order_lines WHERE id = p_line_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  SELECT * INTO o FROM public.orders WHERE id = l.order_id FOR UPDATE;
  -- Under the order lock, so a concurrent request with the same key sees the committed row.
  IF p_request_key IS NOT NULL THEN
    SELECT * INTO f FROM public.refunds WHERE request_key = p_request_key;
    IF FOUND THEN
      IF f.order_line_id IS DISTINCT FROM p_line_id OR f.amount <> p_grosze THEN
        RAISE EXCEPTION 'request_key_mismatch';
      END IF;
      RETURN jsonb_build_object('refundId', f.id, 'messageId', f.message_id, 'replay', true, 'status', f.dpay_status,
        'requestedAt', f.requested_at, 'respondedAt', f.responded_at,
        'transactionId', (SELECT pa.dpay_transaction_id FROM public.payment_attempts pa WHERE pa.id = f.payment_attempt_id));
    END IF;
  END IF;

  IF o.status <> 'paid' OR o.paid_transaction_id IS NULL THEN
    RAISE EXCEPTION 'not_paid';
  END IF;
  SELECT rs.event_date INTO v_date FROM public.registration_settings rs WHERE rs.event_id = o.event_id;
  IF v_date IS NULL OR now() >= public.registration_refund_cutoff(v_date) THEN
    RAISE EXCEPTION 'race_day';
  END IF;
  SELECT * INTO a FROM public.payment_attempts
   WHERE order_id = o.id AND dpay_transaction_id = o.paid_transaction_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_paid';
  END IF;

  -- Both caps: the line's and record_refund's per attempt.
  SELECT * INTO l FROM public.order_lines WHERE id = p_line_id FOR UPDATE;
  -- V-89: the line is read again under the order lock, which apply_transfer also holds while it
  -- moves the line to the new holder. A dialog opened on the old holder's row is refused.
  IF p_registration_id IS NOT NULL AND l.registration_id IS DISTINCT FROM p_registration_id THEN
    RAISE EXCEPTION 'entry_changed';
  END IF;
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

  -- O-20b: the key lookup above is serialised by the ORDER lock, so the same key sent at once for a
  -- line of another order passes it too and meets the unique index here. That is the mismatch the
  -- lookup would have found; the whole reservation rolls back with the exception.
  BEGIN
    INSERT INTO public.refunds (id, order_id, payment_attempt_id, order_line_id, amount, kind, reason,
                                requested_by, message_id, request_key)
    VALUES (v_id, o.id, a.id, l.id, p_grosze, 'organizer', 'organizer', p_actor, v_msg, p_request_key);
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'request_key_mismatch';
  END;
  RETURN jsonb_build_object('refundId', v_id, 'messageId', v_msg, 'transactionId', a.dpay_transaction_id,
                            'replay', false, 'status', 'pending', 'requestedAt', NULL, 'respondedAt', NULL);
END $$;

REVOKE EXECUTE ON FUNCTION public.reserve_organizer_refund(uuid, integer, uuid, text, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_organizer_refund(uuid, integer, uuid, text, uuid) TO service_role;

CREATE FUNCTION public.registration_refunds_in_flight(p_registration_ids uuid[]) RETURNS uuid[]
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = ''
AS $$
  SELECT coalesce(array_agg(x ORDER BY x), '{}')
    FROM unnest(coalesce(p_registration_ids, '{}')) AS u(x)
   WHERE public.registration_refund_in_flight(x)
$$;
REVOKE EXECUTE ON FUNCTION public.registration_refunds_in_flight(uuid[]) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.registration_refunds_in_flight(uuid[]) TO service_role;
