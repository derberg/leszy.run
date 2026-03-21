ALTER TABLE checkpoints ALTER COLUMN km_marker TYPE numeric(6,2) USING km_marker::numeric(6,2);
