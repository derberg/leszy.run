-- Race registration, plan 2 task 7: edits after publish.
--
-- A save on a published event never touches the live tables. It is staged in
-- registration_pending_changes (one row per event), and „Opublikuj zmiany”
-- applies everything staged in one transaction, through the same
-- apply_registration_section a draft save uses, with p_allow_delete = false.
--
-- * registration_check_locks(event, section, value): the server-side locks
--   (spec §2, ruling P2-R8). Raises
--     immutable           slug or timing_mode differs from the live value
--     foreign_id          a competition id of another event
--     competition_locked  a competition left out (deletion is banned after
--                         publish: hide it instead), a kind change or a hide
--                         of a competition with taken > 0
--     price_locked        pricing_mode change while any competition has
--                         taken > 0, or a price change of one with taken > 0
--   Called when staging (early answer, no row locks) and again when applying,
--   with the competition rows locked, which is the check that counts.
-- * registration_pending_fields(event, payload) → changed_fields: the staged
--   keys whose value differs from the live column ('<section>.<key>'); list
--   keys (items, hours, groups, consents) always count.
-- * stage_registration_section(event, section, value, actor): merges one
--   validated section into payload[section] (keys of a later save win) and
--   recomputes changed_fields; a payload that changes nothing is deleted.
-- * publish_registration_changes(event, actor, expected_updated_at, claim_notice):
--   applies the staged payload. Lock order is the one register_free uses —
--   the event's competition rows FOR UPDATE first, then the settings row — so
--   the two never deadlock. A capacity below taken fails in the writing
--   statement (apply_registration_section: … WHERE taken <= capacity), so a
--   registration either lands first and blocks the change or waits and meets
--   the new limit. Hide/unhide is written WHERE taken = 0. A changed
--   regulamin bumps regulamin_version. Then registration_write_public_rows
--   rewrites the events, categories and calendar rows, and the pending row is
--   deleted. With p_claim_notice the change notice's throttle slot
--   (notice:<event>, one per hour) is claimed inside the same transaction, so
--   a refused publish never uses up the slot and a throttled one applies
--   nothing. Errors: not_found, not_published, forbidden, no_changes,
--   changed, notice_throttled, and the lock errors above,
--   capacity_below_taken:<category_id>.
-- * registration_write_public_rows: replaced to keep a calendar row an admin
--   set to 'rejected' rejected, and to add 'dzieci' to event_type when a
--   visible competition is for kids (task 5 review).
-- * apply_registration_section / registration_check_upload lose EXECUTE for
--   service_role: their only callers are SECURITY DEFINER functions owned by
--   postgres, and a direct call skipped not_draft and the row lock.

-- ---------------------------------------------------------------- locks

CREATE FUNCTION public.registration_check_locks(p_event_id uuid, p_section text, p_value jsonb) RETURNS void
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
     AND EXISTS (SELECT 1 FROM public.competitions c WHERE c.event_id = p_event_id AND c.taken > 0) THEN
    RAISE EXCEPTION 'price_locked';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_value->'items') LOOP
    CONTINUE WHEN v_item->>'category_id' IS NULL;
    SELECT * INTO v_comp FROM public.competitions WHERE category_id = (v_item->>'category_id')::uuid;
    CONTINUE WHEN v_comp.taken = 0;
    IF v_item ? 'kind' AND v_item->>'kind' IS DISTINCT FROM v_comp.kind THEN
      RAISE EXCEPTION 'competition_locked';
    END IF;
    IF v_item ? 'hidden' AND (v_item->>'hidden')::boolean IS DISTINCT FROM (v_comp.hidden_at IS NOT NULL) THEN
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

-- ---------------------------------------------------------------- changed fields

CREATE FUNCTION public.registration_pending_fields(p_event_id uuid, p_payload jsonb) RETURNS text[]
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
DECLARE
  v_live    jsonb;
  v_section text;
  v_value   jsonb;
  v_key     text;
  v_type    text;
  v_differs boolean;
  v_fields  text[] := '{}';
BEGIN
  SELECT to_jsonb(rs) INTO v_live FROM public.registration_settings rs WHERE rs.event_id = p_event_id;
  FOR v_section, v_value IN SELECT key, value FROM jsonb_each(p_payload) ORDER BY key LOOP
    CONTINUE WHEN jsonb_typeof(v_value) <> 'object';
    FOR v_key IN SELECT key FROM jsonb_object_keys(v_value) AS t(key) ORDER BY key LOOP
      SELECT format_type(a.atttypid, a.atttypmod) INTO v_type
        FROM pg_catalog.pg_attribute a
       WHERE a.attrelid = 'public.registration_settings'::regclass AND a.attname = v_key
         AND a.attnum > 0 AND NOT a.attisdropped;
      IF NOT FOUND THEN
        v_differs := true;                       -- a list: items, hours, groups, consents
      ELSIF v_type = 'jsonb' THEN
        v_differs := v_value->v_key IS DISTINCT FROM v_live->v_key;
      ELSE
        -- Compared as the column's type: '10:00' equals the stored 10:00:00.
        EXECUTE format('SELECT $1::%s IS DISTINCT FROM $2::%s', v_type, v_type)
          INTO v_differs USING v_value->>v_key, v_live->>v_key;
      END IF;
      IF v_differs THEN
        v_fields := v_fields || (v_section || '.' || v_key);
      END IF;
    END LOOP;
  END LOOP;
  RETURN v_fields;
