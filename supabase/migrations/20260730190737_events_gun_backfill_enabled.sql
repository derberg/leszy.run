-- Companion to local Drizzle migration 0029_gun_backfill_enabled:
-- per-event switch to disable automatic gun-time start backfill. When false the
-- crossing detector neither arms the N-second backfill timer nor assigns gun time
-- to a start-less runner at their finish crossing; such runners stay start-less
-- until an operator triggers manual backfill.
ALTER TABLE events ADD COLUMN IF NOT EXISTS gun_backfill_enabled boolean NOT NULL DEFAULT true;