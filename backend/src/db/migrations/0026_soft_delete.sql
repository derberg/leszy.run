ALTER TABLE participants ADD COLUMN deleted_at timestamptz;
CREATE INDEX participants_deleted_at_idx ON participants (deleted_at) WHERE deleted_at IS NULL;
