-- Competition change, task 4: settling a surcharge, and every reader that must tell one apart.
--
-- * confirm_order: a surcharge order (orders.kind = 'surcharge') owns no registration, so it
--   branches right after the double-payment / cancelled checks into registration_confirm_surcharge:
--   the entry moves (registration_move_entry), registrations.price += the surcharge,
--   list_price := surcharge_list_price, the order is paid → { outcome: 'surcharge_moved', orderId,
--   registrationId }. Otherwise the payment is refunded in full (late_refund, the existing shape
--   { outcome: 'late_refund', refund: { reason, … } }) with reason 'entry_changed' (the entry is no
--   longer confirmed, no longer in surcharge_from_category_id, no longer fits the target, or a newer
--   surcharge of it is pending), 'unavailable' (a hidden or non-individual target, an unpublished
--   event), 'closed' (D3-7's rule: an attempt made before closes_at and confirmed within 5 minutes
--   after it still counts) or 'full'; a pending surcharge is cancelled with that reason, an expired
--   one stays expired. A pending surcharge (inside or past its window) and an expired one are
--   checked alike, the rule regular orders follow since P3-R15: a late payment re-checks everything
--   and moves when every check passes.
-- * registration_expire_due_surcharges: a pending surcharge whose expires_at has passed counts as
--   expired; change_competition and apply_transfer expire it inline instead of answering
--   surcharge_open for up to 5 minutes (the expire_orders cadence).
-- * finish_organizer_refund: on rejected / insufficient_balance the reservation is given back on the
--   line and, for an entry or a surcharge line, on the registration. On accepted the entry is
--   cancelled only when all of its money is back (registrations.refunded >= price, with no other
--   refund of it still in flight) and never for a 'competition_change' refund. For an entry that
--   never moved this is the old rule (its price is its entry line's amount).
-- * apply_transfer: refuses surcharge_open while a surcharge is pending, and moves the entry's paid
--   surcharge lines to the new registration with the entry and extra lines.
-- * record_external_refund: a surcharge line's refund adds to registrations.refunded.
-- * organizer_mark_paid_offline: refuses a surcharge ('surcharge'): it would be paid without a move.
-- * release_orphan_orders: never cancels a surcharge. It cancels an order nobody started paying
--   within 15 minutes because create-order hands out a redirect at once; a surcharge is made by the
--   club and paid by the runner from an e-mail, hours or days later.
-- * create_order / create_team_registration: too_many_pending counts kind = 'registration' only.
-- * registration_order_fits: a surcharge fits while its target has a free place (payer UX only).
-- * Job claims: claim_payment_reminders, claim_expired_notices and claim_confirmation_resends skip
--   surcharge orders (so none is stamped and dropped); three new claims with the same rules,
--   claim_surcharge_reminders, claim_surcharge_expired_notices and claim_surcharge_confirmations,
--   hand them to the job (task 6), which words them for a surcharge. Their RETURNS stay SETOF uuid,
--   like the order claims, so the job's existing callers are unchanged.
-- * purge_expired_registrations is unchanged: a surcharge has no registrations, so a purge of an
--   expired one anonymises no entry; it nulls the surcharge's own buyer_email like any order that
--   moved no money.
--
-- Recreated from (newest body on this branch, changed only where marked "Changed here"):
--   confirm_order, organizer_mark_paid_offline ← 20261118110000_paid_offline.sql
--   change_competition ← 20261124110000_competition_change_rpc.sql
--   apply_transfer ← 20261109200000_event_partners_unified.sql
--   record_external_refund ← 20261110400000_external_refunds.sql
--   finish_organizer_refund ← 20261102102000_organizer_panel_concurrency.sql
--   release_orphan_orders ← 20261103130000_registration_cart_release.sql
--   create_order, create_team_registration ← 20261103120000_registration_cart_rpcs.sql
--   registration_order_fits ← 20261030160000_registration_capacity_paid_only.sql
--   claim_payment_reminders ← 20261107130000_payment_reminder_three_days_before.sql
--   claim_expired_notices ← 20261030125000_registration_jobs_cron.sql
--   claim_confirmation_resends ← 20261102130000_confirmation_resend_live_only.sql
-- CREATE OR REPLACE keeps every grant.
--
-- Lock order (CLAUDE.md, Plan 7 list) in the surcharge branch: the surcharge order (confirm_order's
-- step 1) → its payment attempt (step 4) → the competitions (from, to, and where the entry is now,
-- by category_id) → registration_settings FOR SHARE → the registration → its participant (in the
-- move). The entry's own order is not locked: change_competition, reserve_organizer_refund and
-- apply_transfer reach the entry through it or through this order, and none of them takes this
-- order after a competition or the registration.

-- ---------------------------------------------------------------- registration_expire_due_surcharges

-- Internal: the entry's pending surcharges whose window has passed → expired, as expire_orders
-- would do it (a surcharge holds no registration, voucher use, stock or slot). The caller holds
-- those orders locked.
CREATE FUNCTION public.registration_expire_due_surcharges(p_registration_id uuid) RETURNS void
  LANGUAGE sql
  SET search_path = ''
AS $$
  UPDATE public.orders SET status = 'expired'
   WHERE kind = 'surcharge' AND surcharge_registration_id = p_registration_id
     AND status = 'pending' AND expires_at <= now();
$$;
REVOKE EXECUTE ON FUNCTION public.registration_expire_due_surcharges(uuid) FROM public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- registration_confirm_surcharge

-- Internal, confirm_order's surcharge branch. The caller holds the order and has flipped the attempt
-- to paid; the order is pending or expired.
CREATE FUNCTION public.registration_confirm_surcharge(p_order_id uuid, p_attempt_id uuid, p_txn text,
                                                      p_grosze integer, p_source text)
  RETURNS jsonb
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
DECLARE
  o        public.orders%ROWTYPE;
  a        public.payment_attempts%ROWTYPE;
  r        public.registrations%ROWTYPE;
  v_rs     public.registration_settings%ROWTYPE;
  v_to     public.competitions%ROWTYPE;
  v_reason text;
  v_refund jsonb;
BEGIN
  SELECT * INTO o FROM public.orders WHERE id = p_order_id;
  SELECT * INTO a FROM public.payment_attempts WHERE id = p_attempt_id;
  -- A plain read: where the entry is now, to lock that competition too.
  SELECT * INTO r FROM public.registrations WHERE id = o.surcharge_registration_id;
  PERFORM 1 FROM public.competitions
   WHERE category_id IN (o.surcharge_from_category_id, o.surcharge_to_category_id, r.category_id)
   ORDER BY category_id
     FOR UPDATE;
  SELECT * INTO v_rs FROM public.registration_settings WHERE event_id = o.event_id FOR SHARE;
  SELECT * INTO r FROM public.registrations WHERE id = o.surcharge_registration_id FOR UPDATE;
  SELECT * INTO v_to FROM public.competitions WHERE category_id = o.surcharge_to_category_id;

  -- The entry the surcharge was made for must still be where it was: confirmed, in the competition
  -- the change started from, and with no newer surcharge waiting (that one is the club's current
  -- intent). An entry that moved meanwhile was moved by something else (an entry moved between the
  -- plain read and the lock is caught here too, so the locks above never matter for it).
  IF r.status IS DISTINCT FROM 'confirmed' OR r.category_id IS DISTINCT FROM o.surcharge_from_category_id
     OR r.team_id IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.orders x
                 WHERE x.kind = 'surcharge' AND x.surcharge_registration_id = r.id AND x.id <> o.id
                   AND x.status = 'pending') THEN
    v_reason := 'entry_changed';
  ELSIF v_to.hidden_at IS NOT NULL OR v_to.kind <> 'individual' OR v_rs.state IS DISTINCT FROM 'published' THEN
    v_reason := 'unavailable';
  -- D3-7, confirm_order's rule and literal.
  ELSIF v_rs.closes_at IS NULL
     OR (now() >= v_rs.closes_at
         AND NOT (a.created_at < v_rs.closes_at AND now() < v_rs.closes_at + interval '5 minutes')) THEN
    v_reason := 'closed';
  ELSE
    -- The slot claim, the release and the entry's placement, all or nothing.
    BEGIN
      PERFORM public.registration_move_entry(r.id, o.surcharge_to_category_id);
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM = 'full' THEN
        v_reason := 'full';
      ELSIF SQLERRM IN ('ineligible', 'role_change', 'not_live', 'same_competition', 'not_found') THEN
        v_reason := 'entry_changed';
      ELSE
        RAISE;
      END IF;
    END;
  END IF;

  IF v_reason IS NOT NULL THEN
    PERFORM public.registration_drop_unpaid_order(o.id, o.status, v_reason);
    v_refund := public.registration_refund_attempt(o.id, a.id, p_grosze, 'late_refund', v_reason, p_source);
    RETURN jsonb_build_object('outcome', 'late_refund', 'refund', v_refund);
  END IF;

  -- The money model: price is everything paid for the entry, list_price the new competition's.
  UPDATE public.registrations SET price = price + o.total, list_price = o.surcharge_list_price WHERE id = r.id;
  UPDATE public.orders SET status = 'paid', paid_at = now(), paid_transaction_id = p_txn
   WHERE id = o.id AND status IN ('pending', 'expired');
  RETURN jsonb_build_object('outcome', 'surcharge_moved', 'orderId', o.id, 'registrationId', r.id);
END $$;
REVOKE EXECUTE ON FUNCTION public.registration_confirm_surcharge(uuid, uuid, text, integer, text)
  FROM public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- confirm_order (from 20261118110000)

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
  -- Changed here (competition change): a surcharge owns no registration. Its payment moves the
  -- entry it was made for, or is refunded in full; nothing below applies to it.
  IF o.kind = 'surcharge' THEN
    RETURN public.registration_confirm_surcharge(o.id, a.id, p_txn, p_grosze, p_source);
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

