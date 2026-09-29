-- The login code's only brute-force defence was a read-then-write.
--
-- auth-verify-code SELECTed auth_codes.attempts, compared it to 3, and UPDATEd
-- attempts + 1 in a separate statement — and, unlike auth-request-code, it
-- called no throttle at all. Every request whose SELECT lands before the first
-- UPDATE commits reads the same value and passes the check, so one issued code
-- was worth roughly as many guesses as an attacker could put in flight, not 3.
-- Against a 6-digit space that is the difference between years and hours.
--
-- _shared/throttle.js had the same shape while its own doc comment claimed to
-- be atomic: SELECT, then INSERT-or-UPDATE, with the INSERT's error discarded.
-- A burst of first requests all read "no row", all insert, all collide on the
-- primary key, all return allowed, and the counter stays at 1 — so the 5-mails-
-- per-email cap could be turned into 50 mails at someone else's address.
--
-- Both are now one statement each: the write IS the check.

create or replace function public.claim_auth_code_attempt(p_code_id uuid, p_max integer)
returns text
language sql
security definer
set search_path = public
as $$
  update auth_codes
     set attempts = attempts + 1
   where id = p_code_id
     and used = false
     and expires_at > now()
     and attempts < p_max
  returning code_hash;
$$;

comment on function public.claim_auth_code_attempt(uuid, integer) is
  'Consumes one verification attempt and returns the hash to compare against. NULL means the code is used, expired, or out of attempts.';

create or replace function public.claim_throttle_slot(p_key text, p_limit integer, p_window_seconds integer)
returns table (allowed boolean, retry_after_sec integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempts integer;
  v_window_started timestamptz;
  v_cutoff timestamptz := now() - make_interval(secs => p_window_seconds);
begin
  insert into otp_throttle (key, attempts, window_started_at)
  values (p_key, 1, now())
  on conflict (key) do update
     set attempts = case when otp_throttle.window_started_at < v_cutoff then 1 else otp_throttle.attempts + 1 end,
         window_started_at = case when otp_throttle.window_started_at < v_cutoff then now() else otp_throttle.window_started_at end
  returning otp_throttle.attempts, otp_throttle.window_started_at
       into v_attempts, v_window_started;

  if v_attempts > p_limit then
    return query select false,
      greatest(1, ceil(extract(epoch from (v_window_started + make_interval(secs => p_window_seconds) - now())))::integer);
  else
    return query select true, 0;
  end if;
end;
$$;

comment on function public.claim_throttle_slot(text, integer, integer) is
  'Atomic rate-limit slot: one statement both counts the attempt and decides. A blocked key keeps counting, which is deliberate.';

-- Supabase grants EXECUTE on a new function to anon/authenticated by default.
-- These two write auth tables as SECURITY DEFINER, so only the service role —
-- i.e. the edge functions — may call them.
revoke all on function public.claim_auth_code_attempt(uuid, integer) from public, anon, authenticated;
revoke all on function public.claim_throttle_slot(text, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_auth_code_attempt(uuid, integer) to service_role;
grant execute on function public.claim_throttle_slot(text, integer, integer) to service_role;
