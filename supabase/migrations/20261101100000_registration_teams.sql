-- Plan 5, task 2: teams.
--
-- A team is one teams row plus one registrations row per member, all under one order. It takes
-- one slot when its fee is paid (a free team: at creation, plan 5 task 3). The columns
-- registrations.team_id / team_leg and competitions.team_min / team_max / leg_order_enabled exist
-- since 20261029130000; this file adds the table, the foreign key and the D5-13 limits.
-- registration_slot_units already counts a team once and confirm_order claims through it, while
-- expire_orders, cancel_order and release_orphan_orders release nothing (P3-R15), so none of
-- them is re-created (D5-18).
--
-- teams.released_at frees the NAME only. teams_follow_captain keeps it in step with the captain's
-- registration: the captain leaving pending_payment / confirmed sets it, and coming back (the late
-- confirm of an expired order) clears it. If the name was taken meanwhile, the name index raises
-- unique_violation there, inside confirm_order's claim block, which refunds the whole order
-- (late_refund, reason duplicate) and rolls the claim back (D5-30). A member's own cancel (a swap)
-- never touches the team. Every path that changes a captain's status holds the order row first,
-- so the trigger cannot invert the teams → registrations order against a squad edit (D5-31).
--
-- apply_registration_section is re-created from 20261030170000 (competitions branch: team_min,
-- team_max, leg_order_enabled cleared on a team going back to individual; form branch: leg_order)
-- and registration_check_locks from 20261030160000 (leg_order, and a size change, on a competition
-- in use raise competition_locked, ruling 5, D5-16). Every other line is unchanged.

-- ---------------------------------------------------------------- competitions: the squad limits (D5-13)

ALTER TABLE public.competitions
  DROP CONSTRAINT competitions_team_min_check,
  DROP CONSTRAINT competitions_team_max_check,
  ADD CONSTRAINT competitions_team_min_check CHECK (team_min BETWEEN 2 AND 10),
  ADD CONSTRAINT competitions_team_max_check CHECK (team_max BETWEEN 2 AND 10);

-- ---------------------------------------------------------------- teams

