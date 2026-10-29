-- Race registration, plan 3 task 4: the order RPCs.
--
-- Every function here is SECURITY DEFINER, `search_path = ''`, and executable
-- by service_role only (the edge functions); the internal helpers by nobody.
--
--   insert_registration_participant  the participant bridge (idempotent; never updates a row)
--   create_order                     one checkout: refusals as register_free, price from the
--                                    current tier, amounts from the SQL fee functions, slot claim,
--                                    order + registrations (pending_payment) + consents + lines;
--                                    a total of 0 is paid at once with no dpay
--   add_payment_attempt              one dpay transaction of a pending, payable order
--   confirm_order                    a paid dpay transaction → confirmed / already_confirmed /
--                                    double_payment / late_confirmed / late_refund /
--                                    already_handled / amount_mismatch / unknown_attempt
--   registration_slot_units          slots an order holds per competition (a team is one slot)
--   expire_orders                    the payment window job
--   cancel_order                     a pending order given up
--   record_refund / settle_refund    the refund record and its dpay outcome
--
-- Lock order (ruling D3-1), the one register_free and publish_registration_changes follow:
-- orders → competitions (category_id order) → registration_settings → registrations.
-- create_order has no order to lock: competition FOR UPDATE, then settings FOR SHARE.
--
-- Late payments (user decision D3-7): a payment at or after closes_at is refunded in
-- full (late_refund, reason 'closed'), unless its attempt was created before closes_at
-- and the confirmation arrives within LATE_PAYMENT_GRACE_MINUTES (5) after it.
--
-- Refund idempotency is ours (ruling 8): the only statement that leads to a refund
-- is the one moving the attempt created → paid; a replay finds it paid and answers
-- already_handled. The refunds row is written in the same transaction as the claim
-- (or the absence of one), so the decision and its record commit together.

-- ---------------------------------------------------------------- order columns

-- Deferred from task 3: the dpay value cap on the total, support_fee tied to the
-- support choice, and where a cancellation's reason is kept.
ALTER TABLE public.orders
  ADD COLUMN cancelled_reason text,
  ADD CONSTRAINT orders_total_cap_check CHECK (total <= 99999999),
  ADD CONSTRAINT orders_support_fee_choice_check CHECK (support_choice IS TRUE OR support_fee = 0);

-- ---------------------------------------------------------------- participant bridge

-- Inserts exactly the columns register_free inserted before this migration
-- (never nationality, P2-R31) and links the registration. A registration that
-- already has a participant gets that id back and the row is never touched:
-- after closes_at a participant may be inserted but never updated (spec 14.3).
CREATE FUNCTION public.insert_registration_participant(p_registration_id uuid) RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  r      public.registrations%ROWTYPE;
  v_part uuid;
BEGIN
  SELECT * INTO r FROM public.registrations WHERE id = p_registration_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF r.participant_id IS NOT NULL THEN
    RETURN r.participant_id;
  END IF;
  IF r.status <> 'confirmed' THEN
    RAISE EXCEPTION 'not_confirmed';
  END IF;

  INSERT INTO public.participants (
    event_id, category_id, first_name, last_name, email, gender, birth_date, club, phone,
    registration_id, updated_at)
  VALUES (
    r.event_id, r.category_id, r.first_name, r.last_name, r.email, r.gender, r.birth_date, r.club, r.phone,
    r.id, now())
  RETURNING id INTO v_part;

  UPDATE public.registrations SET participant_id = v_part WHERE id = r.id;
  RETURN v_part;
