-- Team timing (relay / team run). Mirrors Supabase migration 20261114100000_team_timing.sql.
ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "team_mode" text;
--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "team_count_members" integer;
--> statement-breakpoint
ALTER TABLE "categories" DROP CONSTRAINT IF EXISTS "categories_team_mode_check";
--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_team_mode_check" CHECK ("team_mode" IN ('relay', 'together'));
--> statement-breakpoint
ALTER TABLE "participants" ADD COLUMN IF NOT EXISTS "team_id" uuid;
--> statement-breakpoint
ALTER TABLE "participants" ADD COLUMN IF NOT EXISTS "team_leg" integer;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "participants_team_id_idx" ON "participants" ("team_id") WHERE "team_id" IS NOT NULL;
