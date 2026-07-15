# Teams / Clubs — Design

**Date:** 2026-07-15
**Status:** Approved (brainstorming) — ready for implementation planning
**Feature flag:** entire feature is gated behind `useBeta()` (dark-launched, off by default), like the rest of the accounts/community product.

## Summary

Turn clubs from a loose self-declared label into a **created, owned entity**. A user
can create a club (name + logo + description), gets a **public landing page**, and
invites people to it. Confirmed members get a **club view** showing where their
clubmates are heading — aggregated from the events those clubmates follow. Members
control how they appear on the public page: by name, by nickname only, or hidden.

**Core principle:** a club exists only because someone created it. There is **no
free-text club label**. A profile shows a club only if the user created one or joined
one that exists. This removes the entire "type any name" path (`find_or_create_club`).

## Context — what already exists

The current (pre-this-feature) state, all behind `useBeta()`:

- **`clubs`** table: `id, name, normalized_name (unique), created_at`. pg_trgm GIN index
  on `normalized_name`, RLS public-read. No owner, no logo, no membership.
- **`profiles.club_id`** `UUID REFERENCES clubs(id) ON DELETE SET NULL` — a single,
  self-declared club pointer. Anyone can set it to anything via free text.
- **`find_or_create_club(club_name)`** RPC (service_role) — normalizes + upserts a club
  from free text. Called by `update-profile`. **This path is removed by this feature.**
- **`search_clubs(q)`** RPC (anon/authenticated) — top-8 fuzzy matches with a computed
  `member_count`. **Reused** by this feature.
- **`profiles_public`** SECURITY DEFINER view — privacy-masked public profile, resolves
  club name.
- **Clubmate follows (`clubCounts`)** — `get-favorites` aggregates the followed/starred
  events of *other profiles sharing the same `club_id`* who have not opted out
  (`privacy_settings.favorites !== false`). This is the **only** existing club-social
  behavior, and this feature turns it into a real club view. It keeps working unchanged
  because `club_id` still identifies clubmates.
- **Auth**: custom email-code auth. Session = a `leszy_session` httpOnly cookie backed by
  an `auth_sessions` row; `_shared/session.js` `getSession(req, supabaseAdmin)` resolves
  it. All authenticated client calls go through the same-origin **`/edge/*`** proxy
  (`FUNCTIONS_BASE` in `public/src/lib/auth.js`; `callFunction(name, body)`), never the
  raw `VITE_SUPABASE_URL`, so the cookie stays first-party.
- **Profil hub** (commit 5e62c23): `/profil` layout with deep-linked sections
  (`obserwowane`, `zgloszenia`, `ustawienia`) fed once by `get-profile-data` via
  `ProfilContext`. Public profile at `/u/:username` (`UserProfile.jsx`).
- **`profiles`** has `username` (unique @handle, used in `/u/:username`), `display_name`,
  `avatar_url`, `bio`, `privacy_settings` JSONB, `gender`, `phone`, `date_of_birth`,
  `city`, `voivodeship`, `weekly_digest`, `notifications_seen_at`, `deleted_at`.

### Live data note