-- ---------------------------------------------------------------- change_competition (from 20261124110000)

CREATE OR REPLACE FUNCTION public.change_competition(p_registration_id uuid, p_to uuid, p_expected_difference integer,
                                          p_actor uuid, p_actor_kind text, p_request_key uuid,
                                          p_offline_ack boolean DEFAULT false)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  r         public.registrations%ROWTYPE;
  o         public.orders%ROWTYPE;
  v_rs      public.registration_settings%ROWTYPE;
  v_to      public.competitions%ROWTYPE;
  v_key     text := p_request_key::text;
  v_from    uuid;
  v_orders  uuid[];
  v_list    integer;
  v_pct     integer;
  v_price   integer;
  v_diff    integer;
  v_amount  integer;
  v_part    integer;
  v_n       integer := 0;
  v_res     jsonb;
  v_refunds jsonb := '[]'::jsonb;
  v_first   uuid;
  v_buyer   record;
  v_expires timestamptz;
  v_order   uuid;
  l         record;
BEGIN
  IF p_actor_kind IS NULL OR p_actor_kind NOT IN ('organizer', 'runner') THEN
    RAISE EXCEPTION 'invalid_kind';
  END IF;

  -- Plain reads: what to lock.
  SELECT * INTO r FROM public.registrations WHERE id = p_registration_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  v_from := r.category_id;

  -- 1. orders, by id: the entry's own, every surcharge of it, and any order holding a line of it.
  SELECT coalesce(array_agg(DISTINCT x ORDER BY x), '{}') INTO v_orders FROM (
    SELECT r.order_id
    UNION SELECT x.id FROM public.orders x WHERE x.kind = 'surcharge' AND x.surcharge_registration_id = r.id
    UNION SELECT ol.order_id FROM public.order_lines ol
           WHERE ol.registration_id = r.id AND ol.kind IN ('entry', 'surcharge')
  ) AS s(x) WHERE x IS NOT NULL;
  PERFORM 1 FROM public.orders WHERE id = ANY (v_orders) ORDER BY id FOR UPDATE;

  -- A replay of the request key returns what the first call reserved (under the order lock, so a
  -- concurrent first call has committed or not started). A split refund's later parts carry
  -- '<key>:<n>'.
  IF v_key IS NOT NULL AND EXISTS (SELECT 1 FROM public.refunds f WHERE f.request_key = v_key) THEN
    IF EXISTS (SELECT 1 FROM public.refunds f JOIN public.order_lines ol ON ol.id = f.order_line_id
                WHERE (f.request_key = v_key OR f.request_key LIKE v_key || ':%')
                  AND (ol.registration_id IS DISTINCT FROM r.id OR f.reason <> 'competition_change'
                       OR f.change_to_category_id IS DISTINCT FROM p_to)) THEN
      RAISE EXCEPTION 'request_key_mismatch';
    END IF;
    SELECT jsonb_agg(jsonb_build_object(
             'refundId', f.id, 'messageId', f.message_id, 'grosze', f.amount, 'status', f.dpay_status,
             'requestedAt', f.requested_at, 'respondedAt', f.responded_at,
             'transactionId', pa.dpay_transaction_id)
             ORDER BY (f.request_key = v_key) DESC, f.request_key),
           sum(f.amount)::integer
      INTO v_refunds, v_amount
      FROM public.refunds f JOIN public.payment_attempts pa ON pa.id = f.payment_attempt_id
     WHERE f.request_key = v_key OR f.request_key LIKE v_key || ':%';
    RETURN jsonb_build_object('outcome', 'refund', 'refundId', v_refunds->0->'refundId', 'grosze', v_amount,
                              'refunds', v_refunds, 'replay', true);
  END IF;

  -- 2. the paid attempts of those orders, 3. the entry's money lines.
  PERFORM 1 FROM public.payment_attempts pa JOIN public.orders x ON x.id = pa.order_id
   WHERE x.id = ANY (v_orders) AND x.status = 'paid' AND pa.dpay_transaction_id = x.paid_transaction_id
   ORDER BY pa.id FOR UPDATE OF pa;
  PERFORM 1 FROM public.order_lines ol
   WHERE ol.order_id = ANY (v_orders) AND ol.registration_id = r.id AND ol.kind IN ('entry', 'surcharge')
   ORDER BY ol.id FOR UPDATE;
  -- 4. both competitions, by category_id.
  PERFORM 1 FROM public.competitions WHERE category_id IN (v_from, p_to) ORDER BY category_id FOR UPDATE;
  SELECT * INTO v_to FROM public.competitions WHERE category_id = p_to;
  IF NOT FOUND OR v_to.event_id <> r.event_id THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  -- 5. settings, 6. the registration.
  SELECT * INTO v_rs FROM public.registration_settings WHERE event_id = r.event_id FOR SHARE;
  SELECT * INTO r FROM public.registrations WHERE id = p_registration_id FOR UPDATE;
  IF r.category_id IS DISTINCT FROM v_from THEN
    -- Moved between the plain read and the lock: the locks above may be the wrong ones.
    RAISE EXCEPTION 'change_retry' USING ERRCODE = '40001';
  END IF;
  IF r.order_id IS NOT NULL THEN
    SELECT * INTO o FROM public.orders WHERE id = r.order_id;
  END IF;

  -- Checks, with every lock held.
  IF r.status <> 'confirmed' THEN
    RAISE EXCEPTION 'not_live';
  END IF;
  IF r.team_id IS NOT NULL THEN
    RAISE EXCEPTION 'team_competition';
  END IF;
  IF v_rs.state <> 'published' OR v_rs.closes_at IS NULL OR clock_timestamp() >= v_rs.closes_at THEN
    RAISE EXCEPTION 'edits_closed';
  END IF;
  IF p_to = r.category_id THEN
    RAISE EXCEPTION 'same_competition';
  END IF;
  IF v_to.hidden_at IS NOT NULL OR v_to.kind <> 'individual' THEN
    RAISE EXCEPTION 'unavailable';
  END IF;
  IF public.registration_refund_in_flight(r.id) THEN
    RAISE EXCEPTION 'refund_pending';
  END IF;
  -- Changed here: a pending surcharge whose window has passed counts as expired; it is expired now
  -- (what expire_orders does to it: a surcharge holds no registration, voucher use or stock), so it
  -- no longer blocks. Its orders row is locked in step 1.
  PERFORM public.registration_expire_due_surcharges(r.id);
  IF EXISTS (SELECT 1 FROM public.orders x
              WHERE x.kind = 'surcharge' AND x.surcharge_registration_id = r.id AND x.status = 'pending') THEN
    RAISE EXCEPTION 'surcharge_open';
  END IF;
  IF EXISTS (SELECT 1 FROM public.transfers t
              WHERE t.registration_id = r.id AND t.status = 'pending' AND t.expires_at > now()) THEN
    RAISE EXCEPTION 'transfer_open';
  END IF;
  -- Raises ineligible / role_change; the result is re-derived by the move.
  PERFORM public.registration_competition_placement(p_to, r.birth_date, r.gender, r.email IS NULL,
                                                    v_rs.event_date, v_rs.age_reckoning);

  -- The target's list price: in the order's frozen tier (as a transfer prices it). An entry with no
  -- order (a free registration) can go only where the current tier asks nothing.
  IF r.order_id IS NULL THEN
    v_list := coalesce(public.registration_current_price(p_to), 0);
    IF v_list > 0 THEN
      RAISE EXCEPTION 'no_payer';
    END IF;
  ELSE
    v_list := public.registration_tier_price(p_to, o.tier_id);
    IF v_list IS NULL THEN
      RAISE EXCEPTION 'no_price';
    END IF;
  END IF;
  -- The entry's voucher keeps its discount only where it is offered (no competitions listed: all).
  IF r.voucher_id IS NOT NULL AND v_list > 0 THEN
    SELECT v.percent INTO v_pct FROM public.vouchers v
     WHERE v.id = r.voucher_id
       AND (NOT EXISTS (SELECT 1 FROM public.voucher_competitions vc WHERE vc.voucher_id = v.id)
            OR EXISTS (SELECT 1 FROM public.voucher_competitions vc WHERE vc.voucher_id = v.id AND vc.category_id = p_to));
  END IF;
  v_price := public.registration_discounted_price(v_list, v_pct);
  v_diff := v_price - (r.price - r.refunded);
  IF p_expected_difference IS DISTINCT FROM v_diff THEN
    RAISE EXCEPTION 'price_changed:%', v_diff;
  END IF;

  -- D = 0: move now.
  IF v_diff = 0 THEN
    PERFORM public.registration_move_entry(r.id, p_to);
    UPDATE public.registrations SET list_price = v_list WHERE id = r.id;
    RETURN jsonb_build_object('outcome', 'moved', 'grosze', 0);
  END IF;

  -- D < 0: move now, the difference goes back.
  IF v_diff < 0 THEN
    v_amount := -v_diff;
    IF o.id IS NULL THEN
      RAISE EXCEPTION 'no_payer';
    END IF;
    IF o.paid_offline_at IS NOT NULL THEN
      -- Paid outside LESZY.RUN: the club gives the difference back by hand, so no refunds row; the
      -- entry books it as refunded so price − refunded stays the new price.
      IF NOT coalesce(p_offline_ack, false) THEN
        RAISE EXCEPTION 'offline_paid';
      END IF;
      PERFORM public.registration_move_entry(r.id, p_to);
      UPDATE public.registrations SET list_price = v_list, refunded = refunded + v_amount WHERE id = r.id;
      RETURN jsonb_build_object('outcome', 'moved_offline_refund', 'grosze', v_amount);
    END IF;
    IF v_rs.event_date IS NULL OR now() >= public.registration_refund_cutoff(v_rs.event_date) THEN
      RAISE EXCEPTION 'race_day';
    END IF;
    PERFORM public.registration_move_entry(r.id, p_to);
    UPDATE public.registrations SET list_price = v_list WHERE id = r.id;
    -- The newest paid order first, its surcharge line before an entry line; split over orders only
    -- when one does not hold enough. reserve_organizer_refund adds each part to the line's and the
    -- entry's refunded and refuses what its own caps refuse.
    FOR l IN
      SELECT ol.id, ol.amount - ol.refunded AS money_left, pa.id AS attempt_id, pa.grosze AS attempt_grosze
        FROM public.order_lines ol
        JOIN public.orders x ON x.id = ol.order_id
        JOIN public.payment_attempts pa ON pa.order_id = x.id AND pa.dpay_transaction_id = x.paid_transaction_id
       WHERE ol.order_id = ANY (v_orders) AND ol.registration_id = r.id AND ol.kind IN ('entry', 'surcharge')
         AND x.status = 'paid' AND x.paid_transaction_id IS NOT NULL AND ol.amount > ol.refunded
       ORDER BY x.paid_at DESC, (ol.kind = 'surcharge') DESC, ol.id
    LOOP
      EXIT WHEN v_amount = 0;
      v_part := least(v_amount, l.money_left, l.attempt_grosze - public.registration_attempt_refunds_held(l.attempt_id));
      CONTINUE WHEN v_part <= 0;
      v_res := public.reserve_organizer_refund(l.id, v_part, p_actor,
                 CASE WHEN v_key IS NULL THEN NULL WHEN v_n = 0 THEN v_key ELSE v_key || ':' || (v_n + 1) END, r.id);
      UPDATE public.refunds SET reason = 'competition_change', change_to_category_id = p_to
       WHERE id = (v_res->>'refundId')::uuid;
      v_first := coalesce(v_first, (v_res->>'refundId')::uuid);
      v_refunds := v_refunds || jsonb_build_object(
        'refundId', v_res->'refundId', 'messageId', v_res->'messageId', 'grosze', v_part, 'status', 'pending',
        'requestedAt', NULL, 'respondedAt', NULL, 'transactionId', v_res->'transactionId');
      v_amount := v_amount - v_part;
      v_n := v_n + 1;
    END LOOP;
    IF v_amount > 0 THEN
      -- The entry's money is not on a paid line of it: nothing can be given back through dpay.
      RAISE EXCEPTION 'no_payer';
    END IF;
    RETURN jsonb_build_object('outcome', 'refund', 'refundId', v_first, 'grosze', -v_diff, 'refunds', v_refunds);
  END IF;

  -- D > 0: a surcharge order; the entry moves when it is paid (confirm_order, task 4).
  IF r.order_id IS NULL THEN
    RAISE EXCEPTION 'no_payer';
  END IF;
  -- Spec 14.10: online payment stops an hour before registration closes.
  IF now() >= v_rs.closes_at - interval '1 hour' THEN
    RAISE EXCEPTION 'paying_closed';
  END IF;
  -- Nothing is claimed now, but a surcharge into a full competition could only be refunded.
  IF v_to.taken + 1 > v_to.capacity THEN
    RAISE EXCEPTION 'full';
  END IF;
  SELECT * INTO v_buyer FROM public.registration_surcharge_buyer(r.id);
  IF v_buyer.profile_id IS NULL AND v_buyer.email IS NULL THEN
    RAISE EXCEPTION 'no_payer';
  END IF;
  v_expires := CASE WHEN v_rs.payment_window_until_close THEN v_rs.closes_at
                    ELSE least(now() + make_interval(hours => v_rs.payment_window_hours), v_rs.closes_at) END;
  BEGIN
    INSERT INTO public.orders (
      event_id, buyer_profile_id, buyer_email, buyer_name, status, entry_total, extras_total, donation, total,
      tier_id, expires_at, kind, surcharge_registration_id, surcharge_from_category_id, surcharge_to_category_id,
      surcharge_list_price, surcharge_price)
    VALUES (
      r.event_id, v_buyer.profile_id, v_buyer.email, v_buyer.name, 'pending', v_diff, 0, 0, v_diff,
      o.tier_id, v_expires, 'surcharge', r.id, r.category_id, p_to, v_list, v_price)
    RETURNING id INTO v_order;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'surcharge_open';
  END;
  INSERT INTO public.order_lines (order_id, kind, registration_id, qty, amount)
  VALUES (v_order, 'surcharge', r.id, 1, v_diff);
  RETURN jsonb_build_object('outcome', 'surcharge', 'orderId', v_order, 'grosze', v_diff, 'expiresAt', v_expires);
