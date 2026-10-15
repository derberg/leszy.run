-- Finish is now timed at the peak of the pass, like the start (crossingDetector.js).
-- A weak read can no longer set a time, so the tracking floor drops to -9000,
-- below anything the R700 reports. confirm_rssi_cdbm stays NULL: a runner 5 m
-- before the antennas reads -7000…-7700 (measured 2026-10-15), so any bar near
-- the old floor would drop real passes.
--
-- min_finish_seconds goes from 30 to 300: with no floor, a runner leaving the
-- shared start/finish gate stays audible for longer than 30 s.
--
-- Existing rows are left alone: these are per-event operational settings and
-- past events must keep the values their results were produced with.
ALTER TABLE "events" ALTER COLUMN "rssi_threshold" SET DEFAULT -9000;--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "min_finish_seconds" SET DEFAULT 300;
