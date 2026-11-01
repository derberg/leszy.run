-- Plan 5, task 9: a team's name does not outlive its people.
--
-- teams.name is free text the captain typed, and it often names a family („Rodzina Kowalskich”).
-- It is personal data, and nothing removed it: the 30-day purge covered registrations and
-- participants, and delete-my-account anonymised the captain's row while the name stayed on the
-- public start list.
--
-- The team itself stays (ruling 11, D5-29): it holds a place, a fee and a start. So the name is
-- REPLACED, not nulled, which keeps every reader as it is. The replacement carries the team's own
-- id, because teams_category_name_live_key would refuse two teams with one neutral name in a
-- competition, and it says nothing about anybody.
--
-- team_neutral_name is the one place that spells the replacement: „Drużyna” and the first 8
-- characters of the id, or the whole id (p_full) when another live team of the competition already
-- holds the short one (a captain can type any name, „Drużyna 1A2B3C4D” included).
-- neutralise_team_name renames one team, falls back to the whole id on a unique_violation, and
-- skips the team with a warning if even that is taken, so a collision never rolls back a purge
-- (final review L-5). The next run tries again.
-- anonymise_team_names is what delete-my-account calls with the captain's teams.
-- purge_registration_contact_data is re-created from 20261031110000 with a third step. Released
-- teams are covered too: their name is free for others, but the row still holds it.
-- purge_expired_registrations is re-created from 20261031116000 with one more step: the name of a
-- team whose captain's registration it anonymises (an order expired or cancelled 30 days ago).
-- That purge clears the captain's profile_id and email, which is how delete-my-account finds a
-- registration, so after it nothing could reach the name any more (final review I-2).
-- Every statement is idempotent, so a second run touches nothing and returns 0.

CREATE FUNCTION public.team_neutral_name(p_team_id uuid, p_full boolean DEFAULT false) RETURNS text
  LANGUAGE sql
  IMMUTABLE
  SET search_path = ''
AS $$
  SELECT 'Drużyna ' || upper(CASE WHEN p_full THEN p_team_id::text ELSE left(p_team_id::text, 8) END)
$$;
REVOKE EXECUTE ON FUNCTION public.team_neutral_name(uuid, boolean) FROM public, anon, authenticated, service_role;

-- One team under its neutral name → 1 when renamed, 0 when it already was one or both are taken.
CREATE FUNCTION public.neutralise_team_name(p_team_id uuid) RETURNS integer
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.teams t WHERE t.id = p_team_id
               AND t.name IN (public.team_neutral_name(t.id), public.team_neutral_name(t.id, true))) THEN
    RETURN 0;
  END IF;
  BEGIN
    UPDATE public.teams SET name = public.team_neutral_name(id) WHERE id = p_team_id;
    RETURN 1;
  EXCEPTION WHEN unique_violation THEN
    BEGIN
      UPDATE public.teams SET name = public.team_neutral_name(id, true) WHERE id = p_team_id;
      RETURN 1;
    EXCEPTION WHEN unique_violation THEN
      RAISE WARNING 'neutralise_team_name: both neutral names of team % are taken', p_team_id;
      RETURN 0;
    END;
  END;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.neutralise_team_name(uuid) FROM public, anon, authenticated, service_role;

CREATE FUNCTION public.anonymise_team_names(p_captain_registration_ids uuid[]) RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
BEGIN
  RETURN coalesce((SELECT sum(public.neutralise_team_name(t.id))::integer FROM public.teams t
                    WHERE t.captain_registration_id = ANY (p_captain_registration_ids)), 0);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.anonymise_team_names(uuid[]) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anonymise_team_names(uuid[]) TO service_role;

CREATE OR REPLACE FUNCTION public.purge_registration_contact_data() RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_cutoff date := (now() AT TIME ZONE 'Europe/Warsaw')::date - 30;
  v_regs   integer;
  v_parts  integer;
  v_teams  integer;
