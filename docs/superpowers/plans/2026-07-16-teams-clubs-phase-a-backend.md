# Teams/Clubs — Phase A Backend (Part 1: foundation & club lifecycle) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Supabase data foundation and the core club-lifecycle edge functions so a logged-in user can create a club, request to join one, be approved/rejected, have roles managed, and leave — all covered by `node --test` integration tests.

**Architecture:** Supabase-only tables (no Drizzle, no local Postgres) shipped as a committed migration under `supabase/migrations/`. Each behavior is a Deno edge function under `supabase/functions/<name>/index.js`, following the exact skeleton of `supabase/functions/toggle-favorite/index.js` (CORS short-circuit → service-role client → `getSession` → `try` body → local `json()` helper). Migration and functions deploy to production via the **Supabase CI release pipeline** (`.github/workflows/supabase-release.yml`) when the branch merges to `main` — not via MCP. Tests are Node integration tests (`node --test`) that hit the **deployed** functions over HTTP, so they run against the deployed functions after merge (the pipeline runs them as its smoke step; locally you can run them against the deployed functions any time). See `docs/supabase-release-runbook.md`.

**Tech Stack:** Deno edge functions (`Deno.serve`, `https://esm.sh/@supabase/supabase-js@2`), PostgreSQL (Supabase), Node built-in test runner for integration tests.

**Source spec:** `docs/superpowers/specs/2026-07-15-teams-clubs-design.md`

## Global Constraints

_Every task's requirements implicitly include this section._

- **JavaScript only — no TypeScript**, no `.ts` files, no type annotations. Edge function files are named `index.js`.
- **Edge function skeleton is fixed:** `handleOptions(req)` first; service-role client `createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'), { auth: { autoRefreshToken: false, persistSession: false } })`; `const session = await getSession(req, supabaseAdmin)` **before** the `try`; `401 { error: 'Authorization required' }` when null; all responses via a local `json(body, status, req)` helper that spreads `getCorsHeaders(req)` + `'Content-Type': 'application/json'`. Import client from `https://esm.sh/@supabase/supabase-js@2` (unpinned minor, always `@2`).
- **Error shape** is always `{ error: <string> }` with an HTTP status. User-facing error strings are in **Polish**.
- **Success shape:** wrap payloads as `{ data: ... }` (matches `update-profile`; the frontend reads `result.data`).
- **Deploy model (supersedes any per-task "deploy via MCP" wording below):** functions and the migration deploy to production via the **Supabase CI release pipeline** on merge to `main`. Do **not** call `mcp__supabase__deploy_edge_function` or `mcp__supabase__apply_migration`. Instead: (a) add each function's block to `supabase/config.toml` (`verify_jwt = false`, `entrypoint = "./functions/<name>/index.js"`) when the function is created; (b) commit the function file; merging deploys it. Any per-task step that says "deploy via `mcp__supabase__deploy_edge_function`" now means "commit the file; it deploys on merge; run its `node --test` against the deployed function after merge." This is a single shared production project (no dev/prod split) — the PR is the review gate.
- **Schema** changes are a committed migration file `supabase/migrations/<ts>_teams_clubs_phase_a.sql` (Supabase-only tables — no Drizzle migration, no local Postgres change), applied by `supabase db push` in the pipeline on merge. The migration's destructive wipe still requires the confirmation in Task 1 before the file is committed.
- **DB-write safety:** the migration performs destructive `UPDATE`/`DELETE`. State exactly what changes and get explicit user confirmation before applying (the operator has pre-authorized the club wipe, but re-confirm at apply time).
- **Slug rule:** club `slug` is **ASCII-only** — lowercase, Polish diacritics folded to ASCII (`ą→a` … `ż→z`), non-`[a-z0-9]` stripped, whitespace collapsed to `-`. Display text keeps diacritics.
- **Membership invariant:** a user has **at most one `active`** `club_members` row. `profiles.club_id` is kept in sync with the active membership (set on approve/create, cleared on leave/remove).
- **Feature flag:** this is backend only; no UI in this plan. (Frontend gating behind `useBeta()` is Plan 3.)
- **Commits:** do **not** add `Co-Authored-By` trailers or any Claude authorship.
- **Branch workflow:** all work on a feature branch off fresh `main`; PR + squash-merge back (per the `dev-workflow` skill). Never commit to `main`.

## File Structure

- `supabase/functions/_shared/clubText.js` (**create**) — `slugifyClub(name)` + `normalizeClubName(name)`; shared by club-writing functions.
- `supabase/functions/create-club/index.js` (**create**) — create/own a club.
- `supabase/functions/request-join/index.js` (**create**) — request to join a club (pending).
- `supabase/functions/respond-join/index.js` (**create**) — owner/admin approve/reject a pending request.
- `supabase/functions/manage-member/index.js` (**create**) — leave / remove / set-role / set-visibility.
- `supabase/functions/update-profile/index.js` (**modify**) — drop the free-text club branch; add `nickname` + `privacy_settings.club_public_name`.
- `supabase/functions/tests/helpers.js` (**modify**) — add club cleanup + a `createClub` test helper.
- `supabase/functions/tests/clubs-lifecycle.test.js` (**create**) — integration tests for all of the above.
- `supabase/migrations/<ts>_teams_clubs_phase_a.sql` (**create**) — the migration SQL recorded in Task 1 (created with `supabase migration new teams_clubs_phase_a`).
- `supabase/config.toml` (**modify**) — add a `[functions.<name>]` block (`verify_jwt = false`, `entrypoint = "./functions/<name>/index.js"`) for each new function created in this plan.

## Interfaces produced by this plan (contract later plans/frontend rely on)

- `POST create-club { name, description?, city?, voivodeship? }` → `{ data: { club } }` where `club = { id, name, slug, description, city, voivodeship, owner_id, is_public, created_at }`. Also inserts an `owner`/`active` membership and sets `profiles.club_id`.
- `POST request-join { club_id }` → `{ data: { status: 'pending' } }`.
- `POST respond-join { club_id, user_id, action: 'approve'|'reject' }` → `{ data: { status: 'active'|'rejected' } }`.
- `POST manage-member { club_id, action, ... }`:
  - `action: 'leave'` → `{ data: { left: true } }`
  - `action: 'remove', user_id` → `{ data: { removed: true } }`
  - `action: 'set-role', user_id, role: 'admin'|'member' }` → `{ data: { role } }`
  - `action: 'set-visibility', hidden_public: bool }` → `{ data: { hidden_public } }`
