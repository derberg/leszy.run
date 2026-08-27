-- Lock every scraper_* table down to service_role.
--
-- THE HOLE: Supabase's default privileges on the `public` schema grant new tables to
-- `anon` and `authenticated`. Every scraper_* table therefore carried the full set —
-- SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER — for BOTH roles, and
-- 33 of them had RLS disabled. With RLS off, grants are the only gate, so anyone holding
-- the publishable (anon) key could read, rewrite, or TRUNCATE the raw scraper corpus.
-- That is ~35 tables of pipeline input feeding calendar_events.
--
-- WHY IT'S SAFE TO REVOKE: nothing client-side touches these tables. Verified 2026-08-27
-- that `scraper_` appears nowhere in public/src, frontend/src, or supabase/functions. The
-- only writers are the Fastify backend (backend/src/lib/supabaseClient.js) and the Python
-- enricher (enricher/enricher/config.py), and BOTH authenticate with
-- SUPABASE_SERVICE_ROLE_KEY. service_role has rolbypassrls = true (verified against the
-- live catalog) and keeps its own table grants, so neither RLS nor this REVOKE affects it.
--
-- Belt and braces on purpose:
--   ENABLE RLS  — default-deny for any role that is not BYPASSRLS, so a future stray
--                 GRANT does not silently reopen the table.
--   REVOKE      — removes the privilege outright, which is the actual teeth and makes the
--                 service-role-only intent explicit to the next reader.
--
-- Loop rather than 35 hand-written statements: it cannot miss a table, and it is
-- idempotent, so a replay is a no-op. Covers scraper_all plus scraper_<source> for every
-- source in backend/src/scrapers/sources/.

DO $$
DECLARE
  t regclass;
  n int := 0;
BEGIN
  FOR t IN
    SELECT c.oid::regclass
    FROM pg_class c
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    WHERE ns.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relname LIKE 'scraper\_%'
    ORDER BY c.relname
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON %s FROM anon, authenticated', t);
    n := n + 1;
  END LOOP;

  RAISE NOTICE 'scraper_* lockdown applied to % tables', n;
END $$;

-- scraper_supersport was the lone table that already had RLS, carrying a vestigial
-- "Allow anon read" (SELECT, USING true) from an early prototype. No client reads it, and
-- the REVOKE above already strips anon's SELECT grant, so the policy is dead weight that
-- misrepresents the table's access model. Its sibling "Allow service write" is equally
-- redundant — service_role bypasses RLS. Drop both so all scraper_* tables end in the
-- same state: RLS enabled, zero policies, service_role only.
DROP POLICY IF EXISTS "Allow anon read" ON public.scraper_supersport;
DROP POLICY IF EXISTS "Allow service write" ON public.scraper_supersport;
