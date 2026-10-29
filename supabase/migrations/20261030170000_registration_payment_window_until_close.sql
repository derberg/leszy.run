-- Plan 3, user request 2026-10-29: the payment window „do końca zapisów”.
--
-- registration_settings.payment_window_until_close (boolean, default false) beside
-- payment_window_hours (24 / 168 / 336, unchanged and still checked): when true an order's
-- expires_at is closes_at. A boolean rather than a sentinel hour value, so the hours check stays
-- what it was and a reader that misses the flag falls back to a real window, never to "now".
-- The hours are kept while the flag is on, so switching back restores them.
--
-- It is part of the payments section: saved in a draft, staged after publish and applied by
-- publish_registration_changes like payment_window_hours (registration_pending_fields compares
-- columns generically). The reminder needs nothing: claim_payment_reminders already works on
-- expires_at - created_at (half the window, only when it is 6 h or more).
--
-- apply_registration_section is re-created from 20261030130000 (only the payments branch gains a
-- line); create_order from 20261030160000 (only expires_at).

ALTER TABLE public.registration_settings
  ADD COLUMN payment_window_until_close boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------- apply_registration_section (from 20261030130000)

CREATE OR REPLACE FUNCTION public.apply_registration_section(p_event_id uuid, p_section text, p_value jsonb, p_allow_delete boolean)
  RETURNS jsonb
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
DECLARE
  v_state  text;
  v_item   jsonb;
  v_idx    integer := 0;
  v_id     uuid;
  v_ids    uuid[] := '{}';
  v_tier   uuid;
  v_del    record;
  v_result jsonb := '{}'::jsonb;
