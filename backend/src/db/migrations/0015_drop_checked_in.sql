-- Migrate existing checked_in data to checkins table
INSERT INTO checkins (participant_id, event_id, checked_in_at)
SELECT p.id, p.event_id, p.checked_in_at
FROM participants p
WHERE p.checked_in = true AND p.checked_in_at IS NOT NULL
ON CONFLICT (participant_id) DO NOTHING;

-- Drop old columns
ALTER TABLE participants DROP COLUMN checked_in;
ALTER TABLE participants DROP COLUMN checked_in_at;