CREATE TABLE public.teams (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id                uuid NOT NULL REFERENCES public.registration_settings(event_id) ON DELETE RESTRICT,
  category_id             uuid NOT NULL REFERENCES public.competitions(category_id) ON DELETE RESTRICT,
  name                    text NOT NULL,
  captain_registration_id uuid REFERENCES public.registrations(id) ON DELETE RESTRICT,
  released_at             timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX teams_event_id_idx ON public.teams (event_id);
CREATE INDEX teams_category_id_idx ON public.teams (category_id);
CREATE INDEX teams_captain_registration_id_idx ON public.teams (captain_registration_id);

-- The same key as teamNameKey (_shared/registration/team.js): a change there is a change here.
-- NFC first, so a letter typed as a base and a combining mark is the same letter. JavaScript's \s
-- and toLowerCase do not depend on a locale, and PostgreSQL's do, so the key spells out what \s
-- means in JavaScript (NBSP included, every code point escaped so that no invisible byte sits in
-- this file) and names an ICU collation for lower(). The whitespace goes to one space before the
-- trim, because btrim strips only what it is told to. The outer COLLATE "C" keeps ICU to lower():
-- only equality is ever asked of this index, so its order must not depend on the ICU version.
CREATE UNIQUE INDEX teams_category_name_live_key ON public.teams (
  category_id,
  (lower(btrim(
    regexp_replace(normalize(name, NFC) COLLATE "und-x-icu",
      '[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+', ' ', 'g'),
    ' ')) COLLATE "C")
) WHERE released_at IS NULL;

ALTER TABLE public.teams ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.teams FROM anon, authenticated;

ALTER TABLE public.registrations
  ADD CONSTRAINT registrations_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE RESTRICT;
CREATE INDEX registrations_team_id_idx ON public.registrations (team_id);
CREATE UNIQUE INDEX registrations_team_leg_live_key ON public.registrations (team_id, team_leg)
  WHERE team_leg IS NOT NULL AND status IN ('pending_payment', 'confirmed');

-- ---------------------------------------------------------------- teams_follow_captain

CREATE FUNCTION public.teams_follow_captain() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_was_live boolean := OLD.status IN ('pending_payment', 'confirmed');
  v_is_live  boolean := NEW.status IN ('pending_payment', 'confirmed');
BEGIN
  IF v_was_live = v_is_live THEN
    RETURN NULL;
  END IF;
  UPDATE public.teams
     SET released_at = CASE WHEN v_is_live THEN NULL ELSE now() END
   WHERE id = NEW.team_id AND captain_registration_id = NEW.id;
  RETURN NULL;
END $$;
REVOKE EXECUTE ON FUNCTION public.teams_follow_captain() FROM public, anon, authenticated, service_role;

CREATE TRIGGER teams_follow_captain
  AFTER UPDATE OF status ON public.registrations
  FOR EACH ROW
  WHEN (NEW.team_id IS NOT NULL AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.teams_follow_captain();

-- ---------------------------------------------------------------- apply_registration_section (from 20261030170000)

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
                                        ELSE payment_window_until_close END
    WHERE event_id = p_event_id;

  ELSE
    RAISE EXCEPTION 'unknown_section';
  END IF;

  RETURN v_result;
END $$;
REVOKE EXECUTE ON FUNCTION public.apply_registration_section(uuid, text, jsonb, boolean) FROM public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- registration_check_locks (from 20261030160000)

CREATE OR REPLACE FUNCTION public.registration_check_locks(p_event_id uuid, p_section text, p_value jsonb) RETURNS void
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
DECLARE
  v_rs   public.registration_settings%ROWTYPE;
  v_item jsonb;
  v_comp public.competitions%ROWTYPE;
  v_mode text;
  v_old  integer;
BEGIN
  SELECT * INTO v_rs FROM public.registration_settings WHERE event_id = p_event_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF p_section = 'basics' AND p_value ? 'slug' AND p_value->>'slug' IS DISTINCT FROM v_rs.slug THEN
    RAISE EXCEPTION 'immutable';
  END IF;
  IF p_section = 'timing' AND p_value ? 'timing_mode' AND p_value->>'timing_mode' IS DISTINCT FROM v_rs.timing_mode THEN
    RAISE EXCEPTION 'immutable';
  END IF;
  -- A custom consent somebody accepted stays, word for word (P2-R30).
  IF p_section = 'form' AND p_value ? 'consents' THEN
    IF EXISTS (
      SELECT 1 FROM public.event_consents ec
       WHERE ec.event_id = p_event_id AND ec.kind = 'custom'
         AND EXISTS (SELECT 1 FROM public.consent_acceptances ca WHERE ca.consent_id = ec.id)
         AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_value->'consents') AS k
                          WHERE k->>'id' = ec.id::text AND k->>'text' = ec.text)) THEN
      RAISE EXCEPTION 'consent_locked';
    END IF;
  END IF;
  -- A pending team has frozen its size and its legs (ruling 5, D5-16).
  IF p_section = 'form' AND p_value ? 'leg_order' THEN
    IF EXISTS (
      SELECT 1 FROM jsonb_object_keys(p_value->'leg_order') AS k
       WHERE NOT EXISTS (SELECT 1 FROM public.competitions c
                          WHERE c.category_id = k::uuid AND c.event_id = p_event_id)) THEN
      RAISE EXCEPTION 'foreign_id';
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_each(p_value->'leg_order') AS e
        JOIN public.competitions c ON c.category_id = e.key::uuid
       WHERE (e.value)::text::boolean IS DISTINCT FROM c.leg_order_enabled
         AND public.registration_competition_in_use(c.category_id)) THEN
      RAISE EXCEPTION 'competition_locked';
    END IF;
  END IF;
  IF p_section <> 'competitions' THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_value->'items') AS i
     WHERE i->>'category_id' IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.competitions c
                        WHERE c.category_id = (i->>'category_id')::uuid AND c.event_id = p_event_id)) THEN
    RAISE EXCEPTION 'foreign_id';
  END IF;
  -- After publish a competition is hidden, never deleted.
  IF EXISTS (
    SELECT 1 FROM public.competitions c
     WHERE c.event_id = p_event_id
       AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_value->'items') AS i
                        WHERE (i->>'category_id')::uuid = c.category_id)) THEN
    RAISE EXCEPTION 'competition_locked';
  END IF;

  v_mode := coalesce(p_value->>'pricing_mode', v_rs.pricing_mode);
  IF v_mode IS DISTINCT FROM v_rs.pricing_mode
     AND EXISTS (SELECT 1 FROM public.competitions c
                 WHERE c.event_id = p_event_id AND public.registration_competition_in_use(c.category_id)) THEN
    RAISE EXCEPTION 'price_locked';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_value->'items') LOOP
    CONTINUE WHEN v_item->>'category_id' IS NULL;
    SELECT * INTO v_comp FROM public.competitions WHERE category_id = (v_item->>'category_id')::uuid;
    CONTINUE WHEN NOT public.registration_competition_in_use(v_comp.category_id);
    IF v_item ? 'kind' AND v_item->>'kind' IS DISTINCT FROM v_comp.kind THEN
      RAISE EXCEPTION 'competition_locked';
    END IF;
    IF v_item ? 'hidden' AND (v_item->>'hidden')::boolean IS DISTINCT FROM (v_comp.hidden_at IS NOT NULL) THEN
      RAISE EXCEPTION 'competition_locked';
    END IF;
    IF (v_item ? 'team_min' AND (v_item->>'team_min')::integer IS DISTINCT FROM v_comp.team_min)
       OR (v_item ? 'team_max' AND (v_item->>'team_max')::integer IS DISTINCT FROM v_comp.team_max) THEN
      RAISE EXCEPTION 'competition_locked';
    END IF;
    IF v_mode = 'fixed' THEN
      SELECT p.amount INTO v_old
        FROM public.competition_prices p JOIN public.price_tiers t ON t.id = p.tier_id
       WHERE p.category_id = v_comp.category_id AND t.ends_on IS NULL
       ORDER BY t.sort_order LIMIT 1;
      IF (v_item->>'price')::integer IS DISTINCT FROM v_old THEN
        RAISE EXCEPTION 'price_locked';
      END IF;
    END IF;
  END LOOP;
END $$;
REVOKE EXECUTE ON FUNCTION public.registration_check_locks(uuid, text, jsonb) FROM public, anon, authenticated, service_role;
