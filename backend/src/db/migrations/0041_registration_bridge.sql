-- Local side of the registration bridge (Supabase migration 20261029100000).
-- events.club_id has no foreign key here: `clubs` exists only in Supabase.
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "club_id" uuid;
--> statement-breakpoint
ALTER TABLE "participants" ADD COLUMN IF NOT EXISTS "registration_id" uuid;
--> statement-breakpoint
ALTER TABLE "participants" ADD COLUMN IF NOT EXISTS "removed_at" timestamp with time zone;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "participants_registration_id_unique"
  ON "participants" ("registration_id") WHERE "registration_id" IS NOT NULL;
