-- Account deletion currently leaves three doors open. This migration closes the
-- two that need schema.
--
-- 1. "Email is NOT released after deletion" is a promise the product makes in
--    the delete dialog and in CLAUDE.md, and it was never true. It rested on
--    supabase.auth.admin.updateUserById(..., { ban_duration }), but this app
--    does not use Supabase auth users at all: auth-verify-code mints a profile
--    row with crypto.randomUUID() and profiles.id has no FK to auth.users. The
--    ban therefore targeted a row that does not exist, failed, and was
--    swallowed as non-fatal. Deleting the account nulls profiles.email, so the
--    next login for that address simply created a brand-new account.
--
--    The retirement list stores a SHA-256 of the normalised address, never the
--    address: it only ever has to answer "has this one been retired", and
--    keeping the plaintext of an erased account would defeat the erasure.
--
-- 2. profiles_public served soft-deleted rows. deleted_at was set, but the view
--    never filtered on it, so an erased profile stayed readable (bio, avatar,
--    the "usuniety-xxxxxxxx" username) to anyone with the publishable key.

create table if not exists public.deleted_email_hashes (
  email_hash text primary key,
  deleted_at timestamptz not null default now()
);

comment on table public.deleted_email_hashes is
  'SHA-256 of the normalised email of every deleted account. Blocks re-registration; holds no plaintext address.';

alter table public.deleted_email_hashes enable row level security;
revoke all on public.deleted_email_hashes from anon, authenticated;

-- Same lockdown for the auth tables. RLS is on and no policy exists, so DML is
-- already denied — but TRUNCATE is not an RLS-governed operation, and the
-- default grants on `public` hand it to anon. Same rule CLAUDE.md already
-- mandates for the scraper_* tables.
revoke all on public.auth_codes from anon, authenticated;
revoke all on public.auth_sessions from anon, authenticated;
revoke all on public.otp_throttle from anon, authenticated;

create or replace view public.profiles_public as
  select p.id,
    p.username,
    case when (p.privacy_settings ->> 'display_name')::boolean then p.display_name else null::text end as display_name,
    case when (p.privacy_settings ->> 'club')::boolean then c.name else null::text end as club,
    case when (p.privacy_settings ->> 'bio')::boolean then p.bio else null::text end as bio,
    p.avatar_url,
    p.created_at
  from profiles p
    left join clubs c on c.id = p.club_id
  where p.deleted_at is null;