- `update-profile` additionally accepts `nickname` (string|null) and `privacy_settings.club_public_name` (`'display'|'nickname'`); it **no longer** accepts `club` or `club_id`.

---

### Task 1: Migration — wipe, schema, RLS, storage bucket

**Files:**
- Create `supabase/migrations/<ts>_teams_clubs_phase_a.sql` (via `supabase migration new teams_clubs_phase_a`) containing the SQL below. It applies to prod via `supabase db push` in the pipeline on merge — **not** via MCP.
- Test: `supabase/functions/tests/clubs-lifecycle.test.js` (schema smoke check — created here, expanded in later tasks).

**Interfaces:**
- Produces: tables `club_members`, `club_invites`; columns `clubs.owner_id/slug/logo_url/description/city/voivodeship/is_public/pending_owner_id`, `profiles.nickname`; bucket `club-logos`.

- [ ] **Step 1: State the destructive change and get confirmation**

Tell the user verbatim what will run and wait for explicit "yes":
> Migration `teams_clubs_phase_a` on the production Supabase project (`kojoxazlnxncrpxmnxiq`) will: (1) `UPDATE profiles SET club_id = NULL` (all rows), (2) `DELETE FROM clubs` (currently 1 row: "ZATYRANI GRATISOWNIA.PL GMINA PILCHOWICE"), (3) add columns + create `club_members`, `club_invites`, RLS, indexes, and the `club-logos` storage bucket. Irreversible for the deleted club row.

- [ ] **Step 2: Write the migration file**

Run `supabase migration new teams_clubs_phase_a`, then put this SQL in the generated `supabase/migrations/<ts>_teams_clubs_phase_a.sql`. It applies to prod via `supabase db push` in the pipeline on merge (do NOT call MCP). The `club-logos` bucket (Step 3) is included as section 7 so the whole change is one atomic migration:

```sql
-- 1. Wipe existing loose clubs (feature is hidden; ~2 users)
UPDATE profiles SET club_id = NULL;
DELETE FROM clubs;

-- 2. Extend clubs into an owned entity
ALTER TABLE clubs ADD COLUMN owner_id         UUID REFERENCES profiles(id) ON DELETE RESTRICT;
ALTER TABLE clubs ADD COLUMN slug             TEXT UNIQUE;
ALTER TABLE clubs ADD COLUMN logo_url         TEXT;
ALTER TABLE clubs ADD COLUMN description       TEXT;
ALTER TABLE clubs ADD COLUMN city             TEXT;
ALTER TABLE clubs ADD COLUMN voivodeship      TEXT;
ALTER TABLE clubs ADD COLUMN is_public        BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE clubs ADD COLUMN pending_owner_id UUID REFERENCES profiles(id) ON DELETE SET NULL;

-- 3. Membership
CREATE TABLE club_members (
  club_id        UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  role           TEXT NOT NULL DEFAULT 'member',   -- 'owner' | 'admin' | 'member'
  status         TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'pending'
  hidden_public  BOOLEAN NOT NULL DEFAULT false,
  joined_at      TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (club_id, user_id),
  CONSTRAINT club_members_role_chk   CHECK (role   IN ('owner','admin','member')),
  CONSTRAINT club_members_status_chk CHECK (status IN ('active','pending'))
);
CREATE INDEX idx_club_members_user        ON club_members(user_id);
CREATE INDEX idx_club_members_club_status ON club_members(club_id, status);

-- 4. Invites (used by Plan 2; table created now so schema is complete)
CREATE TABLE club_invites (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id         UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,                     -- 'link' | 'direct'
  code            TEXT UNIQUE,
  target_email    TEXT,
  target_username TEXT,
  created_by      UUID REFERENCES profiles(id) ON DELETE SET NULL,
  expires_at      TIMESTAMPTZ,
  max_uses        INTEGER,
  uses            INTEGER NOT NULL DEFAULT 0,
  revoked         BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT club_invites_kind_chk CHECK (kind IN ('link','direct'))
);
CREATE INDEX idx_club_invites_code ON club_invites(code) WHERE code IS NOT NULL;
CREATE INDEX idx_club_invites_club ON club_invites(club_id);

-- 5. Profile nickname (freeform, optional, non-unique)
ALTER TABLE profiles ADD COLUMN nickname TEXT;

-- 6. RLS: membership + invites are service-role only (no public/authenticated policies)
ALTER TABLE club_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE club_invites ENABLE ROW LEVEL SECURITY;
-- clubs keeps its existing public-read policy (needed by search_clubs + render-club)

-- 7. Storage bucket for club logos (public read)
INSERT INTO storage.buckets (id, name, public)
VALUES ('club-logos', 'club-logos', true)
ON CONFLICT (id) DO NOTHING;
```

- [ ] **Step 3: (bucket folded into the migration above — no separate step)**

The `club-logos` bucket is section 7 of the migration file, so it is created by the same `db push`. No separate `execute_sql` call.

- [ ] **Step 4: Write the schema smoke test**

Create `supabase/functions/tests/clubs-lifecycle.test.js`:

```js
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { supabaseAdmin } from './helpers.js'

describe('clubs schema', () => {
  it('has club_members and club_invites tables and new club columns', async () => {
    // Empty selects succeed only if the table + columns exist
    const m = await supabaseAdmin.from('club_members')
      .select('club_id, user_id, role, status, hidden_public, joined_at', { head: true, count: 'exact' })
    assert.equal(m.error, null)

    const i = await supabaseAdmin.from('club_invites')
      .select('id, club_id, kind, code, uses, revoked', { head: true, count: 'exact' })
    assert.equal(i.error, null)

    const c = await supabaseAdmin.from('clubs')
      .select('id, name, slug, owner_id, is_public, pending_owner_id, description', { head: true, count: 'exact' })
    assert.equal(c.error, null)

    const p = await supabaseAdmin.from('profiles')
      .select('id, nickname', { head: true, count: 'exact' })
    assert.equal(p.error, null)
  })
})
```

- [ ] **Step 5: Run the smoke test**

From `public/`:
```
node --env-file=../.env --test ../supabase/functions/tests/clubs-lifecycle.test.js
```
Expected: PASS (all four selects return `error: null`).

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/tests/clubs-lifecycle.test.js
git commit -m "feat(clubs): phase A schema — clubs ownership, membership, invites, bucket"
```

---

### Task 2: Shared club text helper (`slugifyClub`, `normalizeClubName`)

**Files:**
- Create: `supabase/functions/_shared/clubText.js`
- Test: `supabase/functions/tests/club-text.test.js`

**Interfaces:**
- Produces: `slugifyClub(name) → string` (ASCII slug base, no date suffix); `normalizeClubName(name) → string` (lowercased, diacritics folded, whitespace collapsed — used for the `clubs.normalized_name` unique key + search).

- [ ] **Step 1: Write the failing test**

Create `supabase/functions/tests/club-text.test.js`:

```js
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { slugifyClub, normalizeClubName } from '../_shared/clubText.js'

