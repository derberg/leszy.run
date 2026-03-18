-- Trigger function: resets synced_at to NULL whenever a row is updated
-- with changes to actual data (not just the sync worker marking it as synced).
--
-- How it works:
--   - Sync worker does: UPDATE ... SET synced_at = now()
--     → OLD.synced_at IS DISTINCT FROM NEW.synced_at → trigger passes through unchanged
--   - Any other UPDATE (API, crossing detector, etc.)
--     → synced_at values are equal → trigger sets NEW.synced_at = NULL
--     → sync worker picks up the row on its next cycle

CREATE OR REPLACE FUNCTION reset_synced_at_on_update()
RETURNS trigger AS $$
BEGIN
  IF OLD.synced_at IS DISTINCT FROM NEW.synced_at THEN
    RETURN NEW;
  END IF;
  NEW.synced_at := NULL;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reset_synced_at_events
  BEFORE UPDATE ON events
  FOR EACH ROW EXECUTE FUNCTION reset_synced_at_on_update();

CREATE TRIGGER trg_reset_synced_at_categories
  BEFORE UPDATE ON categories
  FOR EACH ROW EXECUTE FUNCTION reset_synced_at_on_update();

CREATE TRIGGER trg_reset_synced_at_participants
  BEFORE UPDATE ON participants
  FOR EACH ROW EXECUTE FUNCTION reset_synced_at_on_update();

CREATE TRIGGER trg_reset_synced_at_race_runs
  BEFORE UPDATE ON race_runs
  FOR EACH ROW EXECUTE FUNCTION reset_synced_at_on_update();

CREATE TRIGGER trg_reset_synced_at_results
  BEFORE UPDATE ON results
  FOR EACH ROW EXECUTE FUNCTION reset_synced_at_on_update();

CREATE TRIGGER trg_reset_synced_at_checkpoints
  BEFORE UPDATE ON checkpoints
  FOR EACH ROW EXECUTE FUNCTION reset_synced_at_on_update();
