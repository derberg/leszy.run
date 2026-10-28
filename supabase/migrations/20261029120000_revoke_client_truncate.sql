-- Client roles never hold TRUNCATE on a public table.
--
-- RLS does not govern TRUNCATE: a role holding the privilege empties the whole
-- table whatever the policies say. Supabase's default privileges granted it to
-- anon and authenticated on every table created in public, so before this
-- migration 30 tables (participants, checkins, results, events, ...) were
-- truncatable by the publishable-key roles. Nothing in the app truncates as
-- anon or authenticated; the backend and the enricher use service_role.
--
-- Only TRUNCATE is revoked. SELECT/INSERT/UPDATE/DELETE stay as they are and
-- RLS keeps deciding them.

REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM anon, authenticated;

-- Tables created later by migrations (run as postgres) must not get it back.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE TRUNCATE ON TABLES FROM anon, authenticated;
