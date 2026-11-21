-- Relay in any order: how long a tag must have been unheard before a read of it can close a
-- team lap (the runner came in from the course, not standing in the changeover zone). It was a
-- fixed 60 s in the detector, which a fast runner on a 400 m loop beats, so the lap was lost.
-- Hosts push and pull `events` whole, so this column must exist here before a host runs the
-- code that sends it. Local twin: backend/src/db/migrations/0044_lap_arrival_silence.sql.
ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS lap_arrival_silence_seconds integer NOT NULL DEFAULT 15
  CHECK (lap_arrival_silence_seconds BETWEEN 1 AND 600);
