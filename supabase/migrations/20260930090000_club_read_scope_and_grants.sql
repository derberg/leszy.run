-- Two holes that RLS was supposed to cover and did not.
--
-- 1. The SELECT policy on `clubs` was `qual = true`, so the "Publiczna strona
--    klubu widoczna dla wszystkich" switch suppressed the generated page and
--    nothing else: anyone holding the publishable key could still read every
--    club's name, description, city, voivodeship, slug, owner_id and
--    pending_owner_id straight from PostgREST. The switch promised privacy the
--    data never had.
--
--    search_clubs (the only anon read path the product uses — the club picker)
--    is SECURITY DEFINER and therefore unaffected; every other read goes
--    through an edge function on the service role. Member rows stay invisible
--    either way: club_members has RLS on with no policy at all.
--
-- 2. anon and authenticated hold DELETE, INSERT, REFERENCES, SELECT, TRIGGER,
--    TRUNCATE and UPDATE on the club tables. RLS denies the DML, but TRUNCATE
--    is not an RLS-governed operation, so the protection rests entirely on
--    nobody ever adding a permissive policy. CLAUDE.md already mandates this
--    lockdown for the scraper_* tables; the club tables were never given it.

drop policy if exists "Public read clubs" on public.clubs;

create policy "Public read public clubs"
  on public.clubs
  for select
  to public
  using (is_public = true);

revoke all on public.clubs from anon, authenticated;
revoke all on public.club_members from anon, authenticated;
revoke all on public.club_invites from anon, authenticated;
revoke all on public.club_membership_log from anon, authenticated;
revoke all on public.club_slug_history from anon, authenticated;
revoke all on public.event_notifications from anon, authenticated;
revoke all on public.event_favorites from anon, authenticated;

-- The policy above needs SELECT to mean anything, and the picker's
-- SECURITY DEFINER function needs nothing at all.
grant select on public.clubs to anon, authenticated;
