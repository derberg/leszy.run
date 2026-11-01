-- Plan 7, task 4b: what a cart gives back when an order or an entry leaves live, and what a late
-- payment takes again (D7-13, D7-15, D7-18, D7-19, ruling 8).
--
-- An unpaid order holds voucher uses and extra stock, never a slot (P3-R15). Every exit of one gives
-- the uses and the stock back and touches no slot:
--   registration_release_unpaid  new internal: the uses of the orders' pending_payment registrations
--                                (release_registration_vouchers, voucher-id order) and the stock of
--                                their extra lines (release_order_stock for one order; for several,
--                                one pass across all of them in variant-id order)
--   cancel_order                 (from 20261030160000) also reached from buyer_cancel_order,
--                                create-order's P3-R7 cancel, delete-my-account's account_deleted,
--                                organizer_cancel_order and with it cancel_registration of a
--                                pending entry
--   expire_orders                (from 20261030160000) set-based and its per-order fallback
--   release_orphan_orders        (from 20261030160000) its own UPDATEs, not cancel_order
--   registration_drop_unpaid_order (from 20261030160000) confirm_order's refusals of a pending order
-- C-2: the uses and the stock go back BEFORE the order's registrations are touched. Expiry and a
-- create_order with the same e-mail otherwise wait on each other (the create holds the voucher
-- and waits on the unique index the expiry's registration update holds), a deadlock.
-- The two job loops lock every voucher and variant they will release in id order before the first
-- order, because a loop's earlier subtransactions keep their locks: order A releasing voucher 2 and
-- then order B voucher 1 deadlocks against a create claiming 1 then 2.
--
-- confirm_order (from 20261101110000): an expired order released its uses and stock, so its late
-- payment re-claims them inside the claim subtransaction, after the slots (D7-19, ruling 8): each
-- voucher by the voucher_id stored on the registration, ignoring valid_until and disabled_at but
-- never past max_uses (→ late_refund 'voucher'), then the stock of every extra line (→ 'stock'). A
-- still-pending order holds both and re-claims nothing. The subtransaction undoes every re-claim of
-- a refused payment, and registration_drop_unpaid_order releases what a pending order held. Refusal
-- order: closed (before the block), then full, voucher, stock, duplicate (the slots, vouchers and
-- stock are claimed before the registrations flip, in the Global Constraints lock order).
--
-- cancel_registration (from 20261102102000): cancelling a confirmed entry gives back its slot (as
-- before) and then the voucher use of every registration it cancels; the extra stays sold (§14.11).
-- The vouchers are locked after the team and before the registrations, in id order.
-- finish_organizer_refund is unchanged: an accepted refund of the whole entry line cancels through
-- cancel_registration, which now gives the use back; a partial refund cancels nothing.
--
-- Grants survive CREATE OR REPLACE; the new internal runs as its caller and nobody may execute it.

-- ---------------------------------------------------------------- registration_release_unpaid

CREATE FUNCTION public.registration_release_unpaid(p_order_ids uuid[]) RETURNS void
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
DECLARE
  v_regs uuid[];
  u      record;
BEGIN
  SELECT coalesce(array_agg(r.id), '{}') INTO v_regs FROM public.registrations r
   WHERE r.order_id = ANY (p_order_ids) AND r.status = 'pending_payment' AND r.voucher_id IS NOT NULL;
  PERFORM public.release_registration_vouchers(v_regs);
  IF cardinality(p_order_ids) = 1 THEN
    PERFORM public.release_order_stock(p_order_ids[1]);
    RETURN;
  END IF;
  -- Several orders: one pass in variant-id order, never one order after another.
  FOR u IN
    SELECT l.extra_variant_id, sum(l.qty)::integer AS n
      FROM public.order_lines l
     WHERE l.order_id = ANY (p_order_ids) AND l.kind = 'extra'
     GROUP BY l.extra_variant_id ORDER BY l.extra_variant_id
  LOOP
    UPDATE public.extra_variants AS v SET sold = v.sold - u.n WHERE v.id = u.extra_variant_id;
  END LOOP;
END $$;
REVOKE EXECUTE ON FUNCTION public.registration_release_unpaid(uuid[]) FROM public, anon, authenticated, service_role;

-- Internal: locks, in id order, every voucher and variant the unpaid orders would release.
CREATE FUNCTION public.registration_lock_unpaid_cart(p_order_ids uuid[]) RETURNS void
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
BEGIN
  PERFORM 1 FROM public.vouchers v
   WHERE v.id IN (SELECT r.voucher_id FROM public.registrations r
                   WHERE r.order_id = ANY (p_order_ids) AND r.status = 'pending_payment')
   ORDER BY v.id
     FOR UPDATE;
  PERFORM 1 FROM public.extra_variants v
   WHERE v.id IN (SELECT l.extra_variant_id FROM public.order_lines l
                   WHERE l.order_id = ANY (p_order_ids) AND l.kind = 'extra')
   ORDER BY v.id
     FOR UPDATE;
END $$;
REVOKE EXECUTE ON FUNCTION public.registration_lock_unpaid_cart(uuid[]) FROM public, anon, authenticated, service_role;

-- Internal: an expired order's late payment takes its uses and stock again (ruling 8). Raises
-- 'voucher' or 'stock' when it cannot; the caller's subtransaction undoes the rest.
CREATE FUNCTION public.registration_reclaim_cart(p_order_id uuid) RETURNS void
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
DECLARE
  u record;
BEGIN
  FOR u IN
    SELECT r.voucher_id, count(*)::integer AS n
      FROM public.registrations r
     WHERE r.order_id = p_order_id AND r.status = 'expired' AND r.voucher_id IS NOT NULL
     GROUP BY r.voucher_id ORDER BY r.voucher_id
  LOOP
    -- By the stored id: valid_until and disabled_at no longer matter, max_uses still does.
    UPDATE public.vouchers AS x SET used = x.used + u.n
     WHERE x.id = u.voucher_id AND x.used + u.n <= x.max_uses;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'voucher';
    END IF;
  END LOOP;
  FOR u IN
    SELECT l.extra_variant_id, sum(l.qty)::integer AS n
      FROM public.order_lines l
     WHERE l.order_id = p_order_id AND l.kind = 'extra'
     GROUP BY l.extra_variant_id ORDER BY l.extra_variant_id
  LOOP
    IF NOT public.claim_extra_stock(u.extra_variant_id, u.n) THEN
      RAISE EXCEPTION 'stock';
    END IF;
  END LOOP;
END $$;
REVOKE EXECUTE ON FUNCTION public.registration_reclaim_cart(uuid) FROM public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- registration_drop_unpaid_order (from 20261030160000)

-- Internal: a payment that cannot be accepted leaves the order unpaid for good. A pending
-- order is cancelled (its registrations too) so it cannot be paid again, and gives back the
-- voucher uses and stock it held; an expired one stays expired (it gave them back on expiry).
-- No slot is released: an unpaid order holds none (P3-R15).
CREATE OR REPLACE FUNCTION public.registration_drop_unpaid_order(p_order_id uuid, p_status text, p_reason text) RETURNS void
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
BEGIN
  IF p_status <> 'pending' THEN
    RETURN;
  END IF;
  UPDATE public.orders SET status = 'cancelled', cancelled_reason = p_reason, cancelled_at = now()
   WHERE id = p_order_id AND status = 'pending';
  IF NOT FOUND THEN
    RETURN;
  END IF;
  PERFORM public.registration_release_unpaid(ARRAY[p_order_id]);
  UPDATE public.registrations SET status = 'cancelled'
   WHERE order_id = p_order_id AND status = 'pending_payment';
END $$;

-- ---------------------------------------------------------------- confirm_order (from 20261101110000)

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
  -- any registration is written. Both a pending and an expired order claim their
  -- slots here (P3-R15: the limit counts paid entries only), so both lock the
  -- competitions FOR UPDATE.
  PERFORM 1 FROM public.competitions c
   WHERE c.category_id IN (SELECT r.category_id FROM public.registrations r WHERE r.order_id = o.id)
   ORDER BY c.category_id
     FOR UPDATE;
  -- Ruling P3-R5: nothing is claimed in a competition hidden meanwhile, nor in an
  -- event no longer published; the payment is refunded. A pending order whose
  -- window is still open blocks hiding (registration_competition_in_use), so for
  -- it this only fires past expires_at, before the expiry job ran.
  IF EXISTS (SELECT 1 FROM public.competitions c
              WHERE c.hidden_at IS NOT NULL
                AND c.category_id IN (SELECT r.category_id FROM public.registrations r WHERE r.order_id = o.id))
     OR NOT EXISTS (SELECT 1 FROM public.registration_settings rs
                     WHERE rs.event_id = o.event_id AND rs.state = 'published')
     -- Nor where the entry no longer fits what the competition became: an order past its window
     -- does not lock kind or size (registration_competition_in_use). A team into an individual
     -- competition, or the reverse, or a squad the new size refuses, would hold one wrong slot.
     OR EXISTS (SELECT 1 FROM public.registrations r
                  JOIN public.competitions c ON c.category_id = r.category_id
                 WHERE r.order_id = o.id AND r.status IN ('pending_payment', 'expired')
                   AND (r.team_id IS NOT NULL) <> (c.kind = 'team'))
     OR EXISTS (SELECT 1 FROM public.registrations r
                  JOIN public.competitions c ON c.category_id = r.category_id
                 WHERE r.order_id = o.id AND r.status IN ('pending_payment', 'expired') AND r.team_id IS NOT NULL
                 GROUP BY r.team_id, c.team_min, c.team_max
                HAVING (count(*) BETWEEN c.team_min AND c.team_max) IS NOT TRUE) THEN
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

  -- The claim (P3-R15): every slot of the order, or none. The block is a
  -- subtransaction, so one full competition undoes the claims already made in the
  -- others and the whole order is refunded (never split, whatever it spans).
  -- Plan 7 (D7-19, ruling 8): an expired order gave its voucher uses and stock back,
  -- so it takes them again here, after the slots and before the registrations; a
  -- refusal ('voucher', 'stock') undoes the slots too. A pending order holds them.
  BEGIN
    FOR u IN SELECT * FROM public.registration_slot_units(o.id,
               ARRAY[CASE WHEN o.status = 'pending' THEN 'pending_payment' ELSE 'expired' END]) LOOP
      IF public.claim_competition_slots(u.category_id, u.n) IS NULL THEN
        RAISE EXCEPTION 'full';
      END IF;
    END LOOP;
    IF o.status = 'expired' THEN
      PERFORM public.registration_reclaim_cart(o.id);
    END IF;
    UPDATE public.registrations SET status = 'confirmed'
     WHERE order_id = o.id AND status IN ('pending_payment', 'expired');
  EXCEPTION
    WHEN unique_violation THEN
      v_reason := 'duplicate';
    WHEN raise_exception THEN
      IF SQLERRM NOT IN ('full', 'voucher', 'stock') THEN
        RAISE;
      END IF;
      v_reason := SQLERRM;
  END;
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

-- ---------------------------------------------------------------- cancel_order (from 20261030160000)

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
  -- C-2: the uses and the stock before the registrations.
  PERFORM public.registration_release_unpaid(ARRAY[p_order_id]);
  UPDATE public.registrations SET status = 'cancelled'
   WHERE order_id = p_order_id AND status = 'pending_payment';
  RETURN true;
END $$;

-- ---------------------------------------------------------------- expire_orders (from 20261030160000)

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
    -- C-2: every use and all the stock of these orders, in id order, before their registrations.
    PERFORM public.registration_release_unpaid(v_ids);
    UPDATE public.registrations SET status = 'expired'
     WHERE order_id = ANY (v_ids) AND status = 'pending_payment';
    RETURN cardinality(v_ids);
  EXCEPTION WHEN OTHERS THEN
    NULL; -- rolled back as a unit: go one order at a time
  END;

  SELECT coalesce(array_agg(x.id ORDER BY x.id), '{}') INTO v_ids FROM (
    SELECT o.id FROM public.orders o
     WHERE o.status = 'pending' AND o.expires_at <= p_now
     ORDER BY o.id
       FOR UPDATE OF o SKIP LOCKED) x;
  -- The loop's subtransactions keep their locks, so take them all in id order first.
  PERFORM public.registration_lock_unpaid_cart(v_ids);
  FOR r IN SELECT unnest(v_ids) AS id LOOP
    BEGIN
      UPDATE public.orders SET status = 'expired' WHERE id = r.id AND status = 'pending';
      IF FOUND THEN
        PERFORM public.registration_release_unpaid(ARRAY[r.id]);
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

-- ---------------------------------------------------------------- release_orphan_orders (from 20261030160000)

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
     WHERE o.status = 'pending' AND o.created_at <= p_now - interval '15 minutes'
       AND NOT EXISTS (SELECT 1 FROM public.payment_attempts a WHERE a.order_id = o.id)
     ORDER BY o.id
       FOR UPDATE OF o SKIP LOCKED) x;
  -- The loop's subtransactions keep their locks, so take them all in id order first.
  PERFORM public.registration_lock_unpaid_cart(v_ids);
  FOR r IN SELECT unnest(v_ids) AS id LOOP
    BEGIN
      UPDATE public.orders o
         SET status = 'cancelled', cancelled_reason = 'no_payment_attempt', cancelled_at = now()
       WHERE o.id = r.id AND o.status = 'pending'
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

