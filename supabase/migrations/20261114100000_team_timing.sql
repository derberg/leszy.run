-- Team timing: a relay (sztafeta) or a team run, timed through each member's own tag.
--
-- A team is never timed by a tag of its own. Every member keeps their bib, their tag and their
-- `results` row; the team's standing is derived from those rows (@leszyrun/ui computeTeamResults).
-- So the timing host needs only two facts per participant, which team and which leg, and one per
-- category, how the team is scored. It never gets the team's name (Plan 5: a team name is personal
-- data and `teams` stays off the hosts); the public results snapshot reads names through
-- results_team_names() below, the same names start_list() already publishes.
--
-- Local twin: backend/src/db/migrations/0042_team_timing.sql. Ship this BEFORE any host runs the
-- code that pushes these columns, or PostgREST refuses every participants/categories push.

-- ---------------------------------------------------------------- columns

ALTER TABLE public.categories
  ADD COLUMN team_mode text CHECK (team_mode IN ('relay', 'together')),
  ADD COLUMN team_count_members integer CHECK (team_count_members >= 1);

ALTER TABLE public.participants
  ADD COLUMN team_id uuid,
  ADD COLUMN team_leg integer CHECK (team_leg >= 1);
CREATE INDEX participants_team_id_idx ON public.participants (team_id) WHERE team_id IS NOT NULL;

-- ---------------------------------------------------------------- participants follow their registration

-- The participant bridge (insert_registration_participant) is left as it is: a BEFORE INSERT
-- trigger copies the team and leg, so no registration RPC has to be recreated.
CREATE FUNCTION public.participant_team_from_registration() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
BEGIN
  IF NEW.registration_id IS NOT NULL AND NEW.team_id IS NULL THEN
    SELECT r.team_id, r.team_leg INTO NEW.team_id, NEW.team_leg
      FROM public.registrations r WHERE r.id = NEW.registration_id;
  END IF;
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION public.participant_team_from_registration() FROM public, anon, authenticated;

CREATE TRIGGER participants_team_from_registration
  BEFORE INSERT ON public.participants
  FOR EACH ROW EXECUTE FUNCTION public.participant_team_from_registration();

-- A captain's reorder (team_squad_edit) changes team_leg after the participant exists.
CREATE FUNCTION public.registration_team_to_participant() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
BEGIN
  UPDATE public.participants p
     SET team_id = NEW.team_id, team_leg = NEW.team_leg, updated_at = now()
   WHERE p.registration_id = NEW.id
     AND (p.team_id IS DISTINCT FROM NEW.team_id OR p.team_leg IS DISTINCT FROM NEW.team_leg);
  RETURN NULL;
END $$;
REVOKE EXECUTE ON FUNCTION public.registration_team_to_participant() FROM public, anon, authenticated;

CREATE TRIGGER registrations_team_to_participant
  AFTER UPDATE OF team_id, team_leg ON public.registrations
  FOR EACH ROW EXECUTE FUNCTION public.registration_team_to_participant();

-- ---------------------------------------------------------------- the category's mode from its competition

-- A team competition with leg order collected is a relay, one without is a team run. Set when
-- the competition becomes a team one or its leg order changes; any other time the category's
-- value (an operator's choice on the host, pushed back) stands.
CREATE FUNCTION public.competition_team_mode_to_category() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT'
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.leg_order_enabled IS DISTINCT FROM OLD.leg_order_enabled THEN
    UPDATE public.categories c
       SET team_mode = CASE WHEN NEW.kind <> 'team' THEN NULL
                            WHEN NEW.leg_order_enabled THEN 'relay'
                            ELSE 'together' END
     WHERE c.id = NEW.category_id;
  END IF;
  RETURN NULL;
END $$;
REVOKE EXECUTE ON FUNCTION public.competition_team_mode_to_category() FROM public, anon, authenticated;

CREATE TRIGGER competitions_team_mode_to_category
  AFTER INSERT OR UPDATE OF kind, leg_order_enabled ON public.competitions
  FOR EACH ROW EXECUTE FUNCTION public.competition_team_mode_to_category();

-- ---------------------------------------------------------------- backfill

UPDATE public.participants p
   SET team_id = r.team_id, team_leg = r.team_leg, updated_at = now()
  FROM public.registrations r
 WHERE r.id = p.registration_id AND r.team_id IS NOT NULL;

UPDATE public.categories c
   SET team_mode = CASE WHEN k.leg_order_enabled THEN 'relay' ELSE 'together' END
  FROM public.competitions k
 WHERE k.category_id = c.id AND k.kind = 'team';

-- ---------------------------------------------------------------- public reads

-- Same columns, same order, same filters as 20261031140000; two appended at the end, which
-- CREATE OR REPLACE allows and which keeps the grants.
CREATE OR REPLACE VIEW public.participants_public AS
 SELECT p.id,
    p.bib_number,
    p.first_name,
    p.last_name,
    p.club,
    p.category_id,
    p.emoji,
    p.gender,
    p.deleted_at,
    p.team_id,
    p.team_leg
   FROM public.participants p
  WHERE p.removed_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.registrations r
       WHERE r.participant_id = p.id AND r.consent_state = 'awaiting'
    );

-- The names of the live, confirmed teams of a published event: exactly what start_list() shows.
-- After the 30-day purge a name is already the neutral „Drużyna 1A2B3C4D”.
CREATE FUNCTION public.results_team_names(p_event_id uuid)
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
$$;
REVOKE EXECUTE ON FUNCTION public.results_team_names(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.results_team_names(uuid) TO anon, authenticated, service_role;
