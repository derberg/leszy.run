-- Plan 5, task 3: one team, one slot, one fee.
--
-- create_team_registration writes a team in one transaction, free or paid:
--   * the teams row and one registrations row per member, captain first;
--   * a free event: confirmed, no order, one slot claimed, a participant per member;
--   * a paid event: one order, one entry line on the captain's registration, the fee on the
--     captain and 0 on every member (ruling 4). Nothing is claimed while it waits for payment
--     (P3-R15, D5-14); confirm_order claims the one slot through registration_slot_units;
--   * a 0 zł fee on a paid event: a paid order with its line, confirmed at once (D5-23).
-- Lock order (D3-1): competition FOR UPDATE, settings FOR SHARE (both held by
-- registration_group_lock), then the rows it writes. An order or a team does not exist yet.
--
-- The tier choice was inline in create_order. registration_current_tier and
-- registration_current_price hold it now, so a team's fee and an order's entry price cannot
-- disagree (D5-22). Internal, like registration_group_lock: they run as their caller.
--
-- D5-12: an individual registration in a team competition is refused. register_free and
-- create_order are re-created from 20261031100000 and 20261031150000, raising team_competition
-- right after the competitions are locked. The old-signature wrappers pass it through. Apart from
-- that and the tier helpers, every line is unchanged.
--
-- confirm_order is re-created from 20261030160000 with one more refusal (Task 2's review): an
-- order past its window does not lock its competition, so kind or size can change while its
-- payment is in flight. Such a payment is refunded in full (late_refund, reason unavailable) rather
-- than confirmed. Grants are unchanged: CREATE OR REPLACE keeps them.

-- ---------------------------------------------------------------- the current price

CREATE FUNCTION public.registration_current_tier(p_event_id uuid,
                                                 OUT o_id uuid, OUT o_ends_on date, OUT o_label text)
  LANGUAGE sql
  STABLE
  SET search_path = ''
AS $$
  SELECT t.id, t.ends_on,
         CASE WHEN t.ends_on IS NULL THEN 'do zamknięcia zapisów'
              ELSE 'do ' || to_char(t.ends_on, 'DD.MM.YYYY') END
    FROM public.price_tiers t
   WHERE t.event_id = p_event_id
     AND (t.ends_on IS NULL OR t.ends_on >= (now() AT TIME ZONE 'Europe/Warsaw')::date)
   ORDER BY t.ends_on NULLS LAST, t.sort_order, t.id
   LIMIT 1
$$;
REVOKE EXECUTE ON FUNCTION public.registration_current_tier(uuid) FROM public, anon, authenticated, service_role;

CREATE FUNCTION public.registration_current_price(p_category_id uuid) RETURNS integer
  LANGUAGE sql
  STABLE
  SET search_path = ''
AS $$
  SELECT p.amount
    FROM public.competitions c
    JOIN public.competition_prices p ON p.category_id = c.category_id
   WHERE c.category_id = p_category_id
     AND p.tier_id = (SELECT t.o_id FROM public.registration_current_tier(c.event_id) t)
$$;
REVOKE EXECUTE ON FUNCTION public.registration_current_price(uuid) FROM public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- register_free (from 20261031100000)

CREATE OR REPLACE FUNCTION public.register_free(p_people jsonb, p_profile_id uuid, p_meta jsonb)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_lock   record;
  v_rs     public.registration_settings%ROWTYPE;
  v_cats   uuid[];
  v_person jsonb;
  v_idx    bigint;
  v_buyer  text;
  v_name   text;
  v_ip     inet;
  v_ua     text := left(nullif(p_meta->>'userAgent', ''), 500);
  v_reg    uuid;
  v_regs   uuid[] := '{}';
  v_out    jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO v_lock FROM public.registration_group_lock(p_people, p_meta);
  v_rs := v_lock.o_settings;
  v_cats := v_lock.o_cats;
  IF EXISTS (SELECT 1 FROM public.competitions c WHERE c.category_id = ANY (v_cats) AND c.kind = 'team') THEN
    RAISE EXCEPTION 'team_competition';
  END IF;
  IF v_rs.pricing_mode <> 'free' THEN
    RAISE EXCEPTION 'not_free';
  END IF;

  SELECT lower(btrim(p.email)) INTO v_buyer FROM public.profiles p WHERE p.id = p_profile_id;
  -- A child is registered by a signed-in guardian, whose account it is attached to.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_people) e WHERE e->>'role' = 'minor')
     AND (v_buyer IS NULL OR v_buyer = '') THEN
    RAISE EXCEPTION 'session_required';
  END IF;
  v_name := coalesce(nullif(btrim(p_meta->>'buyerName'), ''),
                     (SELECT btrim(concat_ws(' ', e->>'firstName', e->>'lastName'))
                        FROM jsonb_array_elements(p_people) e WHERE e->>'role' = 'self' LIMIT 1));

  BEGIN
    v_ip := nullif(p_meta->>'ip', '')::inet;
  EXCEPTION WHEN others THEN
    v_ip := NULL;
  END;

  FOR v_person, v_idx IN SELECT value, ordinality FROM jsonb_array_elements(p_people) WITH ORDINALITY LOOP
    v_reg := public.registration_group_insert(v_rs, v_person, (v_idx - 1)::integer, p_profile_id, v_buyer, v_name,
                                              NULL, 'confirmed', 0, v_ip, v_ua);
    v_regs := v_regs || v_reg;
  END LOOP;

  PERFORM public.registration_group_claim(p_people);

  FOR v_person, v_idx IN SELECT value, ordinality FROM jsonb_array_elements(p_people) WITH ORDINALITY LOOP
    v_out := v_out || jsonb_build_object(
      'id', v_regs[v_idx], 'index', v_idx - 1, 'role', v_person->>'role',
      'categoryId', (v_person->>'categoryId')::uuid,
      'participantId', public.insert_registration_participant(v_regs[v_idx]));
  END LOOP;

  RETURN jsonb_build_object('registrations', v_out);
