-- An optional description per extra: „Opis (opcjonalnie)” in the wizard's Dodatki step. On a
-- charity event it says what part of the price pays for the item and where the rest goes, e.g.
-- „35 zł pokrywa koszt wykonania koszulki, pozostałe 25 zł trafia na cel zbiórki.” The runner
-- sees it under the extra's name when picking extras, and the public event page shows it.
--
--   * extras.description: optional text, 1..500 characters, trimmed. NULL says nothing.
--
-- An extras field like the rest: a draft writes it through save_registration_section, a
-- published event stages the whole list in registration_pending_changes and it goes live at
-- „Opublikuj zmiany”. registration_pending_fields counts any staged list as changed, so it needs
-- no change. It is not money: registration_check_locks checks only an extra's price, its
-- variants and that it stays, and apply's writing statement checks only the price, so the
-- description stays editable after an extra has sold. Neither is recreated.
--
-- Recreated from their latest bodies and changed only where marked:
--   * apply_registration_section (from 20261108100000): the extras branch writes description.
--   * registration_raw (from 20261107120000): each extra carries `description`.
--     registration_public returns registration_raw and is not recreated.

ALTER TABLE public.extras
  ADD COLUMN description text;

ALTER TABLE public.extras
  ADD CONSTRAINT extras_description_check
    CHECK (description IS NULL OR (char_length(description) BETWEEN 1 AND 500 AND description = btrim(description)));

