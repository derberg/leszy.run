-- Race registration, plan 3 task 8: the Płatności step.
--
-- * `payments` becomes a wizard section (D3-4): { payment_window_hours }.
--   apply_registration_section gains its branch, stage_registration_section
--   its allow-list entry and publish_registration_changes its place in the
--   section loop, so a published event stages the window and „Opublikuj
--   zmiany” applies it like every other edit (preview_changes /
--   publish_changes with expectedUpdatedAt, P2-R28). The three are replaced
--   from their latest definitions (20261029230000 and 20261029170000) and
--   are otherwise unchanged; CREATE OR REPLACE keeps their grants, which are
--   repeated anyway.
-- * save_event_payout writes one event's payout account into
--   event_payout_details and appends event_payout_history in one
--   transaction, like save_club_payout. Called by update-event-payout only;
--   it re-checks that the actor owns the club (the RPC does not trust its
--   caller). The payout never travels through a section, the pending
--   changes, get-registration-event or the public read model (ruling P3-R1).

-- ---------------------------------------------------------------- apply

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
                                  THEN (p_value->>'payment_window_hours')::integer ELSE payment_window_hours END
    WHERE event_id = p_event_id;

  ELSE
    RAISE EXCEPTION 'unknown_section';
  END IF;

  RETURN v_result;
END $$;
REVOKE EXECUTE ON FUNCTION public.apply_registration_section(uuid, text, jsonb, boolean) FROM public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- stage

CREATE OR REPLACE FUNCTION public.stage_registration_section(p_event_id uuid, p_section text, p_value jsonb, p_actor uuid)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_rs      public.registration_settings%ROWTYPE;
  v_payload jsonb;
  v_fields  text[];
BEGIN
  IF p_section NOT IN ('basics', 'office', 'competitions', 'categories', 'timing', 'form', 'payments')
     OR jsonb_typeof(p_value) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'unknown_section';
  END IF;
  SELECT * INTO v_rs FROM public.registration_settings WHERE event_id = p_event_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_rs.state <> 'published' THEN
    RAISE EXCEPTION 'not_published';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.club_members m
                  WHERE m.club_id = v_rs.club_id AND m.user_id = p_actor
                    AND m.status = 'active' AND m.role IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  PERFORM public.registration_check_locks(p_event_id, p_section, p_value);

  -- The merge is in the writing statement: two saves of one event queue on
  -- the row and neither loses the other's keys.
  INSERT INTO public.registration_pending_changes AS pc (event_id, payload, changed_fields, updated_by)
  VALUES (p_event_id, jsonb_build_object(p_section, p_value), '{}', p_actor)
  ON CONFLICT (event_id) DO UPDATE
    SET payload = pc.payload || jsonb_build_object(p_section, coalesce(pc.payload->p_section, '{}'::jsonb) || p_value),
        updated_by = p_actor
  RETURNING payload INTO v_payload;

  v_fields := public.registration_pending_fields(p_event_id, v_payload);
  IF cardinality(v_fields) = 0 THEN
    DELETE FROM public.registration_pending_changes WHERE event_id = p_event_id;
    RETURN jsonb_build_object('changedFields', '[]'::jsonb, 'savedAt', now());
  END IF;
  UPDATE public.registration_pending_changes SET changed_fields = v_fields WHERE event_id = p_event_id;
  RETURN jsonb_build_object('changedFields', to_jsonb(v_fields), 'savedAt', now());
