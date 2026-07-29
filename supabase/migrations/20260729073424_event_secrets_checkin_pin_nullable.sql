-- event_secrets.checkin_pin was NOT NULL, but checkpoint_pin (added later) is an
-- independent secret: POST /api/events/:id/secrets/checkpoint-pin upserts a row
-- with ONLY checkpoint_pin, and for an event that has no check-in PIN yet that
-- INSERT hit the NOT NULL constraint and failed — so the checkpoint-roster
-- function never found a PIN and returned 401. The two PINs don't depend on each
-- other; drop the constraint so either can exist without the other.
ALTER TABLE event_secrets ALTER COLUMN checkin_pin DROP NOT NULL;