describe('clubText', () => {
  it('slugifyClub folds Polish diacritics and strips punctuation', () => {
    assert.equal(slugifyClub('Górska Drużyna Łódź!'), 'gorska-druzyna-lodz')
    assert.equal(slugifyClub('  ZATYRANI  '), 'zatyrani')
  })
  it('normalizeClubName lowercases + folds but keeps single spaces', () => {
    assert.equal(normalizeClubName('Górska  Drużyna'), 'gorska druzyna')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

From `public/`: `node --test ../supabase/functions/tests/club-text.test.js`
Expected: FAIL (`Cannot find module '../_shared/clubText.js'`).

- [ ] **Step 3: Write the implementation**

Create `supabase/functions/_shared/clubText.js`:

```js
// ASCII slug rule shared with the /listy pages (public/src/lib/slugify.js POLISH_MAP).
const POLISH_MAP = {
  'ą':'a','ć':'c','ę':'e','ł':'l','ń':'n','ó':'o','ś':'s','ź':'z','ż':'z',
  'Ą':'a','Ć':'c','Ę':'e','Ł':'l','Ń':'n','Ó':'o','Ś':'s','Ź':'z','Ż':'z',
}

function fold(str) {
  return str.replace(/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/g, (ch) => POLISH_MAP[ch] || ch)
}

/** ASCII slug base for /klub/:slug (no date/id suffix). */
export function slugifyClub(name) {
  return fold(String(name).toLowerCase())
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

/** Normalized display key for clubs.normalized_name (trigram search + uniqueness). */
export function normalizeClubName(name) {
  return fold(String(name).toLowerCase())
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}
```

- [ ] **Step 4: Run test to verify it passes**

From `public/`: `node --test ../supabase/functions/tests/club-text.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/clubText.js supabase/functions/tests/club-text.test.js
git commit -m "feat(clubs): shared club slug/normalize helper"
```

---

### Task 3: Test helpers — club cleanup + `createClubViaApi`

**Files:**
- Modify: `supabase/functions/tests/helpers.js`

**Interfaces:**
- Consumes: existing `helpers.js` exports (`supabaseAdmin`, `createTestSession`, `cleanupUser`, `callFunction`, `FUNCTIONS_URL`).
- Produces: `cleanupClub(clubId)`; `cleanupUser` extended to remove the user's memberships and owned clubs first (FK-safe).

- [ ] **Step 1: Read the current helpers**

Read `supabase/functions/tests/helpers.js` in full to confirm the exact names of `supabaseAdmin`, `createTestSession`, `cleanupUser`, and `callFunction`, and the FK-ordered deletion already in `cleanupUser`.

- [ ] **Step 2: Add `cleanupClub` and extend `cleanupUser`**

Add near the other cleanup helpers:

```js
export async function cleanupClub(clubId) {
  if (!clubId) return
  await supabaseAdmin.from('club_invites').delete().eq('club_id', clubId)
  await supabaseAdmin.from('club_members').delete().eq('club_id', clubId)
  await supabaseAdmin.from('profiles').update({ club_id: null }).eq('club_id', clubId)
  await supabaseAdmin.from('clubs').delete().eq('id', clubId)
}
```

Inside `cleanupUser(userId)`, **before** the profile/auth-user deletion, remove club links so FK constraints (`club_members.user_id`, `clubs.owner_id`) don't block deletion:

```js
  // Clubs: delete owned clubs (cascades members/invites), then any remaining memberships
  const { data: owned } = await supabaseAdmin.from('clubs').select('id').eq('owner_id', userId)
  for (const c of owned ?? []) await cleanupClub(c.id)
  await supabaseAdmin.from('club_members').delete().eq('user_id', userId)
  await supabaseAdmin.from('profiles').update({ club_id: null }).eq('id', userId)
```

- [ ] **Step 3: Verify existing tests still pass (regression)**

From `public/`:
```
node --env-file=../.env --test ../supabase/functions/tests/clubs-lifecycle.test.js ../supabase/functions/tests/club-text.test.js
```
Expected: PASS (helpers still import cleanly; schema test unaffected).

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/tests/helpers.js
git commit -m "test(clubs): FK-safe club cleanup in test helpers"
```

---

### Task 4: `create-club`

**Files:**
- Create: `supabase/functions/create-club/index.js`
- Test: add a `describe('create-club', …)` block to `supabase/functions/tests/clubs-lifecycle.test.js`

**Interfaces:**
- Consumes: `slugifyClub`, `normalizeClubName` (Task 2); `getSession`, `getCorsHeaders`, `handleOptions`.
- Produces: `POST create-club { name, description?, city?, voivodeship? }` → `{ data: { club } }`; caller becomes `owner`/`active`; `profiles.club_id` set. `409` if caller already has an active membership or the normalized name exists.

- [ ] **Step 1: Write the failing tests**

Add to `clubs-lifecycle.test.js`:

```js
import { createTestSession, cleanupUser, cleanupClub, callFunction } from './helpers.js'

describe('create-club', () => {
  it('creates a club, makes caller owner, sets profile.club_id', async () => {
    const u = await createTestSession('create-owner')
    let clubId
    try {
      const res = await callFunction('create-club', { name: 'Górska Drużyna Test' }, u.sessionToken)
      assert.equal(res.status, 200)
      clubId = res.data.data.club.id
      assert.equal(res.data.data.club.slug, 'gorska-druzyna-test')
      assert.equal(res.data.data.club.owner_id, u.user.id)

      const { data: m } = await supabaseAdmin.from('club_members')
        .select('role, status').eq('club_id', clubId).eq('user_id', u.user.id).single()
      assert.equal(m.role, 'owner')
      assert.equal(m.status, 'active')

      const { data: p } = await supabaseAdmin.from('profiles')
        .select('club_id').eq('id', u.user.id).single()
      assert.equal(p.club_id, clubId)
    } finally {
      await cleanupClub(clubId)
      await cleanupUser(u.user.id)
    }
  })

  it('rejects a second club while already an active member (409)', async () => {
    const u = await createTestSession('create-twice')
    let clubId
    try {
      const first = await callFunction('create-club', { name: 'Klub Jeden Test' }, u.sessionToken)
      clubId = first.data.data.club.id
      const second = await callFunction('create-club', { name: 'Klub Dwa Test' }, u.sessionToken)
      assert.equal(second.status, 409)
    } finally {
      await cleanupClub(clubId)
      await cleanupUser(u.user.id)
    }
  })

  it('requires a non-empty name (400)', async () => {
    const u = await createTestSession('create-noname')
    try {
      const res = await callFunction('create-club', { name: '   ' }, u.sessionToken)
      assert.equal(res.status, 400)
    } finally {
      await cleanupUser(u.user.id)
    }
  })
})
```

- [ ] **Step 2: Run to verify it fails**

From `public/`: `node --env-file=../.env --test ../supabase/functions/tests/clubs-lifecycle.test.js`
Expected: FAIL (create-club not deployed → non-200 / fetch errors).

- [ ] **Step 3: Write the implementation**

Create `supabase/functions/create-club/index.js`:

```js
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, handleOptions } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'
import { slugifyClub, normalizeClubName } from '../_shared/clubText.js'

function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  })
}

