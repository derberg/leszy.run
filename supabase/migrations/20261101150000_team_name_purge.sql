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
-- team_neutral_name is the one place that spells the replacement.
-- anonymise_team_names is what delete-my-account calls with the captain's teams.
-- purge_registration_contact_data is re-created from 20261031110000 with a third step. Released
-- teams are covered too: their name is free for others, but the row still holds it.
-- Every statement is idempotent, so a second run touches nothing and returns 0.

CREATE FUNCTION public.team_neutral_name(p_team_id uuid) RETURNS text
  LANGUAGE sql
  IMMUTABLE
  SET search_path = ''
AS $$
  SELECT 'Drużyna ' || upper(left(p_team_id::text, 8))
$$;
REVOKE EXECUTE ON FUNCTION public.team_neutral_name(uuid) FROM public, anon, authenticated, service_role;

CREATE FUNCTION public.anonymise_team_names(p_captain_registration_ids uuid[]) RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_teams integer;
BEGIN
  UPDATE public.teams t
     SET name = public.team_neutral_name(t.id)
   WHERE t.captain_registration_id = ANY (p_captain_registration_ids)
     AND t.name <> public.team_neutral_name(t.id);
  GET DIAGNOSTICS v_teams = ROW_COUNT;
  RETURN v_teams;
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

  UPDATE public.teams t
     SET name = public.team_neutral_name(t.id)
    FROM public.registration_settings rs
   WHERE rs.event_id = t.event_id
     AND rs.event_date IS NOT NULL
     AND rs.event_date <= v_cutoff
     AND t.name <> public.team_neutral_name(t.id);
  GET DIAGNOSTICS v_teams = ROW_COUNT;

  RETURN v_regs + v_parts + v_teams;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.purge_registration_contact_data() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_registration_contact_data() TO service_role;