END $$;
REVOKE EXECUTE ON FUNCTION public.stage_registration_section(uuid, text, jsonb, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stage_registration_section(uuid, text, jsonb, uuid) TO service_role;

-- ---------------------------------------------------------------- publish changes

CREATE OR REPLACE FUNCTION public.publish_registration_changes(p_event_id uuid, p_actor uuid,
                                                    p_expected_updated_at timestamptz DEFAULT NULL,
                                                    p_claim_notice boolean DEFAULT false)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_rs      public.registration_settings%ROWTYPE;
  v_pending public.registration_pending_changes%ROWTYPE;
  v_section text;
  v_value   jsonb;
  v_result  jsonb;
  v_ids     jsonb := '[]'::jsonb;
  v_item    jsonb;
  v_idx     bigint;
  v_id      uuid;
  v_allowed boolean;
  v_after   public.registration_settings%ROWTYPE;
BEGIN
  -- register_free's order: competition rows first, then the settings row.
  PERFORM 1 FROM public.competitions WHERE event_id = p_event_id ORDER BY category_id FOR UPDATE;
  SELECT * INTO v_rs FROM public.registration_settings WHERE event_id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_rs.state <> 'published' THEN
    RAISE EXCEPTION 'not_published';
  END IF;
  -- The edge function checked these; the RPC does not trust its caller.
  IF NOT EXISTS (SELECT 1 FROM public.club_members m
                  WHERE m.club_id = v_rs.club_id AND m.user_id = p_actor
                    AND m.status = 'active' AND m.role IN ('owner', 'admin'))
     OR NOT EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = v_rs.club_id AND c.registration_enabled) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  SELECT * INTO v_pending FROM public.registration_pending_changes WHERE event_id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no_changes';
  END IF;
  -- The edge function showed (and mailed) a diff of the row it read.
  IF p_expected_updated_at IS NOT NULL AND v_pending.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'changed';
  END IF;
  IF p_claim_notice THEN
    SELECT t.allowed INTO v_allowed FROM public.claim_throttle_slot('notice:' || p_event_id::text, 1, 3600) AS t;
    IF NOT v_allowed THEN
      RAISE EXCEPTION 'notice_throttled';
    END IF;
  END IF;

  FOREACH v_section IN ARRAY ARRAY['basics', 'office', 'competitions', 'categories', 'timing', 'form', 'payments'] LOOP
    v_value := v_pending.payload->v_section;
    CONTINUE WHEN v_value IS NULL;
    PERFORM public.registration_check_locks(p_event_id, v_section, v_value);
    v_result := public.apply_registration_section(p_event_id, v_section, v_value, false);
    IF v_section = 'competitions' THEN
      v_ids := coalesce(v_result->'categoryIds', '[]'::jsonb);
      -- categoryIds follow the items' order; a new competition gets its id there.
      FOR v_item, v_idx IN SELECT value, ordinality FROM jsonb_array_elements(v_value->'items') WITH ORDINALITY LOOP
        CONTINUE WHEN NOT v_item ? 'hidden';
        v_id := (v_ids->>(v_idx::integer - 1))::uuid;
        CONTINUE WHEN NOT EXISTS (SELECT 1 FROM public.competitions
                                   WHERE category_id = v_id AND (hidden_at IS NOT NULL) <> (v_item->>'hidden')::boolean);
        -- Only while nobody is registered, checked in the write.
        UPDATE public.competitions
           SET hidden_at = CASE WHEN (v_item->>'hidden')::boolean THEN now() ELSE NULL END
         WHERE category_id = v_id AND taken = 0;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'competition_locked';
        END IF;
      END LOOP;
    END IF;
  END LOOP;

  SELECT * INTO v_after FROM public.registration_settings WHERE event_id = p_event_id;
  -- What the first publish's checklist required still holds (the edge function
  -- checks the whole checklist first; a direct call cannot skip these).
  IF v_after.opens_at IS NULL OR v_after.closes_at IS NULL OR v_after.event_date IS NULL THEN
    RAISE EXCEPTION 'invalid_state:window';
  END IF;
  IF v_after.closes_at > ((v_after.event_date + 1)::timestamp AT TIME ZONE 'Europe/Warsaw') THEN
    RAISE EXCEPTION 'invalid_state:closes_after_event';
  END IF;
  IF NOT ((v_after.regulamin_kind = 'pdf' AND v_after.regulamin_upload_id IS NOT NULL)
       OR (v_after.regulamin_kind = 'link' AND nullif(btrim(v_after.regulamin_url), '') IS NOT NULL)) THEN
    RAISE EXCEPTION 'invalid_state:regulamin';
  END IF;
  IF (v_after.regulamin_kind, v_after.regulamin_url, v_after.regulamin_upload_id)
     IS DISTINCT FROM (v_rs.regulamin_kind, v_rs.regulamin_url, v_rs.regulamin_upload_id) THEN
    UPDATE public.registration_settings SET regulamin_version = regulamin_version + 1 WHERE event_id = p_event_id;
  END IF;

  PERFORM public.registration_write_public_rows(p_event_id);
  DELETE FROM public.registration_pending_changes WHERE event_id = p_event_id;

  RETURN jsonb_build_object('categoryIds', v_ids, 'changedFields', to_jsonb(v_pending.changed_fields), 'publishedAt', now());
END $$;
REVOKE EXECUTE ON FUNCTION public.publish_registration_changes(uuid, uuid, timestamptz, boolean) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publish_registration_changes(uuid, uuid, timestamptz, boolean) TO service_role;