async function uniqueSlug(supabaseAdmin, base) {
  let slug = base || 'klub'
  for (let n = 1; n < 50; n++) {
    const candidate = n === 1 ? slug : `${slug}-${n}`
    const { data } = await supabaseAdmin.from('clubs').select('id').eq('slug', candidate).maybeSingle()
    if (!data) return candidate
  }
  return `${slug}-${crypto.randomUUID().slice(0, 6)}`
}

Deno.serve(async (req) => {
  const optRes = handleOptions(req)
  if (optRes) return optRes

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL'),
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  const session = await getSession(req, supabaseAdmin)
  if (!session) return json({ error: 'Authorization required' }, 401, req)

  try {
    const { name, description = null, city = null, voivodeship = null } = await req.json()
    const trimmed = (name ?? '').trim()
    if (trimmed.length < 2 || trimmed.length > 120) {
      return json({ error: 'Nazwa klubu jest wymagana (2–120 znaków).' }, 400, req)
    }

    // One active membership per user
    const { data: existing } = await supabaseAdmin
      .from('club_members')
      .select('club_id').eq('user_id', session.userId).eq('status', 'active').maybeSingle()
    if (existing) return json({ error: 'Należysz już do klubu. Opuść go, aby utworzyć nowy.' }, 409, req)

    const normalized = normalizeClubName(trimmed)
    const { data: dupe } = await supabaseAdmin
      .from('clubs').select('id').eq('normalized_name', normalized).maybeSingle()
    if (dupe) return json({ error: 'Klub o tej nazwie już istnieje.' }, 409, req)

    const slug = await uniqueSlug(supabaseAdmin, slugifyClub(trimmed))

    const { data: club, error: clubErr } = await supabaseAdmin
      .from('clubs')
      .insert({
        name: trimmed, normalized_name: normalized, slug,
        owner_id: session.userId, description, city, voivodeship,
      })
      .select('id, name, slug, description, city, voivodeship, owner_id, is_public, created_at')
      .single()
    if (clubErr) {
      if (clubErr.code === '23505') return json({ error: 'Klub o tej nazwie już istnieje.' }, 409, req)
      throw clubErr
    }

    const { error: memErr } = await supabaseAdmin.from('club_members').insert({
      club_id: club.id, user_id: session.userId, role: 'owner', status: 'active',
      joined_at: new Date().toISOString(),
    })
    if (memErr) throw memErr

    await supabaseAdmin.from('profiles').update({ club_id: club.id }).eq('id', session.userId)

    return json({ data: { club } }, 200, req)
  } catch (err) {
    return json({ error: err.message }, 500, req)
  }
})
```

- [ ] **Step 4: Deploy the function**

Add the `[functions.create-club]` block to `supabase/config.toml` (`verify_jwt = false`, `entrypoint = "./functions/create-club/index.js"`), then commit the function file. It deploys on merge to `main` via the pipeline (`_shared/` is bundled automatically) — no MCP call. Its `node --test` runs against the deployed function after merge.

- [ ] **Step 5: Run tests to verify they pass**

From `public/`: `node --env-file=../.env --test ../supabase/functions/tests/clubs-lifecycle.test.js`
Expected: PASS (all `create-club` cases).

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/create-club/index.js supabase/functions/tests/clubs-lifecycle.test.js
git commit -m "feat(clubs): create-club edge function"
```

---

### Task 5: `request-join`

**Files:**
- Create: `supabase/functions/request-join/index.js`
- Test: add `describe('request-join', …)` to `clubs-lifecycle.test.js`

**Interfaces:**
- Consumes: session helpers.
- Produces: `POST request-join { club_id }` → `{ data: { status: 'pending' } }`. Idempotent if already pending. `409` if the caller already has an active membership anywhere. Does **not** set `profiles.club_id`.

- [ ] **Step 1: Write the failing tests**

Add to `clubs-lifecycle.test.js`:

```js
describe('request-join', () => {
  it('creates a pending membership without setting club_id', async () => {
    const owner = await createTestSession('rj-owner')
    const joiner = await createTestSession('rj-joiner')
    let clubId
    try {
      const c = await callFunction('create-club', { name: 'Klub Do Zapisu Test' }, owner.sessionToken)
      clubId = c.data.data.club.id

      const res = await callFunction('request-join', { club_id: clubId }, joiner.sessionToken)
      assert.equal(res.status, 200)
      assert.equal(res.data.data.status, 'pending')

      const { data: m } = await supabaseAdmin.from('club_members')
        .select('status').eq('club_id', clubId).eq('user_id', joiner.user.id).single()
      assert.equal(m.status, 'pending')

      const { data: p } = await supabaseAdmin.from('profiles').select('club_id').eq('id', joiner.user.id).single()
      assert.equal(p.club_id, null) // pending must NOT set club_id
    } finally {
      await cleanupClub(clubId)
      await cleanupUser(owner.user.id)
      await cleanupUser(joiner.user.id)
    }
  })

  it('is idempotent when already pending', async () => {
    const owner = await createTestSession('rj2-owner')
    const joiner = await createTestSession('rj2-joiner')
    let clubId
    try {
      const c = await callFunction('create-club', { name: 'Klub Idempotent Test' }, owner.sessionToken)
      clubId = c.data.data.club.id
      await callFunction('request-join', { club_id: clubId }, joiner.sessionToken)
      const again = await callFunction('request-join', { club_id: clubId }, joiner.sessionToken)
      assert.equal(again.status, 200)
      assert.equal(again.data.data.status, 'pending')
    } finally {
      await cleanupClub(clubId)
      await cleanupUser(owner.user.id)
      await cleanupUser(joiner.user.id)
    }
  })
})
```

