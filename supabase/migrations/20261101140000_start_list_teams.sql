-- Plan 5, task 8: teams on the public start list (RA8 / RA8d). Recreates start_list() from
-- 20261031120000_start_list_full.sql: same signature, same grant to anon, and every key of a
-- person's entry unchanged. Each competition gains `kind`, and `entries` gains one row per
-- confirmed team (D5-28):
--   { kind: 'team', name, members: [firstName…], size, town, categoryId, competition, payment }
--
-- A team is ONE entry and ONE slot. Its people never appear as entries of their own, and a team
-- competition's paid / free / awaiting count teams, so paid + free stays equal to `taken`.
-- A pending team is only the `awaiting` count, like every unpaid entry (P3-R14), and stays outside
-- the limit (P3-R15).
--
-- payment reads the captain's row, not each member's: the captain holds the one fee and a member
-- carries price 0 (ruling 4), so the person rule `r.price > 0` would read a paid team as free. The
-- rule here is paymentStatusOf(captain, order, fee) in list-event-registrations.
--
-- members holds first names only, with what start_list already leaves out of a person's entry left
-- out here too: an added adult who has not accepted yet (they have not seen the data information
-- that says the list is public; 'accepted' and 'office' are public), and a person who deleted their
-- account (the 'Usunięte konto' pair, M10; rename it in both places together). `size` stays the
-- squad, so the two can differ. A team stays listed when its captain deleted their account, with
-- town null (D5-29).
--
-- town is the captain's, under the rule every town here follows: none for somebody under 18 on the
-- event date or with no birth date. The captain is always an adult, so that leaves the no-date case.
--
-- Names run in leg order when the competition has it on, else in team_position: the order the
-- captain gave them (the captain first), an added member last, a swapped-in member in the old
-- place. The order is all the list says about the legs: `team_leg` is never returned. No
-- surname, birth date, contact, guardian, price, or id of a team, person or order, at any depth.
-- A team sorts by its name, in Polish, among its competition's entries.

CREATE OR REPLACE FUNCTION public.start_list(p_event_id uuid) RETURNS jsonb
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
    SELECT k.category_id, k.name, k.kind, k.capacity, k.sort_order, k.is_kids, k.leg_order_enabled
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
     WHERE r.status IN ('pending_payment', 'confirmed') AND r.team_id IS NULL
  ),
  live_teams AS (
    SELECT t.id, t.name, t.created_at, t.captain_registration_id,
           c.category_id, c.name AS competition, c.sort_order, c.leg_order_enabled,
           CASE
             WHEN cap.status = 'pending_payment' THEN 'awaiting'
             WHEN o.total > 0 AND cap.price > 0 THEN 'paid'
             ELSE 'free'
           END AS payment,
           CASE
             WHEN cap.first_name = 'Usunięte konto' AND cap.last_name = 'Usunięte konto' THEN NULL
             WHEN cap.birth_date IS NULL OR rs.event_date IS NULL
               OR cap.birth_date > (rs.event_date - interval '18 years')::date THEN NULL
             ELSE nullif(btrim(cap.city), '')
           END AS town
      FROM public.teams t
      JOIN comps c ON c.category_id = t.category_id
      JOIN public.registrations cap ON cap.id = t.captain_registration_id
      CROSS JOIN rs
      LEFT JOIN public.orders o ON o.id = cap.order_id
     WHERE t.released_at IS NULL AND cap.status IN ('pending_payment', 'confirmed')
  ),
  units AS (
    SELECT category_id, payment FROM live
    UNION ALL
    SELECT category_id, payment FROM live_teams
  ),
  listed AS (
    SELECT l.sort_order, l.last_name AS sort_1, l.first_name AS sort_2, l.created_at, l.id,
           jsonb_build_object(
             'name', concat_ws(' ', l.first_name, l.last_name),
             'town', l.town,
             'club', nullif(btrim(l.club), ''),
             'categoryId', l.category_id,
             'competition', l.competition,
             'ageGroupLabel', l.age_group_label,
             'kidsGroupLabel', l.kids_group_label,
             'gender', l.gender,
             'payment', l.payment
           ) AS entry
      FROM live l
     WHERE l.payment <> 'awaiting' AND NOT l.deleted AND NOT l.unconsented
    UNION ALL
    SELECT t.sort_order, t.name, NULL, t.created_at, t.id,
           jsonb_build_object(
             'kind', 'team',
             'name', t.name,
             'members', COALESCE((
               SELECT jsonb_agg(m.first_name ORDER BY
                        CASE WHEN t.leg_order_enabled IS TRUE THEN m.team_leg END NULLS LAST,
                        m.team_position NULLS LAST, m.created_at, m.id)
                 FROM public.registrations m
                WHERE m.team_id = t.id AND m.status = 'confirmed'
                  AND m.consent_state IS DISTINCT FROM 'awaiting'
                  AND NOT (m.first_name = 'Usunięte konto' AND m.last_name = 'Usunięte konto')), '[]'::jsonb),
             'size', (SELECT count(*) FROM public.registrations m WHERE m.team_id = t.id AND m.status = 'confirmed')::integer,
             'town', t.town,
             'categoryId', t.category_id,
             'competition', t.competition,
             'payment', t.payment
           )
      FROM live_teams t
     WHERE t.payment <> 'awaiting'
  )
  SELECT jsonb_build_object(
    'competitions', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'categoryId', c.category_id,
               'name', c.name,
               'kind', c.kind,
               'capacity', c.capacity,
               'isKids', c.is_kids,
               'paid', (SELECT count(*) FROM units u WHERE u.category_id = c.category_id AND u.payment = 'paid')::integer,
               'free', (SELECT count(*) FROM units u WHERE u.category_id = c.category_id AND u.payment = 'free')::integer,
               'awaiting', (SELECT count(*) FROM units u WHERE u.category_id = c.category_id AND u.payment = 'awaiting')::integer
             ) ORDER BY c.sort_order, c.category_id)
        FROM comps c), '[]'::jsonb),
    'entries', COALESCE((
      SELECT jsonb_agg(e.entry ORDER BY e.sort_order, e.sort_1 COLLATE "pl-PL-x-icu", e.sort_2 COLLATE "pl-PL-x-icu", e.created_at, e.id)
        FROM listed e), '[]'::jsonb)
  )
  FROM rs
$$;
REVOKE EXECUTE ON FUNCTION public.start_list(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.start_list(uuid) TO anon, authenticated, service_role;
