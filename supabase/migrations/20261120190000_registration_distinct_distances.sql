-- Each distance once on an online-registration event's calendar row.
--
-- registration_write_public_rows aggregated one distance per competition, so an event offering a
-- run and a nordic walk over the same courses (II NieboCross 2027) published
-- '3 km, 9 km, 3 km, 9 km, 100 m - 1 km' to calendar_events, and the kalendarz and the POLECAMY
-- banner showed each distance twice. The function is recreated from its latest body
-- (20261108100000_registration_listed.sql) with only the distance aggregate changed, and the
-- calendar rows it already wrote lose their repeated distances (first occurrence kept, order kept,
-- a row whose distances an admin locked left alone).

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
      -- new: an unlisted event is published but kept off every listing (they all filter 'public')
      visibility = CASE WHEN v_rs.listed THEN 'public' ELSE 'unlisted' END,
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

  -- calendar_events. New: an unlisted event has no calendar row, so /kalendarz, the landing and
  -- /listy pages, the sitemap and the static generators never see it. A row it had while listed
  -- goes, unless an admin rejected it: that row lists nothing and keeps the rejection for a later
  -- listing (the UPDATE below never revives a rejected row).
  IF NOT v_rs.listed THEN
    PERFORM pg_advisory_xact_lock(hashtext('calendar_events:leszyrun:' || p_event_id::text));
    DELETE FROM public.calendar_events ce
     WHERE ce.source = 'leszyrun' AND ce.source_id = p_event_id::text AND ce.status <> 'rejected';
    RETURN;
  END IF;
  v_url := 'https://www.leszy.run/events/' || v_rs.slug;
  -- closes_at is exclusive: the last open Warsaw day is the deadline.
  v_deadline := ((v_rs.closes_at - interval '1 microsecond') AT TIME ZONE 'Europe/Warsaw')::date;
  -- new: each distance once, in the order of its first competition. A run and a nordic walk over
  -- the same course gave '3 km, 9 km, 3 km, 9 km' on the calendar and the POLECAMY banner.
  SELECT (SELECT array_agg(d.label ORDER BY d.first_sort, d.label)
            FROM (SELECT k2.distance_label AS label, min(k2.sort_order) AS first_sort
                    FROM public.competitions k2
                   WHERE k2.event_id = p_event_id AND k2.hidden_at IS NULL
                     AND k2.distance_label IS NOT NULL
                   GROUP BY k2.distance_label) d),
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


UPDATE public.calendar_events ce
   SET distances = (SELECT array_agg(s.x ORDER BY s.i)
                      FROM (SELECT DISTINCT ON (u.x) u.x, u.i
                              FROM unnest(ce.distances) WITH ORDINALITY AS u(x, i)
                             ORDER BY u.x, u.i) s),
       updated_at = now()
 WHERE ce.source = 'leszyrun'
   AND NOT ('distances' = ANY(coalesce(ce.locked_fields, '{}')))
   AND cardinality(ce.distances) > (SELECT count(DISTINCT x) FROM unnest(ce.distances) AS x);
