-- Camera audit: capture sessions and the sightings read out of them.
--
-- These tables are DEVICE-LOCAL, like gate_crossings. They are deliberately
-- NOT in configSync.js's table list and they get NO trg_reset_synced_at_*
-- trigger, because that trigger exists only to re-dirty rows for the push to
-- Supabase and nothing here is ever pushed. Camera evidence staying on the
-- machine that captured it is the whole data protection position.
--
-- race_run_id is nullable on purpose. The operator needs to see what the
-- camera is reading before a race is started, the same way gate_events are
-- recorded outside a run.

CREATE TABLE IF NOT EXISTS "vision_sessions" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "event_id"     uuid NOT NULL REFERENCES "events"("id") ON DELETE CASCADE,
  "race_run_id"  uuid REFERENCES "race_runs"("id") ON DELETE SET NULL,
  "label"        text,
  "queue_dir"    text NOT NULL,
  "clock_offset" double precision,
  -- Byte offset into sightings.jsonl already ingested. The log is append-only,
  -- so resuming from here after a backend restart loses nothing and repeats
  -- nothing.
  "log_cursor"   bigint NOT NULL DEFAULT 0,
  "health"       jsonb,
  "started_at"   timestamptz NOT NULL DEFAULT now(),
  "stopped_at"   timestamptz,
  "created_at"   timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vision_sightings" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "session_id"     uuid NOT NULL REFERENCES "vision_sessions"("id") ON DELETE CASCADE,
  -- Nullable on purpose. A row saying somebody crossed at 14:52:31 and could
  -- not be read is the most useful row in the table when a runner is missing,
  -- because it says where in the footage to look.
  "bib_number"     text,
  -- Filled when the number matches this event's roster. A recognised number
  -- that matches nobody is almost certainly a misread, and that is the only
  -- quality signal available without ground truth.
  "participant_id" uuid REFERENCES "participants"("id") ON DELETE SET NULL,
  "confidence"     double precision NOT NULL DEFAULT 0,
  "frame_count"    integer NOT NULL DEFAULT 0,
  "sighted_at"     timestamptz NOT NULL,
  "best_frame_ts"  bigint,
  "crop_name"      text,
  "votes"          jsonb,
  "created_at"     timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vision_sightings_session_idx"
  ON "vision_sightings" ("session_id", "sighted_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vision_sessions_event_idx"
  ON "vision_sessions" ("event_id", "started_at" DESC);
--> statement-breakpoint
-- One sighting per track. The reader emits a closed track exactly once, but a
-- re-ingest after a cursor reset must not duplicate rows on the screen.
CREATE UNIQUE INDEX IF NOT EXISTS "vision_sightings_unique_track"
  ON "vision_sightings" ("session_id", "best_frame_ts", "sighted_at");
