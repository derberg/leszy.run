-- „Opłacone poza systemem” (B3): the club's owner or an admin marks an unpaid order as paid outside
-- LESZY.RUN (cash at the bib office, a bank transfer to the club). The whole order is confirmed exactly
-- as a dpay payment would confirm it: every slot or none, an expired order's voucher uses and extra
-- stock taken again, the participants inserted. Nothing is refunded on a refusal, because no money
-- moved here: the RPC raises and the order stays as it was.
--
-- The order keeps status 'paid' (every read model, the start list's „opłacone” among them, reads
-- that), with three new columns: paid_offline_at, offline_note (the club's own words, up to 300
-- characters, never shown to the runner) and offline_marked_by. No dpay transaction is ever tied to
-- it, so online payment is refused like for any paid order, an organizer refund answers not_paid and
-- the external_refunds step never reads it. A late dpay payment of one of its old attempts reaches
-- confirm_order's double_payment branch and is refunded in full.
--
-- confirm_order (from 20261103130000) is recreated unchanged in behaviour: its availability check and
-- its claim block move into two internal helpers that the new RPC shares.

-- ---------------------------------------------------------------- columns

ALTER TABLE public.orders
  ADD COLUMN paid_offline_at   timestamptz,
  ADD COLUMN offline_note      text CHECK (char_length(offline_note) BETWEEN 1 AND 300),
  ADD COLUMN offline_marked_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  -- An order marked offline never carries a dpay transaction, and a 0 zł order needs no mark.
  ADD CONSTRAINT orders_paid_offline_check
    CHECK (paid_offline_at IS NULL OR (status = 'paid' AND paid_transaction_id IS NULL AND total > 0)),
  ADD CONSTRAINT orders_offline_note_marked_check
    CHECK (offline_note IS NULL OR paid_offline_at IS NOT NULL);
CREATE INDEX orders_offline_marked_by_idx ON public.orders (offline_marked_by);

-- A paid order holds a dpay transaction, is free, or was paid outside the system.
ALTER TABLE public.orders DROP CONSTRAINT orders_paid_check;
ALTER TABLE public.orders ADD CONSTRAINT orders_paid_check
  CHECK (status <> 'paid' OR (paid_at IS NOT NULL
    AND (paid_transaction_id IS NOT NULL OR total = 0 OR paid_offline_at IS NOT NULL)));

-- ---------------------------------------------------------------- registration_order_unavailable

-- confirm_order's ruling P3-R5 check, unchanged: a competition of the order hidden meanwhile, an event
-- no longer published, or an entry that no longer fits what its competition became (kind, team size).
-- The caller holds the order and its competitions locked.
CREATE FUNCTION public.registration_order_unavailable(p_order_id uuid, p_event_id uuid) RETURNS boolean
  LANGUAGE sql
  STABLE
  SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM public.competitions c
                  WHERE c.hidden_at IS NOT NULL
                    AND c.category_id IN (SELECT r.category_id FROM public.registrations r WHERE r.order_id = p_order_id))
     OR NOT EXISTS (SELECT 1 FROM public.registration_settings rs
                     WHERE rs.event_id = p_event_id AND rs.state = 'published')
     OR EXISTS (SELECT 1 FROM public.registrations r
                  JOIN public.competitions c ON c.category_id = r.category_id
                 WHERE r.order_id = p_order_id AND r.status IN ('pending_payment', 'expired')
                   AND (r.team_id IS NOT NULL) <> (c.kind = 'team'))
     OR EXISTS (SELECT 1 FROM public.registrations r
                  JOIN public.competitions c ON c.category_id = r.category_id
                 WHERE r.order_id = p_order_id AND r.status IN ('pending_payment', 'expired') AND r.team_id IS NOT NULL
                 GROUP BY r.team_id, c.team_min, c.team_max
                HAVING (count(*) BETWEEN c.team_min AND c.team_max) IS NOT TRUE)
$$;
REVOKE EXECUTE ON FUNCTION public.registration_order_unavailable(uuid, uuid) FROM public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- registration_claim_order

-- confirm_order's claim (P3-R15), unchanged: a duplicate made meanwhile (an expired order only), then
-- every slot of the order or none, an expired order's voucher uses and stock again (D7-19), and the
-- registrations confirmed. → NULL when all of it happened, else the reason nothing did: 'duplicate',
-- 'full', 'voucher' or 'stock'. The claims sit in a subtransaction, so a refusal leaves nothing behind.
-- The caller holds the order, its competitions (category_id order) and the settings, in that order.
CREATE FUNCTION public.registration_claim_order(p_order_id uuid, p_status text) RETURNS text
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
DECLARE
  u record;
