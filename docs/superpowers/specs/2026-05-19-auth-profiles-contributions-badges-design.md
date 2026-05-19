# Auth, Profiles, Contributions & Badges — Design Spec

**Date:** 2026-05-19
**Status:** Approved

## Scope

First of four user-feature sub-projects:

1. **Auth + Profiles + Contributions + Badges** ← this spec
2. Notifications (email, browser push, in-app, saved filters) — next spec
3. Event favorites — future spec
4. Event creation + multi-user management — future spec

## Overview

Add user identity to leszy.run using Supabase Auth. Authenticated users get a public profile at `/u/:username`, a private dashboard at `/profil`, a contribution history tied to the existing community flows (event reports, event submissions, general feedback), and auto-awarded badges for community activity.

No Fastify backend changes — all reads use Supabase JS with RLS; all writes use Supabase Edge Functions with JWT validation.

## Architecture

```
public app (leszy.run)
    │
    ├── reads  → Supabase DB (RLS: anon reads public data; owner reads own private data)
    └── writes → Supabase Edge Functions (validate JWT → service_role SQL)
                        │
                        └── Supabase DB (service_role bypasses RLS, full control)
```

Edge Functions are the only write path for authenticated user data. The public app never writes directly to user tables.

## Auth

**Provider:** Supabase Auth — magic link + OTP in the same email. No passwords stored. No social login (can be added later without structural changes).

**Session duration:** 60 days (`JWT_EXPIRY = 5184000`).

**Email contains:**
- 6-digit OTP code (user types it in)
- One-click magic link button (click → instantly logged in)

**First-login onboarding:**

1. User submits email → Supabase sends magic link + OTP
2. User authenticates → Supabase creates `auth.users` row
3. If no `profiles` row exists → redirect to `/onboarding`
4. `/onboarding` form: username (required), display name (optional), club/association (optional)
5. On submit → `update-profile` Edge Function → creates `profiles` row → redirect to `/profil`

**Username rules:** 3–30 chars, lowercase alphanumeric + underscore (`/^[a-z0-9_]{3,30}$/`). Unique — checked in Edge Function before save. Changing username is out of scope for this spec.

**Routes:**

| Route | Access | Notes |
|---|---|---|
| `/login` | Public | Redirects to `/profil` if already logged in |
| `/onboarding` | Auth-required | Redirects to `/profil` if profile already exists |
| `/profil` | Auth-required | Private dashboard |
| `/u/:username` | Public | Profile visible to anyone |

## Data Model

All tables are Supabase-only. No Drizzle schema. Applied via `mcp__supabase__apply_migration`.

### `profiles`

```sql
CREATE TABLE profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT,
  club TEXT,
  avatar_url TEXT,
  bio TEXT,
  privacy_settings JSONB NOT NULL DEFAULT '{"display_name": true, "club": true, "bio": true}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX profiles_username_idx ON profiles(username);
CREATE INDEX profiles_club_idx ON profiles(club);
```

`privacy_settings` keys: `true` = field is public, `false` = hidden from non-owners. `avatar_url` is always public (choosing to upload an avatar implies intent to display it). New profile fields in the future only need a default entry added to `privacy_settings` — no schema migration.

### `profiles_public` view

Masks privacy-controlled fields for non-owners. Anonymous users and non-owner authenticated users always read from this view — never from the `profiles` table directly.

```sql
CREATE OR REPLACE VIEW profiles_public AS
SELECT
  id,
  username,
  CASE WHEN (privacy_settings->>'display_name')::boolean THEN display_name ELSE NULL END AS display_name,
  CASE WHEN (privacy_settings->>'club')::boolean       THEN club           ELSE NULL END AS club,
  CASE WHEN (privacy_settings->>'bio')::boolean        THEN bio            ELSE NULL END AS bio,
  avatar_url,
  created_at
FROM profiles;
```

### RLS on `profiles`

```sql
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- Owner can read their own full row (bypasses the view masking)
CREATE POLICY "Owner reads own profile" ON profiles
  FOR SELECT TO authenticated USING (id = auth.uid());

-- Only Edge Functions (service_role) can INSERT / UPDATE / DELETE
```

No SELECT policy for anon or other authenticated users — they use the view.

### Changes to existing tables

Add nullable `user_id` to existing community tables so submissions can be tied to users. Existing rows stay valid (NULL = anonymous).

```sql
ALTER TABLE calendar_event_reports ADD COLUMN user_id UUID REFERENCES auth.users(id);
ALTER TABLE website_feedback        ADD COLUMN user_id UUID REFERENCES auth.users(id);
ALTER TABLE calendar_events         ADD COLUMN submitted_by UUID REFERENCES auth.users(id);
```

### `badge_definitions`

```sql
CREATE TABLE badge_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  icon TEXT NOT NULL,
  condition_type TEXT NOT NULL,
  condition_value INTEGER
);
```

