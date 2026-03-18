--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "lockout_seconds" SET DEFAULT 1;
--> statement-breakpoint
UPDATE "events" SET "lockout_seconds" = 1 WHERE "lockout_seconds" = 60;