END $$;

-- ---------------------------------------------------------------- apply_transfer (from 20261109200000)

CREATE OR REPLACE FUNCTION public.apply_transfer(p_registration_id uuid, p_person jsonb, p_category_id uuid,
                                      p_profile_id uuid, p_consent jsonb, p_kind text,
                                      p_actor uuid DEFAULT NULL, p_transfer_id uuid DEFAULT NULL)
  RETURNS jsonb
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
DECLARE
  c_live      constant text[] := ARRAY['pending_payment', 'confirmed'];
  r           public.registrations%ROWTYPE;
  v_rec       public.registrations%ROWTYPE;
  o           public.orders%ROWTYPE;
  v_rs        public.registration_settings%ROWTYPE;
  v_comp      public.competitions%ROWTYPE;
  v_team      public.teams%ROWTYPE;
  v_email     text := lower(btrim(p_person->>'email'));
  v_birth     date;
  v_rec_order uuid;
  v_orders    uuid[];
  v_cats      uuid[];
  v_price     integer;
  v_sent      uuid[];
  v_have      uuid[];
  v_ip        inet;
  v_ua        text := left(nullif(p_consent->>'userAgent', ''), 500);
  v_new       uuid;
  v_part      uuid;
  v_host      boolean := false;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('runner', 'organizer') THEN
    RAISE EXCEPTION 'invalid_kind';
  END IF;
  IF jsonb_typeof(p_person) IS DISTINCT FROM 'object'
     OR nullif(btrim(p_person->>'firstName'), '') IS NULL OR nullif(btrim(p_person->>'lastName'), '') IS NULL
     OR v_email IS NULL OR v_email = '' OR nullif(p_person->>'birthDate', '') IS NULL THEN
    RAISE EXCEPTION 'invalid_person';
  END IF;
  -- The shape transfers.to_email and the organizer's record need (m-4), refused before any work.
  IF char_length(v_email) > 254 OR v_email NOT LIKE '%_@_%' OR v_email ~ '\s' THEN
    RAISE EXCEPTION 'invalid_email';
  END IF;
  BEGIN
    v_birth := (p_person->>'birthDate')::date;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'invalid_person';
  END;

  -- Plain reads: what to lock.
  SELECT * INTO r FROM public.registrations WHERE id = p_registration_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  SELECT x.order_id INTO v_rec_order FROM public.registrations x
   WHERE x.event_id = r.event_id AND x.email IS NOT NULL AND lower(x.email) = v_email
     AND x.status = 'pending_payment' AND x.order_id IS NOT NULL
   LIMIT 1;

  -- 1. orders, by id. Changed here: with every surcharge order of the entry (made for it, or holding
  --    a surcharge line of it after an earlier transfer).
  SELECT coalesce(array_agg(DISTINCT x ORDER BY x), '{}') INTO v_orders FROM (
    SELECT u.x FROM unnest(ARRAY[r.order_id, v_rec_order]) AS u(x)
    UNION SELECT y.id FROM public.orders y WHERE y.kind = 'surcharge' AND y.surcharge_registration_id = r.id
    UNION SELECT ol.order_id FROM public.order_lines ol WHERE ol.registration_id = r.id AND ol.kind = 'surcharge'
  ) AS s(x) WHERE x IS NOT NULL;
  PERFORM 1 FROM public.orders WHERE id = ANY (v_orders) ORDER BY id FOR UPDATE;
  -- 2. the old entry's lines.
  IF r.order_id IS NOT NULL THEN
    SELECT * INTO o FROM public.orders WHERE id = r.order_id;
    -- Changed here: with the entry's paid surcharge lines on other orders.
    PERFORM 1 FROM public.order_lines
     WHERE registration_id = r.id
       AND ((order_id = r.order_id AND kind IN ('entry', 'extra')) OR (order_id = ANY (v_orders) AND kind = 'surcharge'))
     ORDER BY id FOR UPDATE;
  END IF;
  -- 3. every competition involved (the recipient's order's hold no slot, P3-R15, but take the one
  --    lock pattern), by category_id.
  SELECT coalesce(array_agg(DISTINCT x ORDER BY x), '{}') INTO v_cats FROM (
    SELECT r.category_id UNION SELECT p_category_id
    UNION SELECT y.category_id FROM public.registrations y WHERE v_rec_order IS NOT NULL AND y.order_id = v_rec_order
  ) AS s(x) WHERE x IS NOT NULL;
  PERFORM 1 FROM public.competitions WHERE category_id = ANY (v_cats) ORDER BY category_id FOR UPDATE;
  SELECT * INTO v_comp FROM public.competitions WHERE category_id = p_category_id;
  IF NOT FOUND OR v_comp.event_id <> r.event_id THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  -- 4. settings, 5. the team.
  SELECT * INTO v_rs FROM public.registration_settings WHERE event_id = r.event_id FOR SHARE;
  IF r.team_id IS NOT NULL THEN
    SELECT * INTO v_team FROM public.teams WHERE id = r.team_id FOR UPDATE;
  END IF;
  -- 6. vouchers by id: the old entry's (the new row's foreign key reads it) together with those the
  --    recipient's unpaid order would give back; then that order's variants by id; then the
  --    partner the new row's foreign key reads (m-1).
  PERFORM 1 FROM public.vouchers v
   WHERE v.id = r.voucher_id
      OR (v_rec_order IS NOT NULL AND v.id IN (SELECT y.voucher_id FROM public.registrations y
                                                WHERE y.order_id = v_rec_order AND y.status = 'pending_payment'))
   ORDER BY v.id
     FOR UPDATE;
  IF v_rec_order IS NOT NULL THEN
    PERFORM public.registration_lock_unpaid_cart(ARRAY[v_rec_order]);
  END IF;
  IF r.partner_id IS NOT NULL THEN
    PERFORM 1 FROM public.event_partners WHERE id = r.partner_id FOR KEY SHARE;
  END IF;
  -- 7. the registrations, by id.
  PERFORM 1 FROM public.registrations
   WHERE id = r.id OR (v_rec_order IS NOT NULL AND order_id = v_rec_order)
   ORDER BY id FOR UPDATE;
  SELECT * INTO r FROM public.registrations WHERE id = p_registration_id;

  -- Checks, with every lock held.
  IF p_transfer_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.transfers t
        WHERE t.id = p_transfer_id AND t.registration_id = r.id AND t.status = 'pending' AND t.expires_at > now()) THEN
    RAISE EXCEPTION 'gone';
  END IF;
  IF r.status <> 'confirmed' THEN
    RAISE EXCEPTION 'gone';
  END IF;
  IF public.registration_refund_in_flight(r.id) THEN
    RAISE EXCEPTION 'refund_pending';
  END IF;
  -- Changed here (competition change): a pending surcharge would move the entry the new holder
  -- takes; one past its window is expired instead (its order row is locked in step 1).
  PERFORM public.registration_expire_due_surcharges(r.id);
  IF EXISTS (SELECT 1 FROM public.orders x
              WHERE x.kind = 'surcharge' AND x.surcharge_registration_id = r.id AND x.status = 'pending') THEN
    RAISE EXCEPTION 'surcharge_open';
  END IF;
  -- I-1: an open invite follows the organizer's switch and date (§5.4). The settings row is held FOR
  -- SHARE, so a save of the payments section waits for this accept or this accept sees it.
  IF p_kind = 'runner'
     AND (NOT v_rs.transfer_enabled OR v_rs.transfer_until IS NULL
          OR (now() AT TIME ZONE 'Europe/Warsaw')::date > v_rs.transfer_until) THEN
    RAISE EXCEPTION 'transfer_off';
  END IF;
  IF r.email IS NULL OR r.guardian_profile_id IS NOT NULL
     OR r.birth_date IS NULL OR r.birth_date > (v_rs.event_date - interval '18 years')::date
     OR (r.team_id IS NOT NULL AND v_team.captain_registration_id IS DISTINCT FROM r.id) THEN
    RAISE EXCEPTION 'not_transferable';
  END IF;
  IF v_email = lower(btrim(r.email)) THEN
    RAISE EXCEPTION 'same_person';
  END IF;
  IF v_birth > (v_rs.event_date - interval '18 years')::date THEN
    RAISE EXCEPTION 'recipient_minor';
  END IF;
  IF (r.team_id IS NOT NULL AND p_category_id <> r.category_id)
     OR (r.team_id IS NULL AND v_comp.kind = 'team') THEN
    RAISE EXCEPTION 'team_competition';
  END IF;
  IF p_category_id <> r.category_id AND v_comp.hidden_at IS NOT NULL THEN
    RAISE EXCEPTION 'unavailable';
  END IF;
  -- Ruling 2: the target's list price in the old order's frozen tier.
  v_price := CASE WHEN o.tier_id IS NULL THEN 0 ELSE public.registration_tier_price(p_category_id, o.tier_id) END;
  IF v_price IS DISTINCT FROM r.list_price THEN
    RAISE EXCEPTION 'price_differs';
  END IF;
  IF p_kind = 'runner' THEN
    IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_profile_id AND lower(btrim(p.email)) = v_email) THEN
      RAISE EXCEPTION 'profile_mismatch';
    END IF;
    IF jsonb_typeof(p_consent) IS DISTINCT FROM 'object' OR (p_consent->'serviceRegulamin') IS DISTINCT FROM 'true'::jsonb THEN
      RAISE EXCEPTION 'consents_required';
    END IF;
    IF jsonb_typeof(coalesce(p_consent->'consentIds', '[]'::jsonb)) <> 'array'
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(p_consent->'consentIds', '[]'::jsonb)) AS t(e)
                   WHERE jsonb_typeof(e) <> 'string'
                      OR (e #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
      RAISE EXCEPTION 'consents_changed';
    END IF;
    -- Changed here: the recipient is an adult, so no minors_only consent.
    SELECT coalesce(array_agg(DISTINCT x::uuid ORDER BY x::uuid), '{}') INTO v_sent
      FROM jsonb_array_elements_text(coalesce(p_consent->'consentIds', '[]'::jsonb)) AS t(x);
    SELECT coalesce(array_agg(ec.id ORDER BY ec.id), '{}') INTO v_have
      FROM public.event_consents ec WHERE ec.event_id = r.event_id AND NOT ec.minors_only;
    IF v_sent IS DISTINCT FROM v_have THEN
      RAISE EXCEPTION 'consents_changed';
    END IF;
  END IF;

  -- The recipient's own live entry, read again under the locks.
  SELECT * INTO v_rec FROM public.registrations x
   WHERE x.event_id = r.event_id AND x.email IS NOT NULL AND lower(x.email) = v_email AND x.status = ANY (c_live)
   LIMIT 1;
  IF FOUND THEN
    IF v_rec.status = 'confirmed' THEN
      RAISE EXCEPTION 'duplicate';
    END IF;
    IF v_rec.order_id IS NULL OR v_rec.order_id IS DISTINCT FROM v_rec_order THEN
      RAISE EXCEPTION 'transfer_retry' USING ERRCODE = '40001';
    END IF;
    IF (SELECT count(*) FROM public.registrations x WHERE x.order_id = v_rec.order_id) > 1 THEN
      RAISE EXCEPTION 'pending_elsewhere';
    END IF;
    -- §2: an unpaid entry alone in its order is replaced. It held no slot (P3-R15); its voucher
    -- uses and stock go back (D7-18). Every lock it needs is held.
    PERFORM public.cancel_order(v_rec.order_id, 'transfer_accepted');
  END IF;

  -- 3. the new registration, with the old one's money.
  BEGIN
    v_ip := nullif(p_consent->>'ip', '')::inet;
  EXCEPTION WHEN others THEN
    v_ip := NULL;
  END;
  BEGIN
    v_new := public.registration_group_insert(
      v_rs,
      p_person || jsonb_build_object('categoryId', p_category_id,
                                     'role', CASE WHEN p_kind = 'runner' THEN 'self' ELSE 'adult' END,
                                     'email', v_email),
      0, coalesce(p_actor, p_profile_id), NULL, NULL, r.order_id, 'confirmed', r.price, v_ip, v_ua,
      r.list_price, r.voucher_id, r.partner_id);
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'duplicate:%' THEN
      RAISE EXCEPTION 'duplicate';
    END IF;
    RAISE;
  END;
  UPDATE public.registrations
     SET team_id = r.team_id, team_position = r.team_position, refunded = r.refunded
   WHERE id = v_new;
  -- Carry from task 2: the captain role moves before the old row leaves live.
  IF r.team_id IS NOT NULL THEN
    UPDATE public.teams SET captain_registration_id = v_new WHERE id = r.team_id AND captain_registration_id = r.id;
  END IF;

  -- 4. the old registration leaves live (the refunded amount goes with the line).
  UPDATE public.registrations SET status = 'transferred_out', refunded = 0
   WHERE id = r.id AND status = 'confirmed';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'gone';
  END IF;
  IF r.team_leg IS NOT NULL THEN
    UPDATE public.registrations SET team_leg = r.team_leg WHERE id = v_new;
  END IF;

  -- 5. the lines follow.
  IF r.order_id IS NOT NULL THEN
    UPDATE public.order_lines SET registration_id = v_new
     WHERE order_id = r.order_id AND registration_id = r.id AND kind IN ('entry', 'extra');
    -- Changed here: a paid surcharge is part of the entry's price (registrations.price, copied
    -- above), so its line follows too. orders.surcharge_registration_id keeps naming the entry the
    -- move was paid for.
    UPDATE public.order_lines SET registration_id = v_new
     WHERE order_id = ANY (v_orders) AND registration_id = r.id AND kind = 'surcharge';
  END IF;

  -- 6. a confirmed slot moves, with no capacity check (§4.8).
  IF p_category_id <> r.category_id THEN
    UPDATE public.competitions SET taken = taken - 1 WHERE category_id = r.category_id;
    UPDATE public.competitions SET taken = taken + 1 WHERE category_id = p_category_id;
  END IF;

  -- 7. participants (§14.3, D7-24).
  IF r.participant_id IS NOT NULL THEN
    IF v_rs.closes_at IS NOT NULL AND clock_timestamp() < v_rs.closes_at THEN
      UPDATE public.participants SET removed_at = now(), updated_at = now()
       WHERE id = r.participant_id AND removed_at IS NULL;
    ELSE
      INSERT INTO public.operator_alerts (kind, order_id, payload, dedupe_key)
      SELECT 'host_withdraw', r.order_id,
             jsonb_build_object('reason', 'transfer', 'registrationId', r.id, 'eventId', r.event_id,
                                'bib', p.bib_number),
             'host_withdraw:transfer:' || r.id
        FROM public.participants p WHERE p.id = r.participant_id
      ON CONFLICT ON CONSTRAINT operator_alerts_dedupe_key_key DO NOTHING;
      v_host := true;
    END IF;
  END IF;
  v_part := public.insert_registration_participant(v_new);

  RETURN jsonb_build_object(
    'registrationId', v_new, 'oldRegistrationId', r.id, 'participantId', v_part, 'hostWithdraw', v_host,
    'senderProfileId', r.profile_id, 'senderEmail', r.email, 'eventId', r.event_id, 'orderId', r.order_id);