`condition_type` values: `first_contribution`, `accepted_reports_count`, `accepted_submissions_count`, `accepted_count`, `club_set`.

**Seed data:**

| slug | name | icon | condition_type | condition_value |
|---|---|---|---|---|
| `pioneer` | Pionier | ★ | `first_contribution` | — |
| `discoverer` | Odkrywca | 🗺 | `accepted_submissions_count` | 1 |
| `guardian` | Strażnik | 🛡 | `accepted_reports_count` | 5 |
| `veteran` | Weteran | ⚡ | `accepted_count` | 20 |
| `legend` | Legenda | 🏆 | `accepted_count` | 50 |
| `club` | Klubowicz | 🏃 | `club_set` | — |

New badges are added by inserting rows — no code change required unless a new `condition_type` is introduced.

### `user_badges`

```sql
CREATE TABLE user_badges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  badge_id UUID NOT NULL REFERENCES badge_definitions(id),
  awarded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, badge_id)
);

ALTER TABLE user_badges ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read badges" ON user_badges
  FOR SELECT TO anon, authenticated USING (true);
-- Only service_role (Edge Functions) can INSERT
```

### `notification_preferences` (stub for next spec)

Schema only — no UI or logic in this spec. Exists so the notifications spec has no blocking migration.

```sql
CREATE TABLE notification_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  email_enabled BOOLEAN NOT NULL DEFAULT true,
  push_enabled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### Future: `event_favorites` (not built in this spec)

```sql
-- Planned — do NOT apply yet
CREATE TABLE event_favorites (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  calendar_event_id UUID NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, calendar_event_id)
);
-- calendar_events will also need: favorites_count INTEGER DEFAULT 0
```

`profiles.club` is indexed specifically for the future "your club-mate favorited this event" social feature. Do not remove the index.

## Edge Functions

### `update-profile`

**Triggered by:** `/onboarding` form, `/profil` edit actions.

```
POST /functions/v1/update-profile
Authorization: Bearer <supabase_jwt>
Body: { username?, display_name?, club?, bio?, avatar_url?, privacy_settings? }
```

1. Validate JWT → extract `user_id`
2. If `username` in body: validate regex, check uniqueness → 409 if taken
3. If no `profiles` row → INSERT (onboarding path)
4. Else → UPDATE only provided fields
5. If `club` changed from null to a value → run badge check for `club_set`
6. Return updated profile

### `submit-contribution`

**Triggered by:** ReportEventModal, DodajWydarzenie, FeedbackModal.

```
POST /functions/v1/submit-contribution
Authorization: Bearer <supabase_jwt>   (optional — anon path still works without it)
Body: { type, reference_id?, payload }
```

`type` values: `event_report`, `event_submission`, `general_feedback`.

1. If `Authorization` header present → validate JWT → set `user_id`
2. Based on `type`:
   - `event_report` → INSERT into `calendar_event_reports` with `user_id`
   - `event_submission` → INSERT into `calendar_events` with `submitted_by = user_id`, `status = 'pending'`
   - `general_feedback` → INSERT into `website_feedback` with `user_id`
3. If `user_id` set → run badge check for `pioneer` (first-ever contribution)
4. Return created record id

Anonymous submissions (no header) proceed unchanged — this is not a breaking change to existing flows.

### `admin-review-contribution`

**Triggered by:** Admin moderation UI accept/reject actions.

```
POST /functions/v1/admin-review-contribution
Authorization: Bearer <supabase_jwt>
Body: { type, id, action: 'accept' | 'reject', admin_note? }
```

1. Validate JWT → check if user is admin (checked against `ADMIN_USER_IDS` Edge Function secret — comma-separated list of UUID strings; role table is future scope)
2. → 403 if not admin
3. UPDATE `status` on the relevant table
4. If `action = 'accept'` and the record has a `user_id` → run full badge check for that user:
   - Count accepted reports, accepted submissions, total accepted contributions, club set
   - Compare against all `badge_definitions`
   - INSERT newly-earned badges into `user_badges` (UNIQUE constraint prevents double-award)
5. Return updated record

### Badge check (internal helper, called by above functions)

```js
async function checkAndAwardBadges(supabase, userId) {
  const [reportCount, submissionCount, totalCount, hasClub, existingBadges] =
    await Promise.all([
      countAcceptedReports(userId),
      countAcceptedSubmissions(userId),
      countAllAccepted(userId),
      hasClubSet(userId),
      getExistingBadgeIds(userId),
    ]);
  const definitions = await getBadgeDefinitions();
  for (const badge of definitions) {
    if (existingBadges.includes(badge.id)) continue;
    if (qualifies(badge, { reportCount, submissionCount, totalCount, hasClub })) {
      await awardBadge(userId, badge.id);
    }
  }
}
```

## Public UI

### Navbar changes (`public/src/components/Navbar.jsx`)

- Logged-out state: "Zaloguj się" link → `/login`
- Logged-in state: `@username` chip with dropdown → links to `/profil`, logout action

### Profile layout (Sidebar A — approved)

**`/u/:username` — public view** (reads from `profiles_public` view):

- Left sidebar: avatar, `@username`, display name (if public), club (if public), stats row (contributions total, accepted count, badge count), badge list with icons
- Main panel: contribution history — type chip, event name/link, status badge, date. Shows only `accepted` and `pending` contributions publicly; `rejected` entries are hidden from public view.

**`/profil` — private dashboard** (reads from `profiles` table directly via owner RLS policy):

- Same sidebar layout, but all fields visible regardless of privacy settings, edit button per field, privacy toggle per field
- Main panel: full contribution history with status filter tabs (Wszystkie / Oczekujące / Zaakceptowane / Odrzucone)
- Notification preferences stub panel at bottom: "Powiadomienia — wkrótce" placeholder (wired to `notification_preferences` table schema)

### Integration with existing community flows

No breaking changes. The existing anonymous flows continue to work:

- **ReportEventModal** — if user is logged in, include `Authorization: Bearer <jwt>` on `submit-contribution` call; if logged out, call proceeds without header
- **DodajWydarzenie** — same pattern; `submitted_by` gets set when logged in
- **FeedbackModal** — same pattern

## Testing

End-to-end and integration tests are a first-class deliverable. Every feature must have test coverage exercising the complete path as a real user would — not just unit tests of isolated functions.

### E2E tests — Playwright

**Location:** `public/tests/auth/` (new directory)

| Test | Scenario |
|---|---|
| Magic link auth | Enter email → poll Inbucket API → click link → land on `/onboarding` |
| OTP auth | Enter email → poll Inbucket API → type 6-digit code → land on `/onboarding` |
| Onboarding — username taken | Submit taken username → error shown, not submitted |
| Onboarding — happy path | Set username + club → submit → land on `/profil` with correct data |
| Profile edit | Change display name → toggle privacy off → visit `/u/:username` → field is null |
| Submit event report (logged in) | Open ReportEventModal → submit → contribution appears in `/profil` as pending |
| Submit event report (anon) | Same modal without login → submits successfully, no profile entry |
| Submit new event (logged in) | Fill DodajWydarzenie → submit → appears in `/profil` contribution history |
| View public profile | Visit `/u/:username` as anon → see badges, stats, public fields only |
| Session persistence | Log in → close tab → reopen `/profil` → still authenticated |
| Unauthenticated redirect | Visit `/profil` without login → redirected to `/login` |

**Test email:** Supabase local dev exposes Inbucket at `http://localhost:54324/monitor`. Playwright reads magic link and OTP from the Inbucket REST API — no real email sending in tests.

