-- A person's verdict on a finisher the camera did not read: the bib was
-- visible (and where in which frame), covered, not worn on the front, or the
-- runner is not in the photographs. The visible ones become training labels;
-- the rest are misses the camera could never have read. Device-local like the
-- other vision tables, and deleted with its session by the retention purge.
CREATE TABLE IF NOT EXISTS "vision_reviews" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL REFERENCES "vision_sessions"("id") ON DELETE CASCADE,
  "participant_id" uuid NOT NULL REFERENCES "participants"("id") ON DELETE CASCADE,
  "verdict" text NOT NULL CHECK ("verdict" IN ('visible', 'covered', 'no_front', 'absent')),
  "bib_number" text,
  "frame_ts" bigint,
  "x" double precision,
  "y" double precision,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  UNIQUE ("session_id", "participant_id")
);
