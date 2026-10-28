-- LOCAL test stack only (`supabase db reset`). Never applied to production:
-- `supabase db push` does not run seed.sql.
-- Two clubs with an owner, an admin and a member each. Task 1 of the race
-- registration plan adds clubs.registration_enabled and updates this seed so
-- `zatyrani-test` has it on and `inny-klub` does not.

INSERT INTO profiles (id, email, username, display_name) VALUES
  ('00000000-0000-4000-8000-0000000000a1', 'owner@zatyrani-test.local',  'zt-owner',  'ZT Owner'),
  ('00000000-0000-4000-8000-0000000000a2', 'admin@zatyrani-test.local',  'zt-admin',  'ZT Admin'),
  ('00000000-0000-4000-8000-0000000000a3', 'member@zatyrani-test.local', 'zt-member', 'ZT Member'),
  ('00000000-0000-4000-8000-0000000000b1', 'owner@inny-klub.local',      'ik-owner',  'IK Owner'),
  ('00000000-0000-4000-8000-0000000000b2', 'admin@inny-klub.local',      'ik-admin',  'IK Admin'),
  ('00000000-0000-4000-8000-0000000000b3', 'member@inny-klub.local',     'ik-member', 'IK Member');

INSERT INTO clubs (id, name, normalized_name, slug, owner_id, is_public) VALUES
  ('00000000-0000-4000-8000-0000000000c1', 'Zatyrani Test', 'zatyrani test', 'zatyrani-test', '00000000-0000-4000-8000-0000000000a1', true),
  ('00000000-0000-4000-8000-0000000000c2', 'Inny Klub',     'inny klub',     'inny-klub',     '00000000-0000-4000-8000-0000000000b1', true);

INSERT INTO club_members (club_id, user_id, role, status, joined_at) VALUES
  ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000a1', 'owner',  'active', now()),
  ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000a2', 'admin',  'active', now()),
  ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000a3', 'member', 'active', now()),
  ('00000000-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-0000000000b1', 'owner',  'active', now()),
  ('00000000-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-0000000000b2', 'admin',  'active', now()),
  ('00000000-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-0000000000b3', 'member', 'active', now());

UPDATE profiles SET club_id = '00000000-0000-4000-8000-0000000000c1' WHERE email LIKE '%@zatyrani-test.local';
UPDATE profiles SET club_id = '00000000-0000-4000-8000-0000000000c2' WHERE email LIKE '%@inny-klub.local';
