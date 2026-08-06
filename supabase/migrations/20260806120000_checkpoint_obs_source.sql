-- checkpoint_observations.source + RFID-over-manual priority (Supabase mirror of
-- local Drizzle migration 0030). Must stay in sync with
-- backend/src/db/migrations/0030_checkpoint_obs_source.sql.
--
-- The Raspberry-Pi checkpoint-agent (RFID) and the volunteer phone app both
-- INSERT here directly (anon role). They share UNIQUE(checkpoint_id, bib_number).
-- `source` records the origin; the BEFORE INSERT trigger makes RFID authoritative:
-- an 'rfid' read upgrades an existing 'manual' row in place (same id → the
-- realtime UPDATE mirrors to local PostgreSQL and public live views); any other
-- collision keeps the existing row and silently drops the incoming insert.
--
-- SECURITY DEFINER: the in-place UPDATE must bypass RLS (there is no "anon update
-- observations" policy — only insert/select), so the function runs as owner.

ALTER TABLE "public"."checkpoint_observations"
  ADD COLUMN IF NOT EXISTS "source" text NOT NULL DEFAULT 'manual';

ALTER TABLE "public"."checkpoint_observations"
  DROP CONSTRAINT IF EXISTS "checkpoint_observations_source_check";

ALTER TABLE "public"."checkpoint_observations"
  ADD CONSTRAINT "checkpoint_observations_source_check"
  CHECK ("source" IN ('rfid', 'manual'));

CREATE OR REPLACE FUNCTION "public"."checkpoint_obs_priority"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  existing checkpoint_observations%ROWTYPE;
BEGIN
  SELECT * INTO existing
    FROM checkpoint_observations
   WHERE checkpoint_id = NEW.checkpoint_id
     AND bib_number = NEW.bib_number
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF existing.source = 'manual' AND NEW.source = 'rfid' THEN
    UPDATE checkpoint_observations
       SET observed_at    = NEW.observed_at,
           source         = 'rfid',
           participant_id = COALESCE(NEW.participant_id, participant_id),
           synced_at      = NULL
     WHERE id = existing.id;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS "trg_checkpoint_obs_priority" ON "public"."checkpoint_observations";

CREATE TRIGGER "trg_checkpoint_obs_priority"
  BEFORE INSERT ON "public"."checkpoint_observations"
  FOR EACH ROW
  EXECUTE FUNCTION "public"."checkpoint_obs_priority"();
