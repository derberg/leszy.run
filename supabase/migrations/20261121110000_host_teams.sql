-- Names of relay teams set up on a timing host, with no online registration.
--
-- A host team is a participants.team_id its members share (backend lib/teamEdit.js). Until now
-- such a team had no name anywhere and was labelled by its members' surnames. The operator now
-- names it on the host (PUT /api/events/:eventId/host-teams/:teamId); the row is pushed here and
-- pulled by every other host (configSync), like categories. A registration team's name stays in
-- `teams` and never reaches a host: the host refuses to name a team that has a registration
-- member, and results_team_names below lets a `teams` row win over a host_teams row of the same id.
--
-- A team name may name a family, so it follows the registration rule: 30 days after the race
-- purge_host_team_names() replaces it with team_neutral_name() (pg_cron, daily). A clean host row
-- receives the replacement through configSync.
--
-- Local twin: backend/src/db/migrations/0043_host_teams.sql. Ship this BEFORE any host runs the
-- code that pushes host_teams, or every push of it is refused (the push retries next cycle).

CREATE TABLE public.host_teams (
  id          uuid PRIMARY KEY,
  event_id    uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60 AND name = btrim(name)),
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now(),
  synced_at   timestamptz
);
CREATE INDEX host_teams_event_id_idx ON public.host_teams (event_id);
ALTER TABLE public.host_teams ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.host_teams FROM anon, authenticated;

-- ---------------------------------------------------------------- public read

-- Same signature, body extended: the registration teams exactly as in 20261118100000, plus the
-- host teams of the event that have a live member and are not a registration team. CREATE OR
-- REPLACE keeps the grants; they are restated as they were.
CREATE OR REPLACE FUNCTION public.results_team_names(p_event_id uuid)
  RETURNS TABLE (team_id uuid, name text)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = ''
AS $$
  SELECT t.id, t.name
    FROM public.teams t
    JOIN public.registration_settings rs ON rs.event_id = t.event_id
    JOIN public.registrations cap ON cap.id = t.captain_registration_id
   WHERE t.event_id = p_event_id
     AND t.released_at IS NULL
     AND rs.state <> 'draft'
     AND cap.status = 'confirmed'
  UNION ALL
  SELECT h.id, h.name
    FROM public.host_teams h
   WHERE h.event_id = p_event_id
     AND NOT EXISTS (SELECT 1 FROM public.teams t WHERE t.id = h.id)
     AND NOT EXISTS (SELECT 1 FROM public.registration_settings rs
                      WHERE rs.event_id = h.event_id AND rs.state = 'draft')
     AND EXISTS (SELECT 1 FROM public.participants p
                  WHERE p.event_id = h.event_id AND p.team_id = h.id
                    AND p.removed_at IS NULL AND p.deleted_at IS NULL)
$$;
REVOKE EXECUTE ON FUNCTION public.results_team_names(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.results_team_names(uuid) TO anon, authenticated, service_role;

-- ---------------------------------------------------------------- retention

-- The event's day: registration_settings.event_date for a registration event, else events.date
-- when it holds an ISO date (it is free text on older events). Same Warsaw-day cutoff as
-- purge_registration_contact_data(). An event with no readable date is never purged here, and an
-- impossible one ('2026-02-30') reads as none rather than failing the whole run.
CREATE FUNCTION public.iso_day_or_null(p_text text) RETURNS date
  LANGUAGE plpgsql
  IMMUTABLE
  SET search_path = ''
AS $$
BEGIN
  IF p_text IS NULL OR p_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN RETURN NULL; END IF;
  RETURN left(p_text, 10)::date;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.iso_day_or_null(text) FROM public, anon, authenticated;

CREATE FUNCTION public.purge_host_team_names() RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_cutoff date := (now() AT TIME ZONE 'Europe/Warsaw')::date - 30;
  v_count  integer;
BEGIN
  UPDATE public.host_teams h
     SET name = public.team_neutral_name(h.id), updated_at = now()
    FROM public.events e
    LEFT JOIN public.registration_settings rs ON rs.event_id = e.id
   WHERE e.id = h.event_id
     AND h.name <> public.team_neutral_name(h.id)
     AND coalesce(rs.event_date, public.iso_day_or_null(e.date)) <= v_cutoff;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.purge_host_team_names() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_host_team_names() TO service_role;

-- 01:40 UTC, ten minutes after purge-registration-contact.
SELECT cron.schedule('purge-host-team-names', '40 1 * * *', $$SELECT public.purge_host_team_names()$$);
