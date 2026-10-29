-- Plan 3, task 9: the public start list (RA8's columns, no filters; Plan 4
-- adds filters, groups and teams).
--
-- start_list(event id) → null unless the event is published or closed, else
-- {
--   competitions: [{ categoryId, name, capacity, paid, free, awaiting }],
--   entries: [{ name, town, club, categoryId, competition, ageGroupLabel, payment }]
-- }
-- payment is 'paid' (confirmed through an order with money in it) or 'free'
-- (confirmed with nothing to pay: a free event, or a 0 zł entry), the same rule
-- as paymentStatusOf() in list-event-registrations.
--
-- Ruling P3-R14 (the DPIA addendum's R2 and R6):
-- * entries awaiting payment are never listed by person: they are only the
--   per-competition `awaiting` count („+N czeka na wpłatę”); the runner sees
--   their own status on the order page, the organizer in Zgłoszenia;
-- * the town of a runner under 18 on the event date (or with no birth date)
--   is never returned.
-- A registration whose person deleted their account (delete-my-account
-- anonymises it to „Usunięte konto”) keeps its slot and is counted, but is not
-- listed. Expired, cancelled and transferred rows count for nothing. A hidden
-- competition is left out entirely, counts included, as in registration_raw.
--
-- An explicit list of fields, never a row: no birth date, e-mail, phone, ICE,
-- gender, bib, price or any id of a person or an order. Names sort in Polish
-- (pl-PL ICU collation: Ł after L, Ś after S, Ż after Z). Granted to anon:
-- public/api/startlist.js calls it with the anon key and the CDN answers the
-- viewers, so no public page queries Supabase per viewer.

CREATE FUNCTION public.start_list(p_event_id uuid) RETURNS jsonb
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = ''
AS $$
  WITH rs AS (
    SELECT event_id, event_date FROM public.registration_settings
     WHERE event_id = p_event_id AND state IN ('published', 'closed')
  ),
  comps AS (
    SELECT k.category_id, k.name, k.capacity, k.sort_order
      FROM public.competitions k JOIN rs ON rs.event_id = k.event_id
     WHERE k.hidden_at IS NULL
  ),
  live AS (
    SELECT r.first_name, r.last_name, r.club, r.age_group_label, r.created_at, r.id,
           c.category_id, c.name AS competition, c.sort_order,
           CASE
             WHEN r.status = 'pending_payment' THEN 'awaiting'
             WHEN o.total > 0 THEN 'paid'
             ELSE 'free'
           END AS payment,
           CASE
             WHEN r.birth_date IS NULL OR rs.event_date IS NULL
               OR r.birth_date > (rs.event_date - interval '18 years')::date THEN NULL
             ELSE nullif(btrim(r.city), '')
           END AS town,
           (r.first_name = 'Usunięte konto' AND r.last_name = 'Usunięte konto') AS deleted
      FROM public.registrations r
      JOIN comps c ON c.category_id = r.category_id
      CROSS JOIN rs
      LEFT JOIN public.orders o ON o.id = r.order_id
     WHERE r.status IN ('pending_payment', 'confirmed')
  )
  SELECT jsonb_build_object(
    'competitions', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'categoryId', c.category_id,
               'name', c.name,
               'capacity', c.capacity,
               'paid', (SELECT count(*) FROM live l WHERE l.category_id = c.category_id AND l.payment = 'paid')::integer,
               'free', (SELECT count(*) FROM live l WHERE l.category_id = c.category_id AND l.payment = 'free')::integer,
               'awaiting', (SELECT count(*) FROM live l WHERE l.category_id = c.category_id AND l.payment = 'awaiting')::integer
             ) ORDER BY c.sort_order, c.category_id)
        FROM comps c), '[]'::jsonb),
    'entries', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'name', concat_ws(' ', l.first_name, l.last_name),
               'town', l.town,
               'club', nullif(btrim(l.club), ''),
               'categoryId', l.category_id,
               'competition', l.competition,
               'ageGroupLabel', l.age_group_label,
               'payment', l.payment
             ) ORDER BY l.sort_order, l.last_name COLLATE "pl-PL-x-icu", l.first_name COLLATE "pl-PL-x-icu", l.created_at, l.id)
        FROM live l
       WHERE l.payment <> 'awaiting' AND NOT l.deleted), '[]'::jsonb)
  )
  FROM rs
$$;
REVOKE EXECUTE ON FUNCTION public.start_list(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.start_list(uuid) TO anon, authenticated, service_role;
