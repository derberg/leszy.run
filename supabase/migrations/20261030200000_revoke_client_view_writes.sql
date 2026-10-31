-- Client roles only read through a view.
--
-- A simple view over one table is automatically updatable, and it runs as its
-- owner. Every view in public is owned by postgres, which bypasses RLS, so a
-- write through one skips the policies of the table underneath. Supabase's
-- default privileges gave anon and authenticated INSERT, UPDATE, DELETE,
-- REFERENCES and TRIGGER on all four views. On a local stack built from main,
-- `UPDATE participants_public SET club = 'x'` as anon changed the participants
-- row. Nothing in the app writes through a view.
--
-- SELECT is kept: the public pages read these views with the publishable key.
-- TRUNCATE went in 20261029120000 and is listed here so that a view that
-- reached production some other way is covered too. The loop, rather than four
-- names, covers such a view as well; it skips anything postgres does not own,
-- because a REVOKE there would fail and take the release down with it.
DO $$
DECLARE
  v regclass;
BEGIN
  FOR v IN
    SELECT c.oid::regclass
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('v', 'm')
       AND c.relowner = 'postgres'::regrole
  LOOP
    EXECUTE format(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON %s FROM anon, authenticated',
      v
    );
  END LOOP;
END
$$;

-- Views created later by migrations (run as postgres) must not get them back.
-- Default privileges have one class for tables and views, so this also applies
-- to new tables: a table that clients really must write needs an explicit GRANT.
-- That is already the rule (`REVOKE ALL`, then GRANT only what is needed), and
-- tables that exist today keep the privileges they have.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE INSERT, UPDATE, DELETE, REFERENCES, TRIGGER ON TABLES FROM anon, authenticated;
