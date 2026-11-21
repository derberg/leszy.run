-- Relay baton mode: a team carries one tag (the baton) and a read of it at the gate closes a
-- lap, instead of the runner's own tag. A baton lap may have no runner yet, and a read the
-- detector is unsure of is stored as a 'candidate' for review.
--
-- Local twin: backend/src/db/migrations/0045_relay_baton.sql. Ship this BEFORE any host runs the
-- code that pushes team_batons or the new team_laps columns, or every push of them is refused
-- (the push retries next cycle).

CREATE TABLE public.team_batons (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  team_id     uuid NOT NULL,
  epc         text,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now(),
  synced_at   timestamptz,
  UNIQUE (event_id, team_id)
);
CREATE UNIQUE INDEX team_batons_event_epc_key ON public.team_batons (event_id, epc) WHERE epc IS NOT NULL;
ALTER TABLE public.team_batons ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.team_batons FROM anon, authenticated;

ALTER TABLE public.categories
  ADD COLUMN team_lap_source text NOT NULL DEFAULT 'runner' CHECK (team_lap_source IN ('runner', 'baton'));

ALTER TABLE public.team_laps ALTER COLUMN participant_id DROP NOT NULL;
ALTER TABLE public.team_laps
  ADD COLUMN status text NOT NULL DEFAULT 'counted' CHECK (status IN ('counted', 'candidate')),
  ADD COLUMN reviewed_at timestamptz;
ALTER TABLE public.team_laps DROP CONSTRAINT team_laps_source_check;
ALTER TABLE public.team_laps ADD CONSTRAINT team_laps_source_check CHECK (source IN ('chip', 'manual', 'baton'));