-- ---------------------------------------------------------------- cancel_registration (from 20261102102000)

CREATE OR REPLACE FUNCTION public.cancel_registration(p_registration_id uuid, p_reason text, p_actor uuid) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  c_live    constant text[] := ARRAY['pending_payment', 'confirmed'];
  r         public.registrations%ROWTYPE;
  v_comp    public.competitions%ROWTYPE;
  v_rs      public.registration_settings%ROWTYPE;
  v_team    public.teams%ROWTYPE;
  v_text    text;
  v_targets uuid[];
  v_done    uuid[];
  v_whole   boolean;
  v_live    integer;
  v_bibs    jsonb;
BEGIN
  SELECT * INTO r FROM public.registrations WHERE id = p_registration_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  -- Unpaid: the whole order goes (ruling 6). It held no slot (P3-R15); cancel_order gives its
  -- voucher uses and stock back (D7-18).
  IF r.status = 'pending_payment' THEN
    IF r.order_id IS NULL THEN
      RAISE EXCEPTION 'not_found';
    END IF;
    v_text := public.organizer_cancel_order(r.order_id, p_actor);
    IF v_text <> 'cancelled' THEN
      RAISE EXCEPTION '%', CASE WHEN v_text = 'cancelled_already' THEN 'already_cancelled' ELSE v_text END;
    END IF;
    SELECT coalesce(array_agg(x.id ORDER BY x.id), '{}') INTO v_done FROM public.registrations x
     WHERE x.order_id = r.order_id AND x.status = 'cancelled' AND x.cancelled_at = now()
       AND x.cancelled_by IS NOT DISTINCT FROM p_actor;
    RETURN jsonb_build_object('cancelled', to_jsonb(v_done), 'hostWithdraw', false);
  END IF;
  IF r.status <> 'confirmed' THEN
    RAISE EXCEPTION '%', CASE WHEN r.status = 'cancelled' THEN 'already_cancelled' ELSE 'not_live' END;
  END IF;

  -- Confirmed: the locks in the Global Constraints order. Plan 2's free path has no order.
  IF r.order_id IS NOT NULL THEN
    PERFORM 1 FROM public.orders WHERE id = r.order_id FOR UPDATE;
  END IF;
  SELECT * INTO v_comp FROM public.competitions WHERE category_id = r.category_id FOR UPDATE;
  SELECT * INTO v_rs FROM public.registration_settings WHERE event_id = r.event_id FOR SHARE;
  IF r.team_id IS NOT NULL THEN
    SELECT * INTO v_team FROM public.teams WHERE id = r.team_id FOR UPDATE;
  END IF;
  -- Plan 7: the vouchers this cancel may give a use back to, before the registrations (id order).
  PERFORM 1 FROM public.vouchers v
   WHERE v.id IN (SELECT x.voucher_id FROM public.registrations x
                   WHERE CASE WHEN r.team_id IS NOT NULL THEN x.team_id = r.team_id AND x.status = ANY (c_live)
                              ELSE x.id = r.id END)
   ORDER BY v.id
     FOR UPDATE;
  IF r.team_id IS NOT NULL THEN
    PERFORM 1 FROM public.registrations WHERE team_id = r.team_id AND status = ANY (c_live) ORDER BY id FOR UPDATE;
  ELSE
    PERFORM 1 FROM public.registrations WHERE id = r.id FOR UPDATE;
  END IF;
  SELECT * INTO r FROM public.registrations WHERE id = p_registration_id;
  IF r.status <> 'confirmed' THEN
    RAISE EXCEPTION 'already_cancelled';
  END IF;

  IF r.team_id IS NULL THEN
    v_targets := ARRAY[r.id];
    v_whole := true;
  ELSIF r.id = v_team.captain_registration_id THEN
    -- The captain takes the team (ruling 6, §12.7).
    SELECT array_agg(x.id ORDER BY x.id) INTO v_targets FROM public.registrations x
     WHERE x.team_id = r.team_id AND x.status = 'confirmed';
    v_whole := true;
  ELSE
    -- One member, no refund (members carry 0, §14.14), never below the squad minimum.
    SELECT count(*) INTO v_live FROM public.registrations x WHERE x.team_id = r.team_id AND x.status = ANY (c_live);
    IF v_live - 1 < v_comp.team_min THEN
      RAISE EXCEPTION 'below_team_min';
    END IF;
    v_targets := ARRAY[r.id];
    v_whole := false;
  END IF;

  -- The slot first (D6-26), then the voucher uses (Plan 7; the extras stay sold, §14.11), then the
  -- flip; a flip that finds nothing rolls both releases back.
  IF v_whole THEN
    UPDATE public.competitions SET taken = taken - 1 WHERE category_id = r.category_id;
  END IF;
  PERFORM public.release_registration_vouchers(ARRAY(
    SELECT x.id FROM public.registrations x WHERE x.id = ANY (v_targets) AND x.status = 'confirmed'));
  WITH flipped AS (
    UPDATE public.registrations
       SET status = 'cancelled', cancelled_at = now(), cancelled_by = p_actor
     WHERE id = ANY (v_targets) AND status = 'confirmed'
    RETURNING id
  )
  SELECT array_agg(id ORDER BY id) INTO v_done FROM flipped;
  IF v_done IS NULL THEN
    RAISE EXCEPTION 'already_cancelled';
  END IF;
  IF v_whole AND r.team_id IS NOT NULL THEN
    UPDATE public.teams SET released_at = coalesce(released_at, now()) WHERE id = r.team_id;
  END IF;

  -- §14.3: before close the participant leaves through removed_at; from close on the timing
  -- host owns the row, so the operator crew is told instead.
  IF v_rs.closes_at IS NOT NULL AND clock_timestamp() < v_rs.closes_at THEN
    UPDATE public.participants p SET removed_at = now(), updated_at = now()
      FROM public.registrations x
     WHERE x.id = ANY (v_done) AND p.id = x.participant_id AND p.removed_at IS NULL;
    RETURN jsonb_build_object('cancelled', to_jsonb(v_done), 'hostWithdraw', false);
  END IF;

  SELECT jsonb_agg(p.bib_number ORDER BY x.id) INTO v_bibs
    FROM public.registrations x JOIN public.participants p ON p.id = x.participant_id
   WHERE x.id = ANY (v_done);
  IF v_bibs IS NULL THEN
    RETURN jsonb_build_object('cancelled', to_jsonb(v_done), 'hostWithdraw', false);
  END IF;
  INSERT INTO public.operator_alerts (kind, order_id, payload, dedupe_key)
  VALUES ('host_withdraw', r.order_id, jsonb_build_object(
    'registrationIds', to_jsonb(v_done), 'eventId', r.event_id, 'bibs', v_bibs, -- Review fix 6: a code, never the caller's text (this payload skips redactDpay, D6-29).
    'reason', CASE WHEN p_reason IN ('refund', 'organizer') THEN p_reason ELSE 'other' END),
    'host_withdraw:' || r.id)
  ON CONFLICT ON CONSTRAINT operator_alerts_dedupe_key_key DO NOTHING;
  RETURN jsonb_build_object('cancelled', to_jsonb(v_done), 'hostWithdraw', true);
END $$;
