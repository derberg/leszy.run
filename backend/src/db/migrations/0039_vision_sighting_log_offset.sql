-- One sighting per line of sightings.jsonl, keyed on the line's byte offset.
-- The old key (session, best frame, time) is not unique: a pass with no
-- number and a read pass can start on the same frame, and the second was
-- dropped. On 2026-10-17 that lost 188's read beside 171's. Rows ingested
-- before this have no offset and are left alone.
ALTER TABLE "vision_sightings" ADD COLUMN IF NOT EXISTS "log_offset" bigint;
--> statement-breakpoint
DROP INDEX IF EXISTS "vision_sightings_unique_track";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "vision_sightings_unique_line"
  ON "vision_sightings" ("session_id", "log_offset");
