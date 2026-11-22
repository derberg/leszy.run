-- Relay baton mode: a team carries one tag (the baton) and a read of it at the gate closes a
-- lap, instead of the runner's own tag. A baton lap may have no runner yet, and a read the
-- detector is unsure of is stored as a 'candidate' for review.
-- Supabase twin: supabase/migrations/20261121150000_relay_baton.sql. The Supabase file ships
-- BEFORE any host runs the code that pushes team_batons or the new team_laps columns.
-- id is the team id (like host_teams): every host writes the same row for a team, so two hosts
-- setting one team's baton never push two rows that refuse each other.
CREATE TABLE IF NOT EXISTS "team_batons" (
  "id" uuid PRIMARY KEY NOT NULL,
  "event_id" uuid NOT NULL REFERENCES "events"("id") ON DELETE CASCADE,
  "team_id" uuid NOT NULL,
  "epc" text,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  "synced_at" timestamp with time zone,
  CONSTRAINT "team_batons_id_is_team_id" CHECK ("id" = "team_id"),
  -- One tag is one team's baton, checked at commit so a swap pulled in one transaction applies
  -- (configSync). NULLs are distinct: any number of teams may have no baton.
  CONSTRAINT "team_batons_event_epc_key" UNIQUE ("event_id", "epc") DEFERRABLE INITIALLY DEFERRED
);
--> statement-breakpoint
CREATE TRIGGER trg_reset_synced_at_team_batons
  BEFORE UPDATE ON team_batons
  FOR EACH ROW EXECUTE FUNCTION reset_synced_at_on_update();
--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "team_lap_source" text DEFAULT 'runner' NOT NULL
  CHECK ("team_lap_source" IN ('runner', 'baton'));
--> statement-breakpoint
ALTER TABLE "team_laps" ALTER COLUMN "participant_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "team_laps" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'counted' NOT NULL
  CHECK ("status" IN ('counted', 'candidate'));
--> statement-breakpoint
ALTER TABLE "team_laps" ADD COLUMN IF NOT EXISTS "reviewed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "team_laps" DROP CONSTRAINT IF EXISTS "team_laps_source_check";
--> statement-breakpoint
ALTER TABLE "team_laps" ADD CONSTRAINT "team_laps_source_check" CHECK ("source" IN ('chip', 'manual', 'baton'));
