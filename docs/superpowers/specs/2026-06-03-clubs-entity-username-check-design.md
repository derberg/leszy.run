# Clubs entity + live username availability check — Design

**Date:** 2026-06-03
**Status:** Approved
**Branch:** feat/auth-profiles-contributions-badges
**Extends:** [2026-05-19-auth-profiles-contributions-badges-design.md](2026-05-19-auth-profiles-contributions-badges-design.md)

## Problem

1. **Username:** the onboarding form only discovers a taken username at submit time, via an
   English 409 error from `update-profile`. No live feedback while typing.
2. **Club:** `profiles.club` is free text. People mistype club names ("KB Kraków" vs
   "Klub Biegacza Kraków" vs "klub biegacza krakow"), which splinters the same club into
   multiple string values. The future "your club-mate favorited this event" social feature
   needs two members of the same club to resolve to the **same identity** — exact-string
   matching on free text cannot deliver that.

## Decision

Make clubs a first-class entity (`clubs` table + `profiles.club_id` FK) with:

- **Input-time fuzzy matching** — pg_trgm autocomplete against normalized names reduces
  duplicates at the source
- **Find-or-create on save** — exact duplicates (after normalization) auto-resolve to the
  existing club
- **Admin merge tool** — duplicates that slip through are corrected after the fact; one
  merge fixes every member atomically, forever

Cold start is organic: the table starts empty, each new free-text club name creates a row.
No external seeding.

Rejected alternatives:

- **Free text + trigram suggest + admin bulk-rename** — matching stays string-based, merges
  are lossy (no entity to anchor), same typo re-splinters later
- **Clubs + alias memory (`club_aliases`)** — smartest long-term, but YAGNI now; aliases can
  be added later without schema pain