BEGIN
  -- Ruling 8's order: a duplicate before full, voucher and stock. Only an expired order's rows are
  -- out of the live unique indexes; a plain read with their keys (e-mail per event, and a child's
  -- name and birth date) finds a live entry made meanwhile. No lock: the flip below decides a race.
  IF p_status = 'expired' AND EXISTS (
       SELECT 1 FROM public.registrations r
         JOIN public.registrations x
           ON x.event_id = r.event_id AND x.id <> r.id AND x.status IN ('pending_payment', 'confirmed')
        WHERE r.order_id = p_order_id AND r.status = 'expired'
          AND ((r.email IS NOT NULL AND x.email IS NOT NULL AND lower(x.email) = lower(r.email))
            OR (r.email IS NULL AND x.email IS NULL AND x.birth_date = r.birth_date
                AND lower(btrim(x.first_name)) = lower(btrim(r.first_name))
                AND lower(btrim(x.last_name)) = lower(btrim(r.last_name))))) THEN
    RETURN 'duplicate';
  END IF;
  BEGIN
    FOR u IN SELECT * FROM public.registration_slot_units(p_order_id,
               ARRAY[CASE WHEN p_status = 'pending' THEN 'pending_payment' ELSE 'expired' END]) LOOP
      IF public.claim_competition_slots(u.category_id, u.n) IS NULL THEN
        RAISE EXCEPTION 'full';
      END IF;
    END LOOP;
    IF p_status = 'expired' THEN
      PERFORM public.registration_reclaim_cart(p_order_id);
    END IF;
    UPDATE public.registrations SET status = 'confirmed'
     WHERE order_id = p_order_id AND status IN ('pending_payment', 'expired');
  EXCEPTION
    WHEN unique_violation THEN
      RETURN 'duplicate';
    WHEN raise_exception THEN
      IF SQLERRM NOT IN ('full', 'voucher', 'stock') THEN
        RAISE;
      END IF;
      RETURN SQLERRM;
  END;
  RETURN NULL;
END $$;
REVOKE EXECUTE ON FUNCTION public.registration_claim_order(uuid, text) FROM public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- confirm_order (from 20261103130000)

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

  -- (5) Branch on the order. An order paid outside the system (paid_offline_at) is paid: a payment
  -- of one of its old attempts is a double payment, refunded in full.
  IF o.status = 'paid' THEN
    v_refund := public.registration_refund_attempt(o.id, a.id, p_grosze, 'double_payment', 'double_payment', p_source);
    RETURN jsonb_build_object('outcome', 'double_payment', 'refund', v_refund);
  END IF;
  IF o.status = 'cancelled' THEN
    v_refund := public.registration_refund_attempt(o.id, a.id, p_grosze, 'late_refund', 'cancelled', p_source);
    RETURN jsonb_build_object('outcome', 'late_refund', 'refund', v_refund);
  END IF;

  -- D3-1: the order's competitions (category_id order), then the settings, before
  -- any registration is written. Both a pending and an expired order claim their
  -- slots here (P3-R15: the limit counts paid entries only), so both lock the
  -- competitions FOR UPDATE.
  PERFORM 1 FROM public.competitions c
   WHERE c.category_id IN (SELECT r.category_id FROM public.registrations r WHERE r.order_id = o.id)
   ORDER BY c.category_id
     FOR UPDATE;
  -- Ruling P3-R5: nothing is claimed in a competition hidden meanwhile, nor in an
  -- event no longer published, nor where the entry no longer fits what the competition
  -- became; the payment is refunded. A pending order whose window is still open blocks
  -- hiding (registration_competition_in_use), so for it this only fires past expires_at,
  -- before the expiry job ran.
  IF public.registration_order_unavailable(o.id, o.event_id) THEN
    PERFORM public.registration_drop_unpaid_order(o.id, o.status, 'unavailable');
    v_refund := public.registration_refund_attempt(o.id, a.id, p_grosze, 'late_refund', 'unavailable', p_source);
    RETURN jsonb_build_object('outcome', 'late_refund', 'refund', v_refund);
  END IF;

  -- D3-7: at or after closes_at only an attempt created before it and confirmed
  -- within a 5-minute grace (the literal below) is accepted; everything else is
  -- refunded in full.
  SELECT rs.closes_at INTO v_closes FROM public.registration_settings rs WHERE rs.event_id = o.event_id
     FOR KEY SHARE;
  IF v_closes IS NULL
     OR (now() >= v_closes AND NOT (a.created_at < v_closes AND now() < v_closes + interval '5 minutes')) THEN
    PERFORM public.registration_drop_unpaid_order(o.id, o.status, 'closed');
    v_refund := public.registration_refund_attempt(o.id, a.id, p_grosze, 'late_refund', 'closed', p_source);
    RETURN jsonb_build_object('outcome', 'late_refund', 'refund', v_refund);
  END IF;

  -- The claim (P3-R15): every slot of the order, or none; a refusal ('duplicate',
  -- 'full', 'voucher', 'stock') refunds the whole order (never split, whatever it spans).
  v_reason := public.registration_claim_order(o.id, o.status);
  IF v_reason IS NOT NULL THEN
    PERFORM public.registration_drop_unpaid_order(o.id, o.status, v_reason);
    v_refund := public.registration_refund_attempt(o.id, a.id, p_grosze, 'late_refund', v_reason, p_source);
    RETURN jsonb_build_object('outcome', 'late_refund', 'refund', v_refund);
  END IF;

  UPDATE public.orders SET status = 'paid', paid_at = now(), paid_transaction_id = p_txn
   WHERE id = o.id AND status IN ('pending', 'expired');
  PERFORM public.insert_registration_participant(r.id)
     FROM public.registrations r WHERE r.order_id = o.id AND r.status = 'confirmed' ORDER BY r.id;
  RETURN jsonb_build_object('outcome', CASE WHEN o.status = 'pending' THEN 'confirmed' ELSE 'late_confirmed' END);
