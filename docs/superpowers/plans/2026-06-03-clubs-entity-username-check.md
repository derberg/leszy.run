# Clubs Entity + Live Username Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make clubs a first-class entity (`clubs` table + `profiles.club_id`) with fuzzy autocomplete, find-or-create dedup, and admin merge; add live username availability feedback to onboarding.

**Architecture:** One Supabase migration creates the `clubs` table, normalization function, and 5 RPCs. Edge functions keep returning `club` as a string (joined from `clubs.name`) so display code is untouched. The public app gets a `ClubInput` combobox and a debounced username check via anon-key RPCs. The backend gets two admin routes that call atomic SQL functions; the admin frontend gets a "Kluby" page.

**Tech Stack:** Supabase (Postgres + pg_trgm, Deno edge functions), supabase-js, React (Vite), Fastify, Playwright e2e, node:test for edge functions.

**Spec:** `docs/superpowers/specs/2026-06-03-clubs-entity-username-check-design.md`

**Supabase project ref:** `kojoxazlnxncrpxmnxiq` (visible in `public/tests/e2e/helpers.js`)

**Key facts for the implementer:**
- `profiles`, `clubs`, `profiles_public` are **Supabase-only** — NO Drizzle schema, NO local migration. Apply DDL via `mcp__supabase__apply_migration` ONLY.
- Edge function tests are **integration tests against the deployed Supabase project** (`public/package.json` → `test:functions` runs `node --test ../supabase/functions/tests/*.test.js`). You must deploy a function before its tests can pass. Env vars `VITE_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` come from the root `.env` — run with `node --env-file=../.env --test …` from `public/`.
- Deploy edge functions with `npx supabase functions deploy <name> --project-ref kojoxazlnxncrpxmnxiq` (run from repo root; `_shared/` is bundled automatically).
- e2e: `cd public && npx playwright test tests/e2e/<file>` (needs `npx vite --port 3002` NOT running — playwright config starts its own server; check `public/playwright.config.js` `webServer` block before assuming).
- `CategorySection.jsx` also mentions `club` — that is **race participants' club (local Postgres)**, completely unrelated. Do not touch.
- The view is named **`profiles_public`** (not `public_profiles` as the older spec wrote).
- This branch is pre-launch: dropping `profiles.club` loses no real data.

---

### Task 1: Supabase migration — clubs table, normalization, RPCs

**Files:**
- No repo files. Applied via `mcp__supabase__apply_migration` (name: `clubs_entity_and_username_rpc`).

- [ ] **Step 1: Check current `profiles_public` view definition and `profiles.club` dependents**

Run via `mcp__supabase__execute_sql`:

```sql
SELECT pg_get_viewdef('profiles_public'::regclass, true);
```

Compare with the CREATE VIEW below — if the deployed view has drifted (extra columns), carry those columns over into Step 2's recreation. Also confirm nothing else depends on the column:

```sql
SELECT dependent_ns.nspname, dependent_view.relname
FROM pg_depend
JOIN pg_rewrite ON pg_depend.objid = pg_rewrite.oid
JOIN pg_class AS dependent_view ON pg_rewrite.ev_class = dependent_view.oid
JOIN pg_class AS source_table ON pg_depend.refobjid = source_table.oid
JOIN pg_attribute ON pg_depend.refobjid = pg_attribute.attrelid AND pg_depend.refobjsubid = pg_attribute.attnum
JOIN pg_namespace dependent_ns ON dependent_view.relnamespace = dependent_ns.oid
WHERE source_table.relname = 'profiles' AND pg_attribute.attname = 'club';
```

Expected: only `profiles_public`. If anything else appears, STOP and report.

- [ ] **Step 2: Apply the migration**