## 1. Data model (Supabase migration — apply via `mcp__supabase__apply_migration`)

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Single source of truth for normalization: lowercase, Polish diacritics stripped,
-- punctuation removed, whitespace collapsed and trimmed.
CREATE FUNCTION normalize_club_name(input TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT trim(regexp_replace(
    regexp_replace(
      translate(lower(input),
        'ąćęłńóśźż',
        'acelnoszz'),
      '[^a-z0-9 ]', '', 'g'),   -- strip punctuation ("K.B. Kraków" ≡ "KB Kraków")
    ' +', ' ', 'g'))
$$;

CREATE TABLE clubs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,                   -- display form, as first user typed it
  normalized_name TEXT NOT NULL UNIQUE, -- normalize_club_name(name)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX clubs_normalized_trgm_idx ON clubs USING gin (normalized_name gin_trgm_ops);

ALTER TABLE profiles ADD COLUMN club_id UUID REFERENCES clubs(id) ON DELETE SET NULL;
CREATE INDEX profiles_club_id_idx ON profiles(club_id);  -- club-mate matching
ALTER TABLE profiles DROP COLUMN club;                    -- pre-launch, no data to migrate
```

- `public_profiles` view recreated: the privacy CASE for club now joins `clubs.name`
  (privacy key in `privacy_settings` stays `"club"` — no client change)
- The old `profiles_club_idx` disappears with the column; `profiles_club_id_idx` replaces
  its role for the club-mate feature
- RLS: `clubs` is world-readable (names are public data), writes only via service role /
  security-definer paths

## 2. RPCs (Postgres functions, called from the public app with the anon key)

Direct RPC instead of edge functions: no cold start, important for debounced as-you-type
calls.

```sql
-- Top 8 clubs by trigram similarity to the normalized query, with member counts.
CREATE FUNCTION search_clubs(q TEXT)
RETURNS TABLE (id UUID, name TEXT, member_count BIGINT)
LANGUAGE sql STABLE SECURITY DEFINER ...
-- WHERE normalized_name % normalize_club_name(q)
--    OR normalized_name LIKE normalize_club_name(q) || '%'
-- ORDER BY similarity DESC LIMIT 8

CREATE FUNCTION is_username_available(u TEXT)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER ...
-- format-validates, then NOT EXISTS (SELECT 1 FROM profiles WHERE username = lower(u))
```

`GRANT EXECUTE ... TO anon` on both. Both functions `SET search_path = public`.

## 3. Edge functions — API contract stays string-compatible

Reads keep returning `club` as a string so display code does not change.

| Function | Change |
|---|---|
| `auth-me` | select `club_id, clubs(name)` → respond `club: clubs?.name ?? null`, plus `club_id` |
| `get-profile-data` | same join for own profile; `public_profiles` view already resolves the name for public profiles |
| `update-profile` | accepts `club_id` (UUID, picked from dropdown → validate exists, 400 if not) **or** `club` (free text → normalize → find-or-create → set `club_id`). Empty string / null clears `club_id`. On concurrent-create unique violation: re-select by `normalized_name`, use the winner |
| `_shared/badge-check.js` | `club_set` condition reads `club_id IS NOT NULL` |

Validation: free-text club max 100 chars; normalized form must be non-empty (a value like
`"---"` normalizes to `""` → 400).

## 4. Public app UX

### ClubInput (new shared component, `public/src/components/ClubInput.jsx`)

- After 3 typed chars, 400 ms debounce → `supabase.rpc('search_clubs', { q })`
- Dropdown lists matches as `name (N członków)`; OVERDRIVE styling (rounded-none,
  apex-border, yellow focus)
- Picking a suggestion fills the input and pins `club_id`; any further typing clears
  `club_id` back to free-text mode
- Submit sends `club_id` when pinned, else `club` free text
- Used in **Onboarding** and in **Profil** edit mode (replaces the generic `EditableField`
  for the club field only)

### Username live check (Onboarding)

- After the client regex passes (`^[a-z0-9_]{3,30}$`), 400 ms debounce →
  `supabase.rpc('is_username_available', { u })`
- Inline indicator: ✓ `dostępna` (apex-yellow) / ✗ `zajęta` (apex-red) / spinner while
  checking; stale responses discarded (compare against current input value)
- Submit button not blocked by the live check (advisory only); the server-side 409 stays
  authoritative and now maps to Polish: `Ta nazwa jest już zajęta.`

## 5. Admin merge tool

Backend (Fastify, service-role Supabase client), consistent with existing admin routes:

- `GET /api/clubs` → `{ data: [{ id, name, memberCount }] }` plus similarity-grouped
  duplicate suggestions (pairs above 0.45 trigram similarity)
- `POST /api/clubs/:id/merge` body `{ sourceIds: [] }` → repoint
  `profiles.club_id` from each source to target, delete source clubs. Single transaction.
  Rejects: target in `sourceIds`, unknown IDs, empty list.

Admin frontend: new **Kluby** page (`/clubs`), same UX pattern as the calendar-events
Duplikaty tab — grouped suggestions with "Połącz" action, full club list below.

## 6. Error handling & race conditions

- Concurrent find-or-create of the same club → unique violation on `normalized_name` →
  catch `23505`, re-select, use existing row
- Live username check is advisory; submit-time check is the gate
- Merge is transactional; a failed merge changes nothing
- `ON DELETE SET NULL` on the FK means a deleted club can never strand profiles

## 7. Tests

- **SQL/RPC:** `normalize_club_name` (diacritics, casing, whitespace, punctuation),
  `search_clubs` finds "Klub Biegacza Kraków" for "kb krakow" / "biegacza" / "Krakw",
  `is_username_available` true/false/format-invalid
- **`update-profile`:** free text creates club; "KB Kraków" then "kb krakow" → same
  `club_id`; `club_id` path validates existence; clearing works; `club_set` badge awarded;
  409 unchanged for taken username
- **Public app (existing test setup):** Onboarding renders suggestions, picking pins
  `club_id`, taken username shows `zajęta`, available shows `dostępna`
- **Merge route:** members repointed, sources deleted, self-merge rejected, unknown ID
  rejected

## Out of scope (deliberate)

- Alias memory for merged names (add later if typo recurrence is real)
- External seeding of Polish clubs
- Club profile pages / club search UI for end users
- The club-mate favorites feature itself (this design only makes it possible)