-- ---------------------------------------------------------------- event payout

CREATE OR REPLACE FUNCTION public.save_event_payout(
  p_event_id uuid, p_actor uuid, p_mode text,
  p_recipient text, p_tax_id text, p_iban text, p_title text
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_club   uuid;
  v_state  text;
  v_live   text;
  v_staged text;
  v_old    jsonb;
  v_new    jsonb;
BEGIN
  SELECT rs.club_id, rs.state, rs.pricing_mode, pc.payload->'competitions'->>'pricing_mode'
    INTO v_club, v_state, v_live, v_staged
    FROM public.registration_settings rs
    LEFT JOIN public.registration_pending_changes pc ON pc.event_id = rs.event_id
   WHERE rs.event_id = p_event_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.club_members m
                  WHERE m.club_id = v_club AND m.user_id = p_actor
                    AND m.status = 'active' AND m.role = 'owner')
     OR NOT EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = v_club AND c.registration_enabled) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  -- A published event that collects money (live or staged pricing) never
  -- switches to a club account with no payout details: runners would pay with
  -- nowhere to pay out to. A draft may: its publish checklist blocks.
  IF p_mode = 'club' AND v_state <> 'draft'
     AND (coalesce(v_live, 'free') <> 'free' OR coalesce(v_staged, 'free') <> 'free')
     AND NOT EXISTS (SELECT 1 FROM public.club_payout_details d WHERE d.club_id = v_club) THEN
    RAISE EXCEPTION 'payout_not_ready';
  END IF;
  -- The club account keeps no event-level details; another account needs all
  -- three identifying fields. Only the format is checked here: the NIP and
  -- IBAN checksums are update-event-payout's (payoutValidation.js), and the
  -- checklist re-checks them on read (customPayoutReady).
  IF p_mode = 'club' THEN
    v_new := jsonb_build_object('payout_mode', 'club', 'payout_recipient', NULL, 'payout_tax_id', NULL,
                                'payout_iban', NULL, 'payout_title', NULL);
  ELSIF p_mode = 'custom'
        AND nullif(btrim(p_recipient), '') IS NOT NULL
        AND p_tax_id ~ '^[0-9]{10}$'
        AND p_iban ~ '^PL[0-9]{26}$' THEN
    v_new := jsonb_build_object('payout_mode', 'custom', 'payout_recipient', btrim(p_recipient), 'payout_tax_id', p_tax_id,
                                'payout_iban', p_iban, 'payout_title', nullif(btrim(p_title), ''));
  ELSE
    RAISE EXCEPTION 'invalid_payout';
  END IF;

  -- Serialise saves per event: FOR UPDATE locks nothing before the first save.
  PERFORM pg_advisory_xact_lock(hashtext('event_payout:' || p_event_id::text));

  SELECT to_jsonb(d) - 'event_id' - 'updated_by' - 'updated_at' INTO v_old
    FROM public.event_payout_details d
   WHERE d.event_id = p_event_id
   FOR UPDATE;

  -- Saved again unchanged: nothing to record.
  IF v_old IS NOT DISTINCT FROM v_new THEN
    RETURN jsonb_build_object('old', v_old, 'new', v_new, 'clubId', v_club, 'unchanged', true);
  END IF;

  INSERT INTO public.event_payout_details AS t
         (event_id, payout_mode, payout_recipient, payout_tax_id, payout_iban, payout_title, updated_by, updated_at)
  VALUES (p_event_id, v_new->>'payout_mode', v_new->>'payout_recipient', v_new->>'payout_tax_id',
          v_new->>'payout_iban', v_new->>'payout_title', p_actor, now())
  ON CONFLICT (event_id) DO UPDATE SET
    payout_mode = EXCLUDED.payout_mode, payout_recipient = EXCLUDED.payout_recipient,
    payout_tax_id = EXCLUDED.payout_tax_id, payout_iban = EXCLUDED.payout_iban,
    payout_title = EXCLUDED.payout_title, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at;

  INSERT INTO public.event_payout_history (event_id, changed_by, old, new)
  VALUES (p_event_id, p_actor, v_old, v_new);

  RETURN jsonb_build_object('old', v_old, 'new', v_new, 'clubId', v_club);
END $$;
REVOKE EXECUTE ON FUNCTION public.save_event_payout(uuid, uuid, text, text, text, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_event_payout(uuid, uuid, text, text, text, text, text) TO service_role;