BEGIN
  UPDATE public.registrations r
     SET phone = NULL, ice_name = NULL, ice_phone = NULL, guardian_name = NULL, guardian_email = NULL
    FROM public.registration_settings rs
   WHERE rs.event_id = r.event_id
     AND rs.event_date IS NOT NULL
     AND rs.event_date <= v_cutoff
     AND (r.phone IS NOT NULL OR r.ice_name IS NOT NULL OR r.ice_phone IS NOT NULL
          OR r.guardian_name IS NOT NULL OR r.guardian_email IS NOT NULL);
  GET DIAGNOSTICS v_regs = ROW_COUNT;

  UPDATE public.participants p
     SET phone = NULL
    FROM public.registrations r
    JOIN public.registration_settings rs ON rs.event_id = r.event_id
   WHERE p.registration_id = r.id
     AND rs.event_date IS NOT NULL
     AND rs.event_date <= v_cutoff
     AND p.phone IS NOT NULL;
  GET DIAGNOSTICS v_parts = ROW_COUNT;

  SELECT coalesce(sum(public.neutralise_team_name(t.id)), 0)::integer INTO v_teams
    FROM public.teams t
    JOIN public.registration_settings rs ON rs.event_id = t.event_id
   WHERE rs.event_date IS NOT NULL
     AND rs.event_date <= v_cutoff;

  RETURN v_regs + v_parts + v_teams;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.purge_registration_contact_data() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_registration_contact_data() TO service_role;

CREATE OR REPLACE FUNCTION public.purge_expired_registrations() RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_regs   integer;
  v_acc    integer;
  v_orders integer;
  v_teams  integer;
  v_gone   constant text := 'Usunięte zgłoszenie';
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS pg_temp.purge_orders (id uuid PRIMARY KEY) ON COMMIT DROP;
  TRUNCATE pg_temp.purge_orders;
  INSERT INTO pg_temp.purge_orders (id)
  SELECT o.id FROM public.orders o
   WHERE (o.status = 'expired' AND o.expires_at <= now() - interval '30 days')
      OR (o.status = 'cancelled' AND o.cancelled_at <= now() - interval '30 days');

  UPDATE public.registrations r
     SET first_name = v_gone, last_name = v_gone, profile_id = NULL,
         email = NULL, phone = NULL, birth_date = NULL, city = NULL, club = NULL,
         ice_name = NULL, ice_phone = NULL, nationality = NULL,
         guardian_profile_id = NULL, guardian_name = NULL, guardian_email = NULL
    FROM pg_temp.purge_orders p
   WHERE r.order_id = p.id
     AND r.status IN ('expired', 'cancelled')
     AND (r.first_name, r.last_name, r.profile_id, r.email, r.phone, r.birth_date, r.city, r.club,
          r.ice_name, r.ice_phone, r.nationality, r.guardian_profile_id, r.guardian_name, r.guardian_email)
         IS DISTINCT FROM
         (v_gone, v_gone, NULL::uuid, NULL::text, NULL::text, NULL::date, NULL::text, NULL::text,
          NULL::text, NULL::text, NULL::text, NULL::uuid, NULL::text, NULL::text);
  GET DIAGNOSTICS v_regs = ROW_COUNT;

  UPDATE public.consent_acceptances ca
     SET ip = NULL, user_agent = NULL
    FROM public.registrations r
    JOIN pg_temp.purge_orders p ON p.id = r.order_id
   WHERE ca.registration_id = r.id
     AND r.status IN ('expired', 'cancelled')
     AND (ca.ip IS NOT NULL OR ca.user_agent IS NOT NULL);
  GET DIAGNOSTICS v_acc = ROW_COUNT;

  UPDATE public.orders o
     SET buyer_email = NULL, buyer_name = NULL
    FROM pg_temp.purge_orders p
   WHERE o.id = p.id
     AND (o.buyer_email IS NOT NULL OR o.buyer_name IS NOT NULL)
     AND o.paid_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.payment_attempts a
                      WHERE a.order_id = o.id AND a.status IN ('paid', 'refunded'))
     AND NOT EXISTS (SELECT 1 FROM public.refunds f WHERE f.order_id = o.id);
  GET DIAGNOSTICS v_orders = ROW_COUNT;

  -- The team of an anonymised captain: its name goes with its people (final review I-2).
  SELECT coalesce(sum(public.neutralise_team_name(t.id)), 0)::integer INTO v_teams
    FROM public.teams t
    JOIN public.registrations r ON r.id = t.captain_registration_id
    JOIN pg_temp.purge_orders p ON p.id = r.order_id
   WHERE r.status IN ('expired', 'cancelled');

  RETURN v_regs + v_acc + v_orders + v_teams;
END $$;
REVOKE EXECUTE ON FUNCTION public.purge_expired_registrations() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_expired_registrations() TO service_role;
