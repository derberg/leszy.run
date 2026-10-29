-- Race registration, plan 2 task 5: publishing an event.
--
-- * registration_voivodeship(town_area): the calendar's capitalised name
--   (Śląskie, Kujawsko-Pomorskie) from the wizard's „GM. X · ŚLĄSKIE”. Matched
--   against literals, never through upper()/lower(), whose handling of Polish
--   letters depends on the database locale.
-- * registration_write_public_rows(event): the display fields hosts and the
--   calendar see. Spec 14.3: written only at publish and at „Opublikuj
--   zmiany” (task 7 calls it too), never while drafting, because anon reads
--   events, categories and calendar_events.
--     events: name, ISO date, location, slug, visibility public, club_id.
--     categories: each competition's name, a slug from it unique in the event,
--       untimed.
--     calendar_events: one row per event (source leszyrun, source_id = event
--       id). The table has no unique key on (source, source_id), so it is
--       update first, insert when there is none, under an advisory lock; an
--       update leaves the columns listed in that row's locked_fields alone.
-- * publish_registration_event(event, actor, expected_updated_at): draft →
--   published in one transaction. The edge function computed the checklist
--   from a read of the settings; p_expected_updated_at is that read's
--   updated_at, so a section saved in between (every blocking field's save
--   touches the settings row) fails with 'changed' instead of publishing an
--   event nobody checked. The current agreement version is a constant of the
--   edge functions (ORGANIZER_AGREEMENT_VERSION), so the function checks it.
--   Errors: not_found, not_draft, changed, forbidden, slug_taken.

-- ---------------------------------------------------------------- voivodeship

CREATE FUNCTION public.registration_voivodeship(p_town_area text) RETURNS text
  LANGUAGE sql
  IMMUTABLE
  SET search_path = ''
AS $$
  SELECT v.name
    FROM (VALUES
      ('Dolnośląskie', 'DOLNOŚLĄSKIE', 'dolnośląskie'),
      ('Kujawsko-Pomorskie', 'KUJAWSKO-POMORSKIE', 'kujawsko-pomorskie'),
      ('Lubelskie', 'LUBELSKIE', 'lubelskie'),
      ('Lubuskie', 'LUBUSKIE', 'lubuskie'),
      ('Łódzkie', 'ŁÓDZKIE', 'łódzkie'),
      ('Małopolskie', 'MAŁOPOLSKIE', 'małopolskie'),
      ('Mazowieckie', 'MAZOWIECKIE', 'mazowieckie'),
      ('Opolskie', 'OPOLSKIE', 'opolskie'),
      ('Podkarpackie', 'PODKARPACKIE', 'podkarpackie'),
      ('Podlaskie', 'PODLASKIE', 'podlaskie'),
      ('Pomorskie', 'POMORSKIE', 'pomorskie'),
      ('Śląskie', 'ŚLĄSKIE', 'śląskie'),
      ('Świętokrzyskie', 'ŚWIĘTOKRZYSKIE', 'świętokrzyskie'),
      ('Warmińsko-Mazurskie', 'WARMIŃSKO-MAZURSKIE', 'warmińsko-mazurskie'),
      ('Wielkopolskie', 'WIELKOPOLSKIE', 'wielkopolskie'),
      ('Zachodniopomorskie', 'ZACHODNIOPOMORSKIE', 'zachodniopomorskie')
    ) AS v(name, upper_name, lower_name)
   WHERE regexp_replace(btrim(split_part(coalesce(p_town_area, ''), '·', -1)), '^(WOJ\.|woj\.|WOJEWÓDZTWO|województwo)\s+', '')
         IN (v.name, v.upper_name, v.lower_name)
$$;
REVOKE EXECUTE ON FUNCTION public.registration_voivodeship(text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.registration_voivodeship(text) TO service_role;

-- ---------------------------------------------------------------- display rows

CREATE FUNCTION public.registration_write_public_rows(p_event_id uuid) RETURNS void
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
         CASE WHEN bool_or(k.discipline = 'nw') THEN ARRAY['nordic walking'] ELSE '{}'::text[] END
    INTO v_dists, v_types
    FROM public.competitions k
   WHERE k.event_id = p_event_id AND k.hidden_at IS NULL;
  IF v_rs.is_charity THEN
    v_types := v_types || 'charytatywny'::text;
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
      status                = CASE WHEN 'status' = ANY(v_locked) THEN status ELSE 'active' END,
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
-- Internal: reachable only through the SECURITY DEFINER RPCs that call it.
REVOKE EXECUTE ON FUNCTION public.registration_write_public_rows(uuid) FROM public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- publish

CREATE FUNCTION public.publish_registration_event(p_event_id uuid, p_actor uuid,
                                                  p_expected_updated_at timestamptz DEFAULT NULL)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_rs public.registration_settings%ROWTYPE;
BEGIN
  -- Row lock: a second publish waits here and then finds the event published.
  SELECT * INTO v_rs FROM public.registration_settings WHERE event_id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_rs.state <> 'draft' THEN
    RAISE EXCEPTION 'not_draft';
  END IF;
  IF p_expected_updated_at IS NOT NULL AND v_rs.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'changed';
  END IF;
  -- The edge function checked these; the RPC does not trust its caller.
  IF NOT EXISTS (SELECT 1 FROM public.club_members m
                  WHERE m.club_id = v_rs.club_id AND m.user_id = p_actor
                    AND m.status = 'active' AND m.role IN ('owner', 'admin'))
     OR NOT EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = v_rs.club_id AND c.registration_enabled) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  UPDATE public.registration_settings
     SET state = 'published', published_at = now(), regulamin_version = 1
   WHERE event_id = p_event_id AND state = 'draft';

  PERFORM public.registration_write_public_rows(p_event_id);

  RETURN jsonb_build_object('state', 'published', 'slug', v_rs.slug, 'publishedAt', now());
END $$;
REVOKE EXECUTE ON FUNCTION public.publish_registration_event(uuid, uuid, timestamptz) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publish_registration_event(uuid, uuid, timestamptz) TO service_role;
