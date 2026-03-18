---
name: Brutto fallback for missing start crossing + Audit tab
description: When a participant has no RFID start crossing, automatically use gun time as startTime. Track the source. Add an extensible Audit tab to RaceControl for operator visibility and manual correction.
type: project
---

# Brutto Fallback & Audit Tab — Design

## Problem

When an RFID reader misses a participant's start crossing, `startTime` is never written to their `results` row. On finish crossing, `durationMs` (netto/chip time) remains `null` while `gunDurationMs` (brutto) is set. The participant gets no netto time and the operator has no visibility into which runners were affected.

## Solution Overview

1. When a participant is confirmed as being on course (finish crossing or checkpoint observation) and has no `startTime`, automatically set `startTime = raceRun.startedAt` and mark the source as `'gun'`.
2. Add `start_time_source` and `start_time_trigger` columns to `results`.
3. Add an **Audit tab** to the RaceControl page showing affected runners, with manual correction capability.

---

## Data Model

### New columns on `results`

```sql
ALTER TABLE results ADD COLUMN start_time_source text;
-- values: 'chip' | 'gun' | 'manual' | null
ALTER TABLE results ADD COLUMN start_time_trigger text;
-- values: null | 'finish_crossing' | 'checkpoint:<uuid>'
```

| `start_time_source` | Meaning |
|---|---|
| `null` | Participant not yet started |
| `'chip'` | startTime came from a real RFID start crossing |
| `'gun'` | startTime set automatically to gun time (no RFID start detected) |
| `'manual'` | Operator entered a corrected start time via Audit UI |

`start_time_trigger` records what event caused the gun fallback:
- `null` — chip start, manual correction, or not yet started
- `'finish_crossing'` — gun fallback triggered by finish crossing with no prior start
- `'checkpoint:<checkpointId>'` — gun fallback triggered by a checkpoint observation

Drizzle schema additions to `schema.js`:
```js
startTimeSource:  text('start_time_source'),
startTimeTrigger: text('start_time_trigger'),
```

Migration: `0012_start_time_source.sql` + journal entry (idx: 12).

The existing `trg_reset_synced_at_results` trigger (from `0010_sync_trigger`) already covers all columns on `results` — no new trigger needed for the new columns.

---

## Backend Changes

### 1. Crossing detector — start crossing (chip path)

In `#confirmCrossing`, when `gate === 'start'`, add `startTimeSource: 'chip'` to both the `values(...)` and the `onConflictDoUpdate set`. This ensures `null` unambiguously means "not yet started" rather than "chip start that predates this column".

### 2. Crossing detector — finish crossing with no prior start

In `#confirmCrossing`, when `gate === 'finish'` and `existing.startTime` is null:
- Both `values(...)` and `onConflictDoUpdate set` must include: `startTime: race.gunStartTime`, `startTimeSource: 'gun'`, `startTimeTrigger: 'finish_crossing'`, `status: 'finished'`. Since results rows are always pre-seeded at race start, the upsert always hits the conflict branch — fields absent from `set` are silently ignored.
- `durationMs = peakTime - race.gunStartTime` (equals `gunDurationMs` exactly — use `peakTime` to match the variable already in scope, not `finishTime`)
- `race.startedParticipants.add(participantId)` — consistency with DB state
- `race.finishedParticipants.add(participantId)` — required so the `finishedParticipants.has()` guard in `processEvent` skips this participant on future readings
- Broadcast `result:update` as usual

### 3. Checkpoint observations — `POST /api/checkpoints/:id/observations` (new endpoint)

This endpoint does not currently exist and must be created in `checkpoints.js`. It should:
1. Insert the observation into `checkpoint_observations`
2. Look up the active race run for this specific participant:
   - Get the participant's `categoryId` from the `participants` table
   - Find the most recent `race_runs` row for that `categoryId` with `status = 'active'`, ordered by `started_at DESC LIMIT 1`
   - Note: a `checkpoint` can be linked to multiple categories via `checkpointCategories` — filter by the participant's own `categoryId`, not any linked category
3. Verify a `checkpointCategories` row exists for `(checkpointId, participant.categoryId)` — if not, the checkpoint does not apply to this participant's category; skip the fallback
4. Only apply gun fallback if an active race run exists (skip if race is pending or finished)
5. If active race run found and participant's `results` row has `startTime IS NULL`:
   - Upsert on `(raceRunId, participantId)`: `startTime = raceRun.startedAt`, `startTimeSource = 'gun'`, `startTimeTrigger = 'checkpoint:' + checkpointId`, `status = 'started'`
   - Broadcast `result:update`

The `broadcast` function must be imported directly: `import { broadcast } from '../ws/broadcaster.js'` (same pattern as `races.js`).