END $$;

-- ---------------------------------------------------------------- finish_organizer_refund (from 20261102102000)

CREATE OR REPLACE FUNCTION public.finish_organizer_refund(p_refund_id uuid, p_outcome text) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  f        public.refunds%ROWTYPE;
  a        public.payment_attempts%ROWTYPE;
  l        public.order_lines%ROWTYPE;
  v_status text;
  v_out    jsonb;
  v_cancel jsonb := '[]'::jsonb;
  v_host   boolean := false;
  v_state  text;
  v_err    text;
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('pending', 'accepted', 'rejected', 'insufficient_balance', 'unknown') THEN
    RAISE EXCEPTION 'invalid_outcome';
  END IF;
  SELECT * INTO f FROM public.refunds WHERE id = p_refund_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF f.kind <> 'organizer' OR f.order_line_id IS NULL THEN
    RAISE EXCEPTION 'not_organizer';
  END IF;

  PERFORM 1 FROM public.orders WHERE id = f.order_id FOR UPDATE;
  SELECT * INTO a FROM public.payment_attempts WHERE id = f.payment_attempt_id FOR UPDATE;
  SELECT * INTO l FROM public.order_lines WHERE id = f.order_line_id FOR UPDATE;

  UPDATE public.refunds
     SET dpay_status = p_outcome, responded_at = now(), next_retry_at = NULL
   WHERE id = p_refund_id AND dpay_status IN ('pending', 'unknown')
  RETURNING * INTO f;
  IF NOT FOUND THEN
    SELECT dpay_status INTO v_status FROM public.refunds WHERE id = p_refund_id;
    RETURN jsonb_build_object('status', v_status, 'settled', 'already_settled',
                              'cancelled', '[]'::jsonb, 'hostWithdraw', false);
  END IF;

  IF p_outcome IN ('rejected', 'insufficient_balance') THEN
    UPDATE public.order_lines SET refunded = refunded - f.amount WHERE id = l.id;
    -- Changed here: reserve_organizer_refund adds a surcharge line's reservation to the entry too.
    IF l.kind IN ('entry', 'surcharge') THEN
      UPDATE public.registrations SET refunded = refunded - f.amount WHERE id = l.registration_id;
    END IF;
  ELSIF p_outcome = 'accepted' THEN
    UPDATE public.payment_attempts SET status = 'refunded'
     WHERE id = a.id
       AND (SELECT coalesce(sum(x.amount), 0) FROM public.refunds x
             WHERE x.payment_attempt_id = a.id AND x.dpay_status = 'accepted') >= a.grosze;
    -- Changed here: money that left for ALL of the entry ends it (registrations.price is everything
    -- paid for it, its entry line and any paid surcharge; refunded everything given back), once no
    -- other refund of it is still in flight: a reservation alone never does. A refund of the price
    -- difference of a competition change never ends the entry: it moved and stays.
    IF l.kind IN ('entry', 'surcharge')
       AND f.reason IS DISTINCT FROM 'competition_change'
       AND EXISTS (SELECT 1 FROM public.registrations x
                    WHERE x.id = l.registration_id AND x.status = 'confirmed' AND x.refunded >= x.price)
       AND NOT public.registration_refund_in_flight(l.registration_id) THEN
      -- Review fix 2: dpay has moved the money, so the acceptance is stored whatever happens to the
      -- cancellation. A cancel that fails rolls back alone (a subtransaction), is alerted and leaves
      -- the entry for the operator.
      BEGIN
        v_out := public.cancel_registration(l.registration_id, 'refund', f.requested_by);
        v_cancel := v_out->'cancelled';
        v_host := (v_out->>'hostWithdraw')::boolean;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_err = MESSAGE_TEXT;
        INSERT INTO public.operator_alerts (kind, order_id, payload, dedupe_key)
        VALUES ('refund_cancel_failed', f.order_id, jsonb_build_object(
          'refundId', f.id, 'registrationId', l.registration_id, 'error', left(v_err, 200), 'sqlstate', v_state),
          'refund_cancel_failed:' || f.id)
        ON CONFLICT ON CONSTRAINT operator_alerts_dedupe_key_key DO NOTHING;
      END;
    END IF;
  END IF;

  RETURN jsonb_build_object('status', p_outcome, 'settled', 'settled', 'cancelled', v_cancel, 'hostWithdraw', v_host);
