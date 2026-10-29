-- Plan 3, task 9: the public start list (RA8's columns, no filters; Plan 4
-- adds filters, groups and teams).
--
-- start_list(event id) → null unless the event is published or closed, else
-- {
--   competitions: [{ categoryId, name, capacity, paid, awaiting }],
--   entries: [{ name, town, club, categoryId, competition, ageGroupLabel, paid }]
-- }
-- Live registrations only: pending_payment („czeka na wpłatę”, paid = false)
-- and confirmed (paid = true; a free event's runners are confirmed, so they
-- read as „opłacone” too, which is true: nothing is owed). Expired, cancelled
-- and transferred rows are left out. A hidden competition is left out
-- entirely, counts included, as in registration_raw.
--
-- An explicit list of fields, never a row: no birth date, e-mail, phone, ICE,
-- gender, bib, price or any id of a person or an order. Granted to anon:
-- public/api/startlist.js calls it with the anon key and the CDN answers the
-- viewers, so no public page queries Supabase per viewer.

CREATE FUNCTION public.start_list(p_event_id uuid) RETURNS jsonb
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = ''
AS $$
  WITH rs AS (
    SELECT event_id FROM public.registration_settings
     WHERE event_id = p_event_id AND state IN ('published', 'closed')
  ),
  comps AS (
    SELECT k.category_id, k.name, k.capacity, k.sort_order
      FROM public.competitions k JOIN rs ON rs.event_id = k.event_id
     WHERE k.hidden_at IS NULL
  ),
  live AS (
    SELECT r.first_name, r.last_name, r.city, r.club, r.age_group_label, r.status, r.created_at, r.id,
           c.category_id, c.name AS competition, c.sort_order
      FROM public.registrations r JOIN comps c ON c.category_id = r.category_id
     WHERE r.status IN ('pending_payment', 'confirmed')
  )
  SELECT jsonb_build_object(
    'competitions', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'categoryId', c.category_id,
               'name', c.name,
               'capacity', c.capacity,
               'paid', (SELECT count(*) FROM live l WHERE l.category_id = c.category_id AND l.status = 'confirmed')::integer,
               'awaiting', (SELECT count(*) FROM live l WHERE l.category_id = c.category_id AND l.status = 'pending_payment')::integer
             ) ORDER BY c.sort_order, c.category_id)
        FROM comps c), '[]'::jsonb),
    'entries', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'name', concat_ws(' ', l.first_name, l.last_name),
               'town', nullif(btrim(l.city), ''),
               'club', nullif(btrim(l.club), ''),
               'categoryId', l.category_id,
               'competition', l.competition,
               'ageGroupLabel', l.age_group_label,
               'paid', l.status = 'confirmed'
             ) ORDER BY l.sort_order, l.last_name, l.first_name, l.created_at, l.id)
        FROM live l), '[]'::jsonb)
  )
  FROM rs
$$;
REVOKE EXECUTE ON FUNCTION public.start_list(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.start_list(uuid) TO anon, authenticated, service_role;