END $$;
REVOKE EXECUTE ON FUNCTION public.insert_registration_participant(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insert_registration_participant(uuid) TO service_role;

-- ---------------------------------------------------------------- register_free

-- Replaced from 20261030000000: the participants row now comes from the bridge.
-- Unchanged otherwise (nationality on the registration only).
CREATE OR REPLACE FUNCTION public.register_free(p_category_id uuid, p_people jsonb, p_profile_id uuid, p_meta jsonb)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_comp    public.competitions%ROWTYPE;
  v_rs      public.registration_settings%ROWTYPE;
  v_person  jsonb;
  v_email   text;
  v_reg     uuid;
  v_part    uuid;
  v_out     jsonb := '[]'::jsonb;
  v_ip      inet;
  v_ua      text := left(nullif(p_meta->>'userAgent', ''), 500);
  v_sent    uuid[];
  v_have    uuid[];
BEGIN
  IF jsonb_typeof(p_people) IS DISTINCT FROM 'array' OR jsonb_array_length(p_people) = 0 THEN
    RAISE EXCEPTION 'invalid_people';
  END IF;

  SELECT * INTO v_comp FROM public.competitions WHERE category_id = p_category_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  SELECT * INTO v_rs FROM public.registration_settings WHERE event_id = v_comp.event_id FOR SHARE;
  IF NOT FOUND OR v_rs.state = 'draft'
     OR NOT EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = v_rs.club_id AND c.registration_enabled) THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_rs.state <> 'published' OR v_comp.hidden_at IS NOT NULL THEN
    RAISE EXCEPTION 'closed';
  END IF;
  IF v_rs.pricing_mode <> 'free' THEN
    RAISE EXCEPTION 'not_free';
  END IF;
  IF v_rs.opens_at IS NULL OR now() < v_rs.opens_at THEN
    RAISE EXCEPTION 'not_open';
  END IF;
  IF v_rs.closes_at IS NULL OR now() >= v_rs.closes_at THEN
    RAISE EXCEPTION 'closed';
  END IF;

  SELECT coalesce(array_agg(DISTINCT x::uuid ORDER BY x::uuid), '{}') INTO v_sent
    FROM jsonb_array_elements_text(coalesce(p_meta->'consentIds', '[]'::jsonb)) AS t(x);
  SELECT coalesce(array_agg(ec.id ORDER BY ec.id), '{}') INTO v_have
    FROM public.event_consents ec WHERE ec.event_id = v_rs.event_id;
  IF v_sent IS DISTINCT FROM v_have THEN
    RAISE EXCEPTION 'consents_changed';
  END IF;

  BEGIN
    v_ip := nullif(p_meta->>'ip', '')::inet;
  EXCEPTION WHEN others THEN
    v_ip := NULL;
  END;

  FOR v_person IN SELECT value FROM jsonb_array_elements(p_people) LOOP
    v_email := lower(btrim(v_person->>'email'));
    BEGIN
      INSERT INTO public.registrations (
        event_id, category_id, status, profile_id, first_name, last_name, birth_date, gender, email,
        phone, city, club, ice_name, ice_phone, nationality, age_group_label, kids_group_id, consent_state,
        list_price, price)
      VALUES (
        v_rs.event_id, p_category_id, 'confirmed',
        (SELECT p.id FROM public.profiles p WHERE p.id = p_profile_id AND lower(p.email) = v_email),
        v_person->>'firstName', v_person->>'lastName', (v_person->>'birthDate')::date, v_person->>'gender',
        v_email, v_person->>'phone', v_person->>'city', v_person->>'club', v_person->>'iceName',
        v_person->>'icePhone', nullif(v_person->>'nationality', ''), v_person->>'ageGroupLabel', nullif(v_person->>'kidsGroupId', '')::uuid,
        'accepted', 0, 0)
      RETURNING id INTO v_reg;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'duplicate';
    END;

    INSERT INTO public.consent_acceptances (
      registration_id, consent_id, consent_kind, accepted_by_profile_id, accepted_as, regulamin_version, ip, user_agent)
    SELECT v_reg, ec.id, ec.kind, p_profile_id, 'self',
           CASE WHEN ec.kind = 'regulamin' THEN v_rs.regulamin_version END, v_ip, v_ua
      FROM public.event_consents ec WHERE ec.event_id = v_rs.event_id
    UNION ALL
    SELECT v_reg, NULL, 'service_regulamin', p_profile_id, 'self', NULL, v_ip, v_ua;

    v_part := public.insert_registration_participant(v_reg);
    v_out := v_out || jsonb_build_object('id', v_reg, 'participantId', v_part, 'email', v_email);
  END LOOP;

  IF public.claim_competition_slots(p_category_id, jsonb_array_length(p_people)) IS NULL THEN
    RAISE EXCEPTION 'full';
  END IF;

  RETURN jsonb_build_object('registrations', v_out);
