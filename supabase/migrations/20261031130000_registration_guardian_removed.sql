-- Plan 4, task 6 (D4-25): the organizer's „kontakt opiekuna usunięty” needs a durable signal.
--
--   registrations.guardian_removed_at  when the guardian of this (child's) entry deleted their
--                                      LESZY.RUN account (delete-my-account step 1c)
--
-- The guardian fields themselves cannot carry it. delete-my-account nulls guardian_profile_id
-- and guardian_email and writes „Usunięte konto” into guardian_name, but the 30-day contact
-- purge (purge_registration_contact_data, D4-30) nulls guardian_name and guardian_email of
-- every past entry too. Read from those fields, a purged child's row and a row whose guardian
-- left would look the same. The timestamp names nobody, so the purge leaves it alone.
ALTER TABLE public.registrations ADD COLUMN guardian_removed_at timestamptz;

COMMENT ON COLUMN public.registrations.guardian_removed_at IS
  'Set by delete-my-account when the guardian of this entry deleted their account (D4-25). Never derived from null guardian fields: the 30-day purge nulls those too.';