-- ---------------------------------------------------------------- apply_registration_section (from 20261108100000)

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
  v_t      jsonb;
  v_n      bigint;
  v_keys   jsonb := '{}'::jsonb;
  v_tiers  uuid[] := '{}';
  v_x      jsonb;
  v_v      jsonb;
  v_m      bigint;
  v_extra  uuid;
  v_var    uuid;
  v_vids   uuid[];
  v_xids   uuid[] := '{}';
  v_nested jsonb := '[]'::jsonb;
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
        contact_email       = CASE WHEN p_value ? 'contact_email' THEN p_value->>'contact_email' ELSE contact_email END,
        -- the description and the cause's page
        description         = CASE WHEN p_value ? 'description' THEN p_value->>'description' ELSE description END,
        charity_url         = CASE WHEN p_value ? 'charity_url' THEN p_value->>'charity_url' ELSE charity_url END,
        -- the event's own page
        website_url         = CASE WHEN p_value ? 'website_url' THEN p_value->>'website_url' ELSE website_url END,
        -- the share of the income that goes to the cause
        charity_percent     = CASE WHEN p_value ? 'charity_percent' THEN (p_value->>'charity_percent')::smallint ELSE charity_percent END,
        -- „Widoczność” (false = „Tylko przez link”)
        listed              = CASE WHEN p_value ? 'listed' THEN (p_value->>'listed')::boolean ELSE listed END
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
      INSERT INTO public.office_hours (event_id, starts_at, ends_at, note)
      SELECT p_event_id,
             ((h->>'date')::date + (h->>'from')::time) AT TIME ZONE 'Europe/Warsaw',
             ((h->>'date')::date + (h->>'to')::time) AT TIME ZONE 'Europe/Warsaw',
             nullif(btrim(h->>'note'), '')
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
      -- A voucher or an extra restricted to this competition would silently widen to every
      -- competition once its last link went (the links are RESTRICT for that reason): refused,
      -- the organizer changes the code or the extra first.
      IF EXISTS (SELECT 1 FROM public.voucher_competitions vc WHERE vc.category_id = v_del.category_id)
         OR EXISTS (SELECT 1 FROM public.extra_competitions ec WHERE ec.category_id = v_del.category_id) THEN
        RAISE EXCEPTION 'competition_linked';
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
      -- Fixed pricing = exactly one tier, open until registration closes. Coming from tiered, the
      -- tier in force today is the one kept (an order's frozen tier_id keeps pointing at it).
      SELECT t.o_id INTO v_tier FROM public.registration_current_tier(p_event_id) t;
      IF v_tier IS NULL THEN
        SELECT t.id INTO v_tier FROM public.price_tiers t
         WHERE t.event_id = p_event_id AND t.ends_on IS NULL ORDER BY t.sort_order LIMIT 1;
      END IF;
      IF v_tier IS NULL THEN
        INSERT INTO public.price_tiers (event_id, ends_on, sort_order) VALUES (p_event_id, NULL, 0)
        RETURNING id INTO v_tier;
      END IF;
      DELETE FROM public.price_tiers WHERE event_id = p_event_id AND id <> v_tier;
      UPDATE public.price_tiers SET ends_on = NULL, sort_order = 0 WHERE id = v_tier;
    ELSIF p_value->>'pricing_mode' = 'tiered' THEN
      -- Tiers in the grid's order (validateTiers checked the dates). An id must be this event's;
      -- a tier left out goes, its prices with it (competition_prices cascade). A new tier's key
      -- in items[].prices is new:<index>.
      IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_value->'tiers') AS t
         WHERE t->>'id' IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM public.price_tiers pt
                            WHERE pt.id = (t->>'id')::uuid AND pt.event_id = p_event_id)) THEN
        RAISE EXCEPTION 'foreign_id';
      END IF;
      DELETE FROM public.price_tiers pt
       WHERE pt.event_id = p_event_id
         AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_value->'tiers') AS t
                          WHERE (t->>'id')::uuid = pt.id);
      FOR v_t, v_n IN SELECT value, ordinality - 1 FROM jsonb_array_elements(p_value->'tiers') WITH ORDINALITY LOOP
        IF v_t->>'id' IS NULL THEN
          INSERT INTO public.price_tiers (event_id, ends_on, sort_order)
          VALUES (p_event_id, (v_t->>'ends_on')::date, v_n)
          RETURNING id INTO v_tier;
          v_keys := v_keys || jsonb_build_object('new:' || v_n, v_tier);
        ELSE
          v_tier := (v_t->>'id')::uuid;
          UPDATE public.price_tiers SET ends_on = (v_t->>'ends_on')::date, sort_order = v_n WHERE id = v_tier;
          v_keys := v_keys || jsonb_build_object(v_tier::text, v_tier);
        END IF;
        v_tiers := v_tiers || v_tier;
      END LOOP;
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
                                         capacity, min_age, max_age, is_kids, timed, gpx_upload_id, sort_order,
                                         team_min, team_max)
        VALUES (v_id, p_event_id, v_item->>'name', v_item->>'kind', v_item->>'discipline', v_item->>'distance_label',
                (v_item->>'start_time')::time, (v_item->>'capacity')::integer, (v_item->>'min_age')::integer,
                (v_item->>'max_age')::integer, (v_item->>'is_kids')::boolean, (v_item->>'timed')::boolean,
                (v_item->>'gpx_upload_id')::uuid, v_idx,
                (v_item->>'team_min')::integer, (v_item->>'team_max')::integer);
      ELSE
        -- The limit check is in the writing statement: a registration landing
        -- meanwhile either commits first and blocks this, or waits and meets it.
        UPDATE public.competitions SET
          name = v_item->>'name', kind = v_item->>'kind', discipline = v_item->>'discipline',
          distance_label = v_item->>'distance_label', start_time = (v_item->>'start_time')::time,
          capacity = (v_item->>'capacity')::integer, min_age = (v_item->>'min_age')::integer,
          max_age = (v_item->>'max_age')::integer, is_kids = (v_item->>'is_kids')::boolean,
          timed = (v_item->>'timed')::boolean, gpx_upload_id = (v_item->>'gpx_upload_id')::uuid, sort_order = v_idx,
          -- A payload staged before this migration has no size keys: it keeps the stored one.
          team_min = CASE WHEN v_item ? 'team_min' THEN (v_item->>'team_min')::integer ELSE team_min END,
          team_max = CASE WHEN v_item ? 'team_max' THEN (v_item->>'team_max')::integer ELSE team_max END,
          -- Leg order only exists on a team: going back to individual clears it.
          leg_order_enabled = leg_order_enabled AND v_item->>'kind' = 'team'
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
      ELSIF p_value->>'pricing_mode' = 'tiered' THEN
        -- One price per tier, keyed as the tiers were above: nothing missing, nothing extra.
        IF jsonb_typeof(v_item->'prices') IS DISTINCT FROM 'object'
           OR (SELECT count(*) FROM jsonb_object_keys(v_item->'prices')) <> cardinality(v_tiers)
           OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_item->'prices') AS k WHERE NOT v_keys ? k) THEN
          RAISE EXCEPTION 'foreign_id';
        END IF;
        INSERT INTO public.competition_prices (category_id, tier_id, amount)
        SELECT v_id, (v_keys->>e.key)::uuid, (e.value)::text::integer
          FROM jsonb_each(v_item->'prices') AS e
        ON CONFLICT (category_id, tier_id) DO UPDATE SET amount = EXCLUDED.amount;
      END IF;
      v_ids := v_ids || v_id;
    END LOOP;
    v_result := jsonb_build_object('categoryIds', to_jsonb(v_ids));
    IF p_value->>'pricing_mode' = 'tiered' THEN
      v_result := v_result || jsonb_build_object('tierIds', to_jsonb(v_tiers));
    END IF;

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
        -- Changed here: minorsOnly is stored, false when absent.
        IF v_id IS NULL THEN
          INSERT INTO public.event_consents (event_id, kind, text, sort_order, minors_only)
          VALUES (p_event_id, 'custom', v_item->>'text', 1 + v_idx, coalesce((v_item->>'minorsOnly')::boolean, false))
          RETURNING id INTO v_id;
        ELSE
          UPDATE public.event_consents
             SET text = v_item->>'text', sort_order = 1 + v_idx,
                 minors_only = coalesce((v_item->>'minorsOnly')::boolean, false)
           WHERE id = v_id;
        END IF;
        v_ids := v_ids || v_id;
      END LOOP;
      v_result := jsonb_build_object('consentIds', to_jsonb(v_ids));
    END IF;
    IF p_value ? 'leg_order' THEN
      IF EXISTS (
        SELECT 1 FROM jsonb_object_keys(p_value->'leg_order') AS k
         WHERE NOT EXISTS (SELECT 1 FROM public.competitions c
                            WHERE c.category_id = k::uuid AND c.event_id = p_event_id)) THEN
        RAISE EXCEPTION 'foreign_id';
      END IF;
      -- Publish applies competitions before form, so a competition staged back to
      -- individual in the same round is skipped here, not refused.
      UPDATE public.competitions c SET leg_order_enabled = (e.value)::text::boolean
        FROM jsonb_each(p_value->'leg_order') AS e
       WHERE c.category_id = e.key::uuid AND c.event_id = p_event_id AND c.kind = 'team';
    END IF;

  ELSIF p_section = 'payments' THEN
    -- The payment window only. The payout account is not a section: it is
    -- written by save_event_payout (update-event-payout, club owner only).
    UPDATE public.registration_settings SET
      payment_window_hours = CASE WHEN p_value ? 'payment_window_hours'
                                  THEN (p_value->>'payment_window_hours')::integer ELSE payment_window_hours END,
      payment_window_until_close = CASE WHEN p_value ? 'payment_window_until_close'
                                        THEN (p_value->'payment_window_until_close')::text::boolean
                                        ELSE payment_window_until_close END,
      -- „Przekazanie pakietu” (ruling 4; the validator keeps transfer_until ≤ event_date − 1).
      transfer_enabled = CASE WHEN p_value ? 'transfer_enabled'
                              THEN (p_value->'transfer_enabled')::text::boolean ELSE transfer_enabled END,
      transfer_until   = CASE WHEN p_value ? 'transfer_until'
                              THEN (p_value->>'transfer_until')::date ELSE transfer_until END
    WHERE event_id = p_event_id;

  ELSIF p_section = 'extras' THEN
    -- Dodatki: the whole list. Every id must be this event's: an extra, a variant of that very
    -- extra, a competition, an image upload of kind 'extra'.
    IF EXISTS (
         SELECT 1 FROM jsonb_array_elements(p_value->'items') AS x
          WHERE x->>'id' IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM public.extras e WHERE e.id = (x->>'id')::uuid AND e.event_id = p_event_id))
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(p_value->'items') AS x, jsonb_array_elements(x->'variants') AS v
          WHERE v->>'id' IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM public.extra_variants ev
                             WHERE ev.id = (v->>'id')::uuid AND ev.extra_id::text IS NOT DISTINCT FROM x->>'id'))
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(p_value->'items') AS x, jsonb_array_elements_text(x->'category_ids') AS c
          WHERE NOT EXISTS (SELECT 1 FROM public.competitions k WHERE k.category_id = c::uuid AND k.event_id = p_event_id)) THEN
      RAISE EXCEPTION 'foreign_id';
    END IF;
    FOR v_x IN SELECT value FROM jsonb_array_elements(p_value->'items') LOOP
      IF v_x->>'image_upload_id' IS NOT NULL THEN
        PERFORM public.registration_check_upload(p_event_id, v_x->>'image_upload_id', 'extra');
      END IF;
    END LOOP;

    -- Left out: variants go first (extra_variants.extra_id is RESTRICT), then their extras. A
    -- variant that sold stays (ruling 10): the delete skips it in the writing statement, and one
    -- left behind refuses the whole save.
    DELETE FROM public.extra_variants ev USING public.extras e
     WHERE ev.extra_id = e.id AND e.event_id = p_event_id AND ev.sold = 0
       AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_value->'items') AS x, jsonb_array_elements(x->'variants') AS v
                        WHERE (v->>'id')::uuid = ev.id);
    IF EXISTS (
      SELECT 1 FROM public.extra_variants ev JOIN public.extras e ON e.id = ev.extra_id
       WHERE e.event_id = p_event_id
         AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_value->'items') AS x, jsonb_array_elements(x->'variants') AS v
                          WHERE (v->>'id')::uuid = ev.id)) THEN
      RAISE EXCEPTION 'extra_locked';
    END IF;
    DELETE FROM public.extras e
     WHERE e.event_id = p_event_id
       AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_value->'items') AS x WHERE (x->>'id')::uuid = e.id);

    FOR v_x, v_n IN SELECT value, ordinality FROM jsonb_array_elements(p_value->'items') WITH ORDINALITY LOOP
      v_extra := (v_x->>'id')::uuid;
      IF v_extra IS NULL THEN
        -- new: description
        INSERT INTO public.extras (event_id, name, description, image_upload_id, price, order_until, sort_order)
        VALUES (p_event_id, v_x->>'name', v_x->>'description', (v_x->>'image_upload_id')::uuid, (v_x->>'price')::integer,
                (v_x->>'order_until')::date, v_n)
        RETURNING id INTO v_extra;
      ELSE
        -- The price of an extra that sold stays (ruling 10), checked in the writing statement.
        -- new: description, which is not money and so is never locked by a sale
        UPDATE public.extras e SET
          name = v_x->>'name', description = v_x->>'description', image_upload_id = (v_x->>'image_upload_id')::uuid,
          price = (v_x->>'price')::integer, order_until = (v_x->>'order_until')::date, sort_order = v_n
        WHERE e.id = v_extra
          AND (e.price = (v_x->>'price')::integer
               OR NOT EXISTS (SELECT 1 FROM public.extra_variants ev WHERE ev.extra_id = e.id AND ev.sold > 0));
        IF NOT FOUND THEN
          RAISE EXCEPTION 'extra_locked';
        END IF;
      END IF;
      -- No competition named = every competition.
      DELETE FROM public.extra_competitions ec
       WHERE ec.extra_id = v_extra
         AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_x->'category_ids') AS c WHERE c::uuid = ec.category_id);
      INSERT INTO public.extra_competitions (extra_id, category_id)
      SELECT v_extra, c::uuid FROM jsonb_array_elements_text(v_x->'category_ids') AS c
      ON CONFLICT DO NOTHING;

      v_vids := '{}';
      FOR v_v, v_m IN SELECT value, ordinality FROM jsonb_array_elements(v_x->'variants') WITH ORDINALITY LOOP
        v_var := (v_v->>'id')::uuid;
        IF v_var IS NULL THEN
          INSERT INTO public.extra_variants (extra_id, label, stock, sort_order)
          VALUES (v_extra, v_v->>'label', (v_v->>'stock')::integer, v_m)
          RETURNING id INTO v_var;
        ELSE
          -- Stock never below what sold: a sale landing meanwhile either commits first and
          -- blocks this, or waits and meets the new stock.
          UPDATE public.extra_variants SET label = v_v->>'label', stock = (v_v->>'stock')::integer, sort_order = v_m
           WHERE id = v_var AND sold <= (v_v->>'stock')::integer;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'extra_locked';
          END IF;
        END IF;
        v_vids := v_vids || v_var;
      END LOOP;
      v_xids := v_xids || v_extra;
      v_nested := v_nested || jsonb_build_array(to_jsonb(v_vids));
    END LOOP;
    v_result := jsonb_build_object('extraIds', to_jsonb(v_xids), 'variantIds', v_nested);

  ELSE
    RAISE EXCEPTION 'unknown_section';
  END IF;

  RETURN v_result;