END $$;

-- ---------------------------------------------------------------- record_external_refund (from 20261110400000)

CREATE OR REPLACE FUNCTION public.record_external_refund(p_line_id uuid, p_grosze integer, p_note text,
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
  -- Changed here: a surcharge line's money is the entry's too.
  IF l.kind IN ('entry', 'surcharge') THEN
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

-- ---------------------------------------------------------------- organizer_mark_paid_offline (from 20261118110000)

CREATE OR REPLACE FUNCTION public.organizer_mark_paid_offline(p_order_id uuid, p_actor uuid, p_note text) RETURNS jsonb
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
  -- Changed here: a surcharge confirmed here would be paid without moving its entry.
  IF o.kind = 'surcharge' THEN
    RAISE EXCEPTION 'surcharge';
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

-- ---------------------------------------------------------------- release_orphan_orders (from 20261103130000)

CREATE OR REPLACE FUNCTION public.release_orphan_orders(p_now timestamptz DEFAULT now()) RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  r     record;
  v_ids uuid[];
  v_n   integer := 0;
BEGIN
  SELECT coalesce(array_agg(x.id ORDER BY x.id), '{}') INTO v_ids FROM (
    SELECT o.id FROM public.orders o
     WHERE o.status = 'pending' AND o.kind = 'registration' AND o.created_at <= p_now - interval '15 minutes'
       AND NOT EXISTS (SELECT 1 FROM public.payment_attempts a WHERE a.order_id = o.id)
     ORDER BY o.id
       FOR UPDATE OF o SKIP LOCKED) x;
  -- The loop's subtransactions keep their locks, so take them all in id order first. In its own
  -- subtransaction: a lock timeout here only loses that ordering, never the run (each order below
  -- still fails alone and is alerted).
  BEGIN
    PERFORM public.registration_lock_unpaid_cart(v_ids);
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  FOR r IN SELECT unnest(v_ids) AS id LOOP
    BEGIN
      UPDATE public.orders o
         SET status = 'cancelled', cancelled_reason = 'no_payment_attempt', cancelled_at = now()
       WHERE o.id = r.id AND o.status = 'pending' AND o.kind = 'registration'
         AND NOT EXISTS (SELECT 1 FROM public.payment_attempts a WHERE a.order_id = o.id);
      IF FOUND THEN
        PERFORM public.registration_release_unpaid(ARRAY[r.id]);
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

-- ---------------------------------------------------------------- create_order (from 20261103120000)

CREATE OR REPLACE FUNCTION public.create_order(
  p_people jsonb, p_profile_id uuid, p_buyer_email text,
  p_displayed_total integer, p_meta jsonb)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_lock      record;
  v_rs        public.registration_settings%ROWTYPE;
  v_cats      uuid[];
  v_tier      uuid;
  v_tier_ends date;
  v_label     text;
  v_prices    jsonb := '{}'::jsonb;
  v_price     integer;
  v_entry     bigint := 0;
  v_total     bigint;
  v_free      boolean;
  v_buyer     text;
  v_profile   uuid;
  v_name      text;
  v_order     uuid;
  v_expires   timestamptz;
  v_person    jsonb;
  v_idx       bigint;
  v_reg       uuid;
  v_regs      uuid[] := '{}';
  v_out       jsonb := '[]'::jsonb;
  v_ip        inet;
  v_ua        text := left(nullif(p_meta->>'userAgent', ''), 500);
  u           record;
  v_n         integer;
  v_cat       uuid[];
  v_list      integer[];
  v_code      text[];
  v_vid       uuid[];
  v_pct       integer[];
  v_partner   uuid[];
  v_voucher   public.vouchers%ROWTYPE;
  v_refusal   text;
  v_claim     record;
  v_items     jsonb;
  v_x         jsonb;
  v_extras    bigint := 0;
  v_donation  integer;
BEGIN
  IF jsonb_typeof(p_people) IS DISTINCT FROM 'array' OR jsonb_array_length(p_people) = 0 THEN
    RAISE EXCEPTION 'invalid_people';
  END IF;

  -- P3-R4: an order belongs to a signed-in account, and its buyer address is that
  -- account's address. p_buyer_email is only checked against it.
  SELECT p.id, lower(btrim(p.email)) INTO v_profile, v_buyer FROM public.profiles p WHERE p.id = p_profile_id;
  IF v_profile IS NULL OR v_buyer IS NULL OR v_buyer = '' THEN
    RAISE EXCEPTION 'session_required';
  END IF;
  IF p_buyer_email IS NOT NULL AND lower(btrim(p_buyer_email)) IS DISTINCT FROM v_buyer THEN
    RAISE EXCEPTION 'invalid_buyer_email';
  END IF;

  -- D3-1: the competitions (category_id order), then the settings.
  SELECT * INTO v_lock FROM public.registration_group_lock(p_people, p_meta);
  v_rs := v_lock.o_settings;
  v_cats := v_lock.o_cats;
  IF EXISTS (SELECT 1 FROM public.competitions c WHERE c.category_id = ANY (v_cats) AND c.kind = 'team') THEN
    RAISE EXCEPTION 'team_competition';
  END IF;

  -- Plain reads from here to the claims: the donation, the extras, the codes.
  v_n := jsonb_array_length(p_people);
  v_donation := public.registration_donation(v_rs, p_meta);
  v_items := public.registration_extra_items(v_rs, p_people);
  -- Ruling 7: a free event takes an order only for extras or a donation.
  IF v_rs.pricing_mode = 'free' AND jsonb_array_length(v_items) = 0 AND v_donation = 0 THEN
    RAISE EXCEPTION 'free_event';
  END IF;

  -- The current tier; every person at their own competition's price in it (0 on a free event).
  -- v_prices is keyed by the canonical uuid text, so every lookup casts the person's
  -- categoryId through uuid (an uppercase id prices like a lowercase one).
  IF v_rs.pricing_mode <> 'free' THEN
    SELECT t.o_id, t.o_ends_on, t.o_label INTO v_tier, v_tier_ends, v_label
      FROM public.registration_current_tier(v_rs.event_id) t;
  END IF;
  FOR u IN SELECT c AS category_id FROM unnest(v_cats) AS c LOOP
    v_price := CASE WHEN v_rs.pricing_mode = 'free' THEN 0 ELSE public.registration_current_price(u.category_id) END;
    IF v_price IS NULL THEN
      RAISE EXCEPTION 'no_price';
    END IF;
    v_prices := v_prices || jsonb_build_object(u.category_id::text, v_price);
  END LOOP;

  v_cat := array_fill(NULL::uuid, ARRAY[v_n]);
  v_list := array_fill(NULL::integer, ARRAY[v_n]);
  v_code := array_fill(NULL::text, ARRAY[v_n]);
  v_vid := array_fill(NULL::uuid, ARRAY[v_n]);
  v_pct := array_fill(NULL::integer, ARRAY[v_n]);
  v_partner := array_fill(NULL::uuid, ARRAY[v_n]);
  FOR v_person, v_idx IN SELECT value, ordinality FROM jsonb_array_elements(p_people) WITH ORDINALITY LOOP
    v_cat[v_idx] := (v_person->>'categoryId')::uuid;
    v_list[v_idx] := (v_prices->>(v_cat[v_idx]::text))::integer;
    CONTINUE WHEN nullif(btrim(v_person->>'voucherCode'), '') IS NULL;
    v_code[v_idx] := public.registration_normalize_code(v_person->>'voucherCode');
    v_voucher := NULL;
    IF v_code[v_idx] IS NOT NULL THEN
      SELECT * INTO v_voucher FROM public.vouchers x WHERE x.event_id = v_rs.event_id AND x.code = v_code[v_idx];
    END IF;
    v_refusal := public.registration_voucher_refusal(v_voucher, v_cat[v_idx]);
    IF v_refusal IS NOT NULL THEN
      RAISE EXCEPTION '%:%', v_refusal, v_idx - 1;
    END IF;
    -- A code discounts nothing on a 0 zł entry: refused, so no use is spent and no partner credited.
    IF v_list[v_idx] = 0 THEN
      RAISE EXCEPTION 'voucher_not_applicable:%', v_idx - 1;
    END IF;
    v_vid[v_idx] := v_voucher.id;
    v_pct[v_idx] := v_voucher.percent;
  END LOOP;

  FOR v_idx IN 1 .. v_n LOOP
    v_entry := v_entry + public.registration_discounted_price(v_list[v_idx], v_pct[v_idx]);
  END LOOP;
  SELECT coalesce(sum((x->>'price')::bigint * (x->>'qty')::bigint), 0) INTO v_extras FROM jsonb_array_elements(v_items) x;
  v_total := v_entry + v_extras + v_donation;
  IF v_total > 99999999 THEN
    RAISE EXCEPTION 'invalid_amount:total' USING ERRCODE = '22023';
  END IF;
  v_free := v_total = 0;

  -- Spec 14.10: online payment stops an hour before registration closes.
  IF NOT v_free AND now() >= v_rs.closes_at - interval '1 hour' THEN
    RAISE EXCEPTION 'paying_closed';
  END IF;

  -- At most two payable orders per account and event; a group is one order.
  PERFORM pg_advisory_xact_lock(hashtext('create_order:' || v_profile::text || ':' || v_rs.event_id::text));
  IF (SELECT count(*) FROM public.orders o
       WHERE o.event_id = v_rs.event_id AND o.status = 'pending' AND o.expires_at > now()
         AND o.buyer_profile_id = v_profile AND o.kind = 'registration') >= 2 THEN
    RAISE EXCEPTION 'too_many_pending';
  END IF;

  IF p_displayed_total IS DISTINCT FROM v_total THEN
    RAISE EXCEPTION 'price_changed:%', v_total;
  END IF;

  -- P3-R15: an order waiting for payment claims nothing; it is refused when the paid
  -- entries plus the group's people in a competition pass its limit. A 0 zł order is
  -- confirmed here, so it claims now, as register_free does.
  IF v_free THEN
    PERFORM public.registration_group_claim(p_people);
  ELSE
    FOR u IN
      SELECT c.category_id FROM public.competitions c
        JOIN (SELECT (e->>'categoryId')::uuid AS category_id, count(*) AS n
                FROM jsonb_array_elements(p_people) AS e GROUP BY 1) g ON g.category_id = c.category_id
       WHERE c.taken + g.n > c.capacity
       ORDER BY c.category_id LIMIT 1
    LOOP
      RAISE EXCEPTION 'full:%', u.category_id;
    END LOOP;
  END IF;

  -- The voucher uses, in voucher-id order, then person order.
  FOR u IN SELECT t.i::integer AS i FROM unnest(v_vid) WITH ORDINALITY AS t(vid, i)
            WHERE t.vid IS NOT NULL ORDER BY t.vid, t.i LOOP
    SELECT * INTO v_claim FROM public.registration_claim_voucher_at(v_rs.event_id, v_vid[u.i], v_code[u.i], v_cat[u.i], u.i - 1);
    v_vid[u.i] := v_claim.o_id;
    v_pct[u.i] := v_claim.o_percent;
    v_partner[u.i] := v_claim.o_partner_id;
  END LOOP;
  -- A percent edited between the read and the claim re-prices the order.
  IF (SELECT sum(public.registration_discounted_price(v_list[i], v_pct[i])) FROM generate_series(1, v_n) i) <> v_entry THEN
    RAISE EXCEPTION 'price_changed:%',
      (SELECT sum(public.registration_discounted_price(v_list[i], v_pct[i])) FROM generate_series(1, v_n) i)
      + v_extras + v_donation;
  END IF;

  -- The stock, in variant-id order.
  PERFORM public.registration_claim_extras(v_items);

  v_expires := CASE WHEN v_rs.payment_window_until_close THEN v_rs.closes_at
                    ELSE least(now() + make_interval(hours => v_rs.payment_window_hours), v_rs.closes_at) END;
  INSERT INTO public.orders (
    event_id, buyer_profile_id, buyer_email, status, entry_total, extras_total, donation,
    total, tier_id, expires_at, paid_at)
  VALUES (
    v_rs.event_id, v_profile, v_buyer, CASE WHEN v_free THEN 'paid' ELSE 'pending' END, v_entry, v_extras, v_donation,
    v_total, v_tier, v_expires, CASE WHEN v_free THEN now() END)
  RETURNING id INTO v_order;

  BEGIN
    v_ip := nullif(p_meta->>'ip', '')::inet;
  EXCEPTION WHEN others THEN
    v_ip := NULL;
  END;
  v_name := coalesce(nullif(btrim(p_meta->>'buyerName'), ''),
                     (SELECT btrim(concat_ws(' ', e->>'firstName', e->>'lastName'))
                        FROM jsonb_array_elements(p_people) e WHERE e->>'role' = 'self' LIMIT 1));

  FOR v_person, v_idx IN SELECT value, ordinality FROM jsonb_array_elements(p_people) WITH ORDINALITY LOOP
    v_price := public.registration_discounted_price(v_list[v_idx], v_pct[v_idx]);
    v_reg := public.registration_group_insert(v_rs, v_person, (v_idx - 1)::integer, v_profile, v_buyer, v_name,
                                              v_order, CASE WHEN v_free THEN 'confirmed' ELSE 'pending_payment' END,
                                              v_price, v_ip, v_ua, v_list[v_idx], v_vid[v_idx], v_partner[v_idx]);
    INSERT INTO public.order_lines (order_id, kind, registration_id, qty, amount, tier_label, tier_ends_on)
    VALUES (v_order, 'entry', v_reg, 1, v_price, v_label, v_tier_ends);
    v_regs := v_regs || v_reg;
  END LOOP;

  FOR v_x IN SELECT value FROM jsonb_array_elements(v_items) LOOP
    INSERT INTO public.order_lines (order_id, kind, registration_id, extra_variant_id, qty, amount)
    VALUES (v_order, 'extra', v_regs[(v_x->>'i')::integer + 1], (v_x->>'variantId')::uuid, (v_x->>'qty')::integer,
            (v_x->>'price')::integer * (v_x->>'qty')::integer);
  END LOOP;
  IF v_donation > 0 THEN
    INSERT INTO public.order_lines (order_id, kind, registration_id, qty, amount)
    VALUES (v_order, 'donation', NULL, 1, v_donation);
  END IF;

  FOR v_person, v_idx IN SELECT value, ordinality FROM jsonb_array_elements(p_people) WITH ORDINALITY LOOP
    v_out := v_out || jsonb_build_object(
      'id', v_regs[v_idx], 'index', v_idx - 1, 'role', v_person->>'role',
      'categoryId', (v_person->>'categoryId')::uuid,
      'participantId', CASE WHEN v_free THEN public.insert_registration_participant(v_regs[v_idx]) END);
  END LOOP;

  RETURN jsonb_build_object(
    'orderId', v_order,
    'status', CASE WHEN v_free THEN 'paid' ELSE 'pending' END,
    'total', v_total,
    'amounts', jsonb_build_object(
      'entryTotal', v_entry, 'extrasTotal', v_extras, 'donation', v_donation, 'total', v_total),
    'expiresAt', v_expires,
    'registrations', v_out);
END $$;

-- ---------------------------------------------------------------- create_team_registration (from 20261103120000)

CREATE OR REPLACE FUNCTION public.create_team_registration(
  p_category_id uuid, p_team_name text, p_members jsonb, p_profile_id uuid, p_buyer_email text,
  p_displayed_total integer, p_meta jsonb)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_comp      public.competitions%ROWTYPE;
  v_rs        public.registration_settings%ROWTYPE;
  v_people    jsonb;
  v_n         integer;
  v_buyer     text;
  v_profile   uuid;
  v_paid      boolean;
  v_tier      uuid;
  v_tier_ends date;
  v_label     text;
  v_fee       integer := 0;
  v_free      boolean;
  v_expires   timestamptz;
  v_team      uuid;
  v_order     uuid;
  v_name      text;
  v_ip        inet;
  v_ua        text := left(nullif(p_meta->>'userAgent', ''), 500);
  v_person    jsonb;
  v_idx       bigint;
  v_reg       uuid;
  v_regs      uuid[] := '{}';
  v_out       jsonb := '[]'::jsonb;
  v_list      integer := 0;
  v_code      text;
  v_voucher   public.vouchers%ROWTYPE;
  v_refusal   text;
  v_claim     record;
  v_voucher_id uuid;
  v_partner   uuid;
  v_items     jsonb;
  v_x         jsonb;
  v_extras    bigint := 0;
  v_donation  integer;
  v_total     bigint;
BEGIN
  IF jsonb_typeof(p_members) IS DISTINCT FROM 'array' OR jsonb_array_length(p_members) = 0 THEN
    RAISE EXCEPTION 'invalid_people';
  END IF;
  v_n := jsonb_array_length(p_members);
  IF nullif(btrim(p_team_name), '') IS NULL THEN
    RAISE EXCEPTION 'invalid_team_name';
  END IF;

  -- P3-R4: a team belongs to a signed-in account, the captain's, and the buyer address is that
  -- account's address. A free team needs it too: the captain is the guardian of the minors.
  SELECT p.id, lower(btrim(p.email)) INTO v_profile, v_buyer FROM public.profiles p WHERE p.id = p_profile_id;
  IF v_profile IS NULL OR v_buyer IS NULL OR v_buyer = '' THEN
    RAISE EXCEPTION 'session_required';
  END IF;
  IF p_buyer_email IS NOT NULL AND lower(btrim(p_buyer_email)) IS DISTINCT FROM v_buyer THEN
    RAISE EXCEPTION 'invalid_buyer_email';
  END IF;

  -- D3-1: the competition, then the settings. The lock below takes the same row again.
  SELECT * INTO v_comp FROM public.competitions WHERE category_id = p_category_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_comp.kind <> 'team' THEN
    RAISE EXCEPTION 'not_team';
  END IF;

  SELECT jsonb_agg(CASE WHEN jsonb_typeof(e) = 'object'
                        THEN e || jsonb_build_object('categoryId', p_category_id) ELSE e END
                   ORDER BY i)
    INTO v_people FROM jsonb_array_elements(p_members) WITH ORDINALITY AS t(e, i);
  v_rs := (public.registration_group_lock(v_people, p_meta)).o_settings;

  IF v_comp.team_min IS NULL OR v_comp.team_max IS NULL OR v_n NOT BETWEEN v_comp.team_min AND v_comp.team_max THEN
    RAISE EXCEPTION 'team_size';
  END IF;
  -- The captain is the account, and the only 'self'.
  IF v_people->0->>'role' IS DISTINCT FROM 'self'
     OR lower(btrim(v_people->0->>'email')) IS DISTINCT FROM v_buyer
     OR (SELECT count(*) FROM jsonb_array_elements(v_people) e WHERE e->>'role' = 'self') <> 1 THEN
    RAISE EXCEPTION 'invalid_people';
  END IF;
  IF v_comp.leg_order_enabled AND EXISTS (
    SELECT 1 FROM generate_series(1, v_n) AS leg
     WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_people) e WHERE e->>'leg' = leg::text)) THEN
    RAISE EXCEPTION 'invalid_people';
  END IF;

  -- Plain reads: the donation, the members' extras, the team's code.
  v_donation := public.registration_donation(v_rs, p_meta);
  v_items := public.registration_extra_items(v_rs, v_people);
  v_code := nullif(btrim(p_meta->>'voucherCode'), '');
  -- An order exists when there is something to pay for: a priced event, extras or a donation
  -- (ruling 7). A code alone on a free event discounts nothing.
  v_paid := v_rs.pricing_mode <> 'free' OR jsonb_array_length(v_items) > 0 OR v_donation > 0;
  IF NOT v_paid AND v_code IS NOT NULL THEN
    RAISE EXCEPTION 'free_event';
  END IF;

  -- The fee is the competition's current price, less the team's code.
  IF v_rs.pricing_mode <> 'free' THEN
    SELECT t.o_id, t.o_ends_on, t.o_label INTO v_tier, v_tier_ends, v_label
      FROM public.registration_current_tier(v_rs.event_id) t;
    v_list := public.registration_current_price(p_category_id);
    IF v_list IS NULL THEN
      RAISE EXCEPTION 'no_price';
    END IF;
  END IF;
  IF v_code IS NOT NULL THEN
    v_code := public.registration_normalize_code(v_code);
    v_voucher := NULL;
    IF v_code IS NOT NULL THEN
      SELECT * INTO v_voucher FROM public.vouchers x WHERE x.event_id = v_rs.event_id AND x.code = v_code;
    END IF;
    v_refusal := public.registration_voucher_refusal(v_voucher, p_category_id);
    IF v_refusal IS NOT NULL THEN
      RAISE EXCEPTION '%:0', v_refusal;
    END IF;
    IF v_list = 0 THEN
      RAISE EXCEPTION 'voucher_not_applicable:0';
    END IF;
  END IF;
  v_fee := public.registration_discounted_price(v_list, v_voucher.percent);
  SELECT coalesce(sum((x->>'price')::bigint * (x->>'qty')::bigint), 0) INTO v_extras FROM jsonb_array_elements(v_items) x;
  v_total := v_fee + v_extras + v_donation;
  IF v_total > 99999999 THEN
    RAISE EXCEPTION 'invalid_amount:total' USING ERRCODE = '22023';
  END IF;
  v_free := v_total = 0;

  -- Spec 14.10: online payment stops an hour before registration closes.
  IF NOT v_free AND now() >= v_rs.closes_at - interval '1 hour' THEN
    RAISE EXCEPTION 'paying_closed';
  END IF;

  -- One count across team and individual orders.
  IF v_paid THEN
    PERFORM pg_advisory_xact_lock(hashtext('create_order:' || v_profile::text || ':' || v_rs.event_id::text));
    IF (SELECT count(*) FROM public.orders o
         WHERE o.event_id = v_rs.event_id AND o.status = 'pending' AND o.expires_at > now()
           AND o.buyer_profile_id = v_profile AND o.kind = 'registration') >= 2 THEN
      RAISE EXCEPTION 'too_many_pending';
    END IF;
  END IF;

  IF p_displayed_total IS DISTINCT FROM v_total THEN
    RAISE EXCEPTION 'price_changed:%', v_total;
  END IF;

  -- P3-R15: a team takes one slot once it is confirmed. Waiting for payment it holds none and is
  -- refused when the confirmed entries already fill the limit.
  IF v_free THEN
    IF public.claim_competition_slots(p_category_id, 1) IS NULL THEN
      RAISE EXCEPTION 'full';
    END IF;
  ELSIF v_comp.taken >= v_comp.capacity THEN
    RAISE EXCEPTION 'full';
  END IF;

  BEGIN
    INSERT INTO public.teams (event_id, category_id, name)
    VALUES (v_rs.event_id, p_category_id, btrim(p_team_name))
    RETURNING id INTO v_team;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'team_name_taken';
  END;

  -- Lock order: teams → vouchers → extra_variants → registrations.
  IF v_code IS NOT NULL THEN
    SELECT * INTO v_claim FROM public.registration_claim_voucher_at(v_rs.event_id, v_voucher.id, v_code, p_category_id, 0);
    v_voucher_id := v_claim.o_id;
    v_partner := v_claim.o_partner_id;
    IF public.registration_discounted_price(v_list, v_claim.o_percent) <> v_fee THEN
      RAISE EXCEPTION 'price_changed:%', public.registration_discounted_price(v_list, v_claim.o_percent) + v_extras + v_donation;
    END IF;
  END IF;
  PERFORM public.registration_claim_extras(v_items);

  v_name := coalesce(nullif(btrim(p_meta->>'buyerName'), ''),
                     btrim(concat_ws(' ', v_people->0->>'firstName', v_people->0->>'lastName')));

  IF v_paid THEN
    v_expires := CASE WHEN v_rs.payment_window_until_close THEN v_rs.closes_at
                      ELSE least(now() + make_interval(hours => v_rs.payment_window_hours), v_rs.closes_at) END;
    INSERT INTO public.orders (
      event_id, buyer_profile_id, buyer_email, buyer_name, status, entry_total, extras_total, donation,
      total, tier_id, expires_at, paid_at)
    VALUES (
      v_rs.event_id, v_profile, v_buyer, v_name, CASE WHEN v_free THEN 'paid' ELSE 'pending' END, v_fee, v_extras,
      v_donation, v_total, v_tier, v_expires, CASE WHEN v_free THEN now() END)
    RETURNING id INTO v_order;
  END IF;

  BEGIN
    v_ip := nullif(p_meta->>'ip', '')::inet;
  EXCEPTION WHEN others THEN
    v_ip := NULL;
  END;

  -- Ruling 4: the fee sits on the captain; members carry 0 and have no order line.
  FOR v_person, v_idx IN SELECT value, ordinality FROM jsonb_array_elements(v_people) WITH ORDINALITY LOOP
    v_reg := public.registration_group_insert(v_rs, v_person, (v_idx - 1)::integer, v_profile, v_buyer, v_name,
                                              v_order, CASE WHEN v_free THEN 'confirmed' ELSE 'pending_payment' END,
                                              CASE WHEN v_idx = 1 THEN v_fee ELSE 0 END, v_ip, v_ua,
                                              CASE WHEN v_idx = 1 THEN v_list ELSE 0 END,
                                              CASE WHEN v_idx = 1 THEN v_voucher_id END,
                                              CASE WHEN v_idx = 1 THEN v_partner END);
    UPDATE public.registrations
       SET team_id = v_team,
           team_leg = CASE WHEN v_comp.leg_order_enabled THEN (v_person->>'leg')::integer END,
           team_position = v_idx
     WHERE id = v_reg;
    v_regs := v_regs || v_reg;
    v_out := v_out || jsonb_build_object('id', v_reg, 'index', v_idx - 1, 'role', v_person->>'role');
  END LOOP;
  UPDATE public.teams SET captain_registration_id = v_regs[1] WHERE id = v_team;

  IF v_paid THEN
    INSERT INTO public.order_lines (order_id, kind, registration_id, qty, amount, tier_label, tier_ends_on)
    VALUES (v_order, 'entry', v_regs[1], 1, v_fee, v_label, v_tier_ends);
    FOR v_x IN SELECT value FROM jsonb_array_elements(v_items) LOOP
      INSERT INTO public.order_lines (order_id, kind, registration_id, extra_variant_id, qty, amount)
      VALUES (v_order, 'extra', v_regs[(v_x->>'i')::integer + 1], (v_x->>'variantId')::uuid, (v_x->>'qty')::integer,
              (v_x->>'price')::integer * (v_x->>'qty')::integer);
    END LOOP;
    IF v_donation > 0 THEN
      INSERT INTO public.order_lines (order_id, kind, registration_id, qty, amount)
      VALUES (v_order, 'donation', NULL, 1, v_donation);
    END IF;
  END IF;

  IF v_free THEN
    PERFORM public.insert_registration_participant(r) FROM unnest(v_regs) AS r;
  END IF;

  RETURN jsonb_build_object(
    'teamId', v_team,
    'orderId', v_order,
    'status', CASE WHEN v_free THEN 'confirmed' ELSE 'pending' END,
    'total', v_total,
    'amounts', jsonb_build_object('entryTotal', v_fee, 'extrasTotal', v_extras, 'donation', v_donation, 'total', v_total),
    'expiresAt', v_expires,
    'registrations', v_out);
