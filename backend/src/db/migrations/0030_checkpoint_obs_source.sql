-- checkpoint_observations.source + RFID-over-manual priority.
--
-- Two writers land observations in this table: the Raspberry-Pi checkpoint-agent
-- (RFID reads) and volunteers tapping bibs in the phone app / admin POST. They
-- share a UNIQUE(checkpoint_id, bib_number), so historically it was
-- first-write-wins. `source` marks the origin, and the BEFORE INSERT trigger
-- makes RFID authoritative: an incoming 'rfid' read upgrades an existing
-- 'manual' row in place (same id, so live views + sync keep tracking one logical
-- observation); every other collision keeps the existing row.

ALTER TABLE "checkpoint_observations"
  ADD COLUMN IF NOT EXISTS "source" text NOT NULL DEFAULT 'manual';
--> statement-breakpoint
ALTER TABLE "checkpoint_observations"
  DROP CONSTRAINT IF EXISTS "checkpoint_observations_source_check";
--> statement-breakpoint
ALTER TABLE "checkpoint_observations"
  ADD CONSTRAINT "checkpoint_observations_source_check"
  CHECK ("source" IN ('rfid', 'manual'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "checkpoint_obs_priority"()
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
    RETURN NEW;  -- no observation for this bib at this checkpoint yet → insert
  END IF;

  -- RFID overrides an earlier volunteer/manual entry, in place.
  IF existing.source = 'manual' AND NEW.source = 'rfid' THEN
    UPDATE checkpoint_observations
       SET observed_at    = NEW.observed_at,
           source         = 'rfid',
           participant_id = COALESCE(NEW.participant_id, participant_id),
           synced_at      = NULL
     WHERE id = existing.id;
  END IF;

  -- rfid already present, manual-over-rfid, or same source → keep the existing
  -- row and drop the incoming insert (no unique-violation raised).
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_checkpoint_obs_priority" ON "checkpoint_observations";
--> statement-breakpoint
CREATE TRIGGER "trg_checkpoint_obs_priority"
  BEFORE INSERT ON "checkpoint_observations"
  FOR EACH ROW
  EXECUTE FUNCTION "checkpoint_obs_priority"();
