-- Competition change, final whole-branch review fixes.
--
-- 1. refunds.change_to_category_id gets its index (every FK on refunds is indexed, P-12).
-- 2. competition_change_requests: the outcome of a change_competition call that moved the entry
--    (same price, or a difference booked offline) or created a surcharge, by its request key. A
--    retried call with the same key (a lost answer, a double click) gets the first outcome back
--    instead of same_competition / surcharge_open; the same key for another entry or target is
--    request_key_mismatch. A refund outcome is already recognised by refunds.request_key. Ids only,
--    no personal data; a row goes with its registration (ON DELETE CASCADE, registrations are
--    anonymised, never deleted). Service-role only.
-- 3. change_competition (recreated from 20261124170000_registration_changes.sql, changed only at
--    "Changed here (final fixes)" and where each non-refund outcome is recorded).
-- 4. registration_competition_in_use (from 20261030160000_registration_capacity_paid_only.sql) is also
--    true while a pending, unexpired surcharge targets the competition, so the club can neither hide
--    it nor change its type, size or price while somebody may pay to move into it.

-- ---------------------------------------------------------------- refunds.change_to_category_id

CREATE INDEX refunds_change_to_category_id_idx ON public.refunds (change_to_category_id);

-- ---------------------------------------------------------------- competition_change_requests

CREATE TABLE public.competition_change_requests (
  request_key      uuid PRIMARY KEY,
  registration_id  uuid NOT NULL REFERENCES public.registrations(id) ON DELETE CASCADE,
  from_category_id uuid NOT NULL,
  to_category_id   uuid NOT NULL,
  outcome          jsonb NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX competition_change_requests_registration_idx ON public.competition_change_requests (registration_id);
ALTER TABLE public.competition_change_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.competition_change_requests FROM anon, authenticated;

-- Internal: called by change_competition inside its transaction. A NULL key records nothing.
CREATE FUNCTION public.registration_record_change_request(p_request_key uuid, p_registration_id uuid,
                                                          p_from uuid, p_to uuid, p_outcome jsonb) RETURNS void
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = ''
AS $$
  INSERT INTO public.competition_change_requests (request_key, registration_id, from_category_id, to_category_id, outcome)
  SELECT p_request_key, p_registration_id, p_from, p_to, p_outcome WHERE p_request_key IS NOT NULL
$$;
REVOKE EXECUTE ON FUNCTION public.registration_record_change_request(uuid, uuid, uuid, uuid, jsonb)
  FROM public, anon, authenticated;

-- ---------------------------------------------------------------- registration_competition_in_use

-- Plans 5 and 7 reuse this exact name and signature.
CREATE OR REPLACE FUNCTION public.registration_competition_in_use(p_category_id uuid) RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM public.competitions c WHERE c.category_id = p_category_id AND c.taken > 0)
      OR EXISTS (SELECT 1 FROM public.registrations r JOIN public.orders o ON o.id = r.order_id
                  WHERE r.category_id = p_category_id AND r.status = 'pending_payment'
                    AND o.status = 'pending' AND o.expires_at > now())
      -- Changed here (final fixes): a surcharge awaiting payment into this competition.
      OR EXISTS (SELECT 1 FROM public.orders o
                  WHERE o.kind = 'surcharge' AND o.surcharge_to_category_id = p_category_id
                    AND o.status = 'pending' AND o.expires_at > now())