- [ ] **Step 2: Run to verify it fails**

From `public/`: `node --env-file=../.env --test ../supabase/functions/tests/clubs-lifecycle.test.js`
Expected: FAIL (request-join not deployed).

- [ ] **Step 3: Write the implementation**

Create `supabase/functions/request-join/index.js`:

```js
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, handleOptions } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'

function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  const optRes = handleOptions(req)
  if (optRes) return optRes

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL'),
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  const session = await getSession(req, supabaseAdmin)
  if (!session) return json({ error: 'Authorization required' }, 401, req)

  try {
    const { club_id } = await req.json()
    if (!club_id) return json({ error: 'club_id required' }, 400, req)

    const { data: club } = await supabaseAdmin.from('clubs').select('id').eq('id', club_id).maybeSingle()
    if (!club) return json({ error: 'Klub nie istnieje.' }, 404, req)

    // Block if the caller already has an ACTIVE membership anywhere
    const { data: active } = await supabaseAdmin.from('club_members')
      .select('club_id').eq('user_id', session.userId).eq('status', 'active').maybeSingle()
    if (active) return json({ error: 'Należysz już do klubu.' }, 409, req)

    // Idempotent upsert of the pending row (PK = club_id,user_id)
    const { error } = await supabaseAdmin.from('club_members')
      .upsert(
        { club_id, user_id: session.userId, role: 'member', status: 'pending' },
        { onConflict: 'club_id,user_id', ignoreDuplicates: false }
      )
    if (error) throw error

    return json({ data: { status: 'pending' } }, 200, req)
  } catch (err) {
    return json({ error: err.message }, 500, req)
  }
})
```

- [ ] **Step 4: Wire deploy** — add the `[functions.request-join]` block to `supabase/config.toml` (`verify_jwt = false`, `entrypoint = "./functions/request-join/index.js"`) and commit the file. Deploys on merge via the pipeline; tests run against it post-merge.

- [ ] **Step 5: Run tests**

From `public/`: `node --env-file=../.env --test ../supabase/functions/tests/clubs-lifecycle.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/request-join/index.js supabase/functions/tests/clubs-lifecycle.test.js
git commit -m "feat(clubs): request-join edge function"
```

---

### Task 6: `respond-join`

**Files:**
- Create: `supabase/functions/respond-join/index.js`
- Test: add `describe('respond-join', …)` to `clubs-lifecycle.test.js`

**Interfaces:**
- Consumes: session helpers.
- Produces: `POST respond-join { club_id, user_id, action: 'approve'|'reject' }` → `{ data: { status: 'active'|'rejected' } }`. Caller must be `owner`/`admin` of `club_id` (`403` otherwise). `approve` sets that member `active`, `joined_at`, and their `profiles.club_id`; `reject` deletes the pending row.

- [ ] **Step 1: Write the failing tests**

Add to `clubs-lifecycle.test.js`:

```js
describe('respond-join', () => {
  it('owner approves a pending request → active + club_id set', async () => {
    const owner = await createTestSession('resp-owner')
    const joiner = await createTestSession('resp-joiner')
    let clubId
    try {
      const c = await callFunction('create-club', { name: 'Klub Approve Test' }, owner.sessionToken)
      clubId = c.data.data.club.id
      await callFunction('request-join', { club_id: clubId }, joiner.sessionToken)

      const res = await callFunction('respond-join',
        { club_id: clubId, user_id: joiner.user.id, action: 'approve' }, owner.sessionToken)
      assert.equal(res.status, 200)
      assert.equal(res.data.data.status, 'active')

      const { data: m } = await supabaseAdmin.from('club_members')
        .select('status, joined_at').eq('club_id', clubId).eq('user_id', joiner.user.id).single()
      assert.equal(m.status, 'active')
      assert.ok(m.joined_at)
      const { data: p } = await supabaseAdmin.from('profiles').select('club_id').eq('id', joiner.user.id).single()
      assert.equal(p.club_id, clubId)
    } finally {
      await cleanupClub(clubId)
      await cleanupUser(owner.user.id)
      await cleanupUser(joiner.user.id)
    }
  })

  it('rejects a request → pending row deleted, club_id stays null', async () => {
    const owner = await createTestSession('rej-owner')
    const joiner = await createTestSession('rej-joiner')
    let clubId
    try {
      const c = await callFunction('create-club', { name: 'Klub Reject Test' }, owner.sessionToken)
      clubId = c.data.data.club.id
      await callFunction('request-join', { club_id: clubId }, joiner.sessionToken)

      const res = await callFunction('respond-join',
        { club_id: clubId, user_id: joiner.user.id, action: 'reject' }, owner.sessionToken)
      assert.equal(res.status, 200)
      assert.equal(res.data.data.status, 'rejected')

      const { data: m } = await supabaseAdmin.from('club_members')
        .select('user_id').eq('club_id', clubId).eq('user_id', joiner.user.id).maybeSingle()
      assert.equal(m, null)
    } finally {
      await cleanupClub(clubId)
      await cleanupUser(owner.user.id)
      await cleanupUser(joiner.user.id)
    }
  })

  it('non-admin cannot respond (403)', async () => {
    const owner = await createTestSession('perm-owner')
    const joiner = await createTestSession('perm-joiner')
    const stranger = await createTestSession('perm-stranger')
    let clubId
    try {
      const c = await callFunction('create-club', { name: 'Klub Perm Test' }, owner.sessionToken)
      clubId = c.data.data.club.id
      await callFunction('request-join', { club_id: clubId }, joiner.sessionToken)
      const res = await callFunction('respond-join',
        { club_id: clubId, user_id: joiner.user.id, action: 'approve' }, stranger.sessionToken)
      assert.equal(res.status, 403)
    } finally {
      await cleanupClub(clubId)
      await cleanupUser(owner.user.id)
      await cleanupUser(joiner.user.id)
      await cleanupUser(stranger.user.id)
    }
  })
})
```

- [ ] **Step 2: Run to verify it fails**

From `public/`: `node --env-file=../.env --test ../supabase/functions/tests/clubs-lifecycle.test.js`
Expected: FAIL (respond-join not deployed).

- [ ] **Step 3: Write the implementation**

Create `supabase/functions/respond-join/index.js`:

