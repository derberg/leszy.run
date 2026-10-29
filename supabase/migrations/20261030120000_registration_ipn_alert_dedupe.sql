-- Plan 3, task 6: operator alerts deduplicated per (kind, dpay transaction).
--
-- dpay retries an IPN until it reads `OK` (up to 10 times over about 17 h) and
-- the order-status poll asks again every 10 s, so a payment we cannot match
-- (unknown_attempt) or whose amount is wrong (amount_mismatch) used to add one
-- operator_alerts row per delivery (task 4 review, M3). Those two alerts now
-- carry dedupe_key = '<kind>:<txn>', unique, and the insert does nothing when
-- the key exists. The dpay-ipn function uses the same key for the IPNs it
-- refuses before confirm_order (custom not a uuid, no such order, an
-- unparsable amount), so one transaction raises one alert whichever path saw
-- it first. Alerts without a key (every other kind) are unaffected: NULLs are
-- distinct in a unique constraint.
--
-- confirm_order is re-created from its latest definition
-- (20261030110000_registration_order_rpcs.sql); only its two alert inserts
-- change. A full unique constraint rather than a partial index, so PostgREST's
-- on_conflict=dedupe_key can name it.

ALTER TABLE public.operator_alerts ADD COLUMN dedupe_key text;
ALTER TABLE public.operator_alerts
  ADD CONSTRAINT operator_alerts_dedupe_key_key UNIQUE (dedupe_key);

CREATE OR REPLACE FUNCTION public.confirm_order(p_order_id uuid, p_txn text, p_grosze integer, p_source text) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  o         public.orders%ROWTYPE;
  a         public.payment_attempts%ROWTYPE;
  v_found   boolean;
  v_closes  timestamptz;
  v_reason  text;
  v_refund  jsonb;
  u         record;