END $$;
REVOKE EXECUTE ON FUNCTION public.register_free(uuid, jsonb, uuid, jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_free(uuid, jsonb, uuid, jsonb) TO service_role;

-- ---------------------------------------------------------------- slot units

-- What an order holds per competition: one slot per registration, a team
-- (registrations.team_id, plan 5) one slot whatever its size. Every release
-- and re-claim counts through this, never count(*) of the registrations.
CREATE FUNCTION public.registration_slot_units(p_order_id uuid, p_statuses text[])
  RETURNS TABLE (category_id uuid, n integer)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = ''
AS $$
  SELECT r.category_id,
         (count(*) FILTER (WHERE r.team_id IS NULL) + count(DISTINCT r.team_id))::integer
    FROM public.registrations r
   WHERE r.order_id = p_order_id AND r.status = ANY (p_statuses)
   GROUP BY r.category_id
   ORDER BY r.category_id
$$;
REVOKE EXECUTE ON FUNCTION public.registration_slot_units(uuid, text[]) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.registration_slot_units(uuid, text[]) TO service_role;

-- Internal: give back what the orders hold in registrations of p_status, one
-- competition at a time in category_id order (all orders summed, so a batch
-- never takes a competition lock out of order).
CREATE FUNCTION public.registration_release_slots(p_order_ids uuid[], p_status text) RETURNS void
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
DECLARE
  u record;
BEGIN
  FOR u IN
    SELECT s.category_id, sum(s.n)::integer AS n
      FROM unnest(p_order_ids) AS o(id), public.registration_slot_units(o.id, ARRAY[p_status]) AS s
     GROUP BY s.category_id
     ORDER BY s.category_id
  LOOP
    UPDATE public.competitions SET taken = taken - u.n WHERE category_id = u.category_id;
  END LOOP;
END $$;
REVOKE EXECUTE ON FUNCTION public.registration_release_slots(uuid[], text) FROM public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- create_order

CREATE FUNCTION public.create_order(
  p_category_id uuid, p_people jsonb, p_profile_id uuid, p_buyer_email text,
  p_support_choice boolean, p_displayed_total integer, p_meta jsonb)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_comp      public.competitions%ROWTYPE;
  v_rs        public.registration_settings%ROWTYPE;
  v_n         integer;
  v_tier      uuid;
  v_tier_ends date;
  v_label     text;
  v_price     integer;
  v_entry     bigint;
  v_support   integer;
  v_fee       integer;
  v_total     bigint;
  v_free      boolean;
  v_buyer     text;
  v_profile   uuid;
  v_sent      uuid[];
  v_have      uuid[];
  v_order     uuid;
  v_expires   timestamptz;
  v_person    jsonb;
  v_email     text;
  v_reg       uuid;
  v_regs      uuid[] := '{}';
  v_ip        inet;
  v_ua        text := left(nullif(p_meta->>'userAgent', ''), 500);
BEGIN
  IF jsonb_typeof(p_people) IS DISTINCT FROM 'array' OR jsonb_array_length(p_people) = 0 THEN
    RAISE EXCEPTION 'invalid_people';
  END IF;
  v_n := jsonb_array_length(p_people);

  -- D3-1: the competition, then the settings, as register_free.
  SELECT * INTO v_comp FROM public.competitions WHERE category_id = p_category_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  SELECT * INTO v_rs FROM public.registration_settings WHERE event_id = v_comp.event_id FOR SHARE;
  IF NOT FOUND OR v_rs.state = 'draft'
     OR NOT EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = v_rs.club_id AND c.registration_enabled) THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_rs.state <> 'published' OR v_comp.hidden_at IS NOT NULL THEN
    RAISE EXCEPTION 'closed';
  END IF;
  IF v_rs.pricing_mode = 'free' THEN
    RAISE EXCEPTION 'free_event';
  END IF;
  IF v_rs.opens_at IS NULL OR now() < v_rs.opens_at THEN
    RAISE EXCEPTION 'not_open';
  END IF;
  IF v_rs.closes_at IS NULL OR now() >= v_rs.closes_at THEN
    RAISE EXCEPTION 'closed';
  END IF;

  -- The current tier: the first whose last day (a Warsaw date) is today or later,
  -- an open-ended one last (the same choice as registration_raw).
  SELECT t.id, t.ends_on, p.amount INTO v_tier, v_tier_ends, v_price
    FROM public.price_tiers t
    JOIN public.competition_prices p ON p.tier_id = t.id AND p.category_id = p_category_id
   WHERE t.event_id = v_rs.event_id
     AND (t.ends_on IS NULL OR t.ends_on >= (now() AT TIME ZONE 'Europe/Warsaw')::date)
   ORDER BY t.ends_on NULLS LAST, t.sort_order, t.id
   LIMIT 1;
  IF v_price IS NULL THEN
    RAISE EXCEPTION 'no_price';
  END IF;
  v_label := CASE WHEN v_tier_ends IS NULL THEN 'do zamknięcia zapisów'
                  ELSE 'do ' || to_char(v_tier_ends, 'DD.MM.YYYY') END;

  v_entry := v_price::bigint * v_n;
  IF v_entry > 99999999 THEN
    RAISE EXCEPTION 'invalid_amount:total' USING ERRCODE = '22023';
  END IF;
  v_support := CASE WHEN v_entry > 0 THEN public.registration_support_fee(v_entry::integer, p_support_choice) ELSE 0 END;
  v_fee := public.registration_payment_fee((v_entry + v_support)::integer);
  v_total := v_entry + v_support + v_fee;
  IF v_total > 99999999 THEN
    RAISE EXCEPTION 'invalid_amount:total' USING ERRCODE = '22023';
  END IF;
  v_free := v_total = 0;

  -- Spec 14.10: online payment stops an hour before registration closes.
  IF NOT v_free AND now() >= v_rs.closes_at - interval '1 hour' THEN
    RAISE EXCEPTION 'paying_closed';
  END IF;

  -- D3-2: the person accepted exactly the consents the form showed, image included.
  SELECT coalesce(array_agg(DISTINCT x::uuid ORDER BY x::uuid), '{}') INTO v_sent
    FROM jsonb_array_elements_text(coalesce(p_meta->'consentIds', '[]'::jsonb)) AS t(x);
  SELECT coalesce(array_agg(ec.id ORDER BY ec.id), '{}') INTO v_have
    FROM public.event_consents ec WHERE ec.event_id = v_rs.event_id;
  IF v_sent IS DISTINCT FROM v_have THEN
    RAISE EXCEPTION 'consents_changed';
  END IF;

  v_buyer := lower(btrim(p_buyer_email));
  IF v_buyer IS NULL OR v_buyer = '' THEN
    RAISE EXCEPTION 'invalid_buyer_email';
  END IF;
  SELECT p.id INTO v_profile FROM public.profiles p WHERE p.id = p_profile_id;

  -- At most two pending orders per buyer (the account, else the address) and
  -- event. The lock makes the count and the insert one step.
  PERFORM pg_advisory_xact_lock(hashtext('create_order:' || coalesce(v_profile::text, v_buyer) || ':' || v_rs.event_id::text));
  IF (SELECT count(*) FROM public.orders o
       WHERE o.event_id = v_rs.event_id AND o.status = 'pending'
         AND CASE WHEN v_profile IS NOT NULL THEN o.buyer_profile_id = v_profile
                  ELSE o.buyer_profile_id IS NULL AND o.buyer_email = v_buyer END) >= 2 THEN
    RAISE EXCEPTION 'too_many_pending';
  END IF;

  IF p_displayed_total IS DISTINCT FROM v_total THEN
    RAISE EXCEPTION 'price_changed:%', v_total;
  END IF;

  IF public.claim_competition_slots(p_category_id, v_n) IS NULL THEN
    RAISE EXCEPTION 'full';
  END IF;

  v_expires := least(now() + make_interval(hours => v_rs.payment_window_hours), v_rs.closes_at);
  INSERT INTO public.orders (
    event_id, buyer_profile_id, buyer_email, status, entry_total, extras_total, donation,
    support_choice, support_fee, payment_fee, total, tier_id, expires_at, paid_at)
  VALUES (
    v_rs.event_id, v_profile, v_buyer, CASE WHEN v_free THEN 'paid' ELSE 'pending' END, v_entry, 0, 0,
    p_support_choice, v_support, v_fee, v_total, v_tier, v_expires, CASE WHEN v_free THEN now() END)
  RETURNING id INTO v_order;

  BEGIN
    v_ip := nullif(p_meta->>'ip', '')::inet;
  EXCEPTION WHEN others THEN
    v_ip := NULL;
  END;

  FOR v_person IN SELECT value FROM jsonb_array_elements(p_people) LOOP
    v_email := lower(btrim(v_person->>'email'));
    BEGIN
      INSERT INTO public.registrations (
        event_id, category_id, order_id, status, profile_id, first_name, last_name, birth_date, gender, email,
        phone, city, club, ice_name, ice_phone, nationality, age_group_label, kids_group_id, consent_state,
        list_price, price)
      VALUES (
        v_rs.event_id, p_category_id, v_order, CASE WHEN v_free THEN 'confirmed' ELSE 'pending_payment' END,
        -- The account is this person's only when its address is theirs.
        (SELECT p.id FROM public.profiles p WHERE p.id = p_profile_id AND lower(p.email) = v_email),
        v_person->>'firstName', v_person->>'lastName', (v_person->>'birthDate')::date, v_person->>'gender',
        v_email, v_person->>'phone', v_person->>'city', v_person->>'club', v_person->>'iceName',
        v_person->>'icePhone', nullif(v_person->>'nationality', ''), v_person->>'ageGroupLabel', nullif(v_person->>'kidsGroupId', '')::uuid,
        'accepted', v_price, v_price)
      RETURNING id INTO v_reg;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'duplicate';
    END;

    INSERT INTO public.consent_acceptances (
      registration_id, consent_id, consent_kind, accepted_by_profile_id, accepted_as, regulamin_version, ip, user_agent)
    SELECT v_reg, ec.id, ec.kind, p_profile_id, 'self',
           CASE WHEN ec.kind = 'regulamin' THEN v_rs.regulamin_version END, v_ip, v_ua
      FROM public.event_consents ec WHERE ec.event_id = v_rs.event_id
    UNION ALL
    SELECT v_reg, NULL, 'service_regulamin', p_profile_id, 'self', NULL, v_ip, v_ua;

    INSERT INTO public.order_lines (order_id, kind, registration_id, qty, amount, tier_label, tier_ends_on)
    VALUES (v_order, 'entry', v_reg, 1, v_price, v_label, v_tier_ends);

    v_regs := v_regs || v_reg;
  END LOOP;

  IF v_free THEN
    PERFORM public.insert_registration_participant(r) FROM unnest(v_regs) AS r;
  END IF;

  RETURN jsonb_build_object(
    'orderId', v_order,
    'status', CASE WHEN v_free THEN 'paid' ELSE 'pending' END,
    'total', v_total,
    'amounts', jsonb_build_object(
      'entryTotal', v_entry, 'extrasTotal', 0, 'donation', 0,
      'supportFee', v_support, 'paymentFee', v_fee, 'total', v_total),
    'expiresAt', v_expires);