At design time the live DB holds exactly **one** club
(`ZATYRANI GRATISOWNIA.PL GMINA PILCHOWICE`, the operator's own). The feature is hidden
(≈2 people know about the login/profile surface). **Decision: the migration wipes this
single club and nulls `profiles.club_id`** — there is no ownerless-club case to support.
Every club created after migration is owned.

## Decisions (resolved during brainstorming)

1. **Created-only clubs.** Every club has an owner. No loose/unmanaged tier, no
   `is_managed` flag (ownership is implied — `owner_id` is always set), no free-text label.
2. **One club identity per user.** `profiles.club_id` remains a single pointer.
   Multi-club membership is out of scope (future).
3. **Controlled joins only** — three paths, none of which is instant open self-add:
   shareable invite link/code, direct invite by email/username, and request-to-join
   (picking a club by name during onboarding/settings → pending approval).
4. **Club view = follows only.** Honest about what leszy.run knows: it aggregates the
   events clubmates *follow*, not external registrations. (Real leszy.run-race
   registration data and self-declared "I'm going" are future.)
5. **Public landing page, indexed from day one.** Server-rendered by a **Supabase edge
   function** (`render-club`), proxied at `/klub/:slug` via `public/vercel.json` — the
   same first-party proxy trick as `/edge/*`. Not a Vercel serverless function: all
   dynamic backend logic in this repo already lives in Supabase edge functions, the data
   is in Supabase (zero network hop), and this avoids putting the service-role key into
   Vercel.
6. **Member public-visibility control**, three levels: shown by `display_name` (default)
   → shown by **nickname only** → **hidden** from the public page entirely.
7. **Logo** stored in a Supabase Storage bucket (`club-logos`, public read), uploaded via
   an edge function.

## Data model (Supabase — apply via `mcp__supabase__apply_migration`)

These are Supabase-only tables (no Drizzle schema, no local migration), consistent with
`clubs`/`event_favorites`/`event_notifications`.

### `clubs` (extend existing)

```sql
ALTER TABLE clubs ADD COLUMN owner_id     UUID REFERENCES profiles(id) ON DELETE RESTRICT;
ALTER TABLE clubs ADD COLUMN slug         TEXT UNIQUE;         -- ASCII-only (see slug rule)
ALTER TABLE clubs ADD COLUMN logo_url     TEXT;
ALTER TABLE clubs ADD COLUMN description  TEXT;
ALTER TABLE clubs ADD COLUMN city         TEXT;
ALTER TABLE clubs ADD COLUMN voivodeship  TEXT;                -- capitalized (Pomorskie, …)
ALTER TABLE clubs ADD COLUMN is_public    BOOLEAN NOT NULL DEFAULT true;
-- keep: id, name, normalized_name (unique), created_at
```

- `owner_id` is `NOT NULL` for all post-migration clubs (enforced by `create-club`, not a
  table constraint, so the migration can wipe cleanly first). `ON DELETE RESTRICT`: a
  profile that owns a club cannot be hard-deleted without ownership transfer/club deletion
  first — GDPR delete flow must account for this (see Open questions).
- `slug` is generated from `normalized_name`, **ASCII-only** per the `/listy/*` slug rule
  (Polish diacritics forbidden in slugs; display text keeps diacritics). Uniqueness
  enforced; collisions get a numeric suffix.
- `is_public` toggles whether `/klub/:slug` renders a live public page.

### `club_members` (new)

```sql
CREATE TABLE club_members (
  club_id        UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  role           TEXT NOT NULL DEFAULT 'member',   -- 'owner' | 'admin' | 'member'
  status         TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'pending'
  hidden_public  BOOLEAN NOT NULL DEFAULT false,   -- omit me from the public page
  joined_at      TIMESTAMPTZ,                      -- set when status flips to 'active'
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (club_id, user_id)
);
CREATE INDEX idx_club_members_user ON club_members(user_id);
CREATE INDEX idx_club_members_club_status ON club_members(club_id, status);
```

- Exactly one `owner` row per club (the creator; transferable later).
- **Membership ↔ `profiles.club_id` sync:** when a membership becomes `active`, set that
  profile's `club_id` to the club; when a user leaves or is removed (or a pending request
  is rejected), clear `club_id` if it pointed at that club. This keeps `clubCounts` and
  all existing profile UI working. A `pending` row does **not** set `club_id`.
- Single-club invariant: a user has at most one `active` membership. Accepting/creating
  while already a member of another club is blocked with a clear error (must leave first).

### `club_invites` (new)

```sql
CREATE TABLE club_invites (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id         UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,                    -- 'link' | 'direct'
  code            TEXT UNIQUE,                      -- for kind='link' (shareable token)
  target_email    TEXT,                             -- for kind='direct'
  target_username TEXT,                             -- for kind='direct'
  created_by      UUID NOT NULL REFERENCES profiles(id) ON DELETE SET NULL,
  expires_at      TIMESTAMPTZ,
  max_uses        INTEGER,                          -- NULL = unlimited
  uses            INTEGER NOT NULL DEFAULT 0,
  revoked         BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_club_invites_code ON club_invites(code) WHERE code IS NOT NULL;
CREATE INDEX idx_club_invites_club ON club_invites(club_id);
```

- `kind='link'`: a `code` used in `/klub/:slug/dolacz?kod=CODE`. Redeeming (`accept-invite`)
  increments `uses`; blocked when `revoked`, past `expires_at`, or `uses >= max_uses`.
- `kind='direct'`: created for an email or `@username`. A direct email invite reuses the
  existing SendGrid path to notify. Invitee accepts from their profile / the invite link.

### RLS

- `clubs`: public read stays (needed for `render-club` and `search_clubs`); writes only via
  service-role edge functions.
- `club_members`, `club_invites`: no public/authenticated policies — all access via
  service-role edge functions (mirrors how `profiles` writes work today). `render-club`
  (service role) reads members for the public page and applies `hidden_public` /
  nickname masking in code.

### `profiles` (extend)

```sql
ALTER TABLE profiles ADD COLUMN nickname TEXT;   -- freeform, optional, non-unique
```

