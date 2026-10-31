-- Race registration, plan 4 task 2: group registrations. One request registers several
-- people (the buyer, other adults, children), each in their own competition.
--
--   registrations.registered_by_profile_id  who submitted the request (set on every row
--                                           of it): who may remind and see the group
--   registrations_event_minor_live_key      one live start per child (ruling 2): a child
--                                           has no address, so name + birth date decide
--   register_free(p_people, p_profile_id, p_meta)
--   create_order(p_people, p_profile_id, p_buyer_email, p_support_choice, p_displayed_total, p_meta)
--                                           the group functions; every person carries
--                                           { categoryId, role: self|adult|minor, …person }
--   register_free(uuid, jsonb, uuid, jsonb) and create_order(uuid, jsonb, uuid, text, boolean,
--   integer, jsonb)                         kept as thin wrappers (same signature, same
--                                           result shape, bare 'full' / 'duplicate'), because CI
--                                           pushes the schema before it deploys the functions
--                                           that still call them, and Plans 2–3 test them
--
-- Lock order (D3-1, the one publish_registration_changes and confirm_order take): every
-- competition of the request FOR UPDATE in category_id order, then the settings row FOR
-- SHARE, then registrations. A competition is never locked after the settings row.
--
-- Capacity (P3-R15): a free group (and a 0 zł order) claims every competition in
-- category_id order, all or nothing; the first that has no room raises full:<categoryId>
-- and the whole transaction rolls back. A group that must be paid claims nothing: it is
-- refused with full:<categoryId> when the confirmed entries plus the group's people in
-- that competition pass the limit. confirm_order, expire_orders, cancel_order,
-- release_orphan_orders and buyer_cancel_order are unchanged (D4-16, D4-18): confirm_order
-- already claims per competition, all or none, and refunds the whole order otherwise.
--
-- Rows by role:
--   self   the buyer, consent_state 'accepted', acceptances 'self' (every event consent +
--          service_regulamin), as register_free wrote them before
--   adult  another grown-up, consent_state 'awaiting', no acceptance yet (task 3 asks them)
--   minor  email null, guardian = the buyer (profile, name from p_meta.buyerName, the
--          account's address), consent_state 'accepted', acceptances 'guardian' by the
--          buyer: every event consent + service_regulamin on every child row
-- A unique violation raises duplicate:<index> (0-based, the person whose insert failed).

-- ---------------------------------------------------------------- columns and indexes

ALTER TABLE public.registrations
  ADD COLUMN registered_by_profile_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL;
CREATE INDEX registrations_registered_by_profile_id_idx ON public.registrations (registered_by_profile_id);

-- Ruling 2: one live start per child. delete-my-account nulls birth_date, so an
-- anonymised row never collides.
CREATE UNIQUE INDEX registrations_event_minor_live_key
  ON public.registrations (event_id, lower(btrim(first_name)), lower(btrim(last_name)), birth_date)
  WHERE email IS NULL AND status IN ('pending_payment', 'confirmed');

-- ---------------------------------------------------------------- shared internals

-- The request's people checked for shape and its competitions locked (D3-1: competitions
-- in category_id order, then the settings row). Raises invalid_people, not_found,
-- mixed_events, closed, not_open and consents_changed; the caller checks pricing.
-- „At most one 'self', the session's person” is group.js's rule, not this one: the
-- old-signature wrappers mark every person 'self', as Plans 2–3 wrote them.
-- Internal: executable by nobody but the SECURITY DEFINER callers (it runs as its caller).
CREATE FUNCTION public.registration_group_lock(p_people jsonb, p_meta jsonb,
                                               OUT o_settings public.registration_settings,
                                               OUT o_cats uuid[])
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
DECLARE
  v_person jsonb;
  v_role   text;
  v_events uuid[];
  v_n      integer;
  v_sent   uuid[];
  v_have   uuid[];