END $$;

-- ---------------------------------------------------------------- registration_order_fits (from 20261030160000)

CREATE OR REPLACE FUNCTION public.registration_order_fits(p_order_id uuid) RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = ''
AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM public.registration_slot_units(p_order_id, ARRAY['pending_payment']) u
      JOIN public.competitions c ON c.category_id = u.category_id
     WHERE c.taken + u.n > c.capacity)
  -- Changed here: a surcharge claims one place in its target when it is paid.
  AND NOT EXISTS (
    SELECT 1 FROM public.orders o
      JOIN public.competitions c ON c.category_id = o.surcharge_to_category_id
     WHERE o.id = p_order_id AND o.kind = 'surcharge' AND c.taken + 1 > c.capacity)
$$;

-- ---------------------------------------------------------------- order claims skip surcharges

-- claim_payment_reminders (from 20261107130000): changed only by o.kind = 'registration'.
CREATE OR REPLACE FUNCTION public.claim_payment_reminders(p_limit integer DEFAULT 100) RETURNS SETOF uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT o.id FROM public.orders o
     WHERE o.status = 'pending' AND o.kind = 'registration' AND o.reminder_sent_at IS NULL
       AND o.expires_at > now()
       AND o.expires_at - o.created_at > interval '24 hours'
       AND now() >= greatest(o.expires_at - interval '3 days',
                             o.created_at + (o.expires_at - o.created_at) / 2)
     ORDER BY o.created_at
     LIMIT greatest(p_limit, 0)
       FOR UPDATE SKIP LOCKED
  )
  UPDATE public.orders o SET reminder_sent_at = now()
    FROM due WHERE o.id = due.id AND o.reminder_sent_at IS NULL
  RETURNING o.id;
