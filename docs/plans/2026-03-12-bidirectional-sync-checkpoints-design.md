# Design: Bidirectional Sync, Checkpoints & Live Results

Date: 2026-03-12

## Summary

Extend LeszyRun with:
1. Bidirectional Supabase sync (Supabase → local via Realtime subscriptions)
2. Volunteer checkpoint observation app (`volunteer/`)
3. Public live results app (`liveresults/`)
4. Shared UI component library (`packages/ui`)
5. Checkpoint management in LeszyRun admin UI

---

## Monorepo structure after this change

```
LeszyRun/
  backend/          existing — gains Realtime subscriptions, checkpoint routes, new tables
  frontend/         existing — gains checkpoint management UI, enhanced podium
  volunteer/        NEW — mobile-first bib entry, fire-and-forget to Supabase
  liveresults/      NEW — public live results + podium, reads Supabase Realtime directly
  packages/
    ui/             NEW — shared components reused by frontend/ and liveresults/
```

---

## Architecture

### Data flow

```
LeszyRun backend ──push──▶ Supabase ◀──── volunteer app (anon key, INSERT only)
                               │
                    Realtime subscriptions
                               │
              ┌────────────────┴────────────────┐
              ▼                                  ▼
    LeszyRun backend                    liveresults browser
    (merges to local DB,                (recomputes positions
     broadcasts via WS)                 client-side, no server)
```

### Key principles

- No polling anywhere — all Supabase → local flow is event-driven via Realtime
- `liveresults/` is a purely static app — no server to operate, just Netlify/GitHub Pages
- LeszyRun backend keeps using service role key; volunteer and liveresults use anon key + RLS
- Local PostgreSQL remains the source of truth for all RFID timing data

---

## Database changes

### New tables

```sql
-- Checkpoints configured per event
checkpoints (
  id            uuid PK DEFAULT gen_random_uuid(),
  event_id      uuid FK → events.id ON DELETE CASCADE,
  name          text NOT NULL,       -- e.g. "Km 5 – Górka"
  km_marker     int,                 -- display only, nullable
  created_at    timestamptz DEFAULT now(),
  synced_at     timestamptz
)

-- Which categories a checkpoint applies to
checkpoint_categories (
  checkpoint_id uuid FK → checkpoints.id ON DELETE CASCADE,
  category_id   uuid FK → categories.id ON DELETE CASCADE,
  PRIMARY KEY (checkpoint_id, category_id)
)

-- Volunteer observations: one row per bib seen at a checkpoint
checkpoint_observations (
  id              uuid PK DEFAULT gen_random_uuid(),
  checkpoint_id   uuid FK → checkpoints.id ON DELETE CASCADE,
  bib_number      int NOT NULL,
  participant_id  uuid FK → participants.id ON DELETE SET NULL,  -- resolved locally on arrival
  observed_at     timestamptz NOT NULL,
  synced_at       timestamptz,
  UNIQUE (checkpoint_id, bib_number)   -- first observation wins, duplicates dropped
)
```

### Modified tables

```sql
-- participants gains updated_at for Realtime loop-dedup
ALTER TABLE participants ADD COLUMN updated_at timestamptz;
-- Set on every PATCH via backend route
```

---

## Supabase Realtime subscriptions (backend)

Added to `backend/src/sync/supabase.js` alongside existing push sync.

### `participants` channel
- Events: INSERT, UPDATE
- Handler: upsert into local DB if `updated_at` from Supabase is newer than local — prevents loop when LeszyRun's own push sync triggers a Realtime event back

### `checkpoint_observations` channel
- Events: INSERT only
- Handler:
  1. Resolve `participant_id` by looking up `bib_number` within the event (via checkpoint → event join)
  2. Write to local `checkpoint_observations` with resolved `participant_id`
  3. Broadcast `checkpoint:observation` WebSocket event to all connected LeszyRun frontend clients

---

## Supabase RLS policies

```sql
-- checkpoints: public read
CREATE POLICY "anon read checkpoints" ON checkpoints FOR SELECT TO anon USING (true);

-- checkpoint_categories: public read
CREATE POLICY "anon read checkpoint_categories" ON checkpoint_categories FOR SELECT TO anon USING (true);

-- checkpoint_observations: public read + insert (dedup handled by unique constraint)
CREATE POLICY "anon read observations" ON checkpoint_observations FOR SELECT TO anon USING (true);
CREATE POLICY "anon insert observations" ON checkpoint_observations FOR INSERT TO anon WITH CHECK (true);

-- events: public read
CREATE POLICY "anon read events" ON events FOR SELECT TO anon USING (true);

-- categories: public read
CREATE POLICY "anon read categories" ON categories FOR SELECT TO anon USING (true);

-- participants: public read of display fields only
CREATE POLICY "anon read participants" ON participants FOR SELECT TO anon
  USING (true)
  -- Column-level: bib_number, first_name, last_name, category_id only
  -- (enforced in app layer since Supabase column-level security requires Postgres 15+)

-- results: public read
CREATE POLICY "anon read results" ON results FOR SELECT TO anon USING (true);

-- gate_crossings: public read
CREATE POLICY "anon read gate_crossings" ON gate_crossings FOR SELECT TO anon USING (true);
```

