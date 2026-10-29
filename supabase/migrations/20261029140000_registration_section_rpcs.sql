-- Race registration, plan 2 task 3: creating an event and saving wizard sections.
--
-- * registration_slugify(text): the SQL twin of slugify() in
--   _shared/registration/slug.js (a test keeps them equal).
-- * create_registration_event: the draft events row AND its
--   registration_settings row in ONE transaction. Plan 1's host filter reads
--   settings after events; an events row visible without its settings row is a
--   legacy event and would be pulled to the timing hosts.
-- * apply_registration_section: the one place a section value reaches the
--   tables. Internal (no EXECUTE grant): save_registration_section calls it for
--   drafts, and the post-publish "Opublikuj zmiany" RPC reuses it with
--   p_allow_delete = false.
-- * save_registration_section: drafts only (raises not_draft).
--
-- Errors are raised as plain messages the edge function maps: not_draft,
-- slug_taken, foreign_id, competition_locked, capacity_below_taken:<id>,
-- forbidden, invalid_name. Values arrive validated by validateSection() in
-- _shared/registration/sections.js; this layer re-checks only what a validator
-- cannot know (ownership of ids, slug collisions, taken).

-- ---------------------------------------------------------------- slug

CREATE FUNCTION public.registration_slugify(p_text text) RETURNS text
  LANGUAGE sql
  IMMUTABLE
  SET search_path = ''
AS $$
  SELECT rtrim(left(btrim(regexp_replace(
           lower(regexp_replace(normalize(translate(coalesce(p_text, ''), 'łŁ', 'lL'), NFD), '[̀-ͯ]', '', 'g')),
           '[^a-z0-9]+', '-', 'g'), '-'), 80), '-')
$$;
REVOKE EXECUTE ON FUNCTION public.registration_slugify(text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.registration_slugify(text) TO service_role;

-- ---------------------------------------------------------------- create

-- The events row carries placeholders only (anon can read events): name
-- 'Szkic', slug 'szkic-<id>', visibility private, no date. Publish writes the
-- real values. rssi_threshold and min_finish_seconds are set explicitly: hosts
-- pull this row, and an old column default (-6500 / 30) cut finish passes on
-- 2026-08-07.
CREATE FUNCTION public.create_registration_event(p_club_id uuid, p_name text, p_actor uuid) RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_name  text := btrim(coalesce(p_name, ''));
  v_event uuid := gen_random_uuid();
  v_base  text;
  v_slug  text;
  v_n     integer := 1;
BEGIN
  IF v_name = '' OR char_length(v_name) > 120 THEN
    RAISE EXCEPTION 'invalid_name';
  END IF;
  -- The edge function checked this already; the RPC does not trust its caller.
  IF NOT EXISTS (SELECT 1 FROM public.club_members m
                  WHERE m.club_id = p_club_id AND m.user_id = p_actor
                    AND m.status = 'active' AND m.role IN ('owner', 'admin'))
     OR NOT EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = p_club_id AND c.registration_enabled) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_base := public.registration_slugify(v_name);
  IF char_length(v_base) < 3 THEN
    v_base := CASE WHEN v_base = '' THEN 'zawody' ELSE 'zawody-' || v_base END;
  END IF;

  INSERT INTO public.events (id, name, slug, visibility, club_id, rssi_threshold, min_finish_seconds)
  VALUES (v_event, 'Szkic', 'szkic-' || v_event, 'private', p_club_id, -9000, 300);

  -- First free of base, base-2, base-3 … against both slug namespaces. Two
  -- creates can pick the same candidate; the loser's insert waits on the unique
  -- index, fails once the winner commits, and moves to the next suffix.
  LOOP
    v_slug := CASE WHEN v_n = 1 THEN v_base
                   ELSE rtrim(left(v_base, 80 - char_length('-' || v_n)), '-') || '-' || v_n END;
    IF NOT EXISTS (SELECT 1 FROM public.registration_settings rs WHERE rs.slug = v_slug)
       AND NOT EXISTS (SELECT 1 FROM public.events e WHERE e.slug = v_slug) THEN
      BEGIN
        INSERT INTO public.registration_settings (event_id, club_id, name, slug)
        VALUES (v_event, p_club_id, v_name, v_slug);
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        NULL;
      END;
    END IF;
    v_n := v_n + 1;
    IF v_n > 1000 THEN
      RAISE EXCEPTION 'slug_exhausted';
    END IF;
  END LOOP;

  INSERT INTO public.event_consents (event_id, kind, text, sort_order) VALUES
    (v_event, 'regulamin', 'Akceptuję regulamin zawodów.', 0),
    (v_event, 'data_info', 'Znam informację o danych osobowych.', 1);

  RETURN v_event;
END $$;
REVOKE EXECUTE ON FUNCTION public.create_registration_event(uuid, text, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_registration_event(uuid, text, uuid) TO service_role;

-- ---------------------------------------------------------------- apply

-- An upload id must belong to this event and be of the expected kind.
CREATE FUNCTION public.registration_check_upload(p_event_id uuid, p_upload text, p_kind text) RETURNS void
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
BEGIN
  IF p_upload IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.registration_uploads u
     WHERE u.id = p_upload::uuid AND u.event_id = p_event_id AND u.kind = p_kind) THEN
    RAISE EXCEPTION 'foreign_id';
  END IF;
END $$;
REVOKE EXECUTE ON FUNCTION public.registration_check_upload(uuid, text, text) FROM public, anon, authenticated;

CREATE FUNCTION public.apply_registration_section(p_event_id uuid, p_section text, p_value jsonb, p_allow_delete boolean)
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
        poster_upload_id    = CASE WHEN p_value ? 'poster_upload_id' THEN (p_value->>'poster_upload_id')::uuid ELSE poster_upload_id END
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

  ELSE
    RAISE EXCEPTION 'unknown_section';
  END IF;

  RETURN v_result;
END $$;
-- Internal: reachable only through the SECURITY DEFINER RPCs that call it.
REVOKE EXECUTE ON FUNCTION public.apply_registration_section(uuid, text, jsonb, boolean) FROM public, anon, authenticated;

-- ---------------------------------------------------------------- save (draft)

CREATE FUNCTION public.save_registration_section(p_event_id uuid, p_section text, p_value jsonb) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_state text;
BEGIN
  -- Row lock: saves of one event run one after another, so two sections saved
  -- at the same moment never interleave.
  SELECT rs.state INTO v_state FROM public.registration_settings rs WHERE rs.event_id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_state <> 'draft' THEN
    RAISE EXCEPTION 'not_draft';
  END IF;
  RETURN public.apply_registration_section(p_event_id, p_section, p_value, true)
         || jsonb_build_object('savedAt', now());
END $$;
REVOKE EXECUTE ON FUNCTION public.save_registration_section(uuid, text, jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_registration_section(uuid, text, jsonb) TO service_role;