- Distinct from `username` (the unique URL handle) and `display_name`.
- **`privacy_settings`** gains `club_public_name`: `'display'` (default) | `'nickname'`.
  Used only by `render-club` to decide the public label. Inside the member-only club view
  and elsewhere, `display_name` is used as today.

### Migration steps (destructive — confirm before running)

1. `UPDATE profiles SET club_id = NULL;`
2. `DELETE FROM clubs;` (single row today)
3. Add the columns above; create `club_members`, `club_invites`; add indexes + RLS.
4. Remove the `find_or_create_club` call site (handled in `update-profile`, see below); the
   RPC itself may stay defined but unused, or be dropped.

> Per the DB-write-safety rule, these DELETE/UPDATE statements are stated here and must be
> re-confirmed at execution time even though the operator has pre-authorized the wipe.

## Backend — Supabase edge functions (`/edge/*`)

All new functions use the shared pattern: service-role `supabaseAdmin` client →
`getSession(req, supabaseAdmin)` → `401` if null (except `render-club`, which is public) →
CORS via `_shared/cors.js`. Written in JS (`index.js`), deployed via
`mcp__supabase__deploy_edge_function`. **New functions are auto-EXECUTE-granted to
anon/authenticated — no extra grants needed; `render-club` is intentionally public, the
rest verify the session inside.**

| Function | Auth | Purpose | Tables |
|---|---|---|---|
| `create-club` | member | Create a club (name, slug gen, description, optional logo). Caller becomes `owner` (active). Blocks if caller already has an active membership. | `clubs`, `club_members`, `profiles` |
| `update-club` | owner/admin | Edit name/description/logo/`city`/`voivodeship`/`is_public`. Regenerates slug only on explicit rename (avoid breaking links). | `clubs` |
| `upload-club-logo` | owner/admin | Upload image to `club-logos` bucket, set `clubs.logo_url`. Validates type/size. | Storage + `clubs` |
| `manage-club-invite` | owner/admin | Create/revoke `link` invites (code, expiry, max_uses); create `direct` invites (email/username, sends email). List active invites. | `club_invites` |
| `accept-invite` | member | Redeem a `link` code or accept a `direct` invite → `active` membership; sets `club_id`. Validates expiry/uses/revoked; enforces single-club. | `club_invites`, `club_members`, `profiles` |
| `request-join` | member | Picking a club by name (onboarding/settings) → `pending` membership. Idempotent. | `club_members` |
| `respond-join` | owner/admin | Approve (→ `active`, set `club_id`, `joined_at`) or reject (delete pending row) a request. | `club_members`, `profiles` |
| `manage-member` | see below | Change a member's role; remove a member; leave the club; toggle own `hidden_public`; set own `club_public_name`. | `club_members`, `profiles` |
| `get-club` | member | Authenticated club view: roster (with roles, pending requests for admins) + aggregated followed events of clubmates (reuses the `clubCounts` logic). | `club_members`, `profiles`, `event_favorites`, `calendar_events` |
| `render-club` | **public** | SSR: returns full HTML for `/klub/:slug` — title, meta description, canonical, `SportsTeam` JSON-LD, `robots: index,follow`. Lists members honoring `hidden_public` (omit) and `club_public_name` (nickname vs display_name). 404 if not found or `is_public=false`. | `clubs`, `club_members`, `profiles`, `event_favorites`, `calendar_events` |

`manage-member` authorization: role change / remove require owner or admin (admins cannot
touch an owner or promote past their own level; only owner assigns `admin`); leave / own
visibility toggles require the acting user to be that member. Owner cannot leave without
transferring ownership or deleting the club (Open questions).

**`update-profile` change:** remove the `find_or_create_club` free-text branch. Club is no
longer settable via free text on the profile; it changes only through create/join/leave
flows. `nickname` and `privacy_settings.club_public_name` become updatable fields.

**`get-favorites` / `clubCounts`:** unchanged. Still groups by `profiles.club_id` and
respects `privacy_settings.favorites`. The new `get-club` view reuses this aggregation.

### Vercel proxy

`public/vercel.json` (and the Vite dev proxy in `public/vite.config.js`) rewrites:

```
/klub/:slug        -> <project>.supabase.co/functions/v1/render-club?slug=:slug
```

The SPA still owns `/klub/:slug/dolacz` and the app's interactive club routes; the rewrite
targets only the bare public page for crawlers/social. The SPA hydrates interactive bits
for logged-in visitors on top of the rendered HTML.

## Frontend (`public/`) — all behind `useBeta()`

### Onboarding / settings — club picker replaces `ClubInput`

The free-text `ClubInput` combobox is replaced by a picker with three outcomes:

- **Search existing clubs** (reuses `search_clubs`) → **request to join** (`request-join`,
  pending). Shows "oczekuje na akceptację" until an admin approves.
