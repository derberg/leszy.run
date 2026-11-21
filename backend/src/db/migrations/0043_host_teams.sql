-- Names of relay teams set up on the timing host (no online registration). Mirrors Supabase
-- migration 20261121110000_host_teams.sql. id is the participants.team_id the members share.
-- A registration team's name never lands here: it stays in Supabase's `teams`.
CREATE TABLE IF NOT EXISTS "host_teams" (
  "id" uuid PRIMARY KEY NOT NULL,
  "event_id" uuid NOT NULL REFERENCES "events"("id") ON DELETE CASCADE,
  "name" text NOT NULL CHECK (char_length("name") BETWEEN 1 AND 60 AND "name" = btrim("name")),
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  "synced_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "host_teams_event_id_idx" ON "host_teams" ("event_id");
--> statement-breakpoint
CREATE TRIGGER trg_reset_synced_at_host_teams
  BEFORE UPDATE ON host_teams
  FOR EACH ROW EXECUTE FUNCTION reset_synced_at_on_update();