END $$;

-- claim_expired_notices (from 20261030125000): changed only by o.kind = 'registration'.
CREATE OR REPLACE FUNCTION public.claim_expired_notices(p_limit integer DEFAULT 100) RETURNS SETOF uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT o.id FROM public.orders o
     WHERE o.status = 'expired' AND o.kind = 'registration' AND o.expired_notified_at IS NULL
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

-- claim_confirmation_resends (from 20261102130000): changed only by o.kind = 'registration'.
CREATE OR REPLACE FUNCTION public.claim_confirmation_resends(p_limit integer DEFAULT 50) RETURNS SETOF uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT o.id FROM public.orders o
     WHERE o.status = 'paid' AND o.kind = 'registration' AND o.confirmation_sent_at IS NULL
       AND o.paid_at <= now() - interval '10 minutes'
     ORDER BY o.paid_at
     LIMIT greatest(p_limit, 0)
       FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE public.orders o SET confirmation_sent_at = now()
      FROM due WHERE o.id = due.id AND o.confirmation_sent_at IS NULL
    RETURNING o.id
  )
  SELECT c.id FROM claimed c
   WHERE EXISTS (SELECT 1 FROM public.registrations r WHERE r.order_id = c.id AND r.status = 'confirmed');
END $$;

-- ---------------------------------------------------------------- surcharge claims (for the job, task 6)