BEGIN
  SELECT rs.state INTO v_state FROM public.registration_settings rs WHERE rs.event_id = p_event_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF p_section = 'basics' THEN
    IF p_value ? 'slug' AND (
         EXISTS (SELECT 1 FROM public.events e WHERE e.slug = p_value->>'slug' AND e.id <> p_event_id)
      OR EXISTS (SELECT 1 FROM public.registration_settings rs
                  WHERE rs.slug = p_value->>'slug' AND rs.event_id <> p_event_id)) THEN
      RAISE EXCEPTION 'slug_taken';
    END IF;
    IF p_value ? 'poster_upload_id' THEN
      PERFORM public.registration_check_upload(p_event_id, p_value->>'poster_upload_id', 'poster');
    END IF;
    IF p_value ? 'regulamin_upload_id' THEN
      PERFORM public.registration_check_upload(p_event_id, p_value->>'regulamin_upload_id', 'regulamin');
    END IF;
    BEGIN
      UPDATE public.registration_settings SET
        name                = CASE WHEN p_value ? 'name' THEN p_value->>'name' ELSE name END,
        slug                = CASE WHEN p_value ? 'slug' THEN p_value->>'slug' ELSE slug END,
        event_date          = CASE WHEN p_value ? 'event_date' THEN (p_value->>'event_date')::date ELSE event_date END,
        first_start_time    = CASE WHEN p_value ? 'first_start_time' THEN (p_value->>'first_start_time')::time ELSE first_start_time END,
        opens_at            = CASE WHEN p_value ? 'opens_at' THEN (p_value->>'opens_at')::timestamptz ELSE opens_at END,
        closes_at           = CASE WHEN p_value ? 'closes_at' THEN (p_value->>'closes_at')::timestamptz ELSE closes_at END,
        is_charity          = CASE WHEN p_value ? 'is_charity' THEN (p_value->>'is_charity')::boolean ELSE is_charity END,
        charity_goal        = CASE WHEN p_value ? 'charity_goal' THEN p_value->>'charity_goal' ELSE charity_goal END,
        donations_enabled   = CASE WHEN p_value ? 'donations_enabled' THEN (p_value->>'donations_enabled')::boolean ELSE donations_enabled END,
        town_label          = CASE WHEN p_value ? 'town_label' THEN p_value->>'town_label' ELSE town_label END,
        town_area           = CASE WHEN p_value ? 'town_area' THEN p_value->>'town_area' ELSE town_area END,
        place_details       = CASE WHEN p_value ? 'place_details' THEN p_value->>'place_details' ELSE place_details END,
        lat                 = CASE WHEN p_value ? 'lat' THEN (p_value->>'lat')::numeric ELSE lat END,
        lng                 = CASE WHEN p_value ? 'lng' THEN (p_value->>'lng')::numeric ELSE lng END,
        regulamin_kind      = CASE WHEN p_value ? 'regulamin_kind' THEN p_value->>'regulamin_kind' ELSE regulamin_kind END,
        regulamin_url       = CASE WHEN p_value ? 'regulamin_url' THEN p_value->>'regulamin_url' ELSE regulamin_url END,
        regulamin_upload_id = CASE WHEN p_value ? 'regulamin_upload_id' THEN (p_value->>'regulamin_upload_id')::uuid ELSE regulamin_upload_id END,
        poster_upload_id    = CASE WHEN p_value ? 'poster_upload_id' THEN (p_value->>'poster_upload_id')::uuid ELSE poster_upload_id END,
        contact_email       = CASE WHEN p_value ? 'contact_email' THEN p_value->>'contact_email' ELSE contact_email END
      WHERE event_id = p_event_id;
    EXCEPTION WHEN unique_violation THEN
      -- a concurrent save claimed the slug after the check above
      RAISE EXCEPTION 'slug_taken';
    END;

  ELSIF p_section = 'office' THEN
    UPDATE public.registration_settings SET
      office_same_as_event = CASE WHEN p_value ? 'office_same_as_event' THEN (p_value->>'office_same_as_event')::boolean ELSE office_same_as_event END,
      office_address       = CASE WHEN p_value ? 'office_address' THEN p_value->>'office_address' ELSE office_address END,
      office_notes         = CASE WHEN p_value ? 'office_notes' THEN p_value->>'office_notes' ELSE office_notes END,
      office_lat           = CASE WHEN p_value ? 'office_lat' THEN (p_value->>'office_lat')::numeric ELSE office_lat END,
      office_lng           = CASE WHEN p_value ? 'office_lng' THEN (p_value->>'office_lng')::numeric ELSE office_lng END
    WHERE event_id = p_event_id;
    IF p_value ? 'hours' THEN
      DELETE FROM public.office_hours WHERE event_id = p_event_id;
      -- Hours are Warsaw wall-clock times.
      INSERT INTO public.office_hours (event_id, starts_at, ends_at)
      SELECT p_event_id,
             ((h->>'date')::date + (h->>'from')::time) AT TIME ZONE 'Europe/Warsaw',
             ((h->>'date')::date + (h->>'to')::time) AT TIME ZONE 'Europe/Warsaw'
        FROM jsonb_array_elements(p_value->'hours') AS h;
    END IF;

  ELSIF p_section = 'competitions' THEN
    -- Every referenced id must belong to this event.
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_value->'items') AS i
       WHERE i->>'category_id' IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM public.competitions c
                          WHERE c.category_id = (i->>'category_id')::uuid AND c.event_id = p_event_id)) THEN
      RAISE EXCEPTION 'foreign_id';
    END IF;
    FOR v_item IN SELECT value FROM jsonb_array_elements(p_value->'items') LOOP
      IF v_item ? 'gpx_upload_id' THEN
        PERFORM public.registration_check_upload(p_event_id, v_item->>'gpx_upload_id', 'gpx');
      END IF;
    END LOOP;

    -- Competitions left out of the list are deleted, child rows first, only in
    -- a draft and only while nobody registered. The category goes last, with
    -- the delete-refusal trigger's draft exception switched on for that one
    -- statement.
    FOR v_del IN
      SELECT c.category_id, c.taken FROM public.competitions c
       WHERE c.event_id = p_event_id
         AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_value->'items') AS i
                          WHERE (i->>'category_id')::uuid = c.category_id)
       FOR UPDATE
    LOOP
      IF NOT p_allow_delete OR v_state <> 'draft' OR v_del.taken > 0 THEN
        RAISE EXCEPTION 'competition_locked';
      END IF;
      DELETE FROM public.competition_prices WHERE category_id = v_del.category_id;
      DELETE FROM public.age_groups WHERE category_id = v_del.category_id;
      DELETE FROM public.kids_groups WHERE category_id = v_del.category_id;
      DELETE FROM public.competitions WHERE category_id = v_del.category_id;
      PERFORM set_config('leszyrun.registration_draft_delete', 'on', true);
      DELETE FROM public.categories WHERE id = v_del.category_id;
      PERFORM set_config('leszyrun.registration_draft_delete', 'off', true);
    END LOOP;

    UPDATE public.registration_settings SET pricing_mode = p_value->>'pricing_mode' WHERE event_id = p_event_id;
    IF p_value->>'pricing_mode' = 'fixed' THEN
      -- Fixed pricing = exactly one tier, open until registration closes.
      SELECT t.id INTO v_tier FROM public.price_tiers t
       WHERE t.event_id = p_event_id AND t.ends_on IS NULL ORDER BY t.sort_order LIMIT 1;
      IF v_tier IS NULL THEN
        INSERT INTO public.price_tiers (event_id, ends_on, sort_order) VALUES (p_event_id, NULL, 0)
        RETURNING id INTO v_tier;
      END IF;
      DELETE FROM public.price_tiers WHERE event_id = p_event_id AND id <> v_tier;
    ELSE
      DELETE FROM public.price_tiers WHERE event_id = p_event_id;
    END IF;

    FOR v_item IN SELECT value FROM jsonb_array_elements(p_value->'items') LOOP
      v_idx := v_idx + 1;
      v_id := (v_item->>'category_id')::uuid;
      IF v_id IS NULL THEN
        -- A draft category carries a placeholder name and slug; publish writes
        -- the competition's real name (anon can read categories).
        v_id := gen_random_uuid();
        INSERT INTO public.categories (id, event_id, name, slug, untimed)
        VALUES (v_id, p_event_id, 'Szkic ' || v_idx, 'szkic-' || v_id, NOT (v_item->>'timed')::boolean);
        INSERT INTO public.competitions (category_id, event_id, name, kind, discipline, distance_label, start_time,
                                         capacity, min_age, max_age, is_kids, timed, gpx_upload_id, sort_order)
        VALUES (v_id, p_event_id, v_item->>'name', v_item->>'kind', v_item->>'discipline', v_item->>'distance_label',
                (v_item->>'start_time')::time, (v_item->>'capacity')::integer, (v_item->>'min_age')::integer,
                (v_item->>'max_age')::integer, (v_item->>'is_kids')::boolean, (v_item->>'timed')::boolean,
                (v_item->>'gpx_upload_id')::uuid, v_idx);
      ELSE
        -- The limit check is in the writing statement: a registration landing
        -- meanwhile either commits first and blocks this, or waits and meets it.
        UPDATE public.competitions SET
          name = v_item->>'name', kind = v_item->>'kind', discipline = v_item->>'discipline',
          distance_label = v_item->>'distance_label', start_time = (v_item->>'start_time')::time,
          capacity = (v_item->>'capacity')::integer, min_age = (v_item->>'min_age')::integer,
          max_age = (v_item->>'max_age')::integer, is_kids = (v_item->>'is_kids')::boolean,
          timed = (v_item->>'timed')::boolean, gpx_upload_id = (v_item->>'gpx_upload_id')::uuid, sort_order = v_idx
        WHERE category_id = v_id AND taken <= (v_item->>'capacity')::integer;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'capacity_below_taken:%', v_id;
        END IF;
        UPDATE public.categories SET untimed = NOT (v_item->>'timed')::boolean WHERE id = v_id;
      END IF;
      IF p_value->>'pricing_mode' = 'fixed' THEN
        INSERT INTO public.competition_prices (category_id, tier_id, amount)
        VALUES (v_id, v_tier, (v_item->>'price')::integer)
        ON CONFLICT (category_id, tier_id) DO UPDATE SET amount = EXCLUDED.amount;
      END IF;
      v_ids := v_ids || v_id;
    END LOOP;
    v_result := jsonb_build_object('categoryIds', to_jsonb(v_ids));

  ELSIF p_section = 'categories' THEN
    IF p_value ? 'age_reckoning' THEN
      UPDATE public.registration_settings SET age_reckoning = p_value->>'age_reckoning' WHERE event_id = p_event_id;
    END IF;
    IF p_value ? 'age_groups' THEN
      IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_value->'age_groups') AS g
         WHERE NOT EXISTS (SELECT 1 FROM public.competitions c
                            WHERE c.category_id = (g->>'category_id')::uuid AND c.event_id = p_event_id)
            OR (g->>'id' IS NOT NULL AND NOT EXISTS (
                  SELECT 1 FROM public.age_groups ag JOIN public.competitions c ON c.category_id = ag.category_id
                   WHERE ag.id = (g->>'id')::uuid AND c.event_id = p_event_id))) THEN
        RAISE EXCEPTION 'foreign_id';
      END IF;
      DELETE FROM public.age_groups ag USING public.competitions c
       WHERE ag.category_id = c.category_id AND c.event_id = p_event_id
         AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_value->'age_groups') AS g
                          WHERE (g->>'id')::uuid = ag.id);
      v_ids := '{}';
      FOR v_item IN SELECT value FROM jsonb_array_elements(p_value->'age_groups') LOOP
        v_id := (v_item->>'id')::uuid;
        IF v_id IS NULL THEN
          INSERT INTO public.age_groups (category_id, gender, label, min_age, max_age)
          VALUES ((v_item->>'category_id')::uuid, v_item->>'gender', v_item->>'label',
                  (v_item->>'min_age')::integer, (v_item->>'max_age')::integer)
          RETURNING id INTO v_id;
        ELSE
          UPDATE public.age_groups SET category_id = (v_item->>'category_id')::uuid, gender = v_item->>'gender',
                 label = v_item->>'label', min_age = (v_item->>'min_age')::integer, max_age = (v_item->>'max_age')::integer
           WHERE id = v_id;
        END IF;
        v_ids := v_ids || v_id;
      END LOOP;
      v_result := v_result || jsonb_build_object('ageGroupIds', to_jsonb(v_ids));
    END IF;
    IF p_value ? 'kids_groups' THEN
      IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_value->'kids_groups') AS g
         WHERE NOT EXISTS (SELECT 1 FROM public.competitions c
                            WHERE c.category_id = (g->>'category_id')::uuid AND c.event_id = p_event_id)
            OR (g->>'id' IS NOT NULL AND NOT EXISTS (
                  SELECT 1 FROM public.kids_groups kg JOIN public.competitions c ON c.category_id = kg.category_id
                   WHERE kg.id = (g->>'id')::uuid AND c.event_id = p_event_id))) THEN
        RAISE EXCEPTION 'foreign_id';
      END IF;
      DELETE FROM public.kids_groups kg USING public.competitions c
       WHERE kg.category_id = c.category_id AND c.event_id = p_event_id
         AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_value->'kids_groups') AS g
                          WHERE (g->>'id')::uuid = kg.id);
      v_ids := '{}';
      FOR v_item IN SELECT value FROM jsonb_array_elements(p_value->'kids_groups') LOOP
        v_id := (v_item->>'id')::uuid;
        IF v_id IS NULL THEN
          INSERT INTO public.kids_groups (category_id, label, birth_year_from, birth_year_to, gender, distance_label)
          VALUES ((v_item->>'category_id')::uuid, v_item->>'label', (v_item->>'birth_year_from')::integer,
                  (v_item->>'birth_year_to')::integer, v_item->>'gender', v_item->>'distance_label')
          RETURNING id INTO v_id;
        ELSE
          UPDATE public.kids_groups SET category_id = (v_item->>'category_id')::uuid, label = v_item->>'label',
                 birth_year_from = (v_item->>'birth_year_from')::integer, birth_year_to = (v_item->>'birth_year_to')::integer,
                 gender = v_item->>'gender', distance_label = v_item->>'distance_label'
           WHERE id = v_id;
        END IF;
        v_ids := v_ids || v_id;
      END LOOP;
      v_result := v_result || jsonb_build_object('kidsGroupIds', to_jsonb(v_ids));
    END IF;

  ELSIF p_section = 'timing' THEN
    UPDATE public.registration_settings SET
      timing_mode      = CASE WHEN p_value ? 'timing_mode' THEN p_value->>'timing_mode' ELSE timing_mode END,
      timing_company   = CASE WHEN p_value ? 'timing_company' THEN p_value->>'timing_company' ELSE timing_company END,
      results_url      = CASE WHEN p_value ? 'results_url' THEN p_value->>'results_url' ELSE results_url END,
      live_results_url = CASE WHEN p_value ? 'live_results_url' THEN p_value->>'live_results_url' ELSE live_results_url END
    WHERE event_id = p_event_id;

  ELSIF p_section = 'form' THEN
    IF p_value ? 'form_fields' THEN
      UPDATE public.registration_settings SET form_fields = p_value->'form_fields' WHERE event_id = p_event_id;
    END IF;
    IF p_value ? 'consents' THEN
      -- One entry per consent: a repeated id would update the row twice.
      IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_value->'consents') AS k
         WHERE k->>'id' IS NOT NULL
         GROUP BY k->>'id' HAVING count(*) > 1) THEN
        RAISE EXCEPTION 'duplicate_id';
      END IF;
      -- Only custom consents are listed; regulamin and data_info stay as created.
      IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_value->'consents') AS k
         WHERE k->>'id' IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM public.event_consents ec
            WHERE ec.id = (k->>'id')::uuid AND ec.event_id = p_event_id AND ec.kind = 'custom')) THEN
        RAISE EXCEPTION 'foreign_id';
      END IF;
      DELETE FROM public.event_consents ec
       WHERE ec.event_id = p_event_id AND ec.kind = 'custom'
         AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_value->'consents') AS k
                          WHERE (k->>'id')::uuid = ec.id);
      v_ids := '{}';
      FOR v_item IN SELECT value FROM jsonb_array_elements(p_value->'consents') LOOP
        v_idx := v_idx + 1;
        v_id := (v_item->>'id')::uuid;
        IF v_id IS NULL THEN
          INSERT INTO public.event_consents (event_id, kind, text, sort_order)
          VALUES (p_event_id, 'custom', v_item->>'text', 1 + v_idx)
          RETURNING id INTO v_id;
        ELSE
          UPDATE public.event_consents SET text = v_item->>'text', sort_order = 1 + v_idx WHERE id = v_id;
        END IF;
        v_ids := v_ids || v_id;
      END LOOP;
      v_result := jsonb_build_object('consentIds', to_jsonb(v_ids));
    END IF;

  ELSIF p_section = 'payments' THEN
    -- The payment window only. The payout account is not a section: it is
    -- written by save_event_payout (update-event-payout, club owner only).
    UPDATE public.registration_settings SET
      payment_window_hours = CASE WHEN p_value ? 'payment_window_hours'
                                  THEN (p_value->>'payment_window_hours')::integer ELSE payment_window_hours END,
      payment_window_until_close = CASE WHEN p_value ? 'payment_window_until_close'
                                        THEN (p_value->'payment_window_until_close')::text::boolean
                                        ELSE payment_window_until_close END
    WHERE event_id = p_event_id;

  ELSE
    RAISE EXCEPTION 'unknown_section';
  END IF;

  RETURN v_result;