END $$;
REVOKE EXECUTE ON FUNCTION public.apply_registration_section(uuid, text, jsonb, boolean) FROM public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- registration_raw (from 20261107120000)

CREATE OR REPLACE FUNCTION public.registration_raw(p_event_id uuid) RETURNS jsonb
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = ''
AS $$
  WITH rs AS (
    SELECT * FROM public.registration_settings WHERE event_id = p_event_id
  ),
  tiers AS (
    SELECT t.id, t.ends_on,
           row_number() OVER (ORDER BY t.ends_on NULLS LAST, t.sort_order, t.id) AS n
      FROM public.price_tiers t
     WHERE t.event_id = p_event_id
       AND (t.ends_on IS NULL OR t.ends_on >= (now() AT TIME ZONE 'Europe/Warsaw')::date)
  ),
  comps AS (
    SELECT k.*,
           (SELECT count(*) FROM public.registrations r
             WHERE r.category_id = k.category_id AND r.status = 'confirmed')::integer AS confirmed,
           (SELECT p.amount FROM public.competition_prices p JOIN tiers t ON t.id = p.tier_id
             WHERE p.category_id = k.category_id AND t.n = 1) AS current_price,
           (SELECT jsonb_build_object('grosze', p.amount, 'from', to_char(cur.ends_on + 1, 'YYYY-MM-DD'))
              FROM public.competition_prices p
              JOIN tiers nxt ON nxt.id = p.tier_id AND nxt.n = 2
              JOIN tiers cur ON cur.n = 1
             WHERE p.category_id = k.category_id) AS next_price,
           u.path AS gpx_path, u.meta AS gpx_meta
      FROM public.competitions k
      LEFT JOIN public.registration_uploads u
        ON u.id = k.gpx_upload_id AND u.kind = 'gpx' AND u.event_id = k.event_id
     WHERE k.event_id = p_event_id AND k.hidden_at IS NULL
  )
  SELECT jsonb_build_object(
    'eventId', rs.event_id,
    'slug', rs.slug,
    'state', rs.state,
    'club', (SELECT jsonb_build_object('name', c.name) FROM public.clubs c WHERE c.id = rs.club_id),
    'name', rs.name,
    'eventDate', to_char(rs.event_date, 'YYYY-MM-DD'),
    'firstStartTime', to_char(rs.first_start_time, 'HH24:MI'),
    'opensAt', rs.opens_at,
    'closesAt', rs.closes_at,
    'isCharity', rs.is_charity,
    'charityGoal', rs.charity_goal,
    'charityUrl', rs.charity_url,
    'websiteUrl', rs.website_url,
    'charityPercent', rs.charity_percent,
    'description', rs.description,
    'donationsEnabled', rs.donations_enabled,
    'town', jsonb_build_object(
      'label', rs.town_label, 'area', rs.town_area, 'placeDetails', rs.place_details,
      'lat', rs.lat, 'lng', rs.lng),
    'office', jsonb_build_object(
      'sameAsEvent', rs.office_same_as_event, 'address', rs.office_address, 'notes', rs.office_notes,
      'lat', rs.office_lat, 'lng', rs.office_lng,
      'hours', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
                 'date', to_char(h.starts_at AT TIME ZONE 'Europe/Warsaw', 'YYYY-MM-DD'),
                 'from', to_char(h.starts_at AT TIME ZONE 'Europe/Warsaw', 'HH24:MI'),
                 'to', to_char(h.ends_at AT TIME ZONE 'Europe/Warsaw', 'HH24:MI'),
                 'note', h.note)
               ORDER BY h.starts_at, h.ends_at)
          FROM public.office_hours h WHERE h.event_id = rs.event_id), '[]'::jsonb)),
    'timing', jsonb_build_object(
      'mode', rs.timing_mode, 'company', rs.timing_company,
      'resultsUrl', rs.results_url, 'liveResultsUrl', rs.live_results_url),
    'contactEmail', rs.contact_email,
    'regulamin', jsonb_build_object(
      'kind', rs.regulamin_kind,
      'url', CASE WHEN rs.regulamin_kind = 'link' THEN rs.regulamin_url END,
      'path', CASE WHEN rs.regulamin_kind = 'pdf' THEN
                (SELECT u.path FROM public.registration_uploads u
                  WHERE u.id = rs.regulamin_upload_id AND u.kind = 'regulamin' AND u.event_id = rs.event_id) END,
      'version', rs.regulamin_version),
    'posterPath', (SELECT u.path FROM public.registration_uploads u
                    WHERE u.id = rs.poster_upload_id AND u.kind = 'poster' AND u.event_id = rs.event_id),
    'ageReckoning', rs.age_reckoning,
    'formFields', rs.form_fields,
    'pricingMode', rs.pricing_mode,
    'transfer', jsonb_build_object('enabled', rs.transfer_enabled, 'until', to_char(rs.transfer_until, 'YYYY-MM-DD')),
    -- No stock, sold, voucher or partner: only what is left of each variant (0 stays, as „brak”).
    'extras', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', x.id,
               'name', x.name,
               'description', x.description,  -- new
               'imagePath', (SELECT u.path FROM public.registration_uploads u
                              WHERE u.id = x.image_upload_id AND u.kind = 'extra' AND u.event_id = x.event_id),
               'price', x.price,
               'orderUntil', to_char(x.order_until, 'YYYY-MM-DD'),
               'categoryIds', coalesce((SELECT jsonb_agg(ec.category_id ORDER BY ec.category_id)
                                          FROM public.extra_competitions ec WHERE ec.extra_id = x.id), '[]'::jsonb),
               'variants', coalesce((SELECT jsonb_agg(jsonb_build_object('id', v.id, 'label', v.label, 'left', v.stock - v.sold)
                                                      ORDER BY v.sort_order, v.id)
                                       FROM public.extra_variants v WHERE v.extra_id = x.id), '[]'::jsonb))
             ORDER BY x.sort_order, x.id)
        FROM public.extras x WHERE x.event_id = rs.event_id), '[]'::jsonb),
    'consents', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'text', e.text, 'minorsOnly', e.minors_only)
             ORDER BY CASE e.kind WHEN 'regulamin' THEN 0 WHEN 'data_info' THEN 1 ELSE 2 END, e.sort_order, e.created_at, e.id)
        FROM public.event_consents e WHERE e.event_id = rs.event_id), '[]'::jsonb),
    'competitions', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'categoryId', k.category_id,
               'name', k.name,
               'kind', k.kind,
               'teamMin', k.team_min,
               'teamMax', k.team_max,
               'legOrderEnabled', k.leg_order_enabled,
               'discipline', k.discipline,
               'distanceLabel', k.distance_label,
               'startTime', to_char(k.start_time, 'HH24:MI'),
               'capacity', k.capacity,
               'taken', k.taken,
               'confirmed', k.confirmed,
               'minAge', k.min_age,
               'maxAge', k.max_age,
               'isKids', k.is_kids,
               'timed', k.timed,
               'priceGrosze', CASE WHEN rs.pricing_mode = 'free' THEN 0 ELSE k.current_price END,
               'nextPrice', CASE WHEN rs.pricing_mode = 'free' THEN NULL ELSE k.next_price END,
               'ageGroups', coalesce((
                 SELECT jsonb_agg(jsonb_build_object('gender', g.gender, 'label', g.label,
                                                     'minAge', g.min_age, 'maxAge', g.max_age)
                        ORDER BY g.gender, g.min_age, g.label)
                   FROM public.age_groups g WHERE g.category_id = k.category_id), '[]'::jsonb),
               'kidsGroups', coalesce((
                 SELECT jsonb_agg(jsonb_build_object('label', g.label, 'birthYearFrom', g.birth_year_from,
                                                     'birthYearTo', g.birth_year_to, 'gender', g.gender,
                                                     'distanceLabel', g.distance_label)
                        ORDER BY g.birth_year_from DESC, g.label)
                   FROM public.kids_groups g WHERE g.category_id = k.category_id), '[]'::jsonb),
               'course', CASE WHEN k.gpx_path IS NULL THEN NULL ELSE jsonb_build_object(
                 'km', k.gpx_meta -> 'km', 'upM', k.gpx_meta -> 'upM', 'downM', k.gpx_meta -> 'downM',
                 'points', k.gpx_meta -> 'points', 'profile', coalesce(k.gpx_meta -> 'profile', '[]'::jsonb),
                 'gpxPath', k.gpx_path) END)
             ORDER BY k.sort_order, k.category_id)
        FROM comps k), '[]'::jsonb)
  )
  FROM rs
$$;
REVOKE EXECUTE ON FUNCTION public.registration_raw(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.registration_raw(uuid) TO service_role;