END $$;
REVOKE EXECUTE ON FUNCTION public.create_order(uuid, jsonb, uuid, text, boolean, integer, jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_order(uuid, jsonb, uuid, text, boolean, integer, jsonb) TO service_role;

-- ---------------------------------------------------------------- add_payment_attempt

CREATE FUNCTION public.add_payment_attempt(p_order_id uuid, p_txn text, p_grosze integer) RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  o      public.orders%ROWTYPE;
  v_id   uuid;
BEGIN
  SELECT * INTO o FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND OR o.status <> 'pending' OR o.expires_at <= now() THEN
    RAISE EXCEPTION 'not_payable';
  END IF;
  -- User decision: no new payment once registration has closed.
  IF NOT EXISTS (SELECT 1 FROM public.registration_settings rs
                  WHERE rs.event_id = o.event_id AND rs.closes_at > now()) THEN
    RAISE EXCEPTION 'not_payable';
  END IF;
  IF p_grosze IS DISTINCT FROM o.total THEN
    RAISE EXCEPTION 'amount_mismatch';
  END IF;
  INSERT INTO public.payment_attempts (order_id, dpay_transaction_id, grosze)
  VALUES (o.id, p_txn, p_grosze)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
REVOKE EXECUTE ON FUNCTION public.add_payment_attempt(uuid, text, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.add_payment_attempt(uuid, text, integer) TO service_role;

-- ---------------------------------------------------------------- refunds

-- One refund row. messageId labels the dpay transfer (24 hex characters of the
-- refund id); it is not an idempotency key. The refunds already recorded for
-- the attempt (other than rejected ones) plus this one never exceed what it paid.
CREATE FUNCTION public.record_refund(p_attempt_id uuid, p_grosze integer, p_kind text, p_reason text) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  a     public.payment_attempts%ROWTYPE;
  v_id  uuid := gen_random_uuid();
  v_msg text := left(replace(v_id::text, '-', ''), 24);
BEGIN
  IF p_grosze IS NULL OR p_grosze <= 0 THEN
    RAISE EXCEPTION 'invalid_amount';
  END IF;
  SELECT * INTO a FROM public.payment_attempts WHERE id = p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF p_grosze + coalesce((SELECT sum(f.amount) FROM public.refunds f
                           WHERE f.payment_attempt_id = a.id AND f.dpay_status <> 'rejected'), 0) > a.grosze THEN
    RAISE EXCEPTION 'invalid_amount';
  END IF;
  INSERT INTO public.refunds (id, order_id, payment_attempt_id, amount, kind, reason, message_id)
  VALUES (v_id, a.order_id, a.id, p_grosze, p_kind, p_reason, v_msg);
  RETURN jsonb_build_object('refundId', v_id, 'messageId', v_msg);
END $$;
REVOKE EXECUTE ON FUNCTION public.record_refund(uuid, integer, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_refund(uuid, integer, text, text) TO service_role;

-- The dpay outcome of a refund call. Only insufficient_balance (406) is retried,
-- an hour later; unknown is left for a person (ruling 8).
CREATE FUNCTION public.settle_refund(p_refund_id uuid, p_outcome text) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_attempt uuid;
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('accepted', 'rejected', 'insufficient_balance', 'unknown') THEN
    RAISE EXCEPTION 'invalid_outcome';
  END IF;
  UPDATE public.refunds
     SET dpay_status = p_outcome,
         attempts = attempts + 1,
         next_retry_at = CASE WHEN p_outcome = 'insufficient_balance' THEN now() + interval '1 hour' END
   WHERE id = p_refund_id
  RETURNING payment_attempt_id INTO v_attempt;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF p_outcome = 'accepted' THEN
    UPDATE public.payment_attempts SET status = 'refunded' WHERE id = v_attempt;
  END IF;
END $$;
REVOKE EXECUTE ON FUNCTION public.settle_refund(uuid, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_refund(uuid, text) TO service_role;

-- Internal: refund an attempt in full, alert the operator, → the refund object.
CREATE FUNCTION public.registration_refund_attempt(
  p_order_id uuid, p_attempt_id uuid, p_grosze integer, p_alert text, p_reason text, p_source text)
  RETURNS jsonb
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
DECLARE
  v_rec jsonb;
  v_out jsonb;
BEGIN
  v_rec := public.record_refund(p_attempt_id, p_grosze, 'automatic', p_reason);
  v_out := jsonb_build_object('attemptId', p_attempt_id, 'grosze', p_grosze, 'reason', p_reason) || v_rec;
  INSERT INTO public.operator_alerts (kind, order_id, payload)
  VALUES (p_alert, p_order_id, v_out || jsonb_build_object('source', p_source));
  RETURN v_out;
END $$;
REVOKE EXECUTE ON FUNCTION public.registration_refund_attempt(uuid, uuid, integer, text, text, text)
  FROM public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- confirm_order

CREATE FUNCTION public.confirm_order(p_order_id uuid, p_txn text, p_grosze integer, p_source text) RETURNS jsonb
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
    INSERT INTO public.operator_alerts (kind, order_id, payload)
    VALUES ('unknown_attempt', o.id, jsonb_build_object(
      'orderId', p_order_id, 'txn', p_txn, 'grosze', p_grosze, 'source', p_source));
    RETURN jsonb_build_object('outcome', 'unknown_attempt');
  END IF;

  -- (3) Ruling 6: a mismatch never confirms and never refunds.
  IF p_grosze IS DISTINCT FROM a.grosze OR p_grosze IS DISTINCT FROM o.total THEN
    INSERT INTO public.operator_alerts (kind, order_id, payload)
    VALUES ('amount_mismatch', o.id, jsonb_build_object(
      'attemptId', a.id, 'txn', p_txn, 'grosze', p_grosze, 'expected', o.total, 'source', p_source));
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

-- ---------------------------------------------------------------- expire / cancel

-- The payment window job. One statement flips every due order; orders another
-- transaction holds (a confirm in flight, a second run of this job) are skipped
-- and picked up by the next run. Then the slots go back (competitions in
-- category_id order) and only then do the registrations flip: flipping them
-- first deadlocks against a create_order that holds the competition and
-- inserts the same address.
CREATE FUNCTION public.expire_orders(p_now timestamptz DEFAULT now()) RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_ids uuid[];
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
END $$;
REVOKE EXECUTE ON FUNCTION public.expire_orders(timestamptz) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_orders(timestamptz) TO service_role;

-- A pending order given up (by the runner or an operator). → whether it was pending.
CREATE FUNCTION public.cancel_order(p_order_id uuid, p_reason text) RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
BEGIN
  UPDATE public.orders SET status = 'cancelled', cancelled_reason = left(p_reason, 500)
   WHERE id = p_order_id AND status = 'pending';
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  PERFORM public.registration_release_slots(ARRAY[p_order_id], 'pending_payment');
  UPDATE public.registrations SET status = 'cancelled'
   WHERE order_id = p_order_id AND status = 'pending_payment';
  RETURN true;
END $$;
REVOKE EXECUTE ON FUNCTION public.cancel_order(uuid, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_order(uuid, text) TO service_role;