END $$;
REVOKE EXECUTE ON FUNCTION public.register_free(jsonb, uuid, jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_free(jsonb, uuid, jsonb) TO service_role;

-- ---------------------------------------------------------------- create_order (from 20261031150000)

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
  IF v_rs.pricing_mode = 'free' THEN
    RAISE EXCEPTION 'free_event';
  END IF;

  -- The current tier; every person at their own competition's price in it.
  -- v_prices is keyed by the canonical uuid text, so every lookup casts the person's
  -- categoryId through uuid (an uppercase id prices like a lowercase one).
  SELECT t.o_id, t.o_ends_on, t.o_label INTO v_tier, v_tier_ends, v_label
    FROM public.registration_current_tier(v_rs.event_id) t;
  FOR u IN SELECT c AS category_id FROM unnest(v_cats) AS c LOOP
    v_price := public.registration_current_price(u.category_id);
    IF v_price IS NULL THEN
      RAISE EXCEPTION 'no_price';
    END IF;
    v_prices := v_prices || jsonb_build_object(u.category_id::text, v_price);
  END LOOP;

  SELECT sum((v_prices->>((e->>'categoryId')::uuid::text))::bigint) INTO v_entry FROM jsonb_array_elements(p_people) AS e;
  IF v_entry > 99999999 THEN
    RAISE EXCEPTION 'invalid_amount:total' USING ERRCODE = '22023';
  END IF;
  v_total := v_entry;
  v_free := v_total = 0;

  -- Spec 14.10: online payment stops an hour before registration closes.
  IF NOT v_free AND now() >= v_rs.closes_at - interval '1 hour' THEN
    RAISE EXCEPTION 'paying_closed';
  END IF;

  -- At most two payable orders per account and event; a group is one order.
  PERFORM pg_advisory_xact_lock(hashtext('create_order:' || v_profile::text || ':' || v_rs.event_id::text));
  IF (SELECT count(*) FROM public.orders o
       WHERE o.event_id = v_rs.event_id AND o.status = 'pending' AND o.expires_at > now()
         AND o.buyer_profile_id = v_profile) >= 2 THEN
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

  v_expires := CASE WHEN v_rs.payment_window_until_close THEN v_rs.closes_at
                    ELSE least(now() + make_interval(hours => v_rs.payment_window_hours), v_rs.closes_at) END;
  INSERT INTO public.orders (
    event_id, buyer_profile_id, buyer_email, status, entry_total, extras_total, donation,
    total, tier_id, expires_at, paid_at)
  VALUES (
    v_rs.event_id, v_profile, v_buyer, CASE WHEN v_free THEN 'paid' ELSE 'pending' END, v_entry, 0, 0,
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
    v_price := (v_prices->>((v_person->>'categoryId')::uuid::text))::integer;
    v_reg := public.registration_group_insert(v_rs, v_person, (v_idx - 1)::integer, v_profile, v_buyer, v_name,
                                              v_order, CASE WHEN v_free THEN 'confirmed' ELSE 'pending_payment' END,
                                              v_price, v_ip, v_ua);
    INSERT INTO public.order_lines (order_id, kind, registration_id, qty, amount, tier_label, tier_ends_on)
    VALUES (v_order, 'entry', v_reg, 1, v_price, v_label, v_tier_ends);
    v_regs := v_regs || v_reg;
  END LOOP;

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
      'entryTotal', v_entry, 'extrasTotal', 0, 'donation', 0, 'total', v_total),
    'expiresAt', v_expires,
    'registrations', v_out);
