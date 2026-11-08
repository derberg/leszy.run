-- Team timing (relay in any order / relay with a fixed order). Mirrors Supabase migration
-- 20261118100000_team_timing.sql.
ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "team_mode" text;
--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "team_time_limit_seconds" integer;
--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "team_lap_count" integer;
--> statement-breakpoint
ALTER TABLE "categories" DROP CONSTRAINT IF EXISTS "categories_team_mode_check";
--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_team_mode_check" CHECK ("team_mode" IN ('relay', 'relay_free'));
--> statement-breakpoint
ALTER TABLE "participants" ADD COLUMN IF NOT EXISTS "team_id" uuid;
--> statement-breakpoint
ALTER TABLE "participants" ADD COLUMN IF NOT EXISTS "team_leg" integer;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "participants_team_id_idx" ON "participants" ("team_id") WHERE "team_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "team_laps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "race_run_id" uuid NOT NULL REFERENCES "race_runs"("id") ON DELETE CASCADE,
  "team_id" uuid NOT NULL,
  "lap_number" integer NOT NULL,
  "participant_id" uuid NOT NULL REFERENCES "participants"("id") ON DELETE CASCADE,
  "closed_at" timestamp with time zone NOT NULL,
  "lap_ms" bigint NOT NULL,
  "peak_rssi_cdbm" integer,
  "source" text DEFAULT 'chip' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now(),
  "synced_at" timestamp with time zone,
  CONSTRAINT "team_laps_race_run_id_team_id_lap_number_unique" UNIQUE ("race_run_id", "team_id", "lap_number")
);
--> statement-breakpoint
CREATE TRIGGER trg_reset_synced_at_team_laps
  BEFORE UPDATE ON team_laps
  FOR EACH ROW EXECUTE FUNCTION reset_synced_at_on_update();