```js
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, handleOptions } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'

function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  })
}

// Caller must be owner/admin (active) of the club
async function requireManager(supabaseAdmin, clubId, userId) {
  const { data } = await supabaseAdmin.from('club_members')
    .select('role').eq('club_id', clubId).eq('user_id', userId).eq('status', 'active').maybeSingle()
  return data && (data.role === 'owner' || data.role === 'admin')
}

Deno.serve(async (req) => {
  const optRes = handleOptions(req)
  if (optRes) return optRes

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL'),
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  const session = await getSession(req, supabaseAdmin)
  if (!session) return json({ error: 'Authorization required' }, 401, req)

  try {
    const { club_id, user_id, action } = await req.json()
    if (!club_id || !user_id || !['approve', 'reject'].includes(action)) {
      return json({ error: 'club_id, user_id, action required' }, 400, req)
    }
    if (!(await requireManager(supabaseAdmin, club_id, session.userId))) {
      return json({ error: 'Brak uprawnień.' }, 403, req)
    }

    const { data: pending } = await supabaseAdmin.from('club_members')
      .select('status').eq('club_id', club_id).eq('user_id', user_id).maybeSingle()
    if (!pending || pending.status !== 'pending') {
      return json({ error: 'Brak oczekującego zgłoszenia.' }, 404, req)
    }

    if (action === 'reject') {
      await supabaseAdmin.from('club_members').delete().eq('club_id', club_id).eq('user_id', user_id)
      return json({ data: { status: 'rejected' } }, 200, req)
    }

    // approve — guard: the joiner must not have become active elsewhere meanwhile
    const { data: activeElsewhere } = await supabaseAdmin.from('club_members')
      .select('club_id').eq('user_id', user_id).eq('status', 'active').maybeSingle()
    if (activeElsewhere) return json({ error: 'Użytkownik należy już do innego klubu.' }, 409, req)

    await supabaseAdmin.from('club_members')
      .update({ status: 'active', joined_at: new Date().toISOString() })
      .eq('club_id', club_id).eq('user_id', user_id)
    await supabaseAdmin.from('profiles').update({ club_id }).eq('id', user_id)

    return json({ data: { status: 'active' } }, 200, req)
  } catch (err) {
    return json({ error: err.message }, 500, req)
  }
})
```

- [ ] **Step 4: Wire deploy** — add the `[functions.respond-join]` block to `supabase/config.toml` (`verify_jwt = false`, `entrypoint = "./functions/respond-join/index.js"`) and commit. Deploys on merge; tests run against it post-merge.

- [ ] **Step 5: Run tests**

From `public/`: `node --env-file=../.env --test ../supabase/functions/tests/clubs-lifecycle.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/respond-join/index.js supabase/functions/tests/clubs-lifecycle.test.js
git commit -m "feat(clubs): respond-join edge function"
```

---

### Task 7: `manage-member` (leave / remove / set-role / set-visibility)

**Files:**
- Create: `supabase/functions/manage-member/index.js`
- Test: add `describe('manage-member', …)` to `clubs-lifecycle.test.js`

**Interfaces:**
- Consumes: session helpers.
- Produces: `POST manage-member { club_id, action, ... }`:
  - `'leave'` (self) → `{ data: { left: true } }`; **owner cannot leave** (`409`); clears own `club_id`.
  - `'remove' { user_id }` (owner/admin) → `{ data: { removed: true } }`; cannot remove an owner; admins cannot remove admins (owner-only); clears target `club_id`.
  - `'set-role' { user_id, role }` (owner only) → `{ data: { role } }`; `role ∈ {'admin','member'}`; cannot target the owner row.
  - `'set-visibility' { hidden_public }` (self) → `{ data: { hidden_public } }`.

- [ ] **Step 1: Write the failing tests**

Add to `clubs-lifecycle.test.js`:

```js
async function joinActive(owner, joiner, clubId) {
  await callFunction('request-join', { club_id: clubId }, joiner.sessionToken)
  await callFunction('respond-join', { club_id: clubId, user_id: joiner.user.id, action: 'approve' }, owner.sessionToken)
}

describe('manage-member', () => {
  it('member leaves → membership gone, club_id cleared', async () => {
    const owner = await createTestSession('mm-owner')
    const member = await createTestSession('mm-member')
    let clubId
    try {
      const c = await callFunction('create-club', { name: 'Klub Leave Test' }, owner.sessionToken)
      clubId = c.data.data.club.id
      await joinActive(owner, member, clubId)

      const res = await callFunction('manage-member', { club_id: clubId, action: 'leave' }, member.sessionToken)
      assert.equal(res.status, 200)
      const { data: m } = await supabaseAdmin.from('club_members')
        .select('user_id').eq('club_id', clubId).eq('user_id', member.user.id).maybeSingle()
      assert.equal(m, null)
      const { data: p } = await supabaseAdmin.from('profiles').select('club_id').eq('id', member.user.id).single()
      assert.equal(p.club_id, null)
    } finally {
      await cleanupClub(clubId); await cleanupUser(owner.user.id); await cleanupUser(member.user.id)
    }
  })

  it('owner cannot leave (409)', async () => {
    const owner = await createTestSession('mm-owner2')
    let clubId
    try {
      const c = await callFunction('create-club', { name: 'Klub Owner Leave Test' }, owner.sessionToken)
      clubId = c.data.data.club.id
      const res = await callFunction('manage-member', { club_id: clubId, action: 'leave' }, owner.sessionToken)
      assert.equal(res.status, 409)
    } finally {
      await cleanupClub(clubId); await cleanupUser(owner.user.id)
    }
  })

  it('owner promotes a member to admin then removes them', async () => {
    const owner = await createTestSession('mm-owner3')
    const member = await createTestSession('mm-member3')
    let clubId
    try {
      const c = await callFunction('create-club', { name: 'Klub Role Test' }, owner.sessionToken)
      clubId = c.data.data.club.id
      await joinActive(owner, member, clubId)

      const promote = await callFunction('manage-member',
        { club_id: clubId, action: 'set-role', user_id: member.user.id, role: 'admin' }, owner.sessionToken)
      assert.equal(promote.status, 200)
      assert.equal(promote.data.data.role, 'admin')

      const remove = await callFunction('manage-member',
        { club_id: clubId, action: 'remove', user_id: member.user.id }, owner.sessionToken)
      assert.equal(remove.status, 200)
      const { data: p } = await supabaseAdmin.from('profiles').select('club_id').eq('id', member.user.id).single()
      assert.equal(p.club_id, null)
    } finally {
      await cleanupClub(clubId); await cleanupUser(owner.user.id); await cleanupUser(member.user.id)
    }
  })

  it('member toggles own hidden_public', async () => {
    const owner = await createTestSession('mm-owner4')
    const member = await createTestSession('mm-member4')
    let clubId
    try {
      const c = await callFunction('create-club', { name: 'Klub Hide Test' }, owner.sessionToken)
      clubId = c.data.data.club.id
      await joinActive(owner, member, clubId)
      const res = await callFunction('manage-member',
        { club_id: clubId, action: 'set-visibility', hidden_public: true }, member.sessionToken)
      assert.equal(res.status, 200)
      assert.equal(res.data.data.hidden_public, true)
      const { data: m } = await supabaseAdmin.from('club_members')
        .select('hidden_public').eq('club_id', clubId).eq('user_id', member.user.id).single()
      assert.equal(m.hidden_public, true)
    } finally {
      await cleanupClub(clubId); await cleanupUser(owner.user.id); await cleanupUser(member.user.id)
    }
  })
})
```