BEGIN
  IF jsonb_typeof(p_people) IS DISTINCT FROM 'array' OR jsonb_array_length(p_people) = 0 THEN
    RAISE EXCEPTION 'invalid_people';
  END IF;
  FOR v_person IN SELECT value FROM jsonb_array_elements(p_people) LOOP
    IF jsonb_typeof(v_person) IS DISTINCT FROM 'object'
       OR coalesce(v_person->>'categoryId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'invalid_people';
    END IF;
    v_role := v_person->>'role';
    IF v_role IS NULL OR v_role NOT IN ('self', 'adult', 'minor') THEN
      RAISE EXCEPTION 'invalid_people';
    END IF;
    IF nullif(btrim(v_person->>'firstName'), '') IS NULL OR nullif(btrim(v_person->>'lastName'), '') IS NULL THEN
      RAISE EXCEPTION 'invalid_people';
    END IF;
    -- An adult is kept unique by the address, a child by name + birth date.
    IF v_role <> 'minor' AND nullif(btrim(v_person->>'email'), '') IS NULL THEN
      RAISE EXCEPTION 'invalid_people';
    END IF;
    IF v_role = 'minor' AND nullif(v_person->>'birthDate', '') IS NULL THEN
      RAISE EXCEPTION 'invalid_people';
    END IF;
  END LOOP;

  SELECT array_agg(DISTINCT (e->>'categoryId')::uuid ORDER BY (e->>'categoryId')::uuid) INTO o_cats
    FROM jsonb_array_elements(p_people) AS e;

  -- D3-1: every competition first, in category_id order.
  PERFORM 1 FROM public.competitions c WHERE c.category_id = ANY (o_cats) ORDER BY c.category_id FOR UPDATE;
  SELECT count(*), array_agg(DISTINCT c.event_id) INTO v_n, v_events
    FROM public.competitions c WHERE c.category_id = ANY (o_cats);
  IF v_n <> cardinality(o_cats) THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF cardinality(v_events) > 1 THEN
    RAISE EXCEPTION 'mixed_events';
  END IF;

  SELECT * INTO o_settings FROM public.registration_settings WHERE event_id = v_events[1] FOR SHARE;
  IF NOT FOUND OR o_settings.state = 'draft'
     OR NOT EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = o_settings.club_id AND c.registration_enabled) THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF o_settings.state <> 'published'
     OR EXISTS (SELECT 1 FROM public.competitions c WHERE c.category_id = ANY (o_cats) AND c.hidden_at IS NOT NULL) THEN
    RAISE EXCEPTION 'closed';
  END IF;
  IF o_settings.opens_at IS NULL OR now() < o_settings.opens_at THEN
    RAISE EXCEPTION 'not_open';
  END IF;
  IF o_settings.closes_at IS NULL OR now() >= o_settings.closes_at THEN
    RAISE EXCEPTION 'closed';
  END IF;

  -- D3-2 / D4-5: the payer accepted exactly the consents the form showed, image included.
  SELECT coalesce(array_agg(DISTINCT x::uuid ORDER BY x::uuid), '{}') INTO v_sent
    FROM jsonb_array_elements_text(coalesce(p_meta->'consentIds', '[]'::jsonb)) AS t(x);
  SELECT coalesce(array_agg(ec.id ORDER BY ec.id), '{}') INTO v_have
    FROM public.event_consents ec WHERE ec.event_id = o_settings.event_id;
  IF v_sent IS DISTINCT FROM v_have THEN
    RAISE EXCEPTION 'consents_changed';
  END IF;
END $$;
REVOKE EXECUTE ON FUNCTION public.registration_group_lock(jsonb, jsonb) FROM public, anon, authenticated, service_role;

-- One registration row of a group with its acceptances (the role decides both). Raises
-- duplicate:<p_index> on a unique violation. Internal, like registration_group_lock.
CREATE FUNCTION public.registration_group_insert(
  p_rs public.registration_settings, p_person jsonb, p_index integer, p_profile_id uuid,
  p_buyer_email text, p_buyer_name text, p_order_id uuid, p_status text, p_price integer,
  p_ip inet, p_ua text) RETURNS uuid
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
DECLARE
  v_role  text := p_person->>'role';
  v_email text := CASE WHEN p_person->>'role' = 'minor' THEN NULL ELSE lower(btrim(p_person->>'email')) END;
  v_reg   uuid;
BEGIN
  BEGIN
    INSERT INTO public.registrations (
      event_id, category_id, order_id, status, profile_id, registered_by_profile_id,
      first_name, last_name, birth_date, gender, email,
      phone, city, club, ice_name, ice_phone, nationality, age_group_label, kids_group_id,
      guardian_profile_id, guardian_name, guardian_email, consent_state, list_price, price)
    VALUES (
      p_rs.event_id, (p_person->>'categoryId')::uuid, p_order_id, p_status,
      -- The account is this person's only when its address is theirs.
      CASE WHEN v_email IS NOT NULL
           THEN (SELECT p.id FROM public.profiles p WHERE p.id = p_profile_id AND lower(p.email) = v_email) END,
      p_profile_id,
      p_person->>'firstName', p_person->>'lastName', (p_person->>'birthDate')::date, p_person->>'gender', v_email,
      p_person->>'phone', p_person->>'city', p_person->>'club', p_person->>'iceName', p_person->>'icePhone',
      nullif(p_person->>'nationality', ''), p_person->>'ageGroupLabel', nullif(p_person->>'kidsGroupId', '')::uuid,
      CASE WHEN v_role = 'minor' THEN p_profile_id END,
      CASE WHEN v_role = 'minor' THEN p_buyer_name END,
      CASE WHEN v_role = 'minor' THEN p_buyer_email END,
      CASE WHEN v_role = 'adult' THEN 'awaiting' ELSE 'accepted' END,
      p_price, p_price)
    RETURNING id INTO v_reg;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'duplicate:%', p_index;
  END;

  -- An added adult accepts for themself later (consent request, task 3). The buyer accepts
  -- for themself, and as guardian for every child, the LESZY.RUN service regulamin included.
  IF v_role IN ('self', 'minor') THEN
    INSERT INTO public.consent_acceptances (
      registration_id, consent_id, consent_kind, accepted_by_profile_id, accepted_as, regulamin_version, ip, user_agent)
    SELECT v_reg, ec.id, ec.kind, p_profile_id, CASE WHEN v_role = 'minor' THEN 'guardian' ELSE 'self' END,
           CASE WHEN ec.kind = 'regulamin' THEN p_rs.regulamin_version END, p_ip, p_ua
      FROM public.event_consents ec WHERE ec.event_id = p_rs.event_id
    UNION ALL
    SELECT v_reg, NULL, 'service_regulamin', p_profile_id, CASE WHEN v_role = 'minor' THEN 'guardian' ELSE 'self' END,
           NULL, p_ip, p_ua;
  END IF;
  RETURN v_reg;