---

## Position estimation algorithm

Used by both `frontend/` (enhanced podium) and `liveresults/` (via shared logic or duplicated).

Given a list of participants in a race run:

1. **Finished** (`status = 'finished'`): ranked by `duration_ms` ascending
2. **At checkpoint, not finished**: ranked by furthest checkpoint reached (highest `km_marker`), then earliest `observed_at` at that checkpoint
3. **Started, no checkpoint data**: ranked after group 2, by `start_time` ascending (started earlier = ahead)
4. **Not yet started**: ranked last

Display:
- Groups 1: "FINAL" badge
- Groups 2–4: "LIVE" badge with a pulsing indicator during active race

---

## New backend routes

```
GET  /api/events/:id/checkpoints          list checkpoints for event (with categories)
POST /api/events/:id/checkpoints          create checkpoint
PATCH /api/checkpoints/:id               update name, km_marker, categories
DELETE /api/checkpoints/:id              delete checkpoint
GET  /api/checkpoints/:id/observations   list observations (for admin/debug)
```

New WebSocket event:
```
checkpoint:observation  { checkpointId, checkpointName, participantId, bibNumber, firstName, lastName, observedAt }
```

---

## LeszyRun frontend changes (`frontend/`)

### EventDetail — new "Checkpoints" tab
- List of configured checkpoints with name, km marker, assigned categories
- Add / edit / delete checkpoint
- Per checkpoint: shareable URL + QR code (using a QR library)

### RaceControl — enhanced podium
- Existing podium view extended with checkpoint tracking table below
- Table: `Bib | Name | Start | [per checkpoint in km order] | Finish`
- Cells populate live via WebSocket `checkpoint:observation` event
- Position estimation runs client-side, updates on every new observation or result

---

## `volunteer/` app

Separate Vite + React project.

**URL format:** `https://volunteer-host.com/?checkpoint=<checkpoint-uuid>`

**Startup:** fetch checkpoint record from Supabase → show checkpoint name in header

**UI flow:**
1. Large numeric input (triggers numeric keyboard on mobile) + "Submit" button
2. → Confirm screen: shows bib number large, "Runner #42 — confirm?" + ✓ / ✗
3. ✓ → fire-and-forget `supabase.from('checkpoint_observations').insert(...)` — no await, no spinner
4. Immediately reset to input screen with brief "Sent ✓" flash (1s)
5. Network errors silently queued for retry — volunteer never blocked

**Mobile-first:** full-screen single-column layout, minimum 48px touch targets, system numeric keyboard.

**Deduplication:** handled by Supabase unique constraint `(checkpoint_id, bib_number)`. Second submit of same bib silently drops — volunteer sees no error.

---

## `liveresults/` app

Separate Vite + React project. Purely static — no server.

**Supabase anon key** embedded as env var (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`).

**Realtime subscriptions on mount:**
- `results` INSERT + UPDATE for active race run → recompute positions
- `checkpoint_observations` INSERT → update checkpoint tracking table

**Routes:**
- `/` → event list (fetched from Supabase on load)
- `/events/:id` → category list
- `/events/:id/:categoryId` → live podium + checkpoint tracking

**Position estimation:** identical algorithm to frontend, runs client-side.

---

## `packages/ui` shared library

Vite library mode, plain JS + React. Contains only components used by both `frontend/` and `liveresults/`:

- `Podium` — 3-box podium layout (1st elevated center, 2nd left, 3rd right) with animal avatars, LIVE/FINAL badges
- `CheckpointTrackingTable` — participant rows × checkpoint columns, fills live
- `PositionBadge` — LIVE (pulsing) / FINAL badge

Both apps import: `import { Podium, CheckpointTrackingTable } from '@leszyrun/ui'`

---

## Migration plan

One new migration file covering:
- `checkpoints` table
- `checkpoint_categories` table
- `checkpoint_observations` table
- `updated_at` column on `participants`

Registered in `_journal.json` per LeszyRun conventions.

---

## What is NOT changed

- Existing push sync (local → Supabase) unchanged
- RFID crossing detection unchanged
- `gate_events` not synced to Supabase (raw data, high volume, not needed remotely)
- `checkpoint_imports` (CSV checkpoint imports) unchanged — separate feature
