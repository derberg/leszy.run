-- Relay in any order: how long a tag must have been unheard before a read of it can close a
-- team lap (the runner came in from the course). Was a fixed 60 s in the detector, which a
-- 400 m loop beats. Supabase twin: supabase/migrations/20261121130000_lap_arrival_silence.sql.
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "lap_arrival_silence_seconds" integer DEFAULT 15 NOT NULL;
