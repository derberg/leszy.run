-- Plan 4 final review I-1: an added adult whose consent is still awaiting is not public.
--
-- register_free, create_order (0 zł) and confirm_order create the participants row for every
-- person of a group, the added adult awaiting consent included: the timing host pulls it through
-- configSync, and the office override („Podpisany w biurze”) may let them run. start_list() hides
-- that person by name until accepted or office (T7-F2), because they have not seen the data
-- information yet. participants_public (granted to anon) and the /api/results snapshot that
-- reads it would have published the same person by first name, last name, club and gender.
--
-- Same columns, same order, same removed_at filter as 20261029100000_registration_foundation.sql;
-- CREATE OR REPLACE keeps the existing grants (anon, authenticated, service_role SELECT from
-- 20260717053838_remote_schema.sql). The view runs as its owner, so anon never needs a grant
-- on registrations. Only 'awaiting' is hidden: 'accepted' and 'office' are public, and a
-- participant with no registration (every pre-registration event) is unaffected.
CREATE OR REPLACE VIEW public.participants_public AS
 SELECT p.id,
    p.bib_number,
    p.first_name,
    p.last_name,
    p.club,
    p.category_id,
    p.emoji,
    p.gender,
    p.deleted_at
   FROM public.participants p
  WHERE p.removed_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.registrations r
       WHERE r.participant_id = p.id AND r.consent_state = 'awaiting'
    );