END $$;
REVOKE EXECUTE ON FUNCTION public.registration_group_insert(public.registration_settings, jsonb, integer, uuid, text, text,
  uuid, text, integer, inet, text) FROM public, anon, authenticated, service_role;

-- Claims every competition of the group in category_id order, all or nothing (the
-- caller's transaction rolls back on the raise). Internal.
CREATE FUNCTION public.registration_group_claim(p_people jsonb) RETURNS void
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
DECLARE
  u record;
BEGIN
  FOR u IN
    SELECT (e->>'categoryId')::uuid AS category_id, count(*)::integer AS n
      FROM jsonb_array_elements(p_people) AS e
     GROUP BY 1 ORDER BY 1
  LOOP
    IF public.claim_competition_slots(u.category_id, u.n) IS NULL THEN
      RAISE EXCEPTION 'full:%', u.category_id;
    END IF;
  END LOOP;
END $$;
REVOKE EXECUTE ON FUNCTION public.registration_group_claim(jsonb) FROM public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- register_free (group)

CREATE FUNCTION public.register_free(p_people jsonb, p_profile_id uuid, p_meta jsonb)
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

-- ---------------------------------------------------------------- register_free (old signature)

-- Plan 2's signature, kept while deployed functions and Plans 2–3 call it: every person
-- 'self' in p_category_id, the result and the errors as before.
CREATE OR REPLACE FUNCTION public.register_free(p_category_id uuid, p_people jsonb, p_profile_id uuid, p_meta jsonb)
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
    v_res := public.register_free(v_people, p_profile_id, p_meta);
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'full:%' THEN
      RAISE EXCEPTION 'full';
    ELSIF SQLERRM LIKE 'duplicate:%' THEN
      RAISE EXCEPTION 'duplicate';
    END IF;
    RAISE;
  END;
  RETURN jsonb_build_object('registrations', (
    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'id', r->'id', 'participantId', r->'participantId',
             'email', lower(btrim(p_people->((r->>'index')::integer)->>'email'))) ORDER BY (r->>'index')::integer), '[]'::jsonb)
      FROM jsonb_array_elements(v_res->'registrations') AS r));
END $$;
REVOKE EXECUTE ON FUNCTION public.register_free(uuid, jsonb, uuid, jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_free(uuid, jsonb, uuid, jsonb) TO service_role;

-- ---------------------------------------------------------------- create_order (group)

CREATE FUNCTION public.create_order(
  p_people jsonb, p_profile_id uuid, p_buyer_email text,
  p_support_choice boolean, p_displayed_total integer, p_meta jsonb)
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
  v_support   integer;
  v_fee       integer;
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
      'entryTotal', v_entry, 'extrasTotal', 0, 'donation', 0,
      'supportFee', v_support, 'paymentFee', v_fee, 'total', v_total),
    'expiresAt', v_expires,
    'registrations', v_out);
END $$;
REVOKE EXECUTE ON FUNCTION public.create_order(jsonb, uuid, text, boolean, integer, jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_order(jsonb, uuid, text, boolean, integer, jsonb) TO service_role;

-- ---------------------------------------------------------------- create_order (old signature)

-- Plan 3's signature (body from 20261030170000), kept like register_free's: every person
-- 'self' in p_category_id, Plan 3's object, bare 'full' / 'duplicate'.
CREATE OR REPLACE FUNCTION public.create_order(
  p_category_id uuid, p_people jsonb, p_profile_id uuid, p_buyer_email text,
  p_support_choice boolean, p_displayed_total integer, p_meta jsonb)
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
    v_res := public.create_order(v_people, p_profile_id, p_buyer_email, p_support_choice, p_displayed_total, p_meta);
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
REVOKE EXECUTE ON FUNCTION public.create_order(uuid, jsonb, uuid, text, boolean, integer, jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_order(uuid, jsonb, uuid, text, boolean, integer, jsonb) TO service_role;
