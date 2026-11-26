-- "PÓŹNIEJ" in the admin review queue: a pending event the operator cannot judge yet
-- (a race a year away with no sign-up, no regulamin, no price) leaves the queue without
-- being rejected. A rejected row is never touched again, so the race would stay out
-- forever; a snoozed row stays pending and the pipeline keeps filling it.
--
-- run-publish clears snoozed_at when it fills a field the row lacked, which puts the
-- event back in the queue (backend/src/lib/calendarSnooze.js). The table is service-role
-- only (20261117100000), so the column needs no grant.

ALTER TABLE public.calendar_events ADD COLUMN IF NOT EXISTS snoozed_at timestamptz;

COMMENT ON COLUMN public.calendar_events.snoozed_at IS
  'Set by the admin''s PÓŹNIEJ: hidden from the review queue until run-publish fills an empty field.';
