-- supabase/rls-policies.sql
-- Run once in Supabase SQL editor for project <your-supabase-project-id>
-- These policies allow the volunteer app and liveresults app (anon key) to read/write as needed.

-- Enable RLS on new tables (existing tables should already have RLS enabled)
ALTER TABLE checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE checkpoint_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE checkpoint_observations ENABLE ROW LEVEL SECURITY;

-- Checkpoints: anon can read
CREATE POLICY "anon read checkpoints"
  ON checkpoints FOR SELECT TO anon USING (true);

-- Checkpoint categories: anon can read
CREATE POLICY "anon read checkpoint_categories"
  ON checkpoint_categories FOR SELECT TO anon USING (true);

-- Checkpoint observations: anon can read + insert (dedup via unique constraint)
CREATE POLICY "anon read observations"
  ON checkpoint_observations FOR SELECT TO anon USING (true);
CREATE POLICY "anon insert observations"
  ON checkpoint_observations FOR INSERT TO anon WITH CHECK (true);

-- Events: anon can read (needed by volunteer app to show event name)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='events' AND policyname='anon read events'
  ) THEN
    CREATE POLICY "anon read events" ON events FOR SELECT TO anon USING (true);
  END IF;
END $$;

-- Categories: anon can read
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='categories' AND policyname='anon read categories'
  ) THEN
    CREATE POLICY "anon read categories" ON categories FOR SELECT TO anon USING (true);
  END IF;
END $$;

-- Participants: anon reads via participants_public view (no PII columns).
-- Direct table access removed — check-in pages use PIN-gated RPCs.
-- View (owned by postgres, security_invoker=false → bypasses RLS):
CREATE OR REPLACE VIEW participants_public AS
SELECT id, bib_number, first_name, last_name, club, category_id, emoji, gender
FROM participants;
GRANT SELECT ON participants_public TO anon;
GRANT SELECT ON participants_public TO authenticated;
-- RPCs for check-in (SECURITY DEFINER, see migrations):
--   get_participant_for_checkin(p_participant_id) — self-service (UUID from SMS = auth)
--   get_participant_admin(p_event_id, p_pin, p_participant_id) — admin, PIN-gated
--   search_participants_admin(p_event_id, p_pin, p_query) — admin search, PIN-gated

-- Results: anon can read
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='results' AND policyname='anon read results'
  ) THEN
    CREATE POLICY "anon read results" ON results FOR SELECT TO anon USING (true);
  END IF;
END $$;

-- Gate crossings: anon can read
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='gate_crossings' AND policyname='anon read gate_crossings'
  ) THEN
    CREATE POLICY "anon read gate_crossings" ON gate_crossings FOR SELECT TO anon USING (true);
  END IF;
END $$;

-- Race runs: anon can read
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='race_runs' AND policyname='anon read race_runs'
  ) THEN
    CREATE POLICY "anon read race_runs" ON race_runs FOR SELECT TO anon USING (true);
  END IF;
END $$;

-- Enable Realtime for tables that need it (postgres_changes subscriptions)
ALTER TABLE participants REPLICA IDENTITY FULL;
ALTER TABLE checkpoint_observations REPLICA IDENTITY FULL;
ALTER TABLE results REPLICA IDENTITY FULL;
ALTER TABLE race_runs REPLICA IDENTITY FULL;
