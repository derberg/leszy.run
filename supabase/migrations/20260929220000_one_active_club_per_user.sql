-- "A user belongs to at most one club" was enforced four times in application
-- code — create-club, accept-invite, request-join, respond-join — and each one
-- reads the membership rows, decides, and writes in a separate statement with
-- no transaction and no lock. Two of those paths running in the same second
-- both see "no active membership" and both succeed.
--
-- The state that produces cannot be repaired by anything in the codebase: the
-- user is active in two clubs, profiles.club_id points at whichever wrote last,
-- so one club's roster shows them while their own profile shows the other, and
-- `leave` only clears club_id when it still points at the club being left.
--
-- Verified before adding: zero users currently hold more than one active
-- membership, so the index applies cleanly.

create unique index if not exists club_members_one_active_per_user
  on public.club_members (user_id)
  where status = 'active';

comment on index public.club_members_one_active_per_user is
  'One active club per user. The four JS guards are check-then-write and race; this is the one that cannot.';
