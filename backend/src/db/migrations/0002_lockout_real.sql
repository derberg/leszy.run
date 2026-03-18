--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "lockout_seconds" TYPE real;
--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "lockout_seconds" SET DEFAULT 0.5;
--> statement-breakpoint
UPDATE "events" SET "lockout_seconds" = 0.5 WHERE "lockout_seconds" = 1;
