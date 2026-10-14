-- Checkpoint category links were never pushed to Supabase (sync/checkpointLinks.js now
-- carries them with their checkpoint). Mark every checkpoint that has links dirty, so the
-- push worker sends its link set once. Without this the pull would see the empty remote
-- set for a clean checkpoint and replace the local links with nothing.
-- The 0010 trigger passes this through: synced_at itself changes.
UPDATE checkpoints SET synced_at = NULL
WHERE id IN (SELECT checkpoint_id FROM checkpoint_categories);
