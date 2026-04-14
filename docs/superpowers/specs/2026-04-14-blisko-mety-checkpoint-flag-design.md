# Blisko Mety — Near-Finish Checkpoint Flag

**Date:** 2026-04-14
**Status:** Draft

## Problem

The current "Na Trasie" tab in the public results view tries to show all on-course runners with complex cross-category position estimation. The ordering is misleading (mixes categories with different distances, stale observations look live, cross-category ranking is meaningless). The feature is over-engineered for what spectators actually want: knowing who's close to the finish line.

## Solution

Replace the "Na Trasie" concept with a simpler "Blisko Mety" (close to finish) feature. Instead of tracking all runners across all checkpoints, show only runners observed at a single designated near-finish checkpoint.

## Design

### Data Model

Add `is_near_finish` boolean column to the `checkpoints` table (default `false`).

**Migration `0025_checkpoint_near_finish.sql`:**
```sql
ALTER TABLE checkpoints ADD COLUMN is_near_finish BOOLEAN NOT NULL DEFAULT false;
```

**Supabase:** Apply the same migration via `mcp__supabase__apply_migration`.

**Drizzle schema** (`backend/src/db/schema.js`): Add `isNearFinish: boolean('is_near_finish').default(false)` to the `checkpoints` table definition.

**Constraint:** At most one checkpoint per event can have `is_near_finish = true`. Enforced in the backend API (not a DB constraint — simpler to manage and gives better error messages).

### Backend API Changes

**`POST /events/:eventId/checkpoints`** and **`PATCH /checkpoints/:id`:**
- Accept `isNearFinish` boolean in body
- On create/update with `isNearFinish: true`: query existing checkpoints for that event where `is_near_finish = true`. If one exists (and it's not the same checkpoint being updated), return `409 { error: 'Tylko jeden punkt kontrolny może być oznaczony jako "blisko mety"' }`.
- On update with `isNearFinish: false`: just clear it, no validation needed.

**`GET /events/:eventId/checkpoints`:** Already returns all columns — `isNearFinish` will be included automatically from Drizzle.

### Frontend Admin UI Changes

**Checkpoint dialog** (`frontend/src/pages/EventDetail.jsx`):
- Add a checkbox/toggle: "Blisko mety" with helper text: "(wyświetla zakładkę 'Blisko Mety' na stronie publicznej)"
- Add to `cpForm` state: `isNearFinish: false` (default), populate from existing checkpoint on edit.
- **Validation:** If another checkpoint in the event already has `isNearFinish: true`, disable the toggle and show which checkpoint has it (e.g., "Punkt 'Km 9' jest już oznaczony jako blisko mety"). Backend 409 is the safety net.

**Checkpoint list** (`frontend/src/pages/EventDetail.jsx`):
- Show a small badge/indicator next to checkpoints that have `isNearFinish: true` (e.g., a yellow "BLISKO METY" badge).

### Public Results Page Changes

**Tab visibility** (`public/src/pages/Results.jsx`):
- Current: "Na Trasie" tab shown when `!allRacesFinished`
- New: "Blisko Mety" tab shown when `!allRacesFinished` AND a checkpoint with `is_near_finish = true` exists for this event
- The public page already fetches checkpoints from Supabase. Filter for `is_near_finish = true` to determine tab visibility.

**Tab label:** "Blisko Mety" (replaces "Na Trasie")

### New "Blisko Mety" Component

Replace `LiveTracking.jsx` with a simpler `NearFinish.jsx` in `public/src/pages/`.

**Data fetching:**
1. Find the checkpoint with `is_near_finish = true` for this event
2. Find active/finished race runs
3. Fetch `checkpoint_observations` for that checkpoint, filtered to observations after the race started
4. Join with participants (via `participant_id` or `bib_number`) to get names, bibs, categories

**Display:** Simple table, no top-3 cards, no position estimation:

| Nr | Zawodnik | Kategoria | Godzina |
|----|----------|-----------|---------|
| #12 | Jan Kowalski | 10km | 14:32:05 |
| #45 | Anna Nowak | 5km | 14:31:48 |

- Sorted by `observed_at` descending (most recent observation first — "who just passed")
- Category name shown for context
- Real-time: subscribe to `checkpoint_observations` inserts for this specific checkpoint ID
- Also poll every 10s as fallback (same as current)

**Mobile:** Same table, responsive — no separate card layout needed for this simple data.

**Empty state:** "Nikt jeszcze nie minął tego punktu. Ta strona aktualizuje się automatycznie."

### What Gets Removed

- `public/src/pages/LiveTracking.jsx` — replaced entirely by `NearFinish.jsx`
- The `estimatePositions()` call and cross-category sort logic from the live tracking view
- References to `LiveTracking` in `Results.jsx` import/routing

### What Stays Unchanged

- `CheckpointTrackingTable` in the full results grid (shows all checkpoint columns per category)
- `estimatePositions()` in podium/results views
- Volunteer interface (`Volunteer.jsx`)
- Checkpoint observations API
- Admin "Na trasie" section in `RaceControl.jsx` and `Results.jsx` (admin-facing, different purpose — shows who hasn't finished yet)

## Edge Cases

1. **No near-finish checkpoint defined:** Tab simply doesn't appear. No degraded fallback.
2. **Near-finish checkpoint deleted mid-race:** Tab disappears. Observations remain in DB. No crash.
3. **Checkpoint is private AND near-finish:** The public tab should still work — `is_near_finish` overrides `private` for this tab's visibility. The checkpoint won't appear in the regular `CheckpointTrackingTable` columns (filtered by `private != true`), but the "Blisko Mety" tab queries specifically by `is_near_finish = true` regardless of `private`.
4. **Multiple categories, one near-finish checkpoint:** All categories' runners shown in one list (with category column). The checkpoint's `categoryIds` restriction still applies — if it's restricted to certain categories, only those categories' runners appear.
5. **Runner observed multiple times at same checkpoint:** Show only the first observation (earliest `observed_at`). Dedup in the component by `participantId` (or `bibNumber` if no participant match), keeping the earliest `observedAt`.
