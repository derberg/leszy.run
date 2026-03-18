-- Replace silence-window lockout_seconds with decline-triggered algorithm
ALTER TABLE events ADD COLUMN decline_threshold_cdbm integer NOT NULL DEFAULT 1000;
ALTER TABLE events DROP COLUMN lockout_seconds;
