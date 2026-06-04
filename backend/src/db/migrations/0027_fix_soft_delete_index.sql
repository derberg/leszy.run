DROP INDEX IF EXISTS participants_deleted_at_idx;
CREATE INDEX participants_active_idx ON participants (id) WHERE deleted_at IS NULL;
