-- RLS Verification Queries for leszy.run Auth & Profiles
--
-- These queries verify that Row Level Security is configured correctly.
-- Run anon-key tests from the Node.js script below, NOT from the SQL editor
-- (the SQL editor runs as postgres/service_role and bypasses RLS).
--
-- For the SQL editor tests below, run each block and verify the comment.

-- ─── SQL EDITOR TESTS (service_role — sanity checks on data) ─────────────────

-- TEST 2: profiles_public view has data accessible to service_role
-- Expected: rows if profiles exist
SELECT username, display_name, club FROM profiles_public LIMIT 5;

-- TEST 3: privacy_settings=false hides display_name in profiles_public
-- Setup: UPDATE profiles SET privacy_settings = '{"display_name": false, "club": true}'
--        WHERE username = 'your_test_user';
-- Then run:
-- SELECT username, display_name FROM profiles_public WHERE username = 'your_test_user';
-- Expected: display_name IS NULL, username has value

-- TEST 4: Anon cannot INSERT to user_badges (should fail with policy violation)
-- Run with anon key client — see Node.js section below.
-- Expected: "new row violates row-level security policy for table \"user_badges\""

-- TEST 5: user_badges is publicly readable
-- Expected: count >= 0 (no error)
SELECT count(*) FROM user_badges;

-- TEST 6: notification_preferences is blocked for anon
-- Run with anon key client — see Node.js section below.
-- Expected: 0 rows returned

-- ─── NODE.JS TESTS (anon key — verifies RLS for real) ────────────────────────
-- Run from project root: node supabase/tests/rls-anon.js
-- (Or paste into browser console on the leszy.run public app)
--
-- import { createClient } from '@supabase/supabase-js'
-- const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
--
-- Test 1: profiles table — anon blocked with FORCE RLS (expect permission error, not empty rows)
-- const { data: t1, error: e1 } = await anon.from('profiles').select('id')
-- console.assert(e1 && e1.message.includes('permission denied'), 'FAIL T1: anon can read profiles')
-- console.log('T1 profiles anon:', e1?.message, '(expect permission denied)')
--
-- Test 2: profiles_public view — anon can read
-- const { data: t2, error: e2 } = await anon.from('profiles_public').select('username')
-- console.assert(!e2, 'FAIL T2: profiles_public error', e2)
-- console.log('T2 profiles_public:', t2?.length, 'rows (expect >= 0, no error)')
--
-- Test 3: privacy masking — display_name null when hidden
-- (Requires a profile with privacy_settings={"display_name":false})
-- const { data: t3 } = await anon.from('profiles_public').select('display_name').limit(1)
-- console.log('T3 privacy masking: see display_name values in profiles_public')
--
-- Test 4: user_badges INSERT blocked for anon
-- const { error: e4 } = await anon.from('user_badges')
--   .insert({ user_id: '00000000-0000-0000-0000-000000000000', badge_id: '00000000-0000-0000-0000-000000000000' })
-- console.assert(e4, 'FAIL T4: anon could insert to user_badges')
-- console.log('T4 user_badges anon insert:', e4?.message ?? 'no error (FAIL)')
--
-- Test 5: user_badges SELECT — anon can read
-- const { data: t5, error: e5 } = await anon.from('user_badges').select('id')
-- console.assert(!e5, 'FAIL T5: user_badges SELECT error', e5)
-- console.log('T5 user_badges anon read:', t5?.length, 'rows (expect >= 0, no error)')
--
-- Test 6: notification_preferences — anon blocked
-- const { data: t6, error: e6 } = await anon.from('notification_preferences').select('id')
-- console.assert(!e6 && t6.length === 0, 'FAIL T6: anon can read notification_preferences', e6)
-- console.log('T6 notification_preferences anon:', t6?.length, '(expect 0)')
--
-- Test 7: calendar_event_reports own-rows read (requires auth)
-- const { data: { session } } = await anonClient.auth.signInWithPassword({ email, password })
-- const authed = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: `Bearer ${session.access_token}` } } })
-- const { data: t7 } = await authed.from('calendar_event_reports').select('id').eq('user_id', session.user.id)
-- console.log('T7 own reports:', t7?.length, '(expect own rows only)')
