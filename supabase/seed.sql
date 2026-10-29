-- LOCAL test stack only (`supabase db reset`). Never applied to production:
-- `supabase db push` does not run seed.sql.
-- Two clubs with an owner, an admin and a member each. `zatyrani-test` has
-- online registration enabled, `inny-klub` does not.

INSERT INTO profiles (id, email, username, display_name) VALUES
  ('00000000-0000-4000-8000-0000000000a1', 'owner@zatyrani-test.local',  'zt-owner',  'ZT Owner'),
  ('00000000-0000-4000-8000-0000000000a2', 'admin@zatyrani-test.local',  'zt-admin',  'ZT Admin'),
  ('00000000-0000-4000-8000-0000000000a3', 'member@zatyrani-test.local', 'zt-member', 'ZT Member'),
  ('00000000-0000-4000-8000-0000000000b1', 'owner@inny-klub.local',      'ik-owner',  'IK Owner'),
  ('00000000-0000-4000-8000-0000000000b2', 'admin@inny-klub.local',      'ik-admin',  'IK Admin'),
  ('00000000-0000-4000-8000-0000000000b3', 'member@inny-klub.local',     'ik-member', 'IK Member');

INSERT INTO clubs (id, name, normalized_name, slug, owner_id, is_public, registration_enabled) VALUES
  ('00000000-0000-4000-8000-0000000000c1', 'Zatyrani Test', 'zatyrani test', 'zatyrani-test', '00000000-0000-4000-8000-0000000000a1', true, true),
  ('00000000-0000-4000-8000-0000000000c2', 'Inny Klub',     'inny klub',     'inny-klub',     '00000000-0000-4000-8000-0000000000b1', true, false);

INSERT INTO club_members (club_id, user_id, role, status, joined_at) VALUES
  ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000a1', 'owner',  'active', now()),
  ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000a2', 'admin',  'active', now()),
  ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000a3', 'member', 'active', now()),
  ('00000000-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-0000000000b1', 'owner',  'active', now()),
  ('00000000-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-0000000000b2', 'admin',  'active', now()),
  ('00000000-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-0000000000b3', 'member', 'active', now());

UPDATE profiles SET club_id = '00000000-0000-4000-8000-0000000000c1' WHERE email LIKE '%@zatyrani-test.local';
UPDATE profiles SET club_id = '00000000-0000-4000-8000-0000000000c2' WHERE email LIKE '%@inny-klub.local';

-- Plan 3, task 7: the registration-jobs cron call (pg_net) reads its URL and secret from Vault.
-- Locally the function runs under `supabase functions serve`, reached from the database
-- container through the host; the secret equals REGISTRATION_JOBS_SECRET in
-- tests/registration/functions.env. Production sets both once (docs/supabase-release-runbook.md).
SELECT vault.create_secret('http://host.docker.internal:54321/functions/v1/registration-jobs', 'registration_jobs_url');
SELECT vault.create_secret('local-registration-jobs-secret', 'registration_jobs_secret');
-- P3-R18: the registration-watchdog cron call, the same way; the secret equals
-- REGISTRATION_WATCHDOG_SECRET in tests/registration/functions.env.
SELECT vault.create_secret('http://host.docker.internal:54321/functions/v1/registration-watchdog', 'registration_watchdog_url');
SELECT vault.create_secret('local-registration-watchdog-secret', 'registration_watchdog_secret');
-- The registration-* cron jobs stay defined but never fire on a local or CI stack: a test owns
-- the moment orders expire and the job runs (it calls expire_orders(), registration-jobs and
-- registration-watchdog itself). The seed never runs in production, where they stay active.
SELECT cron.alter_job(jobid, active := false) FROM cron.job WHERE jobname LIKE 'registration-%';
