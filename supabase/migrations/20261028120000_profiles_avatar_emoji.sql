-- Every account gets an animal emoji as its avatar, drawn once when the
-- profile row is created, the same way the backend gives a race participant
-- one (backend/src/lib/emoji.js). The profile pages used to show the first
-- letter of the username. There is no way to change it yet: it is assigned,
-- not chosen.
--
-- The draw is the column DEFAULT, so every path that inserts a profile
-- (auth-verify-code, the test suite) gets one without knowing about it.
-- The pool is a copy of POOL in backend/src/lib/emoji.js; keep them in step.

create or replace function public.random_avatar_emoji()
returns text
language sql
volatile
set search_path = ''
as $$
  select pool[1 + floor(random() * array_length(pool, 1))::int]
  from (select array[
    '🐶','🐕','🐕‍🦺','🐩','🐱','🐈','🐈‍⬛','🐭','🐹','🐰','🐇',
    '🐿️','🦫','🦔','🦇','🐻','🐻‍❄️','🐼','🐨','🦘','🦡','🐁',
    '🦊','🦝','🐯','🦁','🐅','🐆','🦓','🦍','🦧','🐒',
    '🙈','🙉','🙊','🐵','🐺','🦥',
    '🐘','🦏','🦛','🦒','🦌','🫎','🐮','🐂','🐃','🐄',
    '🦬','🦣','🐪','🐫',
    '🐑','🐏','🐐','🐎','🐴','🫏','🦙','🐗',
    '🦮',
    '🐔','🐓','🐣','🐤','🐥','🐦','🐦‍⬛','🦃','🦆','🦢',
    '🦩','🦚','🦜','🦅','🦉','🦤','🪿','🕊️','🐧',
    '🐳','🐋','🐬','🦭','🦦','🦈',
    '🐟','🐠','🐡','🦐','🦞','🦀','🦑','🐙','🪼','🐚',
    '🐢','🐊','🦎','🐍','🐸',
    '🐲','🐉','🦕','🦖','🦄','🐦‍🔥',
    '👻','👽','🧚','🧛','🧜','🧝','🧞','🧟','🧙',
    '🦸','🦹','🥷',
    '🐌','🦋','🐛','🐝','🐞','🪲','🦂',
    '🐾'
  ] as pool) s
$$;

-- Postgres grants EXECUTE to PUBLIC and Supabase to anon and authenticated by
-- default. Only the column default calls it, as the inserting role, which is
-- the service role in every edge function.
revoke execute on function public.random_avatar_emoji() from public, anon, authenticated;
grant execute on function public.random_avatar_emoji() to service_role;

alter table public.profiles
  add column if not exists avatar_emoji text default public.random_avatar_emoji();

-- Accounts created before this migration. The function is volatile, so each
-- row draws its own.
update public.profiles
  set avatar_emoji = public.random_avatar_emoji()
  where avatar_emoji is null;

-- /u/<username> reads profiles_public. Same definition as
-- 20260929190000_account_deletion_hardening.sql, plus avatar_emoji at the end
-- (create or replace view can only append columns).
create or replace view public.profiles_public as
  select p.id,
    p.username,
    case when (p.privacy_settings ->> 'display_name')::boolean then p.display_name else null::text end as display_name,
    case when (p.privacy_settings ->> 'club')::boolean then c.name else null::text end as club,
    case when (p.privacy_settings ->> 'bio')::boolean then p.bio else null::text end as bio,
    p.avatar_url,
    p.created_at,
    p.avatar_emoji
  from profiles p
    left join clubs c on c.id = p.club_id
  where p.deleted_at is null;
