# Event Favorites (Star), Notifications & Club Visibility — Design

**Date:** 2026-06-04
**Status:** Approved
**Branch:** feat/auth-profiles-contributions-badges
**Extends:** [2026-05-19-auth-profiles-contributions-badges-design.md](2026-05-19-auth-profiles-contributions-badges-design.md) (sub-projects 2 + 3 from its roadmap, merged), [2026-06-03-clubs-entity-username-check-design.md](2026-06-03-clubs-entity-username-check-design.md) (the anticipated "club-mate favorited this event" feature)

## Problem

Logged-in users have no way to shortlist races they care about. Once they find an event in
the kalendarz, nothing tells them when it gets cancelled, when registration opens, or when
the registration deadline approaches. Club members can't see which races their club-mates
are planning to run.

## Scope

1. **Star button** on calendar events — builds a per-user shortlist ("obserwowane")
2. **In-app notifications** for exactly three event changes (see Notification types)
3. **Opt-in weekly email digest** of those changes (SendGrid Pro — volume is not a concern)
4. **Club visibility** — club members see which events club-mates star, on by default,
   opt-out via `privacy_settings`
5. **Cancelled events become publicly visible** with an ODWOŁANY badge (today they vanish
   because public queries filter `status = 'active'`)

Out of scope: "new event matches your interests" alerts (saved filters — future spec),
notifications for any other field changes (price, date, distances — explicitly rejected),
immediate per-event emails.

## Notification types — exactly three, nothing else

| type | Trigger | Producer |
|---|---|---|
| `cancelled` | `calendar_events.status` transitions to `'cancelled'` | DB trigger |
| `registration_opened` | `registration_url` goes NULL/empty → non-empty | DB trigger |
| `deadline_soon` | `registration_deadline` is within 7 days | Daily script |

- `cancelled` comes from the **existing** community report flow: user reports "Wydarzenie
  odwołane" in `ReportEventModal`, admin accepts, `calendarEventReports.js` sets
  `status = 'cancelled'`. Cancelled ≠ rejected/merged — cancelled events stay in the DB and
  stay visible in the UI.
- `deadline_soon` is a **range** check (deadline within `[today, today+7]` and no
  `deadline_soon` row yet), not an equality check — a deadline *added* 4 days out still fires.
- The 7-day window guarantees the weekly digest always catches `deadline_soon` in time,
  so no notification type needs immediate email.

## Architecture — fan-in, not fan-out

Notifications are stored **once per event** (`event_notifications`), never per user. A
user's feed is computed at read time: notifications for their starred events, created after
they starred. At 1k active users this query is trivial; per-user notification rows
(fan-out-on-write) are a 100k+ user problem and would cost 20–30× the storage plus pruning
jobs.

**Storage estimate at 1k active users** (avg 15–25 stars each, ~1,100 future events):
`event_favorites` ~20k rows ≈ 2.5 MB; `event_notifications` ~5–9k rows/year ≈ 2–3 MB/year.
Total <10 MB/year against a 500 MB free-tier cap (current DB: 30 MB). Storage is a non-issue.

## Data model (Supabase-only — apply via `mcp__supabase__apply_migration`)

```sql
CREATE TABLE event_favorites (
  user_id    UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  event_id   UUID NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, event_id)
);
CREATE INDEX event_favorites_event_idx ON event_favorites(event_id);

CREATE TABLE event_notifications (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id   UUID NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  type       TEXT NOT NULL CHECK (type IN ('cancelled', 'registration_opened', 'deadline_soon')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, type)
);
```

`UNIQUE (event_id, type)` means each notification type fires **at most once per event**.
This also neutralizes the enricher-audit edge case: `audit --apply` nulls a
`registration_url`, re-enrichment refills it → the second NULL→value transition hits the
unique constraint → no duplicate "zapisy ruszyły".

**`profiles` additions:**