-- „Przypomnienie o dopłacie”: claim_payment_reminders' rule for a pending surcharge.
CREATE FUNCTION public.claim_surcharge_reminders(p_limit integer DEFAULT 100) RETURNS SETOF uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT o.id FROM public.orders o
     WHERE o.status = 'pending' AND o.kind = 'surcharge' AND o.reminder_sent_at IS NULL
       AND o.expires_at > now()
       AND o.expires_at - o.created_at > interval '24 hours'
       AND now() >= greatest(o.expires_at - interval '3 days',
                             o.created_at + (o.expires_at - o.created_at) / 2)
     ORDER BY o.created_at
     LIMIT greatest(p_limit, 0)
       FOR UPDATE SKIP LOCKED
  )
  UPDATE public.orders o SET reminder_sent_at = now()
    FROM due WHERE o.id = due.id AND o.reminder_sent_at IS NULL
  RETURNING o.id;
END $$;
REVOKE EXECUTE ON FUNCTION public.claim_surcharge_reminders(integer) FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.claim_surcharge_reminders(integer) TO service_role;

-- „Dopłata wygasła — zostajesz w <stara konkurencja>”: claim_expired_notices' rule for a surcharge.
CREATE FUNCTION public.claim_surcharge_expired_notices(p_limit integer DEFAULT 100) RETURNS SETOF uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT o.id FROM public.orders o
     WHERE o.status = 'expired' AND o.kind = 'surcharge' AND o.expired_notified_at IS NULL
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
REVOKE EXECUTE ON FUNCTION public.claim_surcharge_expired_notices(integer) FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.claim_surcharge_expired_notices(integer) TO service_role;

-- A lost „Zmieniono konkurencję”: claim_confirmation_resends' rule for a paid surcharge. Every due
-- one is stamped; only one whose entry (the registration holding its surcharge line, which follows a
-- transfer) is still confirmed is returned for the e-mail.
CREATE FUNCTION public.claim_surcharge_confirmations(p_limit integer DEFAULT 50) RETURNS SETOF uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT o.id FROM public.orders o
     WHERE o.status = 'paid' AND o.kind = 'surcharge' AND o.confirmation_sent_at IS NULL
       AND o.paid_at <= now() - interval '10 minutes'
     ORDER BY o.paid_at
     LIMIT greatest(p_limit, 0)
       FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE public.orders o SET confirmation_sent_at = now()
      FROM due WHERE o.id = due.id AND o.confirmation_sent_at IS NULL
    RETURNING o.id
  )
  SELECT c.id FROM claimed c
   WHERE EXISTS (SELECT 1 FROM public.order_lines l JOIN public.registrations r ON r.id = l.registration_id
                  WHERE l.order_id = c.id AND l.kind = 'surcharge' AND r.status = 'confirmed');
END $$;
REVOKE EXECUTE ON FUNCTION public.claim_surcharge_confirmations(integer) FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.claim_surcharge_confirmations(integer) TO service_role;
