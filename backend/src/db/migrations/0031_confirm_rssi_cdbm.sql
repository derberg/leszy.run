-- Crossing bar, separate from the tracking floor (rssi_threshold).
--
-- rssi_threshold decides whether a read is followed at all and must stay
-- permissive or weak-but-real tags are never seen. confirm_rssi_cdbm decides
-- whether the tag actually reached the gate: START requires the accumulated peak
-- to clear it, FINISH requires the individual read to clear it.
--
-- NULL = disabled (pre-existing single-threshold behaviour), so this migration
-- changes no event's behaviour on its own.
ALTER TABLE events ADD COLUMN IF NOT EXISTS confirm_rssi_cdbm integer;