END $$;
REVOKE EXECUTE ON FUNCTION public.apply_registration_section(uuid, text, jsonb, boolean) FROM public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- create_order (from 20261030160000)

CREATE OR REPLACE FUNCTION public.create_order(
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

  -- Ruling P3-R4: an order belongs to a signed-in account, and its buyer
  -- address is that account's address (reminders, refund and expiry mail go
  -- there). p_buyer_email is only checked against it, never stored as given.
  SELECT p.id, lower(btrim(p.email)) INTO v_profile, v_buyer FROM public.profiles p WHERE p.id = p_profile_id;
  IF v_profile IS NULL OR v_buyer IS NULL OR v_buyer = '' THEN
    RAISE EXCEPTION 'session_required';
  END IF;
  IF p_buyer_email IS NOT NULL AND lower(btrim(p_buyer_email)) IS DISTINCT FROM v_buyer THEN
    RAISE EXCEPTION 'invalid_buyer_email';
  END IF;

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
  SELECT t.id, t.ends_on INTO v_tier, v_tier_ends
    FROM public.price_tiers t
   WHERE t.event_id = v_rs.event_id
     AND (t.ends_on IS NULL OR t.ends_on >= (now() AT TIME ZONE 'Europe/Warsaw')::date)
   ORDER BY t.ends_on NULLS LAST, t.sort_order, t.id
   LIMIT 1;
  SELECT p.amount INTO v_price FROM public.competition_prices p
   WHERE p.tier_id = v_tier AND p.category_id = p_category_id;
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

  -- At most two payable orders per account and event (an overdue one the job
  -- has not swept yet no longer counts). The lock makes the count and the
  -- insert one step, also across competitions of the event.
  PERFORM pg_advisory_xact_lock(hashtext('create_order:' || v_profile::text || ':' || v_rs.event_id::text));
  IF (SELECT count(*) FROM public.orders o
       WHERE o.event_id = v_rs.event_id AND o.status = 'pending' AND o.expires_at > now()
         AND o.buyer_profile_id = v_profile) >= 2 THEN
    RAISE EXCEPTION 'too_many_pending';
  END IF;

  IF p_displayed_total IS DISTINCT FROM v_total THEN
    RAISE EXCEPTION 'price_changed:%', v_total;
  END IF;

  -- P3-R15: the limit counts paid entries only. An order waiting for payment claims
  -- nothing; it is refused when the paid (confirmed) entries already fill the
  -- competition, and its slot is claimed by confirm_order when the money arrives.
  -- A total of 0 is confirmed here, so it claims now, as register_free does.
  IF v_free THEN
    IF public.claim_competition_slots(p_category_id, v_n) IS NULL THEN
      RAISE EXCEPTION 'full';
    END IF;
  ELSIF v_comp.taken + v_n > v_comp.capacity THEN
    RAISE EXCEPTION 'full';
  END IF;

  -- „do końca zapisów”: the window ends when registration closes.
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
    SELECT v_reg, ec.id, ec.kind, v_profile, 'self',
           CASE WHEN ec.kind = 'regulamin' THEN v_rs.regulamin_version END, v_ip, v_ua
      FROM public.event_consents ec WHERE ec.event_id = v_rs.event_id
    UNION ALL
    SELECT v_reg, NULL, 'service_regulamin', v_profile, 'self', NULL, v_ip, v_ua;

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
