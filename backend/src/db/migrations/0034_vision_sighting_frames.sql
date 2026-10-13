-- Every frame a pass was seen in, as sensor timestamps, so the audit screen
-- can step through the whole pass. Device-local like the rest of the table.
ALTER TABLE "vision_sightings" ADD COLUMN IF NOT EXISTS "frame_ts" jsonb;