- [ ] **Step 2: Run to verify it fails**

From `public/`: `node --env-file=../.env --test ../supabase/functions/tests/clubs-lifecycle.test.js`
Expected: FAIL (manage-member not deployed).

- [ ] **Step 3: Write the implementation**

Create `supabase/functions/manage-member/index.js`:

```js
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, handleOptions } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'

function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  })
}

async function membership(supabaseAdmin, clubId, userId) {
  const { data } = await supabaseAdmin.from('club_members')
    .select('role, status').eq('club_id', clubId).eq('user_id', userId).maybeSingle()
  return data
}

async function clearClubIdIfPointing(supabaseAdmin, userId, clubId) {
  await supabaseAdmin.from('profiles').update({ club_id: null }).eq('id', userId).eq('club_id', clubId)
}

Deno.serve(async (req) => {
  const optRes = handleOptions(req)
  if (optRes) return optRes

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL'),
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  const session = await getSession(req, supabaseAdmin)
  if (!session) return json({ error: 'Authorization required' }, 401, req)

  try {
    const { club_id, action, user_id, role, hidden_public } = await req.json()
    if (!club_id || !action) return json({ error: 'club_id, action required' }, 400, req)

    const me = await membership(supabaseAdmin, club_id, session.userId)
    if (!me || me.status !== 'active') return json({ error: 'Nie należysz do tego klubu.' }, 403, req)

    if (action === 'leave') {
      if (me.role === 'owner') {
        return json({ error: 'Właściciel nie może opuścić klubu — przekaż własność lub usuń klub.' }, 409, req)
      }
      await supabaseAdmin.from('club_members').delete().eq('club_id', club_id).eq('user_id', session.userId)
      await clearClubIdIfPointing(supabaseAdmin, session.userId, club_id)
      return json({ data: { left: true } }, 200, req)
    }

    if (action === 'set-visibility') {
      await supabaseAdmin.from('club_members')
        .update({ hidden_public: !!hidden_public })
        .eq('club_id', club_id).eq('user_id', session.userId)
      return json({ data: { hidden_public: !!hidden_public } }, 200, req)
    }

    // remaining actions target another member → require manager
    const isManager = me.role === 'owner' || me.role === 'admin'
    if (!isManager) return json({ error: 'Brak uprawnień.' }, 403, req)
    if (!user_id) return json({ error: 'user_id required' }, 400, req)

    const target = await membership(supabaseAdmin, club_id, user_id)
    if (!target) return json({ error: 'Nie ma takiego członka.' }, 404, req)
    if (target.role === 'owner') return json({ error: 'Nie można modyfikować właściciela.' }, 403, req)

    if (action === 'remove') {
      // admins may remove members only; owner may remove admins + members
      if (target.role === 'admin' && me.role !== 'owner') {
        return json({ error: 'Tylko właściciel może usunąć administratora.' }, 403, req)
      }
      await supabaseAdmin.from('club_members').delete().eq('club_id', club_id).eq('user_id', user_id)
      await clearClubIdIfPointing(supabaseAdmin, user_id, club_id)
      return json({ data: { removed: true } }, 200, req)
    }

    if (action === 'set-role') {
      if (me.role !== 'owner') return json({ error: 'Tylko właściciel zmienia role.' }, 403, req)
      if (!['admin', 'member'].includes(role)) return json({ error: 'Nieprawidłowa rola.' }, 400, req)
      await supabaseAdmin.from('club_members').update({ role }).eq('club_id', club_id).eq('user_id', user_id)
      return json({ data: { role } }, 200, req)
    }

    return json({ error: 'Nieznana akcja.' }, 400, req)
  } catch (err) {
    return json({ error: err.message }, 500, req)
  }
})
```

- [ ] **Step 4: Wire deploy** — add the `[functions.manage-member]` block to `supabase/config.toml` (`verify_jwt = false`, `entrypoint = "./functions/manage-member/index.js"`) and commit. Deploys on merge; tests run against it post-merge.

- [ ] **Step 5: Run tests**

From `public/`: `node --env-file=../.env --test ../supabase/functions/tests/clubs-lifecycle.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/manage-member/index.js supabase/functions/tests/clubs-lifecycle.test.js
git commit -m "feat(clubs): manage-member edge function (leave/remove/role/visibility)"
```

---

### Task 8: `update-profile` — drop free-text club, add `nickname` + `club_public_name`

**Files:**
- Modify: `supabase/functions/update-profile/index.js`
- Test: add `describe('update-profile clubs changes', …)` to `clubs-lifecycle.test.js`

**Interfaces:**
- Consumes: existing `update-profile`.
- Produces: `update-profile` accepts `nickname` (string ≤ 60 chars, or null to clear) and `privacy_settings.club_public_name` (`'display'|'nickname'`). It **ignores/rejects** `club` and `club_id` (club identity is set only through create/join/leave). Response still `{ data: <profile> }`.

- [ ] **Step 1: Read the current function**

Read `supabase/functions/update-profile/index.js` in full — locate: the destructure of the body, the `find_or_create_club` / `club_id` branch, the `privacy_settings` handling, and the final `.update(updates).select('*, clubs(name)').single()`.

- [ ] **Step 2: Write the failing tests**

Add to `clubs-lifecycle.test.js`:

