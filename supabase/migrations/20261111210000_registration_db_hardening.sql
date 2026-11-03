-- Database hardening from the 2026-11 security review. Privileges and bucket settings only: no
-- table, row or stored object is created, changed or deleted.
--
-- 1. Logo buckets accept PNG and JPEG uploads only.
--    `partner-logos` (20261109200000_event_partners_unified.sql) and `club-logos`
--    (20260717062635_teams_clubs_phase_a.sql) were created with no allowed_mime_types, so the
--    bucket itself accepted any type, an SVG or an HTML file included, served from a public URL.
--    Every writer stores a PNG it re-encoded: upload-partner-logo, upload-club-logo and the admin
--    backend (backend/src/routes/eventPartners.js) all upload with contentType 'image/png'. JPEG is
--    allowed too, as the request for this change asked. allowed_mime_types gates new uploads only:
--    the SVG logos already stored stay (user decision 2026-11-02) and nothing is deleted.
--
-- 2. find_or_create_club(text) and similar_club_pairs(real) lose EXECUTE for PUBLIC, anon and
--    authenticated, explicitly. The remote-schema dump revoked PUBLIC and granted service_role
--    only, but on a fresh stack Supabase's default privileges for `postgres` in `public` grant
--    every new function to anon and authenticated, so whether a client could call them depended
--    on the order things were created in. Only the service role calls them (the admin backend).
--
-- 3. A function created later is never callable by a client unless a migration grants it.
--    Two defaults handed EXECUTE out: PostgreSQL's built-in default (PUBLIC, of which anon and
--    authenticated are members) and Supabase's per-schema grant to anon and authenticated.
--    A per-schema `REVOKE … FROM PUBLIC` cannot remove a built-in, global default (the
--    ALTER DEFAULT PRIVILEGES docs: per-schema defaults only add to the global ones), so the
--    PUBLIC revoke is global for role postgres and the anon/authenticated revoke is per-schema.
--    service_role keeps its per-schema grant, so the edge functions are unaffected.
--    Existing functions keep the ACL they have: default privileges apply to new objects only.
--    From now on a new RPC meant for the public app (like start_list, registration_public or
--    checkin_confirm) needs an explicit `GRANT EXECUTE ON FUNCTION … TO anon, authenticated` in
--    the migration that creates it, or the call fails with "permission denied for function".
--    A recreated function (CREATE OR REPLACE) keeps its existing grants. Trigger functions are
--    unaffected: firing a trigger checks no EXECUTE privilege. The global revoke also covers a
--    function an extension created by `postgres` adds later (CREATE EXTENSION / ALTER EXTENSION
--    UPDATE run as postgres): grant what a client needs from such an extension explicitly.
--
-- 4. anon and authenticated lose INSERT, UPDATE and DELETE on tables where nothing writes with a
--    client key. Checked on 2026-11-02 across public/src, public/api, frontend/src,
--    checkpoint-agent/src, backend/src, backend/scripts and scripts:
--    * the backend and its scripts use SUPABASE_SERVICE_ROLE_KEY for every write (sync push,
--      checkin, event secrets, admin audit, geocode cache, url suggestions);
--    * the public app and the admin frontend write none of these tables with the publishable key;
--      every client write goes through an edge function on the service role (self-checkin,
--      checkpoint-write, log-consent, …) or a SECURITY DEFINER RPC (checkin_confirm,
--      check_checkin_pin, verify_checkin_pin, get_participant_admin, search_participants_admin,
--      all SECURITY DEFINER since 20261030020000_anon_lockdown.sql), which run as their owner and
--      do not need the caller to hold a table privilege;
--    * the checkpoint agent reads events and checkpoints with the anon key and writes through the
--      checkpoint-write edge function (edgeWriter.js); its Uploader is handed that writer.
--    No INSERT/UPDATE/DELETE/ALL policy for anon or authenticated survives on these tables except
--    "consent_log: insert own" (authenticated, WITH CHECK auth.uid() = user_id). This app issues no
--    Supabase Auth JWTs (custom cookie sessions, no auth.users rows), so auth.uid() is never a
--    profile id for a client and the policy admits nothing; consent_log is written only by the
--    log-consent edge function on the service role. It is revoked here like the rest; the dead
--    policy is left in place.
--    SELECT is untouched: the public pages still read what RLS lets them.

-- ---------------------------------------------------------------- 1. logo buckets

UPDATE storage.buckets
   SET allowed_mime_types = ARRAY['image/png', 'image/jpeg']
 WHERE id IN ('partner-logos', 'club-logos');

-- ---------------------------------------------------------------- 2. club helper functions

REVOKE EXECUTE ON FUNCTION public.find_or_create_club(text), public.similar_club_pairs(real)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.find_or_create_club(text), public.similar_club_pairs(real)
  TO service_role;

-- ---------------------------------------------------------------- 3. default function privileges

ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------- 4. unused client write privileges

REVOKE INSERT, UPDATE, DELETE ON
  public.admin_actions,
  public.event_secrets,
  public.participants,
  public.events,
  public.results,
  public.race_runs,
  public.categories,
  public.checkpoints,
  public.consent_log,
  public.user_badges,
  public.geocode_cache,
  public.url_suggestions,
  public.notification_preferences,
  public.event_documents,
  public.gate_crossings,
  public.checkpoint_categories,
  public.checkins,
  public.checkin_documents,
  public.checkpoint_observations
FROM anon, authenticated;