```sql
ALTER TABLE profiles
  ADD COLUMN notifications_seen_at TIMESTAMPTZ,
  ADD COLUMN weekly_digest BOOLEAN NOT NULL DEFAULT false;  -- digest is OPT-IN
```

`privacy_settings` gains a `"favorites": true` key (club-visible by **default**, opt-out
toggle in /profil). Per the profiles spec, new keys need only a default — no migration of
existing rows beyond a backfill UPDATE.

**Feed semantics:**

- Feed = `event_notifications` rows joined to the user's `event_favorites` where
  `notification.created_at > favorite.created_at` — no notifications for things that
  happened before you starred.
- Unread = feed rows where `created_at > profiles.notifications_seen_at` (single cursor,
  no per-notification read state). Opening the feed sets the cursor to now().

## Producers

### DB trigger on `calendar_events`

`AFTER UPDATE` trigger inserting into `event_notifications` (with `ON CONFLICT DO NOTHING`)
on exactly two transitions:

1. `NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled'`
2. `(OLD.registration_url IS NULL OR OLD.registration_url = '') AND NEW.registration_url IS NOT NULL AND NEW.registration_url <> ''`

A trigger (vs application code) catches every writer — admin accept route, edge functions,
enricher sync, pipeline publish — and by construction ignores pipeline timestamp noise
(`scraped_at` / `enriched_at` / `updated_at` touches don't match either condition).

### Daily deadline script (scheduler container, ~08:30 Europe/Warsaw)

Backend script `scripts/run-deadline-notifications.js` (backend already holds the Supabase
service key), invoked by the scheduler like the pipeline steps:

```sql
INSERT INTO event_notifications (event_id, type)
SELECT id, 'deadline_soon' FROM calendar_events
WHERE status = 'active'
  AND registration_deadline BETWEEN CURRENT_DATE AND CURRENT_DATE + 7
ON CONFLICT (event_id, type) DO NOTHING;
```

Only events someone starred matter for delivery, but inserting for all qualifying events is
simpler and the row count is tiny; the feed join filters naturally.

### Weekly digest (scheduler container, Monday morning)

Backend script `scripts/run-weekly-digest.js`, reusing the scheduler's existing SendGrid
config (`SENDGRID_API_KEY` / `SENDGRID_FROM_EMAIL`). For each user with
`weekly_digest = true`: collect `event_notifications` from the last 7 days on their starred
events (respecting the `created_at > favorite.created_at` rule) → if non-empty, send one
email. SendGrid Pro — no daily-send-cap concerns. Failures alert via the scheduler's
existing `[FAIL]` email path.

## Write path & reads — Edge Functions (custom auth)

Per the [custom-auth spec](2026-05-20-custom-auth-design.md), there is no Supabase Auth —
sessions live in `auth_sessions` validated via the `leszy_session` cookie by
`_shared/session.js`. `auth.uid()` RLS is unavailable. So: **all authenticated reads AND
writes go through Edge Functions** (service_role); the anon key stays public-read-only for
calendar data.

Both new tables get `ENABLE ROW LEVEL SECURITY` with **no policies** — anon/authenticated
see nothing; only service_role (edge functions, backend scripts) can touch them.

New Edge Functions (all use `getSession` → 401 without a valid cookie):

- **`toggle-favorite`** — body `{ event_id }`. Validates the event exists with status
  `active`/`cancelled`, then inserts or deletes the favorite for the session user.
  Returns `{ starred: boolean }`.
- **`get-favorites`** — returns `{ events: [...starred events with name/date/status/...],
  clubCounts: { event_id: N } }`. Club counts cover favorites of *other* members of the
  user's club whose `privacy_settings->>'favorites'` is not false. Serves the kalendarz
  star state, the club filter, and the /profil starred list.
- **`get-notifications`** — body `{ markSeen?: boolean }`. Returns the feed (notifications
  for starred events with `notification.created_at > favorite.created_at`, newest first,
  with event name/date), plus `unseenCount` vs `profiles.notifications_seen_at`. With
  `markSeen: true`, sets the cursor to now().

Modified Edge Functions:

- **`update-profile`** — accepts `weekly_digest` (boolean); `privacy_settings` updates
  already pass through.
- **`get-profile-data`** — include `weekly_digest` in the profile select.
- **`export-my-data`** — include favorites and `weekly_digest` (GDPR export completeness).

## UI (public app)

- **Star button** on `EventRow` (kalendarz list) and the event page (`/kalendarz/:slug`).
  OVERDRIVE style: rectangular, border-style, acid-yellow fill when starred. Anonymous
  click → existing login prompt with `?from=` return-path.
- **First-star popover** (the "make it clear in UI" requirement) — shown once per user on
  their first star: *"Obserwujesz ten bieg. Dostaniesz powiadomienie gdy: bieg zostanie
  odwołany, pojawi się link do zapisów, zostanie 7 dni do końca zapisów."* With a link to
  the digest opt-in in /profil.
- **/profil → "Obserwowane"** — starred events list (unstar inline) + notification feed;
  digest opt-in toggle; privacy toggle "Pokazuj klubowiczom co obserwuję" (default on).
- **Navbar auth chip** — unread count badge (feed rows newer than `notifications_seen_at`).
- **Club filter on kalendarz** — "Obserwowane w moim klubie" toggle (visible only to
  logged-in users with a club) + per-row "★ N z Twojego klubu" count. Backed by the RLS
  policy above; one batched query per page, not per row.
- **Cancelled events visible:** `Kalendarz.jsx` and `EventPage.jsx` change from
  `.eq('status','active')` to `.in('status', ['active','cancelled'])`, and
  `backend/scripts/publish-event-pages.js` includes cancelled events in the manifest so
  pre-rendered event pages stay live (no 404s for indexed URLs). Red **ODWOŁANY** badge;
  registration CTA hidden on cancelled events. `NearbyEvents.jsx` and `LandingPage.jsx`
  deliberately stay active-only — promotional surfaces shouldn't advertise cancelled races.
  Cancelled is sticky — scraper/enricher updates must not resurrect status (publish step
  already only inserts; verify enricher sync does not write `status`).

## Housekeeping

- **Duplicates:** there is no event-merge endpoint — admin resolves duplicates by
  rejecting the loser (soft-delete to `status='rejected'`). A starred rejected event simply
  stops appearing (feed/list queries filter to active+cancelled); no notification fires
  (the user explicitly distinguished cancelled from rejected/merged). No repointing — YAGNI.
- **GDPR** (ties into [2026-06-03-gdpr-compliance-design.md](2026-06-03-gdpr-compliance-design.md)):
  favorites are personal data → ON DELETE CASCADE covers erasure; add favorites + digest
  opt-in to the data export; privacy policy must state club-visibility-by-default and the
  opt-out.
- **No Drizzle/local-DB involvement** — all tables are Supabase-only, same as profiles/clubs.

## Testing

- **Trigger:** unit-test via SQL — status flip fires once; second flip no-op (unique);
  pipeline-style touch (only `enriched_at`/`updated_at`) fires nothing; URL NULL→value
  fires; value→value change doesn't; null-then-refill doesn't duplicate.
- **Edge Functions:** `toggle-favorite` happy path, toggle-off, unauth 401, unknown
  event 404. `get-favorites` club visibility: same-club counted; same-club + privacy
  off → not counted; different club → not counted; own favorites never in clubCounts.
- **Feed semantics:** notification created before star is excluded; unread cursor math.
- **E2E (Playwright):** star as logged-in user → appears in /profil; anon star click →
  login prompt; cancelled event shows ODWOŁANY badge in kalendarz.
- **Digest script:** dry-run flag printing would-send summary, consistent with pipeline
  script conventions (`--apply` to actually send).