**Note on `startedParticipants` in-memory state:** The checkpoint route has no direct access to the `CrossingDetector` instance. The in-memory `startedParticipants` Set will NOT be updated when a checkpoint triggers the fallback. This is acceptable: on the next RFID reading for that participant, the detector will fall through to the DB slow-path (`db.query.results.findFirst`), which will find `startTime IS NOT NULL` and correctly assign `gate = 'finish'`. The `maxTimer` will also arm correctly on that first RFID reading. This is a known limitation, not a bug.

### 4. New endpoint — audit data

```
GET /api/races/:raceRunId/audit
```

Returns all results for the race run where `start_time_source IN ('gun', 'manual')`. Joins `participants` for name/bib/emoji. For `checkpoint:<id>` triggers, joins `checkpoints` to get the checkpoint name (handle deleted checkpoints gracefully: fall back to `"(usunięty punkt)"`).

Response shape:
```json
{
  "gunStartFallback": [
    {
      "resultId": "...",
      "participantId": "...",
      "firstName": "...",
      "lastName": "...",
      "bibNumber": 42,
      "emoji": "🦊",
      "startTime": "...",
      "finishTime": "...",
      "durationMs": 5025000,
      "gunDurationMs": 5025000,
      "startTimeSource": "gun",
      "startTimeTrigger": "finish_crossing",
      "checkpointName": null
    }
  ]
}
```

`checkpointName` is populated when `startTimeTrigger` is `checkpoint:<id>`, otherwise `null`. The frontend derives the display label from `startTimeTrigger` + `checkpointName` — no server-side Polish string generation.

### 5. Extend `PATCH /api/results/:id`

When `startTime` is present in the request body:
- Server always forces `startTimeSource = 'manual'` and `startTimeTrigger = null` — these are not accepted from the client
- Recalculate `durationMs = new Date(finishTime) - new Date(startTime)` (if `finishTime` exists, else `null`)
- Set `manualOverride = true` (preserves existing behavior for CSV export compatibility)
- Do NOT recalculate or modify `gunDurationMs` — it is `finishTime - raceRun.startedAt` and is unaffected by a startTime correction
- Re-run position recalculation — `recalcPositions` still runs (ordered by `gunDurationMs`; since `gunDurationMs` is unchanged, positions are unchanged in practice, but the call must not be skipped)
- Return updated result

---

## Frontend Changes

### RaceControl — new Audit tab

Add `"audit"` to the tab list in `RaceControl.jsx`. The tab fetches from `GET /api/races/:raceRunId/audit` for the currently selected or active race run.

**Section: "Brutto użyte zamiast netto"**
- Shown only when `gunStartFallback.length > 0`
- Amber section header badge with count of unresolved items (`startTimeSource = 'gun'`)
- Table columns: Zawodnik (emoji + name + bib), Czas netto* (with GUN/MANUAL badge), Czas brutto, Powód, Akcja
- **Reason label** derived client-side:
  - `startTimeTrigger = 'finish_crossing'` → `"brak startu RFID (meta)"`
  - `startTimeTrigger = 'checkpoint:...'` + `checkpointName` → `"brak startu RFID (pkt ${checkpointName})"`
  - `startTimeSource = 'manual'` → `"poprawiono ręcznie"`
- Rows with `startTimeSource = 'gun'`: show "Podaj czas startu" button → opens inline HH:MM:SS input within the row → on confirm, PATCH
- Rows with `startTimeSource = 'manual'`: shown dimmed with "poprawiono ✓", no action button (history preserved in table)

Footnote: `* GUN = użyto czasu brutto jako zastępstwo. MANUAL = ręcznie poprawiony przez operatora.`

**Future sections** (not implemented now, placeholder shown in UI):
- Participants registered at start+finish but not checked in
- Participants checked in but not started and not seen at any checkpoint

The Audit tab trigger shows an amber count badge for unresolved items (`startTimeSource = 'gun'`). Disappears when count = 0.

### Data fetching

```js
useQuery({
  queryKey: ['audit', raceRunId],
  queryFn: () => api.races.audit(raceRunId),
  refetchInterval: 30000,
})
```

Invalidate on `rfid:crossing`, `result:update`, and `race:update` WS events.

### Manual correction UX

"Podaj czas startu" opens an inline time input (HH:MM:SS) within the row. On confirm:
1. Parse HH:MM:SS relative to `raceRun.startedAt` date to produce a full ISO timestamp
2. `PATCH /api/results/:resultId` with `{ startTime }`  — `startTimeSource` is set server-side
3. Optimistic update: mark row as "poprawiono ✓"
4. Invalidate audit and results queries

---

## What This Does NOT Change

- Positions are ranked by `gunDurationMs` — manual startTime correction updates `durationMs` only, positions unchanged
- Participants with no finish time are unaffected
- Supabase sync picks up changes automatically via existing trigger. The sync worker uses `db.select().from(table)` (all Drizzle schema columns), so new columns are included automatically once added to the schema. **The Supabase remote `results` table must also have `start_time_source` and `start_time_trigger` columns added** before the first sync after deployment, otherwise the upsert will fail with an unknown-column error.
- No changes to liveresults or volunteer apps