END $$;
REVOKE EXECUTE ON FUNCTION public.registration_pending_fields(uuid, jsonb) FROM public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- stage

CREATE FUNCTION public.stage_registration_section(p_event_id uuid, p_section text, p_value jsonb, p_actor uuid)
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
  IF p_section NOT IN ('basics', 'office', 'competitions', 'categories', 'timing', 'form')
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

CREATE FUNCTION public.publish_registration_changes(p_event_id uuid, p_actor uuid,
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

  FOREACH v_section IN ARRAY ARRAY['basics', 'office', 'competitions', 'categories', 'timing', 'form'] LOOP
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

-- ---------------------------------------------------------------- display rows

CREATE OR REPLACE FUNCTION public.registration_write_public_rows(p_event_id uuid) RETURNS void
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
DECLARE
  v_rs       public.registration_settings%ROWTYPE;
  v_comp     record;
  v_base     text;
  v_slug     text;
  v_n        integer;
  v_taken    text[] := '{}';
  v_ids      uuid[] := '{}';
  v_slugs    text[] := '{}';
  v_url      text;
  v_deadline date;
  v_from     integer;
  v_to       integer;
  v_types    text[];
  v_dists    text[];
  v_kids     boolean;
  v_cal      uuid;
  v_locked   text[];
BEGIN
  SELECT * INTO v_rs FROM public.registration_settings WHERE event_id = p_event_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  -- events. A slug an ordinary event took after the draft reserved it.
  IF EXISTS (SELECT 1 FROM public.events e WHERE e.slug = v_rs.slug AND e.id <> p_event_id) THEN
    RAISE EXCEPTION 'slug_taken';
  END IF;
  BEGIN
    UPDATE public.events SET
      name       = v_rs.name,
      date       = to_char(v_rs.event_date, 'YYYY-MM-DD'),
      location   = v_rs.town_label,
      slug       = v_rs.slug,
      visibility = 'public',
      club_id    = v_rs.club_id
    WHERE id = p_event_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'slug_taken';
  END;

  -- categories. Slugs are assigned in competition order, unique in the event
  -- (categories_event_id_slug_unique). Changed rows first move to their
  -- id-based placeholder, so two competitions swapping names never collide
  -- mid-statement.
  SELECT coalesce(array_agg(c.slug), '{}') INTO v_taken
    FROM public.categories c
   WHERE c.event_id = p_event_id
     AND NOT EXISTS (SELECT 1 FROM public.competitions k WHERE k.category_id = c.id);
  FOR v_comp IN
    SELECT k.category_id, k.name FROM public.competitions k
     WHERE k.event_id = p_event_id ORDER BY k.sort_order, k.category_id
  LOOP
    v_base := public.registration_slugify(v_comp.name);
    IF v_base = '' THEN
      v_base := 'konkurencja';
    END IF;
    v_slug := v_base;
    v_n := 1;
    WHILE v_slug = ANY(v_taken) LOOP
      v_n := v_n + 1;
      v_slug := rtrim(left(v_base, 80 - char_length('-' || v_n)), '-') || '-' || v_n;
    END LOOP;
    v_taken := v_taken || v_slug;
    v_ids := v_ids || v_comp.category_id;
    v_slugs := v_slugs || v_slug;
  END LOOP;

  UPDATE public.categories c SET slug = 'szkic-' || c.id
    FROM unnest(v_ids, v_slugs) AS t(id, slug)
   WHERE c.id = t.id AND c.slug <> t.slug AND c.slug <> 'szkic-' || c.id;
  UPDATE public.categories c SET name = k.name, slug = t.slug, untimed = NOT k.timed
    FROM unnest(v_ids, v_slugs) AS t(id, slug)
    JOIN public.competitions k ON k.category_id = t.id
   WHERE c.id = t.id;

  -- calendar_events
  v_url := 'https://www.leszy.run/events/' || v_rs.slug;
  -- closes_at is exclusive: the last open Warsaw day is the deadline.
  v_deadline := ((v_rs.closes_at - interval '1 microsecond') AT TIME ZONE 'Europe/Warsaw')::date;
  SELECT array_agg(k.distance_label ORDER BY k.sort_order) FILTER (WHERE k.distance_label IS NOT NULL),
         CASE WHEN bool_or(k.discipline = 'nw') THEN ARRAY['nordic walking'] ELSE '{}'::text[] END,
         coalesce(bool_or(k.is_kids), false)
    INTO v_dists, v_types, v_kids
    FROM public.competitions k
   WHERE k.event_id = p_event_id AND k.hidden_at IS NULL;
  IF v_rs.is_charity THEN
    v_types := v_types || 'charytatywny'::text;
  END IF;
  IF v_kids THEN
    v_types := v_types || 'dzieci'::text;
  END IF;
  IF v_rs.pricing_mode = 'free' THEN
    v_from := 0;
    v_to := 0;
  ELSE
    -- Grosze to whole złoty, rounded outward.
    SELECT floor(min(p.amount) / 100.0)::integer, ceil(max(p.amount) / 100.0)::integer INTO v_from, v_to
      FROM public.competition_prices p
      JOIN public.competitions k ON k.category_id = p.category_id
     WHERE k.event_id = p_event_id AND k.hidden_at IS NULL;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('calendar_events:leszyrun:' || p_event_id::text));
  SELECT ce.id, ce.locked_fields INTO v_cal, v_locked
    FROM public.calendar_events ce
   WHERE ce.source = 'leszyrun' AND ce.source_id = p_event_id::text
   ORDER BY ce.created_at, ce.id
   LIMIT 1
   FOR UPDATE;
  IF v_cal IS NULL THEN
    INSERT INTO public.calendar_events (
      source, source_id, leszyrun_event_id, status, name, date, location, voivodeship, lat, lng,
      distances, event_type, registration_url, registration_deadline, price_from, price_to)
    VALUES (
      'leszyrun', p_event_id::text, p_event_id, 'active', v_rs.name, v_rs.event_date, v_rs.town_label,
      public.registration_voivodeship(v_rs.town_area), v_rs.lat, v_rs.lng, v_dists, NULLIF(v_types, '{}'),
      v_url, v_deadline, v_from, v_to);
  ELSE
    UPDATE public.calendar_events SET
      leszyrun_event_id     = CASE WHEN 'leszyrun_event_id' = ANY(v_locked) THEN leszyrun_event_id ELSE p_event_id END,
      -- An admin's rejection stands: it is what keeps the row off the calendar.
      status                = CASE WHEN 'status' = ANY(v_locked) OR status = 'rejected' THEN status ELSE 'active' END,
      name                  = CASE WHEN 'name' = ANY(v_locked) THEN name ELSE v_rs.name END,
      date                  = CASE WHEN 'date' = ANY(v_locked) THEN date ELSE v_rs.event_date END,
      location              = CASE WHEN 'location' = ANY(v_locked) THEN location ELSE v_rs.town_label END,
      voivodeship           = CASE WHEN 'voivodeship' = ANY(v_locked) THEN voivodeship
                                   ELSE public.registration_voivodeship(v_rs.town_area) END,
      lat                   = CASE WHEN 'lat' = ANY(v_locked) THEN lat ELSE v_rs.lat END,
      lng                   = CASE WHEN 'lng' = ANY(v_locked) THEN lng ELSE v_rs.lng END,
      distances             = CASE WHEN 'distances' = ANY(v_locked) THEN distances ELSE v_dists END,
      event_type            = CASE WHEN 'event_type' = ANY(v_locked) THEN event_type ELSE NULLIF(v_types, '{}') END,
      registration_url      = CASE WHEN 'registration_url' = ANY(v_locked) THEN registration_url ELSE v_url END,
      registration_deadline = CASE WHEN 'registration_deadline' = ANY(v_locked) THEN registration_deadline ELSE v_deadline END,
      price_from            = CASE WHEN 'price_from' = ANY(v_locked) THEN price_from ELSE v_from END,
      price_to              = CASE WHEN 'price_to' = ANY(v_locked) THEN price_to ELSE v_to END,
      updated_at            = now()
    WHERE id = v_cal;
  END IF;
END $$;
REVOKE EXECUTE ON FUNCTION public.registration_write_public_rows(uuid) FROM public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- internal grants

-- Their only callers are SECURITY DEFINER functions owned by postgres
-- (save_registration_section, publish_registration_changes, and
-- apply_registration_section itself for the upload check).
REVOKE EXECUTE ON FUNCTION public.apply_registration_section(uuid, text, jsonb, boolean) FROM service_role;
REVOKE EXECUTE ON FUNCTION public.registration_check_upload(uuid, text, text) FROM service_role;
COMMENT ON FUNCTION public.apply_registration_section(uuid, text, jsonb, boolean) IS
  'Internal: reachable only through save_registration_section (drafts) and publish_registration_changes.';