### Integration tests — Edge Functions

**Location:** `supabase/functions/tests/`

Uses local Supabase stack (`supabase start`). Tests call Edge Functions via HTTP with real JWTs minted for test users via the local Admin API.

| Test | Covers |
|---|---|
| `update-profile` — new user | Profile created, username stored |
| `update-profile` — duplicate username | Returns 409 |
| `update-profile` — privacy toggle | Field masked in `profiles_public` view after update |
| `update-profile` — club set | `club_set` badge awarded |
| `submit-contribution` — authed event_report | Row in `calendar_event_reports` has correct `user_id` |
| `submit-contribution` — anon event_report | Row created, `user_id` is null, no badge check attempted |
| `submit-contribution` — first ever | `pioneer` badge awarded |
| `admin-review-contribution` — accept | Status updated, badge check runs |
| `admin-review-contribution` — non-admin | Returns 403 |
| Badge — guardian threshold | 5th accepted report → guardian badge awarded |
| Badge — no double-award | 6th accepted report → guardian still only one row in `user_badges` |
| Badge — veteran threshold | 20th accepted contribution → veteran badge awarded |

### RLS tests

SQL-level tests (pgTAP or Supabase test framework):

- Anon `SELECT` on `profiles` table → 0 rows (RLS blocks it)
- Authenticated user `SELECT` on another user's `profiles` row → 0 rows
- `profiles_public` view returns `NULL` for fields with `privacy_settings = false`
- Anon `INSERT` into `user_badges` → rejected by RLS
- Anon `SELECT` on `user_badges` → allowed (policy permits)

## Design Constraints for Future Specs

- `notification_preferences` schema is in place — the notifications spec builds on it without a blocking migration
- `profiles.club` is indexed — club-based social queries for the favorites feature will use this index
- `event_favorites` schema is documented above — apply it when the favorites spec starts; do not apply now
- `calendar_events.favorites_count` column is added in the favorites spec — do not add it now
- Admin role is currently a hardcoded `user_id` list in Edge Functions — a `user_roles` table is future scope and should not block this spec