BEGIN
  -- (1) The order lock serialises confirm, expire and cancel of one order.
  SELECT * INTO o FROM public.orders WHERE id = p_order_id FOR UPDATE;
  v_found := FOUND;

  -- (2) A correctly signed payment we cannot match is money received: alert.
  IF v_found THEN
    SELECT * INTO a FROM public.payment_attempts WHERE order_id = o.id AND dpay_transaction_id = p_txn;
    v_found := FOUND;
  END IF;
  IF NOT v_found THEN
    INSERT INTO public.operator_alerts (kind, order_id, payload, dedupe_key)
    VALUES ('unknown_attempt', o.id, jsonb_build_object(
      'orderId', p_order_id, 'txn', p_txn, 'grosze', p_grosze, 'source', p_source),
      'unknown_attempt:' || coalesce(p_txn, ''))
    ON CONFLICT ON CONSTRAINT operator_alerts_dedupe_key_key DO NOTHING;
    RETURN jsonb_build_object('outcome', 'unknown_attempt');
  END IF;

  -- (3) Ruling 6: a mismatch never confirms and never refunds.
  IF p_grosze IS DISTINCT FROM a.grosze OR p_grosze IS DISTINCT FROM o.total THEN
    INSERT INTO public.operator_alerts (kind, order_id, payload, dedupe_key)
    VALUES ('amount_mismatch', o.id, jsonb_build_object(
      'attemptId', a.id, 'txn', p_txn, 'grosze', p_grosze, 'expected', o.total, 'source', p_source),
      'amount_mismatch:' || p_txn)
    ON CONFLICT ON CONSTRAINT operator_alerts_dedupe_key_key DO NOTHING;
    RETURN jsonb_build_object('outcome', 'amount_mismatch');
  END IF;

  -- (4) Ruling 8: only this statement leads to a confirmation or a refund.
  UPDATE public.payment_attempts SET status = 'paid', paid_at = now()
   WHERE id = a.id AND status = 'created';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome',
      CASE WHEN o.status = 'paid' AND o.paid_transaction_id = p_txn THEN 'already_confirmed' ELSE 'already_handled' END);
  END IF;

  -- (5) Branch on the order.
  IF o.status = 'paid' THEN
    v_refund := public.registration_refund_attempt(o.id, a.id, p_grosze, 'double_payment', 'double_payment', p_source);
    RETURN jsonb_build_object('outcome', 'double_payment', 'refund', v_refund);
  END IF;
  IF o.status = 'cancelled' THEN
    v_refund := public.registration_refund_attempt(o.id, a.id, p_grosze, 'late_refund', 'cancelled', p_source);
    RETURN jsonb_build_object('outcome', 'late_refund', 'refund', v_refund);
  END IF;

  -- D3-1: the order's competitions (category_id order), then the settings, before
  -- any registration is written. A re-claim updates the competitions; a plain
  -- confirmation still takes KEY SHARE up front, because writing a registration
  -- row twice in one transaction (status, then participant_id) re-runs its
  -- foreign-key checks, which would otherwise lock the settings and then a
  -- competition: the reverse of publish_registration_changes, a deadlock.
  IF o.status = 'expired' THEN
    PERFORM 1 FROM public.competitions c
     WHERE c.category_id IN (SELECT r.category_id FROM public.registrations r WHERE r.order_id = o.id)
     ORDER BY c.category_id
       FOR UPDATE;
    -- Ruling P3-R5: no re-claim into a competition hidden meanwhile, nor into
    -- an event no longer published; the payment is refunded, nothing claimed.
    IF EXISTS (SELECT 1 FROM public.competitions c
                WHERE c.hidden_at IS NOT NULL
                  AND c.category_id IN (SELECT r.category_id FROM public.registrations r WHERE r.order_id = o.id))
       OR NOT EXISTS (SELECT 1 FROM public.registration_settings rs
                       WHERE rs.event_id = o.event_id AND rs.state = 'published') THEN
      v_refund := public.registration_refund_attempt(o.id, a.id, p_grosze, 'late_refund', 'unavailable', p_source);
      RETURN jsonb_build_object('outcome', 'late_refund', 'refund', v_refund);
    END IF;
  ELSE
    PERFORM 1 FROM public.competitions c
     WHERE c.category_id IN (SELECT r.category_id FROM public.registrations r WHERE r.order_id = o.id)
     ORDER BY c.category_id
       FOR KEY SHARE;
  END IF;

  -- D3-7: at or after closes_at only an attempt created before it and confirmed
  -- within the 5-minute grace is accepted; everything else is refunded in full.
  SELECT rs.closes_at INTO v_closes FROM public.registration_settings rs WHERE rs.event_id = o.event_id
     FOR KEY SHARE;
  IF v_closes IS NULL
     OR (now() >= v_closes AND NOT (a.created_at < v_closes AND now() < v_closes + interval '5 minutes')) THEN
    v_refund := public.registration_refund_attempt(o.id, a.id, p_grosze, 'late_refund', 'closed', p_source);
    RETURN jsonb_build_object('outcome', 'late_refund', 'refund', v_refund);
  END IF;

  IF o.status = 'pending' THEN
    UPDATE public.orders SET status = 'paid', paid_at = now(), paid_transaction_id = p_txn
     WHERE id = o.id AND status = 'pending';
    UPDATE public.registrations SET status = 'confirmed'
     WHERE order_id = o.id AND status = 'pending_payment';
    PERFORM public.insert_registration_participant(r.id)
       FROM public.registrations r WHERE r.order_id = o.id AND r.status = 'confirmed' ORDER BY r.id;
    RETURN jsonb_build_object('outcome', 'confirmed');
  END IF;

  -- Expired: re-claim every slot and re-activate the registrations, or undo
  -- both (the block is a subtransaction) and refund.
  BEGIN
    FOR u IN SELECT * FROM public.registration_slot_units(o.id, ARRAY['expired']) LOOP
      IF public.claim_competition_slots(u.category_id, u.n) IS NULL THEN
        RAISE EXCEPTION 'full';
      END IF;
    END LOOP;
    UPDATE public.registrations SET status = 'confirmed'
     WHERE order_id = o.id AND status = 'expired';
  EXCEPTION
    WHEN unique_violation THEN
      v_reason := 'duplicate';
    WHEN raise_exception THEN
      IF SQLERRM <> 'full' THEN
        RAISE;
      END IF;
      v_reason := 'full';
  END;
  IF v_reason IS NOT NULL THEN
    v_refund := public.registration_refund_attempt(o.id, a.id, p_grosze, 'late_refund', v_reason, p_source);
    RETURN jsonb_build_object('outcome', 'late_refund', 'refund', v_refund);
  END IF;

  UPDATE public.orders SET status = 'paid', paid_at = now(), paid_transaction_id = p_txn
   WHERE id = o.id AND status = 'expired';
  PERFORM public.insert_registration_participant(r.id)
     FROM public.registrations r WHERE r.order_id = o.id AND r.status = 'confirmed' ORDER BY r.id;
  RETURN jsonb_build_object('outcome', 'late_confirmed');
END $$;
REVOKE EXECUTE ON FUNCTION public.confirm_order(uuid, text, integer, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_order(uuid, text, integer, text) TO service_role;