END $$;

-- ---------------------------------------------------------------- organizer_mark_paid_offline

-- „Opłacone poza systemem”: the whole order, at its frozen total. Allowed for an unpaid order
-- (pending, or expired) until 00:00 Warsaw on the race day (registration_refund_cutoff, the rule of
-- organizer refunds and transfers), also after closes_at: the office takes cash until the race. Lock
-- order: the order, its competitions (category_id order), the settings, then the claim's vouchers,
-- extra variants and registrations, then the participants. Refusals (raised, nothing changes):
--   invalid_note, not_found, paid, cancelled, free (a 0 zł order), erased (an anonymised order), payment_received (a dpay payment
--   of the order is recorded), race_day, unavailable (a hidden competition, an unpublished event, an
--   entry that no longer fits its competition), duplicate, full, voucher, stock.
-- → { outcome: 'confirmed' | 'late_confirmed', registrations: [ids confirmed] }. The caller sends the
-- confirmation e-mail and the consent requests (settleConfirmOutcome) and writes the audit row.
CREATE FUNCTION public.organizer_mark_paid_offline(p_order_id uuid, p_actor uuid, p_note text) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  o        public.orders%ROWTYPE;
  v_note   text := btrim(coalesce(p_note, ''));
  v_date   date;
  v_reason text;
  v_ids    uuid[];
BEGIN
  IF char_length(v_note) NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'invalid_note';
  END IF;
  SELECT * INTO o FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF o.status = 'paid' THEN
    RAISE EXCEPTION 'paid';
  END IF;
  IF o.status = 'cancelled' THEN
    RAISE EXCEPTION 'cancelled';
  END IF;
  IF o.total = 0 THEN
    RAISE EXCEPTION 'free';
  END IF;
  -- An expired order whose buyer address is gone was erased: purge_expired_registrations (30 days
  -- after expiry) or delete-my-account anonymised its entries. Confirming it would claim a slot for
  -- „Usunięte zgłoszenie” and revive an erased entry on the start list.
  IF o.buyer_email IS NULL THEN
    RAISE EXCEPTION 'erased';
  END IF;
  IF EXISTS (SELECT 1 FROM public.payment_attempts pa WHERE pa.order_id = o.id AND pa.status <> 'created') THEN
    RAISE EXCEPTION 'payment_received';
  END IF;
  SELECT rs.event_date INTO v_date FROM public.registration_settings rs WHERE rs.event_id = o.event_id;
  IF v_date IS NULL OR now() >= public.registration_refund_cutoff(v_date) THEN
    RAISE EXCEPTION 'race_day';
  END IF;

  PERFORM 1 FROM public.competitions c
   WHERE c.category_id IN (SELECT r.category_id FROM public.registrations r WHERE r.order_id = o.id)
   ORDER BY c.category_id
     FOR UPDATE;
  IF public.registration_order_unavailable(o.id, o.event_id) THEN
    RAISE EXCEPTION 'unavailable';
  END IF;
  PERFORM 1 FROM public.registration_settings rs WHERE rs.event_id = o.event_id FOR KEY SHARE;

  v_reason := public.registration_claim_order(o.id, o.status);
  IF v_reason IS NOT NULL THEN
    RAISE EXCEPTION '%', v_reason;
  END IF;

  UPDATE public.orders
     SET status = 'paid', paid_at = now(), paid_offline_at = now(), offline_note = v_note, offline_marked_by = p_actor
   WHERE id = o.id;
  PERFORM public.insert_registration_participant(r.id)
     FROM public.registrations r WHERE r.order_id = o.id AND r.status = 'confirmed' ORDER BY r.id;
  SELECT coalesce(array_agg(r.id ORDER BY r.id), '{}') INTO v_ids
    FROM public.registrations r WHERE r.order_id = o.id AND r.status = 'confirmed';
  RETURN jsonb_build_object('outcome', CASE WHEN o.status = 'pending' THEN 'confirmed' ELSE 'late_confirmed' END,
                            'registrations', to_jsonb(v_ids));
END $$;
REVOKE EXECUTE ON FUNCTION public.organizer_mark_paid_offline(uuid, uuid, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.organizer_mark_paid_offline(uuid, uuid, text) TO service_role;
