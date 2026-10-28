-- Race registration, plan 2 task 6: what the public event page may read.
--
-- * registration_raw(event): the event as the runner sees it, in any state.
--   Service role only (the members-only preview edge function reads drafts
--   through it).
-- * registration_public(slug): registration_raw of a published or closed
--   event, else null. Granted to anon: public/api/event.js calls it with the
--   anon key, and the CDN answers the viewers.
--
-- Both return an explicit list of fields, never a row: no payout, no person,
-- no club or upload ids. The ids are the event's, the competitions' (category
-- ids, which the registration form posts) and the consents' (which the form
-- accepts by id). Files are storage paths in the public registration-files
-- bucket (posterPath, regulamin.path, course.gpxPath); the readers turn them
-- into URLs, since only they know the project URL.
--
-- A hidden competition (hidden_at set) is left out entirely, counts included.
-- The current price tier is the first whose last day (ends_on, a Warsaw date)
-- is today or later; nextPrice is the tier after it, from the day after.
-- Nothing here depends on the time of day, so the snapshot's version changes
-- when the data does, or at a tier boundary.

CREATE FUNCTION public.registration_raw(p_event_id uuid) RETURNS jsonb
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
                 'to', to_char(h.ends_at AT TIME ZONE 'Europe/Warsaw', 'HH24:MI'))
               ORDER BY h.starts_at, h.ends_at)
          FROM public.office_hours h WHERE h.event_id = rs.event_id), '[]'::jsonb)),
    'timing', jsonb_build_object(
      'mode', rs.timing_mode, 'company', rs.timing_company,
      'resultsUrl', rs.results_url, 'liveResultsUrl', rs.live_results_url),
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
    'consents', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'text', e.text)
             ORDER BY CASE e.kind WHEN 'regulamin' THEN 0 WHEN 'data_info' THEN 1 ELSE 2 END, e.sort_order, e.created_at, e.id)
        FROM public.event_consents e WHERE e.event_id = rs.event_id), '[]'::jsonb),
    'competitions', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'categoryId', k.category_id,
               'name', k.name,
               'kind', k.kind,
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

CREATE FUNCTION public.registration_public(p_slug text) RETURNS jsonb
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = ''
AS $$
  SELECT public.registration_raw(rs.event_id)
    FROM public.registration_settings rs
   WHERE rs.slug = p_slug
     AND rs.state IN ('published', 'closed')
$$;
REVOKE EXECUTE ON FUNCTION public.registration_public(text) FROM public;
GRANT EXECUTE ON FUNCTION public.registration_public(text) TO anon, authenticated, service_role;