```js
describe('update-profile clubs changes', () => {
  it('sets nickname and club_public_name; ignores club/club_id', async () => {
    const u = await createTestSession('up-clubs')
    try {
      const res = await callFunction('update-profile', {
        nickname: 'Szybki Franek',
        privacy_settings: { club_public_name: 'nickname' },
        club: 'Should Be Ignored',
        club_id: '00000000-0000-0000-0000-000000000000',
      }, u.sessionToken)
      assert.equal(res.status, 200)

      const { data: p } = await supabaseAdmin.from('profiles')
        .select('nickname, club_id, privacy_settings').eq('id', u.user.id).single()
      assert.equal(p.nickname, 'Szybki Franek')
      assert.equal(p.club_id, null) // club/club_id in the body must be ignored
      assert.equal(p.privacy_settings.club_public_name, 'nickname')
    } finally {
      await cleanupUser(u.user.id)
    }
  })

  it('rejects an over-long nickname (400)', async () => {
    const u = await createTestSession('up-longnick')
    try {
      const res = await callFunction('update-profile', { nickname: 'x'.repeat(61) }, u.sessionToken)
      assert.equal(res.status, 400)
    } finally {
      await cleanupUser(u.user.id)
    }
  })
})
```

- [ ] **Step 3: Run to verify it fails**

From `public/`: `node --env-file=../.env --test ../supabase/functions/tests/clubs-lifecycle.test.js`
Expected: FAIL (nickname not persisted; club_id gets set from body).

- [ ] **Step 4: Edit the function**

In `update-profile/index.js`:

1. **Remove** the `club` / `club_id` handling entirely — delete the `find_or_create_club` RPC branch and any `updates.club_id = …` assignment. If `club` or `club_id` appear in the body, do not read them.
2. **Add nickname validation** where other fields are validated:

```js
    if (body.nickname !== undefined) {
      if (body.nickname === null || body.nickname === '') {
        updates.nickname = null
      } else if (typeof body.nickname !== 'string' || body.nickname.trim().length > 60) {
        return json({ error: 'Pseudonim może mieć maksymalnie 60 znaków.' }, 400, req)
      } else {
        updates.nickname = body.nickname.trim()
      }
    }
```

3. **Add `club_public_name`** inside the existing `privacy_settings` merge. When the incoming `privacy_settings` object carries `club_public_name`, validate it is `'display'|'nickname'` (default `'display'`) and keep it in the merged JSON:

```js
    if (body.privacy_settings !== undefined) {
      const incoming = body.privacy_settings || {}
      const cpn = incoming.club_public_name
      if (cpn !== undefined && !['display', 'nickname'].includes(cpn)) {
        return json({ error: 'Nieprawidłowa wartość club_public_name.' }, 400, req)
      }
      updates.privacy_settings = { ...(currentProfile?.privacy_settings || {}), ...incoming }
    }
```

   (Use the same current-profile merge the function already does for `privacy_settings`; if it currently overwrites wholesale, switch to the spread-merge above so `favorites` and other keys survive.)

4. Change the final joined select if it references club free-text; keep `.select('*, clubs(name)')` — that still works because `club_id` is now managed elsewhere.

- [ ] **Step 5: Deploy** — `update-profile` already has its `[functions.update-profile]` block in `supabase/config.toml`; just commit the modified function. It re-deploys on merge; tests run against it post-merge.

- [ ] **Step 6: Run tests (new + regression)**

From `public/`:
```
node --env-file=../.env --test ../supabase/functions/tests/clubs-lifecycle.test.js ../supabase/functions/tests/*.test.js
```
Expected: PASS, including any existing `update-profile`/profile tests (confirm none relied on the removed free-text club path — if one does, update it to use `create-club` instead).

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/update-profile/index.js supabase/functions/tests/clubs-lifecycle.test.js
git commit -m "feat(clubs): update-profile — nickname + club_public_name, drop free-text club"
```

---

### Task 9: Full-suite green + branch finish

**Files:** none (verification + integration).

- [ ] **Step 1: Deploy sweep confirm**

Confirm every function touched in this plan is deployed to production: `create-club`, `request-join`, `respond-join`, `manage-member`, `update-profile`. (List them to the user.)

- [ ] **Step 2: Run the whole function test suite**

From `public/`:
```
node ../supabase/functions/tests/sweep.js && node --env-file=../.env --test ../supabase/functions/tests/*.test.js
```
Expected: PASS across all files, no leftover test rows (sweep clean).

- [ ] **Step 3: Confirm no test pollution**

Query for stray club rows created by tests (names end in `Test` and belong to `%@test.leszy.run` owners):

```
node --env-file=../.env -e "import('@supabase/supabase-js').then(async ({createClient})=>{const s=createClient(process.env.VITE_SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY);const {data}=await s.from('clubs').select('id,name');console.log(data)})"
```
Expected: no `… Test` clubs remain. If any do, extend `sweep.js` to remove clubs whose owner is a test user, then re-run Step 2.

- [ ] **Step 4: Push, PR, merge**

```bash
git push -u origin feature/<branch>
gh pr create --fill
# after review:
gh pr merge --squash --delete-branch
```

---

## Self-Review

**Spec coverage (Phase A backend, this slice):**
- Created-only clubs, one active membership, `profiles.club_id` sync → Tasks 1, 4, 6, 7. ✓
- `request-join` / `respond-join` (request-to-join path) → Tasks 5, 6. ✓
- Roles (owner/admin/member), remove/leave, role changes → Task 7. ✓
- Member `hidden_public` toggle → Task 7. ✓
- `nickname` + `privacy_settings.club_public_name`, removal of free-text club → Task 8. ✓
- Storage bucket `club-logos` created (upload logic is Plan 2) → Task 1. ✓
- Migration wipe of the single existing club → Task 1. ✓

**Deferred to later plans (explicitly not in this slice):** invites (`manage-club-invite`, `accept-invite`), `transfer-ownership` (+ `pending_owner_id` use), `update-club`, `upload-club-logo`, `delete-my-account` 409 block, `export-my-data` club section, all frontend, `render-club` public page, member view. `club_invites` + `pending_owner_id` columns are created now so the schema is stable, but no code uses them yet.

**Placeholder scan:** no TBD/TODO; every code step has complete code. ✓

**Type consistency:** `callFunction(name, body, sessionToken)` returns `{ status, data }` (data is the parsed JSON body, so success payloads are read as `res.data.data.*`); functions return `{ data: … }`; `requireManager`/`membership`/`clearClubIdIfPointing` helper names are consistent within their files. ✓

**Known follow-ups for Plan 2 to honor:**
- `respond-join`/`create-club` set `profiles.club_id`; `accept-invite` (Plan 2) must do the same and enforce the one-active-membership rule identically.
- Owner-leave is blocked here; `transfer-ownership` (Plan 2) is the escape hatch that also unblocks GDPR account deletion.