$$;
REVOKE EXECUTE ON FUNCTION public.registration_competition_in_use(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.registration_competition_in_use(uuid) TO service_role;

CREATE INDEX orders_pending_surcharge_to_idx ON public.orders (surcharge_to_category_id)
  WHERE kind = 'surcharge' AND status = 'pending';

-- ---------------------------------------------------------------- change_competition (from 20261124170000)

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
  v_buyer_name text;
  v_expires timestamptz;
  v_order   uuid;
  l         record;
  v_req     public.competition_change_requests%ROWTYPE;
  v_out     jsonb;
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

  -- Changed here (final fixes): a replay of a key whose first call moved the entry or created a
  -- surcharge returns that first outcome (competition_change_requests, written by that call).
  IF v_key IS NOT NULL THEN
    SELECT * INTO v_req FROM public.competition_change_requests q WHERE q.request_key = p_request_key;
    IF FOUND THEN
      IF v_req.registration_id IS DISTINCT FROM r.id OR v_req.to_category_id IS DISTINCT FROM p_to THEN
        RAISE EXCEPTION 'request_key_mismatch';
      END IF;
      RETURN v_req.outcome || jsonb_build_object('replay', true, 'fromCategoryId', v_req.from_category_id);
    END IF;
  END IF;

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
  -- Changed here (task 12): the runner's own change needs the club's consent switch. The
  -- settings row is held FOR SHARE, so a save of the payments section waits for this change.
  IF p_actor_kind = 'runner' AND v_rs.runner_competition_change IS NOT TRUE THEN
    RAISE EXCEPTION 'not_allowed';
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
    PERFORM public.registration_log_runner_change(p_actor_kind, r.id, p_actor, v_from, p_to, 0);
    v_out := jsonb_build_object('outcome', 'moved', 'grosze', 0);
    PERFORM public.registration_record_change_request(p_request_key, r.id, v_from, p_to, v_out);
    RETURN v_out;
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
      -- Changed here (task 12): only the club, which holds the money, can promise it back.
      IF p_actor_kind = 'runner' OR NOT coalesce(p_offline_ack, false) THEN
        RAISE EXCEPTION 'offline_paid';
      END IF;
      PERFORM public.registration_move_entry(r.id, p_to);
      UPDATE public.registrations SET list_price = v_list, refunded = refunded + v_amount WHERE id = r.id;
      v_out := jsonb_build_object('outcome', 'moved_offline_refund', 'grosze', v_amount);
      PERFORM public.registration_record_change_request(p_request_key, r.id, v_from, p_to, v_out);
      RETURN v_out;
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
    PERFORM public.registration_log_runner_change(p_actor_kind, r.id, p_actor, v_from, p_to, v_diff);
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
  IF p_actor_kind = 'runner' THEN
    -- Changed here (task 12): the runner who asks for the dearer competition pays for it, signed
    -- in as p_actor (a child's entry: the guardian acting), never the original order's buyer, who
    -- chose neither this change nor, for an added adult, this person's competition. The name is
    -- the one the registration knows for the actor (the runner's own, by account or by the entry's
    -- address, as an added adult has no profile_id on it; or the guardian name), else the profile's
    -- display name.
    SELECT p.id AS profile_id, p.email AS email,
           CASE WHEN p.id = r.profile_id OR (r.email IS NOT NULL AND lower(p.email) = lower(r.email)) THEN nullif(btrim(concat_ws(' ', r.first_name, r.last_name)), '')
                WHEN p.id = r.guardian_profile_id THEN r.guardian_name END AS name,
           p.display_name AS display_name
      INTO v_buyer
      FROM (SELECT x.id, x.email, x.display_name FROM public.profiles x
             WHERE x.id = p_actor AND x.deleted_at IS NULL AND x.email IS NOT NULL) p;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'no_payer';
    END IF;
    v_buyer_name := coalesce(v_buyer.name, nullif(btrim(v_buyer.display_name), ''));
  ELSE
    SELECT * INTO v_buyer FROM public.registration_surcharge_buyer(r.id);
    v_buyer_name := v_buyer.name;
  END IF;
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
      r.event_id, v_buyer.profile_id, v_buyer.email, v_buyer_name, 'pending', v_diff, 0, 0, v_diff,
      o.tier_id, v_expires, 'surcharge', r.id, r.category_id, p_to, v_list, v_price)
    RETURNING id INTO v_order;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'surcharge_open';
  END;
  INSERT INTO public.order_lines (order_id, kind, registration_id, qty, amount)
  VALUES (v_order, 'surcharge', r.id, 1, v_diff);
  PERFORM public.registration_log_runner_change(p_actor_kind, r.id, p_actor, v_from, p_to, v_diff);
  v_out := jsonb_build_object('outcome', 'surcharge', 'orderId', v_order, 'grosze', v_diff, 'expiresAt', v_expires);
  PERFORM public.registration_record_change_request(p_request_key, r.id, v_from, p_to, v_out);
  RETURN v_out;
END $$;
REVOKE EXECUTE ON FUNCTION public.change_competition(uuid, uuid, integer, uuid, text, uuid, boolean)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.change_competition(uuid, uuid, integer, uuid, text, uuid, boolean) TO service_role;
