-- Plan 4, task 7: the full start list (RA8 / RA8d). Extends Plan 3's start_list
-- (20261030140000) rather than rebuilding it (D4-19): same signature, same grant to
-- anon, same keys, one more per competition:
--   isKids          the competition is a kids one (RA8's „Płeć” reads „Dziewczynki /
--                   Chłopcy” there)
-- and two more per entry:
--   gender          'M' | 'K' (ruling 7: RA8's „Płeć” filter needs it, and the age
--                   group label already shows it)
--   kidsGroupLabel  the kids group's label for an entry in a kids competition, else null
--
-- start_list(event id) → null unless the event is published or closed, else
-- {
--   competitions: [{ categoryId, name, capacity, isKids, paid, free, awaiting }],
--   entries: [{ name, town, club, categoryId, competition, ageGroupLabel,
--               kidsGroupLabel, gender, payment }]
-- }
-- payment is 'paid' (confirmed through an order with money in it AND an entry
-- price above 0) or 'free' (confirmed with nothing to pay for this person: a free
-- event, a 0 zł order, or a 0 zł entry inside a paid group order, e.g. a free kids
-- race beside a parent's paid one), the same rule as paymentStatusOf() in
-- list-event-registrations.
--
-- An adult added to someone else's group (consent_state 'awaiting') is counted but
-- not listed by name until they accept the regulamin online or the office records it
-- ('accepted' / 'office'): they have not yet seen the data information that tells
-- them the start list is public (task 7 review F2). Their slot still counts, so
-- paid + free stays equal to the confirmed `taken`.
--
-- Ruling P3-R14 (the DPIA addendum's R2 and R6), unchanged:
-- * entries awaiting payment are never listed by person: they are only the
--   per-competition `awaiting` count („+N czeka na wpłatę”), outside „N / limit”
--   (P3-R15);
-- * the town of a runner under 18 on the event date (or with no birth date)
--   is never returned.
-- A registration whose person deleted their account (delete-my-account
-- anonymises it to the pair first_name = last_name = 'Usunięte konto'; rename the
-- placeholder in both places together, final review M10) keeps its slot and is
-- counted, but is not listed. A child whose GUARDIAN deleted their account keeps
-- their own name (only the guardian_* fields change), so the child stays listed.
-- Expired, cancelled and transferred rows count for nothing. A hidden competition
-- is left out entirely, counts included, as in registration_raw.
--
-- An explicit list of fields, never a row: no birth date, e-mail, phone, ICE, bib,
-- price, consent state, guardian data or any id of a person or an order. Names sort
-- in Polish (pl-PL ICU collation: Ł after L, Ś after S, Ż after Z). Granted to anon:
-- public/api/startlist.js calls it with the anon key and the CDN answers the viewers,
-- so no public page queries Supabase per viewer.

DROP FUNCTION public.start_list(uuid);
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
    SELECT k.category_id, k.name, k.capacity, k.sort_order, k.is_kids
      FROM public.competitions k JOIN rs ON rs.event_id = k.event_id
     WHERE k.hidden_at IS NULL
  ),
  live AS (
    SELECT r.first_name, r.last_name, r.club, r.age_group_label, r.created_at, r.id,
           r.gender, CASE WHEN c.is_kids THEN kg.label END AS kids_group_label,
           c.category_id, c.name AS competition, c.sort_order,
           CASE
             WHEN r.status = 'pending_payment' THEN 'awaiting'
             WHEN o.total > 0 AND r.price > 0 THEN 'paid'
             ELSE 'free'
           END AS payment,
           CASE
             WHEN r.birth_date IS NULL OR rs.event_date IS NULL
               OR r.birth_date > (rs.event_date - interval '18 years')::date THEN NULL
             ELSE nullif(btrim(r.city), '')
           END AS town,
           (r.first_name = 'Usunięte konto' AND r.last_name = 'Usunięte konto') AS deleted,
           (r.consent_state = 'awaiting') AS unconsented
      FROM public.registrations r
      JOIN comps c ON c.category_id = r.category_id
      CROSS JOIN rs
      LEFT JOIN public.orders o ON o.id = r.order_id
      LEFT JOIN public.kids_groups kg ON kg.id = r.kids_group_id AND kg.category_id = r.category_id
     WHERE r.status IN ('pending_payment', 'confirmed')
  )
  SELECT jsonb_build_object(
    'competitions', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'categoryId', c.category_id,
               'name', c.name,
               'capacity', c.capacity,
               'isKids', c.is_kids,
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
               'kidsGroupLabel', l.kids_group_label,
               'gender', l.gender,
               'payment', l.payment
             ) ORDER BY l.sort_order, l.last_name COLLATE "pl-PL-x-icu", l.first_name COLLATE "pl-PL-x-icu", l.created_at, l.id)
        FROM live l
       WHERE l.payment <> 'awaiting' AND NOT l.deleted AND NOT l.unconsented), '[]'::jsonb)
  )
  FROM rs
$$;
REVOKE EXECUTE ON FUNCTION public.start_list(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.start_list(uuid) TO anon, authenticated, service_role;
