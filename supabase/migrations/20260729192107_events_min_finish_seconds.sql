-- Companion to local Drizzle migration 0028_min_finish_seconds:
-- per-event guard window after the gun during which finish reads are ignored.
ALTER TABLE events ADD COLUMN IF NOT EXISTS min_finish_seconds integer NOT NULL DEFAULT 30;