END $$;
REVOKE EXECUTE ON FUNCTION public.create_order(jsonb, uuid, text, integer, jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_order(jsonb, uuid, text, integer, jsonb) TO service_role;

-- ---------------------------------------------------------------- confirm_order (from 20261030160000)

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
  BEGIN
    FOR u IN SELECT * FROM public.registration_slot_units(o.id,
               ARRAY[CASE WHEN o.status = 'pending' THEN 'pending_payment' ELSE 'expired' END]) LOOP
      IF public.claim_competition_slots(u.category_id, u.n) IS NULL THEN
        RAISE EXCEPTION 'full';
      END IF;
    END LOOP;
    UPDATE public.registrations SET status = 'confirmed'
     WHERE order_id = o.id AND status IN ('pending_payment', 'expired');
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

-- ---------------------------------------------------------------- create_team_registration

-- p_members: member 0 is the captain, { role: self|adult|minor, leg?, …person }, as validateTeam
-- hands them over. The edge function validates them; the shape, the size and the captain are
-- checked again here, because a wrong call would otherwise store acceptances nobody gave.
-- → { teamId, orderId|null, status: confirmed|pending, total, amounts, expiresAt,
--     registrations: [{ id, index, role }] }
CREATE FUNCTION public.create_team_registration(
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

  -- The fee is the competition's current price, and the total is the fee (no participant fees).
  v_paid := v_rs.pricing_mode <> 'free';
  IF v_paid THEN
    SELECT t.o_id, t.o_ends_on, t.o_label INTO v_tier, v_tier_ends, v_label
      FROM public.registration_current_tier(v_rs.event_id) t;
    v_fee := public.registration_current_price(p_category_id);
    IF v_fee IS NULL THEN
      RAISE EXCEPTION 'no_price';
    END IF;
    IF v_fee > 99999999 THEN
      RAISE EXCEPTION 'invalid_amount:total' USING ERRCODE = '22023';
    END IF;
  END IF;
  v_free := v_fee = 0;

  -- Spec 14.10: online payment stops an hour before registration closes.
  IF NOT v_free AND now() >= v_rs.closes_at - interval '1 hour' THEN
    RAISE EXCEPTION 'paying_closed';
  END IF;

  -- One count across team and individual orders.
  IF v_paid THEN
    PERFORM pg_advisory_xact_lock(hashtext('create_order:' || v_profile::text || ':' || v_rs.event_id::text));
    IF (SELECT count(*) FROM public.orders o
         WHERE o.event_id = v_rs.event_id AND o.status = 'pending' AND o.expires_at > now()
           AND o.buyer_profile_id = v_profile) >= 2 THEN
      RAISE EXCEPTION 'too_many_pending';
    END IF;
  END IF;

  IF p_displayed_total IS DISTINCT FROM v_fee THEN
    RAISE EXCEPTION 'price_changed:%', v_fee;
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

  v_name := coalesce(nullif(btrim(p_meta->>'buyerName'), ''),
                     btrim(concat_ws(' ', v_people->0->>'firstName', v_people->0->>'lastName')));

  IF v_paid THEN
    v_expires := CASE WHEN v_rs.payment_window_until_close THEN v_rs.closes_at
                      ELSE least(now() + make_interval(hours => v_rs.payment_window_hours), v_rs.closes_at) END;
    INSERT INTO public.orders (
      event_id, buyer_profile_id, buyer_email, buyer_name, status, entry_total, extras_total, donation,
      total, tier_id, expires_at, paid_at)
    VALUES (
      v_rs.event_id, v_profile, v_buyer, v_name, CASE WHEN v_free THEN 'paid' ELSE 'pending' END, v_fee, 0, 0,
      v_fee, v_tier, v_expires, CASE WHEN v_free THEN now() END)
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
                                              CASE WHEN v_idx = 1 THEN v_fee ELSE 0 END, v_ip, v_ua);
    UPDATE public.registrations
       SET team_id = v_team,
           team_leg = CASE WHEN v_comp.leg_order_enabled THEN (v_person->>'leg')::integer END
     WHERE id = v_reg;
    v_regs := v_regs || v_reg;
    v_out := v_out || jsonb_build_object('id', v_reg, 'index', v_idx - 1, 'role', v_person->>'role');
  END LOOP;
  UPDATE public.teams SET captain_registration_id = v_regs[1] WHERE id = v_team;

  IF v_paid THEN
    INSERT INTO public.order_lines (order_id, kind, registration_id, qty, amount, tier_label, tier_ends_on)
    VALUES (v_order, 'entry', v_regs[1], 1, v_fee, v_label, v_tier_ends);
  END IF;

  IF v_free THEN
    PERFORM public.insert_registration_participant(r) FROM unnest(v_regs) AS r;
  END IF;

  RETURN jsonb_build_object(
    'teamId', v_team,
    'orderId', v_order,
    'status', CASE WHEN v_free THEN 'confirmed' ELSE 'pending' END,
    'total', v_fee,
    'amounts', jsonb_build_object('entryTotal', v_fee, 'extrasTotal', 0, 'donation', 0, 'total', v_fee),
    'expiresAt', v_expires,
    'registrations', v_out);
END $$;
REVOKE EXECUTE ON FUNCTION public.create_team_registration(uuid, text, jsonb, uuid, text, integer, jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_team_registration(uuid, text, jsonb, uuid, text, integer, jsonb) TO service_role;