Via `mcp__supabase__apply_migration`, name `clubs_entity_and_username_rpc`:

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Single source of truth for club-name normalization:
-- lowercase → Polish diacritics stripped → punctuation removed → whitespace collapsed.
CREATE OR REPLACE FUNCTION normalize_club_name(input TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT trim(regexp_replace(
    regexp_replace(
      translate(lower(coalesce(input, '')),
        'ąćęłńóśźż',
        'acelnoszz'),
      '[^a-z0-9 ]', '', 'g'),
    ' +', ' ', 'g'))
$$;

CREATE TABLE clubs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX clubs_normalized_trgm_idx ON clubs USING gin (normalized_name gin_trgm_ops);

ALTER TABLE clubs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read clubs" ON clubs FOR SELECT USING (true);

ALTER TABLE profiles ADD COLUMN club_id UUID REFERENCES clubs(id) ON DELETE SET NULL;
CREATE INDEX profiles_club_id_idx ON profiles(club_id);

-- profiles_public depends on profiles.club → drop, drop column, recreate with join
DROP VIEW profiles_public;
ALTER TABLE profiles DROP COLUMN club;

CREATE VIEW profiles_public AS
SELECT
  p.id,
  p.username,
  CASE WHEN (p.privacy_settings->>'display_name')::boolean THEN p.display_name ELSE NULL END AS display_name,
  CASE WHEN (p.privacy_settings->>'club')::boolean         THEN c.name         ELSE NULL END AS club,
  CASE WHEN (p.privacy_settings->>'bio')::boolean          THEN p.bio          ELSE NULL END AS bio,
  p.avatar_url,
  p.created_at
FROM profiles p
LEFT JOIN clubs c ON c.id = p.club_id;

-- ===== RPCs =====

-- Public: fuzzy club autocomplete (top 8 by similarity, with member counts)
CREATE OR REPLACE FUNCTION search_clubs(q TEXT)
RETURNS TABLE (id UUID, name TEXT, member_count BIGINT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.id, c.name, count(p.id)::bigint AS member_count
  FROM clubs c
  LEFT JOIN profiles p ON p.club_id = c.id
  WHERE normalize_club_name(q) <> ''
    AND (
      c.normalized_name LIKE '%' || normalize_club_name(q) || '%'
      OR word_similarity(normalize_club_name(q), c.normalized_name) > 0.3
    )
  GROUP BY c.id, c.name
  ORDER BY GREATEST(
    word_similarity(normalize_club_name(q), c.normalized_name),
    similarity(c.normalized_name, normalize_club_name(q))
  ) DESC
  LIMIT 8
$$;

-- Public: live username availability (advisory; update-profile 409 stays authoritative)
CREATE OR REPLACE FUNCTION is_username_available(u TEXT)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT u ~ '^[a-z0-9_]{3,30}$'
     AND NOT EXISTS (SELECT 1 FROM profiles WHERE username = u)
$$;

-- Service-role only: atomic find-or-create, race-safe via ON CONFLICT.
-- First writer's display form wins; the no-op DO UPDATE makes RETURNING work on conflict.
CREATE OR REPLACE FUNCTION find_or_create_club(club_name TEXT)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  norm TEXT;
  cid UUID;
BEGIN
  norm := normalize_club_name(club_name);
  IF norm = '' THEN
    RETURN NULL;
  END IF;
  INSERT INTO clubs (name, normalized_name)
  VALUES (trim(club_name), norm)
  ON CONFLICT (normalized_name) DO UPDATE SET name = clubs.name
  RETURNING id INTO cid;
  RETURN cid;
END $$;

-- Service-role only: atomic merge. Repoints members, deletes source clubs.
CREATE OR REPLACE FUNCTION merge_clubs(target UUID, sources UUID[])
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  moved INTEGER;
BEGIN
  IF target = ANY(sources) THEN
    RAISE EXCEPTION 'target cannot be in sources';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM clubs WHERE id = target) THEN
    RAISE EXCEPTION 'target club not found';
  END IF;
  IF (SELECT count(*) FROM clubs WHERE id = ANY(sources)) <> coalesce(array_length(sources, 1), 0)
     OR coalesce(array_length(sources, 1), 0) = 0 THEN
    RAISE EXCEPTION 'unknown or empty source club ids';
  END IF;
  UPDATE profiles SET club_id = target WHERE club_id = ANY(sources);
  GET DIAGNOSTICS moved = ROW_COUNT;
  DELETE FROM clubs WHERE id = ANY(sources);
  RETURN moved;
END $$;

-- Service-role only: duplicate suggestions for the admin Kluby page
CREATE OR REPLACE FUNCTION similar_club_pairs(threshold REAL DEFAULT 0.45)
RETURNS TABLE (a_id UUID, a_name TEXT, b_id UUID, b_name TEXT, sim REAL)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT a.id, a.name, b.id, b.name,
         similarity(a.normalized_name, b.normalized_name) AS sim
  FROM clubs a
  JOIN clubs b ON a.id < b.id
  WHERE similarity(a.normalized_name, b.normalized_name) >= threshold
  ORDER BY sim DESC
$$;

-- ===== Grants =====
REVOKE ALL ON FUNCTION search_clubs(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION is_username_available(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION find_or_create_club(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION merge_clubs(UUID, UUID[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION similar_club_pairs(REAL) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION search_clubs(TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION is_username_available(TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION find_or_create_club(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION merge_clubs(UUID, UUID[]) TO service_role;
GRANT EXECUTE ON FUNCTION similar_club_pairs(REAL) TO service_role;
GRANT SELECT ON clubs TO anon, authenticated, service_role;
```

- [ ] **Step 3: Verify with throwaway data** (read-write test, then clean up)

Via `mcp__supabase__execute_sql`:

```sql
-- Normalization
SELECT normalize_club_name('  K.B.  Kraków!! ') AS a,   -- expect 'kb krakow'
       normalize_club_name('ĄĆĘŁŃÓŚŹŻ') AS b,            -- expect 'acelnoszz'
       normalize_club_name('---') AS c;                  -- expect ''
```

```sql
-- find-or-create dedup + search
SELECT find_or_create_club('Klub Biegacza Kraków') AS id1;
SELECT find_or_create_club('klub biegacza krakow') AS id2;  -- expect SAME id as id1
SELECT count(*) FROM clubs WHERE normalized_name = 'klub biegacza krakow';  -- expect 1
SELECT name, member_count FROM search_clubs('biegacza');   -- expect 1 row 'Klub Biegacza Kraków'
SELECT name FROM search_clubs('krakw');                    -- typo still matches
SELECT is_username_available('zzz_free_name_zzz');         -- expect true
SELECT is_username_available('AB');                        -- expect false (format)
```

```sql
-- cleanup
DELETE FROM clubs WHERE normalized_name = 'klub biegacza krakow';
```

Expected: all assertions hold. NOTE: warn the user per DB-write safety rules before Step 2/3 mutations — this migration drops `profiles.club` (pre-launch, no real data) and the verify step inserts+deletes one throwaway club row.

- [ ] **Step 4: Commit a copy of the migration for the repo record**

Save the exact SQL from Step 2 to `supabase/migrations-applied/2026-06-03-clubs-entity-and-username-rpc.sql` **only if** that directory already exists; otherwise skip (Supabase-only DDL is tracked by `mcp__supabase__list_migrations`). Then:

```bash
git add -A && git commit -m "feat(db): clubs entity, normalization + username availability RPCs"
```

(If nothing to commit because no repo file was created, skip the commit.)

---

### Task 2: `update-profile` + `badge-check` — club find-or-create

**Files:**
- Modify: `supabase/functions/update-profile/index.js`
- Modify: `supabase/functions/_shared/badge-check.js:34,42`
- Test: `supabase/functions/tests/update-profile.test.js`

- [ ] **Step 1: Update the tests to the new contract (failing first)**

Replace `supabase/functions/tests/update-profile.test.js` with:

```js
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestSession, cleanupUser, callFunction, supabaseAdmin } from './helpers.js'

async function cleanupClub(name) {
  const { data } = await supabaseAdmin.rpc('normalize_club_name', { input: name })
  // service role can delete directly; normalize via SQL to find the row
  await supabaseAdmin.from('clubs').delete().eq('normalized_name', data)
}

describe('update-profile edge function', () => {
  let user, sessionToken
  const TS = Date.now() // single timestamp — both names MUST normalize identically
  const CLUB_A = `Klub Testowy Płock ${TS}`
  const CLUB_A_VARIANT = `klub testowy plock ${TS}` // same after normalization

  before(async () => {
    ;({ user, sessionToken } = await createTestSession('profile'))
  })

  after(async () => {
    await cleanupUser(user.id)
    await cleanupClub(CLUB_A)
  })

  it('rejects request without session cookie', async () => {
    const { status } = await callFunction('update-profile', { username: 'testuser' })
    assert.equal(status, 401)
  })

  it('sets username + free-text club on first update (onboarding)', async () => {
    const { status, data } = await callFunction(
      'update-profile',
      { username: 'testuser_plan', display_name: 'Test User', club: CLUB_A },
      sessionToken
    )
    assert.equal(status, 200)
    assert.equal(data.data.username, 'testuser_plan')
    assert.equal(data.data.club, CLUB_A.trim())   // name string still returned
    assert.ok(data.data.club_id)                   // FK now set
  })

  it('same club typed differently resolves to the SAME club_id', async () => {
    const { user: u2, sessionToken: t2 } = await createTestSession('profile_dup')
    try {
      const { data: first } = await callFunction('update-profile', { club: CLUB_A }, sessionToken)
      const { data: second } = await callFunction('update-profile', { club: CLUB_A_VARIANT }, t2)
      assert.equal(second.data.club_id, first.data.club_id)
      assert.equal(second.data.club, CLUB_A.trim()) // first writer's display form wins
    } finally {
      await cleanupUser(u2.id)
      await cleanupClub(CLUB_A_VARIANT)
    }
  })

  it('accepts club_id directly when it exists', async () => {
    const { data: prof } = await callFunction('update-profile', { club: CLUB_A }, sessionToken)
    const { status, data } = await callFunction('update-profile', { club_id: prof.data.club_id }, sessionToken)
    assert.equal(status, 200)
    assert.equal(data.data.club_id, prof.data.club_id)
  })

  it('rejects unknown club_id with 400', async () => {
    const { status } = await callFunction(
      'update-profile',
      { club_id: '00000000-0000-0000-0000-000000000000' },
      sessionToken
    )
    assert.equal(status, 400)
  })

  it('rejects club that normalizes to empty with 400', async () => {
    const { status } = await callFunction('update-profile', { club: '---' }, sessionToken)
    assert.equal(status, 400)
  })

  it('clears club with empty string', async () => {
    const { status, data } = await callFunction('update-profile', { club: '' }, sessionToken)
    assert.equal(status, 200)
    assert.equal(data.data.club_id, null)
    assert.equal(data.data.club, null)
  })

  it('returns 409 if username is already taken', async () => {
    const { user: user2, sessionToken: token2 } = await createTestSession('profile2')
    try {
      const { status, data } = await callFunction('update-profile', { username: 'testuser_plan' }, token2)
      assert.equal(status, 409)
      assert.match(data.error, /already taken/i)
    } finally {
      await cleanupUser(user2.id)
    }
  })

  it('returns 400 for invalid username format', async () => {
    const { status } = await callFunction('update-profile', { username: 'Bad Username!' }, sessionToken)
    assert.equal(status, 400)
  })

  it('updates an existing profile', async () => {
    const { status, data } = await callFunction('update-profile', { display_name: 'Updated Name' }, sessionToken)
    assert.equal(status, 200)
    assert.equal(data.data.display_name, 'Updated Name')
  })

  it('privacy_settings change is reflected in profiles_public view', async () => {
    await callFunction('update-profile', { club: CLUB_A }, sessionToken) // re-set club
    await callFunction('update-profile', { privacy_settings: { display_name: true, club: false, bio: true } }, sessionToken)

    const { data: rows } = await supabaseAdmin
      .from('profiles_public')
      .select('club, username')
      .eq('username', 'testuser_plan')
      .single()

    assert.equal(rows.club, null)
    assert.equal(rows.username, 'testuser_plan')
  })

  it('awards club badge when club is set', async () => {
    const { data: badges } = await supabaseAdmin
      .from('user_badges')
      .select('badge_id, badge_definitions(slug)')
      .eq('user_id', user.id)

    const slugs = badges.map(b => b.badge_definitions.slug)
    assert.ok(slugs.includes('club'), `Expected club badge, got: ${slugs}`)
  })
})
```

Note: `cleanupClub` calls `normalize_club_name` via RPC — it is granted to `service_role` implicitly through PUBLIC default? No: we only granted specific roles. `normalize_club_name` kept default grants (PUBLIC execute) since it leaks nothing — it stays callable. If the RPC call fails, fall back to deleting with `.ilike('name', name)`.

- [ ] **Step 2: Run to verify the new tests fail**

```bash
cd public && node --env-file=../.env --test ../supabase/functions/tests/update-profile.test.js
```

Expected: FAIL — deployed function still writes to dropped `profiles.club` column (500s) / missing `club_id` assertions.

- [ ] **Step 3: Update `_shared/badge-check.js`**

Line 34: `supabaseAdmin.from('profiles').select('club').eq('id', userId).single(),` →

```js
    supabaseAdmin.from('profiles').select('club_id').eq('id', userId).single(),
```

Line 42: `const hasClub = Boolean(profile?.club)` →

```js
  const hasClub = Boolean(profile?.club_id)
```

- [ ] **Step 4: Rewrite `update-profile/index.js` club handling**

Replace the body of the `try` block (lines 27–70) with:

```js
    const body = await req.json()
    const { username, display_name, club, club_id, avatar_url, bio, privacy_settings } = body

    if (username !== undefined) {
      if (!/^[a-z0-9_]{3,30}$/.test(username)) {
        return json({ error: 'Username must be 3–30 chars: lowercase letters, numbers, underscores only' }, 400, req)
      }
      const { data: taken } = await supabaseAdmin
        .from('profiles')
        .select('id')
        .eq('username', username)
        .neq('id', session.userId)
        .single()
      if (taken) return json({ error: 'Username already taken' }, 409, req)
    }

    const { data: existingProfile } = await supabaseAdmin
      .from('profiles')
      .select('id, club_id')
      .eq('id', session.userId)
      .single()

    const updates = {}
    if (username !== undefined)          updates.username = username
    if (display_name !== undefined)      updates.display_name = display_name
    if (avatar_url !== undefined)        updates.avatar_url = avatar_url
    if (bio !== undefined)               updates.bio = bio
    if (privacy_settings !== undefined)  updates.privacy_settings = privacy_settings

    // Club: either a picked club_id (validate it exists) or free text (find-or-create).
    if (club_id !== undefined && club_id !== null && club_id !== '') {
      const { data: clubRow } = await supabaseAdmin
        .from('clubs').select('id').eq('id', club_id).single()
      if (!clubRow) return json({ error: 'Unknown club_id' }, 400, req)
      updates.club_id = club_id
    } else if (club !== undefined) {
      if (club === null || club.trim() === '') {
        updates.club_id = null
      } else {
        if (club.length > 100) return json({ error: 'Club name too long (max 100 chars)' }, 400, req)
        const { data: newClubId, error: clubErr } = await supabaseAdmin
          .rpc('find_or_create_club', { club_name: club })
        if (clubErr) throw clubErr
        if (!newClubId) return json({ error: 'Invalid club name' }, 400, req)
        updates.club_id = newClubId
      }
    }

    const { data: profile, error } = await supabaseAdmin
      .from('profiles')
      .update(updates)
      .eq('id', session.userId)
      .select('*, clubs(name)')
      .single()
    if (error) throw error

    const clubJustSet = updates.club_id && !existingProfile?.club_id
    if (clubJustSet) {
      await checkAndAwardBadges(supabaseAdmin, session.userId)
    }

    // API contract: keep returning club as a string
    const out = { ...profile, club: profile.clubs?.name ?? null }
    delete out.clubs

    return json({ data: out }, 200, req)
```

- [ ] **Step 5: Deploy and run tests**

```bash
npx supabase functions deploy update-profile --project-ref kojoxazlnxncrpxmnxiq
cd public && node --env-file=../.env --test ../supabase/functions/tests/update-profile.test.js
```

Expected: PASS (all tests).

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/update-profile/index.js supabase/functions/_shared/badge-check.js supabase/functions/tests/update-profile.test.js
git commit -m "feat(profile): club find-or-create via clubs entity in update-profile"
```

---

### Task 3: `auth-me` + `get-profile-data` — join club name

**Files:**
- Modify: `supabase/functions/auth-me/index.js:26-34`
- Modify: `supabase/functions/get-profile-data/index.js:32-36,55`

- [ ] **Step 1: Update `auth-me/index.js`** — replace lines 26–34 with:

```js
  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('id, email, username, display_name, club_id, clubs(name)')
    .eq('id', session.userId)
    .single()

  if (!profile) return json({ error: 'Profile not found' }, 404, req)

  const user = { ...profile, club: profile.clubs?.name ?? null }
  delete user.clubs

  return json({ user }, 200, req)
```

- [ ] **Step 2: Update `get-profile-data/index.js`** — replace the profile select (lines 32–36) with:

```js
    supabaseAdmin
      .from('profiles')
      .select('id, email, username, display_name, club_id, clubs(name), privacy_settings, created_at')
      .eq('id', session.userId)
      .single(),
```

and replace the final response line (line 55) with:

```js
  const profileOut = profile
    ? (() => { const p = { ...profile, club: profile.clubs?.name ?? null }; delete p.clubs; return p })()
    : profile

  return json({ profile: profileOut, badges: badges ?? [], reports: reports ?? [], submissions: submissions ?? [] }, 200, req)
```

- [ ] **Step 3: Deploy and run the full function test suite**

```bash
npx supabase functions deploy auth-me --project-ref kojoxazlnxncrpxmnxiq
npx supabase functions deploy get-profile-data --project-ref kojoxazlnxncrpxmnxiq
cd public && node --env-file=../.env --test ../supabase/functions/tests/*.test.js
```

Expected: PASS. (`admin-review-contribution` tests may 403 unless the admin UUID secret is set — same behavior as before this change; only compare against a pre-existing baseline run if unsure.)

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/auth-me/index.js supabase/functions/get-profile-data/index.js
git commit -m "feat(profile): auth-me and get-profile-data resolve club name from clubs entity"
```

---

### Task 4: Onboarding — live username availability + Polish 409

**Files:**
- Modify: `public/src/pages/Onboarding.jsx`
- Test: `public/tests/e2e/onboarding.spec.js`

- [ ] **Step 1: Add failing e2e tests** — append inside the `test.describe('Onboarding', …)` block in `public/tests/e2e/onboarding.spec.js`:

```js
  test('live check shows "zajęta" for a taken username', async ({ page, context }) => {
    const takenName = `taken_${Date.now()}`.slice(0, 28).toLowerCase()
    const other = await createTestUser('taken-owner')
    await supabaseAdmin.from('profiles').update({ username: takenName }).eq('id', other.user.id)
    try {
      await testUser.injectSession(context)
      await page.goto('/onboarding')
      await page.getByLabel(/nazwa użytkownika/i).fill(takenName)
      await expect(page.getByText(/zajęta/i)).toBeVisible({ timeout: 5000 })
    } finally {
      await cleanupUser(other.user.id)
    }
  })

  test('live check shows "dostępna" for a free username', async ({ page, context }) => {
    await testUser.injectSession(context)
    await page.goto('/onboarding')
    await page.getByLabel(/nazwa użytkownika/i).fill(`free_${Date.now()}`.slice(0, 28).toLowerCase())
    await expect(page.getByText(/dostępna/i)).toBeVisible({ timeout: 5000 })
  })
```

- [ ] **Step 2: Run them to verify they fail**

```bash
cd public && npx playwright test tests/e2e/onboarding.spec.js
```

Expected: the two new tests FAIL (no live indicator yet), the four old ones PASS.

- [ ] **Step 3: Implement in `Onboarding.jsx`**

Add imports and state (after line 6 `import { callFunction } …` and inside `OnboardingForm`):

```js
import { supabase } from '../lib/supabase.js'
import { useRef } from 'react'   // merge into the existing react import
```

```js
  const [usernameStatus, setUsernameStatus] = useState('idle') // idle | checking | available | taken
  const usernameRef = useRef(username)
  usernameRef.current = username

  useEffect(() => {
    if (!/^[a-z0-9_]{3,30}$/.test(username)) {
      setUsernameStatus('idle')
      return
    }
    setUsernameStatus('checking')
    const checked = username
    const t = setTimeout(async () => {
      const { data, error } = await supabase.rpc('is_username_available', { u: checked })
      if (usernameRef.current !== checked) return // stale response — input changed meanwhile
      if (error) { setUsernameStatus('idle'); return }
      setUsernameStatus(data ? 'available' : 'taken')
    }, 400)
    return () => clearTimeout(t)
  }, [username])
```

Replace the hint line (line 78 `<p className="font-sans text-xs …">3–30 znaków…</p>`) with:

```jsx
              <div className="flex items-center justify-between mt-1">
                <p className="font-sans text-xs text-apex-muted">3–30 znaków: litery, cyfry, podkreślenie</p>
                {usernameStatus === 'checking' && (
                  <span className="font-mono text-xs text-apex-muted animate-pulse">sprawdzam…</span>
                )}
                {usernameStatus === 'available' && (
                  <span className="font-mono text-xs text-apex-yellow">✓ dostępna</span>
                )}
                {usernameStatus === 'taken' && (
                  <span className="font-mono text-xs text-apex-red">✗ zajęta</span>
                )}
              </div>
```

Map the 409 to Polish in `handleSubmit`'s catch (line 40–41):

```js
    } catch (err) {
      setError(/already taken/i.test(err.message) ? 'Ta nazwa jest już zajęta.' : err.message)
    } finally {
```

- [ ] **Step 4: Run the e2e file again**

```bash
cd public && npx playwright test tests/e2e/onboarding.spec.js
```

Expected: PASS (all 6).

- [ ] **Step 5: Commit**

```bash
git add public/src/pages/Onboarding.jsx public/tests/e2e/onboarding.spec.js
git commit -m "feat(onboarding): live username availability check with Polish feedback"
```

---

### Task 5: `ClubInput` component + Onboarding integration

**Files:**
- Create: `public/src/components/ClubInput.jsx`
- Modify: `public/src/pages/Onboarding.jsx`
- Test: `public/tests/e2e/onboarding.spec.js`

- [ ] **Step 1: Add failing e2e test** — append to the Onboarding describe block:

```js
  test('club autocomplete suggests an existing club and pins it', async ({ page, context }) => {
    const clubName = `KB Testowo ${Date.now()}`
    const { data: clubId } = await supabaseAdmin.rpc('find_or_create_club', { club_name: clubName })
    try {
      await testUser.injectSession(context)
      await page.goto('/onboarding')
      await page.getByLabel(/klub/i).fill('kb testowo')
      await expect(page.getByRole('option', { name: new RegExp(clubName) })).toBeVisible({ timeout: 5000 })
      await page.getByRole('option', { name: new RegExp(clubName) }).click()
      const username = `clb_${Date.now()}`.slice(0, 28).toLowerCase()
      await page.getByLabel(/nazwa użytkownika/i).fill(username)
      await page.getByRole('button', { name: /zapisz/i }).click()
      await page.waitForURL('/profil')
      const { data: prof } = await supabaseAdmin.from('profiles').select('club_id').eq('id', testUser.user.id).single()
      expect(prof.club_id).toBe(clubId)
    } finally {
      await supabaseAdmin.from('profiles').update({ club_id: null }).eq('id', testUser.user.id)
      await supabaseAdmin.from('clubs').delete().eq('id', clubId)
    }
  })
```

Run: `cd public && npx playwright test tests/e2e/onboarding.spec.js` → new test FAILS (no dropdown).

- [ ] **Step 2: Create `public/src/components/ClubInput.jsx`**

```jsx
import { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase.js'

/**
 * Club combobox: free text + fuzzy suggestions from the clubs table.
 * value: { name: string, clubId: string|null } — clubId is pinned when the
 * user picks a suggestion and cleared the moment they type again.
 */
export default function ClubInput({ value, onChange, inputClass, inputId = 'club', testId, placeholder = 'Klub Biegacza Kraków' }) {
  const [suggestions, setSuggestions] = useState([])
  const [open, setOpen] = useState(false)
  const queryRef = useRef(value.name)
  queryRef.current = value.name

  useEffect(() => {
    if (value.clubId || value.name.trim().length < 3) {
      setSuggestions([])
      setOpen(false)
      return
    }
    const q = value.name
    const t = setTimeout(async () => {
      const { data, error } = await supabase.rpc('search_clubs', { q })
      if (queryRef.current !== q) return // stale
      if (error || !data) return
      setSuggestions(data)
      setOpen(data.length > 0)
    }, 400)
    return () => clearTimeout(t)
  }, [value.name, value.clubId])

  return (
    <div className="relative">
      <input
        id={inputId}
        data-testid={testId}
        type="text"
        value={value.name}
        onChange={e => onChange({ name: e.target.value, clubId: null })}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onFocus={() => { if (suggestions.length > 0 && !value.clubId) setOpen(true) }}
        placeholder={placeholder}
        maxLength={100}
        className={inputClass}
        role="combobox"
        aria-expanded={open}
        autoComplete="off"
      />
      {open && (
        <ul role="listbox" className="absolute z-20 left-0 right-0 mt-1 bg-apex-surface border border-apex-border max-h-56 overflow-auto">
          {suggestions.map(s => (
            <li key={s.id}>
              <button
                type="button"
                role="option"
                aria-selected="false"
                onMouseDown={e => e.preventDefault()}
                onClick={() => { onChange({ name: s.name, clubId: s.id }); setOpen(false) }}
                className="w-full text-left px-3.5 py-2 font-sans text-sm text-apex-text hover:bg-apex-bg hover:text-apex-yellow transition-colors"
              >
                {s.name}
                <span className="font-mono text-[10px] text-apex-muted ml-2">
                  {s.member_count} {s.member_count === 1 ? 'członek' : 'członków'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {value.clubId && (
        <span className="absolute right-2.5 top-1/2 -translate-y-1/2 font-mono text-xs text-apex-yellow pointer-events-none">✓</span>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Wire into `Onboarding.jsx`**

Replace `const [club, setClub] = useState('')` with:

```js
  const [club, setClub] = useState({ name: '', clubId: null })
```

Replace the club submit spread (`...(club ? { club } : {})`) with:

```js
        ...(club.clubId ? { club_id: club.clubId } : club.name.trim() ? { club: club.name } : {}),
```

Replace the club `<input …/>` block (the one with `id="club"`) with:

```jsx
              <ClubInput value={club} onChange={setClub} inputClass={inputClass} />
```

and add `import ClubInput from '../components/ClubInput.jsx'` at the top. Keep the existing `<label htmlFor="club">` — `ClubInput` renders `id="club"` by default so the label still binds (and `getByLabel(/klub/i)` works in the test).

- [ ] **Step 4: Run e2e**

```bash
cd public && npx playwright test tests/e2e/onboarding.spec.js
```

Expected: PASS (all 7).

- [ ] **Step 5: Commit**

```bash
git add public/src/components/ClubInput.jsx public/src/pages/Onboarding.jsx public/tests/e2e/onboarding.spec.js
git commit -m "feat(onboarding): club autocomplete with fuzzy matching against clubs entity"
```

---

### Task 6: Profil page — club editing through `ClubInput`

**Files:**
- Modify: `public/src/pages/Profil.jsx:168-171` (club `EditableField` → club-aware editor)
- Test: `public/tests/e2e/profile.spec.js`

- [ ] **Step 1: Add failing e2e test** — append to the main describe in `public/tests/e2e/profile.spec.js` (reuse its existing `testUser` + `injectSession` setup; follow the file's local conventions):

```js
  test('editing club pins an existing club via autocomplete', async ({ page, context }) => {
    const clubName = `KS Profilowo ${Date.now()}`
    const { data: clubId } = await supabaseAdmin.rpc('find_or_create_club', { club_name: clubName })
    try {
      await testUser.injectSession(context)
      await page.goto('/profil')
      await page.getByTestId('edit-club').click()
      await page.getByTestId('input-club').fill('ks profilowo')
      await page.getByRole('option', { name: new RegExp(clubName) }).click()
      await page.getByTestId('save-club').click()
      await expect(page.getByText(clubName).first()).toBeVisible()
      const { data: prof } = await supabaseAdmin.from('profiles').select('club_id').eq('id', testUser.user.id).single()
      expect(prof.club_id).toBe(clubId)
    } finally {
      await supabaseAdmin.from('profiles').update({ club_id: null }).eq('id', testUser.user.id)
      await supabaseAdmin.from('clubs').delete().eq('id', clubId)
    }
  })
```

If `profile.spec.js` seeds a username for the test user before visiting `/profil` (check its `beforeEach`), keep that — `/profil` redirects to onboarding-less flows otherwise. Run to verify FAIL:

```bash
cd public && npx playwright test tests/e2e/profile.spec.js
```

- [ ] **Step 2: Add `EditableClubField` to `Profil.jsx`**

Add import: `import ClubInput from '../components/ClubInput.jsx'`. Below the `EditableField` component, add:

```jsx
function EditableClubField({ value, onSaveClub }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState({ name: value || '', clubId: null })
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    await onSaveClub(draft)
    setSaving(false)
    setEditing(false)
  }

  if (editing) {
    return (
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0" data-testid="input-club-wrap">
          <ClubInput value={draft} onChange={setDraft} inputClass={inputClass} inputId="club-edit" />
        </div>
        <button
          data-testid="save-club"
          onClick={save}
          disabled={saving}
          className="font-mono text-xs text-apex-yellow border border-apex-yellow px-2 py-1 hover:bg-apex-yellow hover:text-apex-ink transition-all"
        >
          OK
        </button>
        <button onClick={() => setEditing(false)} className="font-mono text-xs text-apex-muted hover:text-apex-text transition-colors px-2 py-1">✕</button>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-3 group">
      <span className="font-sans text-sm text-apex-text">
        {value || <span className="text-apex-muted italic">nie ustawiono</span>}
      </span>
      <button
        data-testid="edit-club"
        onClick={() => { setDraft({ name: value || '', clubId: null }); setEditing(true) }}
        className="font-mono text-[10px] text-apex-muted md:opacity-0 md:group-hover:opacity-100 hover:text-apex-yellow transition-all border border-apex-border px-2 py-0.5"
      >
        edytuj
      </button>
    </div>
  )
}
```

NOTE: `ClubInput` (Task 5) already takes a `testId` prop — update the `ClubInput` usage above to pass `testId="input-club"` so the test's `getByTestId('input-club')` binds:

```jsx
          <ClubInput value={draft} onChange={setDraft} inputClass={inputClass} inputId="club-edit" testId="input-club" />
```

- [ ] **Step 3: Use it in the sidebar** — replace lines 168–171 (`<div>…Klub…EditableField fieldKey="club"…</div>` block) with:

```jsx
                <div>
                  <div className="text-[9px] font-mono text-apex-muted mb-0.5">Klub</div>
                  <EditableClubField value={profile?.club} onSaveClub={handleClubSave} />
                </div>
```

and add next to `handleSave` in `ProfilContent`:

```js
  async function handleClubSave(draft) {
    try {
      const payload = draft.clubId
        ? { club_id: draft.clubId }
        : { club: draft.name.trim() }   // empty string clears
      const updated = await callFunction('update-profile', payload)
      setProfile(updated.data)
    } catch (err) {
      console.error('Club update failed:', err)
    }
  }
```

- [ ] **Step 4: Run e2e**

```bash
cd public && npx playwright test tests/e2e/profile.spec.js tests/e2e/onboarding.spec.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add public/src/pages/Profil.jsx public/src/components/ClubInput.jsx public/tests/e2e/profile.spec.js
git commit -m "feat(profil): club editing with autocomplete"
```

---

### Task 7: Backend admin routes — list + merge clubs

**Files:**
- Create: `backend/src/routes/clubs.js`
- Modify: `backend/src/server.js` (register after `eventPartnersRoutes`, ~line 64)

- [ ] **Step 1: Create `backend/src/routes/clubs.js`**

```js
import { supabase } from '../lib/supabaseClient.js'

export async function clubsRoutes(fastify) {
  // List all clubs with member counts + similarity-grouped duplicate suggestions
  fastify.get('/clubs', async (request, reply) => {
    const [clubsRes, pairsRes] = await Promise.all([
      supabase.from('clubs').select('id, name, created_at, profiles(count)').order('name'),
      supabase.rpc('similar_club_pairs', { threshold: 0.45 }),
    ])
    if (clubsRes.error) return reply.status(500).send({ error: clubsRes.error.message })
    if (pairsRes.error) return reply.status(500).send({ error: pairsRes.error.message })

    const data = clubsRes.data.map(c => ({
      id: c.id,
      name: c.name,
      createdAt: c.created_at,
      memberCount: c.profiles?.[0]?.count ?? 0,
    }))
    return { data, duplicates: pairsRes.data ?? [] }
  })

  // Merge source clubs into target: repoints profiles.club_id, deletes sources. Atomic.
  fastify.post('/clubs/:id/merge', async (request, reply) => {
    const { id } = request.params
    const { sourceIds } = request.body || {}
    if (!Array.isArray(sourceIds) || sourceIds.length === 0) {
      return reply.status(400).send({ error: 'sourceIds (non-empty array) required' })
    }
    if (sourceIds.includes(id)) {
      return reply.status(400).send({ error: 'target club cannot be in sourceIds' })
    }
    const { data: moved, error } = await supabase.rpc('merge_clubs', { target: id, sources: sourceIds })
    if (error) {
      const status = /not found|unknown|cannot be/.test(error.message) ? 400 : 500
      return reply.status(status).send({ error: error.message })
    }
    return { data: { movedMembers: moved } }
  })
}
```

- [ ] **Step 2: Register in `backend/src/server.js`** — add import next to the other route imports and `await api.register(clubsRoutes)` after `eventPartnersRoutes` (line 64).

- [ ] **Step 3: Verify with curl** (backend must be running: `docker compose up -d backend` or already up)

```bash
# seed two mergeable clubs via Supabase MCP (state intent, then run):
#   SELECT find_or_create_club('KB Verify A'); SELECT find_or_create_club('K.B. Verify A!');
# note: the second normalizes identically → SAME club. Use these instead:
#   SELECT find_or_create_club('KB Verify A'); SELECT find_or_create_club('KB Verify B');
curl -s http://localhost:3001/api/clubs | python3 -m json.tool
# expect: both clubs listed with memberCount 0; duplicates may include the pair (sim ≥ 0.45)

curl -s -X POST http://localhost:3001/api/clubs/<ID_A>/merge \
  -H 'Content-Type: application/json' -d '{"sourceIds": ["<ID_B>"]}' | python3 -m json.tool
# expect: { "data": { "movedMembers": 0 } }

curl -s -X POST http://localhost:3001/api/clubs/<ID_A>/merge \
  -H 'Content-Type: application/json' -d '{"sourceIds": ["<ID_A>"]}'
# expect: 400 target club cannot be in sourceIds

# cleanup: DELETE FROM clubs WHERE name = 'KB Verify A';  (via MCP, confirm with user first)
```

- [ ] **Step 4: Commit**

```bash
git add backend/src/routes/clubs.js backend/src/server.js
git commit -m "feat(admin): clubs list and merge API routes"
```

---

### Task 8: Admin frontend — Kluby page

**Files:**
- Create: `frontend/src/pages/ClubsPage.jsx`
- Modify: `frontend/src/App.jsx` (route), `frontend/src/components/layout/Navbar.jsx` (nav link after Kalendarz, ~line 116)

- [ ] **Step 1: Create `frontend/src/pages/ClubsPage.jsx`**

```jsx
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001'

export default function ClubsPage() {
  const queryClient = useQueryClient()
  const [merging, setMerging] = useState(null) // pair key while a merge is in flight

  const { data, isLoading } = useQuery({
    queryKey: ['clubs'],
    queryFn: async () => {
      const res = await fetch(`${API}/api/clubs`)
      if (!res.ok) throw new Error('Failed to load clubs')
      return res.json()
    },
  })

  const merge = useMutation({
    mutationFn: async ({ targetId, sourceIds }) => {
      const res = await fetch(`${API}/api/clubs/${targetId}/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceIds }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || 'Merge failed')
      return body
    },
    onSettled: () => {
      setMerging(null)
      queryClient.invalidateQueries({ queryKey: ['clubs'] })
    },
  })

  if (isLoading) return <div className="p-8 font-mono text-sm text-apex-muted animate-pulse">Ładowanie…</div>

  const clubs = data?.data ?? []
  const duplicates = data?.duplicates ?? []
  const byId = Object.fromEntries(clubs.map(c => [c.id, c]))

  return (
    <div className="p-6 md:p-8 max-w-4xl">
      <h1 className="font-display font-extrabold text-2xl text-apex-text-bright uppercase tracking-wider mb-6">Kluby</h1>

      {duplicates.length > 0 && (
        <section className="mb-8">
          <h2 className="font-display font-bold text-xs tracking-widest uppercase text-apex-muted border-b border-apex-border pb-1 mb-3">
            Możliwe duplikaty
          </h2>
          <div className="space-y-2">
            {duplicates.map(d => {
              const key = `${d.a_id}:${d.b_id}`
              const a = byId[d.a_id], b = byId[d.b_id]
              if (!a || !b) return null
              // keep the club with more members as the merge target
              const [target, source] = (a.memberCount >= b.memberCount) ? [a, b] : [b, a]
              return (
                <div key={key} className="flex items-center gap-3 border border-apex-border p-3 text-sm">
                  <span className="flex-1 text-apex-text">
                    <span className="text-apex-text-bright">{target.name}</span>
                    <span className="font-mono text-xs text-apex-muted ml-1.5">({target.memberCount})</span>
                    <span className="text-apex-muted mx-2">←</span>
                    {source.name}
                    <span className="font-mono text-xs text-apex-muted ml-1.5">({source.memberCount})</span>
                  </span>
                  <span className="font-mono text-[10px] text-apex-muted">sim {Math.round(d.sim * 100)}%</span>
                  <button
                    disabled={merging === key}
                    onClick={() => {
                      if (!confirm(`Połączyć "${source.name}" → "${target.name}"? Wszyscy członkowie zostaną przepisani.`)) return
                      setMerging(key)
                      merge.mutate({ targetId: target.id, sourceIds: [source.id] })
                    }}
                    className="font-mono text-xs text-apex-yellow border border-apex-yellow px-3 py-1 hover:bg-apex-yellow hover:text-black transition-all disabled:opacity-40"
                  >
                    {merging === key ? '…' : 'Połącz'}
                  </button>
                </div>
              )
            })}
          </div>
          {merge.isError && <p className="text-apex-red font-sans text-sm mt-2">{merge.error.message}</p>}
        </section>
      )}

      <section>
        <h2 className="font-display font-bold text-xs tracking-widest uppercase text-apex-muted border-b border-apex-border pb-1 mb-3">
          Wszystkie kluby ({clubs.length})
        </h2>
        {clubs.length === 0 ? (
          <p className="font-sans text-sm text-apex-muted py-4">Brak klubów — powstaną, gdy użytkownicy zaczną je wpisywać.</p>
        ) : (
          <div className="divide-y divide-apex-border/50">
            {clubs.map(c => (
              <div key={c.id} className="flex items-center gap-3 py-2 text-sm">
                <span className="flex-1 text-apex-text">{c.name}</span>
                <span className="font-mono text-xs text-apex-muted">{c.memberCount} czł.</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
```

- [ ] **Step 2: Route + nav link**

`frontend/src/App.jsx`: add `import ClubsPage from './pages/ClubsPage'` and inside the `<Route element={<Layout />}>` block (after the `/calendar-events` route, line 22):

```jsx
          <Route path="/clubs" element={<ClubsPage />} />
```

`frontend/src/components/layout/Navbar.jsx`: duplicate the Kalendarz `<Link>` block (lines 106–116) directly below it, changing `to="/clubs"`, the pathname check to `'/clubs'`, and the label to `Kluby`.

- [ ] **Step 3: Manual verification**

With `docker compose up` running and the two `KB Verify` seed clubs from Task 7 present (re-seed if cleaned): open http://localhost:3000/clubs — both clubs listed; if sim ≥ 0.45 the duplicate row shows; click Połącz → confirm → list refreshes with one club. Clean up the seed club afterwards (ask user before DELETE per DB-write rules).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/ClubsPage.jsx frontend/src/App.jsx frontend/src/components/layout/Navbar.jsx
git commit -m "feat(admin): Kluby page with duplicate suggestions and merge"
```

---

### Task 9: Full regression + builds

- [ ] **Step 1: All edge-function tests**

```bash
cd public && node --env-file=../.env --test ../supabase/functions/tests/*.test.js
```

Expected: PASS (admin tests may 403 without the admin secret — compare to pre-change baseline).

- [ ] **Step 2: All e2e specs**

```bash
cd public && npx playwright test
```

Expected: PASS. `contributions.spec.js`, `auth.spec.js`, `public-profile.spec.js` must not regress — `public-profile.spec.js` exercises `profiles_public.club` masking, which now flows through the clubs join.

- [ ] **Step 3: Builds compile**

```bash
cd public && npx vite build 2>&1 | tail -3
cd ../frontend && npx vite build 2>&1 | tail -3
```

Expected: both succeed.

- [ ] **Step 4: Final commit if anything is uncommitted**

```bash
git status --short && git add -A && git commit -m "chore: clubs entity follow-ups" || true
```