- **"Utwórz klub"** → create flow (`create-club`), caller becomes owner.
- **Leave blank** → no club.

`public/src/pages/Onboarding.jsx` and `public/src/pages/profil/Ustawienia.jsx` +
`fields.jsx` (`EditableClubField`) are updated accordingly. `Profil.jsx handleClubSave` and
the `{club_id}`/`{club}` free-text payload are removed.

### Create / manage club (profil section)

New `/profil` section (e.g. `/profil/klub`) rendered via the existing `ProfilLayout`
outlet, fed through `ProfilContext`:

- **No club:** shows create form (name, logo upload, description) + a search-to-join box.
- **Member:** shows the member view (below) + "leave club".
- **Owner/admin:** management panel — roster with roles, **pending join requests**
  (approve/reject), **invite-link** generator (copy link, set expiry/max-uses, revoke),
  **invite by email/username**, promote/remove members, edit club (name/logo/description/
  `is_public`), and (owner) transfer/delete.

### Club member view

Roster of clubmates + **"Nadchodzące biegi, które śledzą klubowicze"** — the aggregated
followed events (reuses `clubCounts`/`get-club`), each with a **Follow / dodaj do
obserwowanych** action so a member can join in. **Follows-only**; copy is honest that this
reflects what clubmates follow, not confirmed registrations.

### Invite acceptance

Route `/klub/:slug/dolacz?kod=CODE`: if logged out → login/onboarding, preserving the code;
if logged in → confirm screen → `accept-invite` → member, land on the club view. Direct
(email/username) invites surface as an "Masz zaproszenie" prompt in profil.

### Public landing page

`/klub/:slug` is served by `render-club` SSR (real HTML for crawlers + correct OG/Twitter
previews). The SPA hydrates interactive elements for logged-in visitors. Rendering rules:

- Member label: `display_name`, or **nickname only** if that member set
  `club_public_name='nickname'`; members with `hidden_public=true` are omitted entirely.
- Includes club name, logo, description, city/voivodeship, member count, and a curated
  slice of upcoming events clubmates follow. `SportsTeam` JSON-LD.
- Static inbound links (per the SEO crawlability rule) from the club member view and
  `/u/:username` profiles so the page is discoverable, not sitemap-only.

### Member privacy controls (profil settings)

Alongside the existing "Pokazuj klubowiczom co obserwuję" toggle:

- **`nickname`** field (freeform).
- **"Na publicznej stronie klubu pokazuj tylko pseudonim"** → sets
  `privacy_settings.club_public_name = 'nickname'`.
- **"Nie pokazuj mnie na publicznej stronie klubu"** → sets `club_members.hidden_public`.

## Implementation phases (one spec, phased build)

- **Phase A — foundation:** migration (wipe + schema + `club_members` + `club_invites` +
  `profiles.nickname`), backend functions (`create-club`, `update-club`,
  `upload-club-logo`, `manage-club-invite`, `accept-invite`, `request-join`,
  `respond-join`, `manage-member`), `update-profile` change, `club-logos` bucket, and the
  create/manage UI + onboarding/settings picker.
- **Phase B — member view:** `get-club` + the club member view (roster + followed-events
  aggregate) and invite-acceptance route.
- **Phase C — public page:** `render-club`, the `/klub/:slug` Vercel/Vite rewrite,
  `SportsTeam` JSON-LD, nickname/hidden masking, and static inbound links for SEO.

## Out of scope (future)

- Clubs **organizing/owning events**, and inviting members as **event moderators** (the
  stated next stage — the `role` enum and `club_members` already leave room for it).
- **Multi-club membership.**
- **Real registration data** (leszy.run-hosted races) and self-declared "I'm going" in the
  club view — this iteration is follows-only.

## Open questions (resolve during planning)

1. **Owner deletion / GDPR erasure.** `clubs.owner_id ON DELETE RESTRICT` means
   `delete-my-account` must handle owners: force ownership transfer, or delete the club
   (cascading `club_members`/`club_invites`), before erasing the profile. Decide the
   default (probably: block deletion with a clear message until the owner transfers or
   deletes the club, surfaced in the danger zone).
2. **Ownership transfer UI** — needed for owner-leave and GDPR-delete; minimal
   "make owner" action in the roster.
3. **Logo constraints** — allowed types (png/jpg/webp/svg?), max dimensions/size, and
   whether to downscale server-side.
4. **`export-my-data`** — include club membership + owned clubs in the GDPR export.
5. **Public page caching** — `render-club` `Cache-Control` (e.g. short s-maxage +
   stale-while-revalidate) so crawlers get fresh-enough HTML without hammering Supabase.
