-- No runner-facing charge payable to LESZY.RUN (legal decision, 2026-10-31). A runner pays the
-- organizer's price, plus optional extras and a donation later (Plan 7), and LESZY.RUN invoices
-- the organizer afterwards, outside this code. orders.total is now
-- entry_total + extras_total + donation.
--
-- * orders.support_choice, support_fee and payment_fee go, with their CHECKs, and so do the SQL
--   mirrors of the two fee formulas.
-- * The guard below refuses to run if any order carries a fee. Production had 0 orders when this
--   was written and a paid event cannot be published while PAID_REGISTRATION_ENABLED is false. An
--   order with a fee means that assumption broke, and a person must decide what happens to it:
--   the release should stop rather than rewrite money.
-- * create_order loses p_support_choice in both overloads. The old signature cannot be replaced
--   in place, so both are dropped and created again, with their REVOKEs and GRANTs.

DO $$
DECLARE
  v_count bigint;
BEGIN
  SELECT count(*) INTO v_count FROM public.orders WHERE support_fee <> 0 OR payment_fee <> 0;
  IF v_count > 0 THEN
    RAISE EXCEPTION '% order(s) carry a participant fee: decide what happens to them before removing the fee columns', v_count;
  END IF;
END $$;

ALTER TABLE public.orders
  DROP CONSTRAINT orders_support_choice_check,
  DROP CONSTRAINT orders_support_fee_choice_check,
  DROP CONSTRAINT orders_amounts_add_up_check;
ALTER TABLE public.orders
  DROP COLUMN support_choice,
  DROP COLUMN support_fee,
  DROP COLUMN payment_fee;
ALTER TABLE public.orders
  ADD CONSTRAINT orders_amounts_add_up_check
    CHECK (total = entry_total + extras_total + donation);

DROP FUNCTION public.create_order(uuid, jsonb, uuid, text, boolean, integer, jsonb);
DROP FUNCTION public.create_order(jsonb, uuid, text, boolean, integer, jsonb);
DROP FUNCTION public.registration_support_fee(integer, boolean);
DROP FUNCTION public.registration_payment_fee(integer);

-- ---------------------------------------------------------------- create_order (group)

CREATE FUNCTION public.create_order(
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
  IF v_rs.pricing_mode = 'free' THEN
    RAISE EXCEPTION 'free_event';
  END IF;

  -- The current tier, as before; every person at their own competition's price in it.
  -- v_prices is keyed by the canonical uuid text, so every lookup casts the person's
  -- categoryId through uuid (an uppercase id prices like a lowercase one).
  SELECT t.id, t.ends_on INTO v_tier, v_tier_ends
    FROM public.price_tiers t
   WHERE t.event_id = v_rs.event_id
     AND (t.ends_on IS NULL OR t.ends_on >= (now() AT TIME ZONE 'Europe/Warsaw')::date)
   ORDER BY t.ends_on NULLS LAST, t.sort_order, t.id
   LIMIT 1;
  FOR u IN SELECT c AS category_id FROM unnest(v_cats) AS c LOOP
    SELECT p.amount INTO v_price FROM public.competition_prices p
     WHERE p.tier_id = v_tier AND p.category_id = u.category_id;
    IF v_price IS NULL THEN
      RAISE EXCEPTION 'no_price';
    END IF;
    v_prices := v_prices || jsonb_build_object(u.category_id::text, v_price);
  END LOOP;
  v_label := CASE WHEN v_tier_ends IS NULL THEN 'do zamknięcia zapisów'
                  ELSE 'do ' || to_char(v_tier_ends, 'DD.MM.YYYY') END;

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

-- ---------------------------------------------------------------- create_order (old signature)

-- Plan 3's signature, kept like register_free's: every person 'self' in p_category_id, Plan 3's
-- object, bare 'full' / 'duplicate'.
CREATE FUNCTION public.create_order(
  p_category_id uuid, p_people jsonb, p_profile_id uuid, p_buyer_email text,
  p_displayed_total integer, p_meta jsonb)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_people jsonb;
  v_res    jsonb;
BEGIN
  IF jsonb_typeof(p_people) IS DISTINCT FROM 'array' OR jsonb_array_length(p_people) = 0 THEN
    RAISE EXCEPTION 'invalid_people';
  END IF;
  SELECT jsonb_agg(CASE WHEN jsonb_typeof(e) = 'object'
                        THEN e || jsonb_build_object('categoryId', p_category_id, 'role', 'self') ELSE e END
                   ORDER BY i)
    INTO v_people FROM jsonb_array_elements(p_people) WITH ORDINALITY AS t(e, i);
  BEGIN
    v_res := public.create_order(v_people, p_profile_id, p_buyer_email, p_displayed_total, p_meta);
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'full:%' THEN
      RAISE EXCEPTION 'full';
    ELSIF SQLERRM LIKE 'duplicate:%' THEN
      RAISE EXCEPTION 'duplicate';
    END IF;
    RAISE;
  END;
  RETURN v_res - 'registrations';
END $$;
REVOKE EXECUTE ON FUNCTION public.create_order(uuid, jsonb, uuid, text, integer, jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_order(uuid, jsonb, uuid, text, integer, jsonb) TO service_role;
