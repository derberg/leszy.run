# Gender-Split Podium & Results

## Problem

Podium and results currently show a single unified ranking per category. In real races, results are always presented three ways: overall (Open), men (Mezczyzni), and women (Kobiety). Each gets its own podium and position numbering.

## Decision

Filter at the API + UI layer. No schema changes. Gender data already exists on every participant (`M` or `K`, always provided).

## Design

### Backend: Results API

**File:** `backend/src/routes/results.js`

Add optional `?gender=M|K` query parameter to results endpoints:

- `GET /races/:raceRunId/results?gender=M` — returns only male participants
- `GET /races/:raceRunId/results?gender=K` — returns only female participants
- `GET /races/:raceRunId/results` (no param) — returns all participants (Open)
- `GET /events/:eventId/results` — unchanged (returns all categories with their results; gender filtering happens per race run)

Filtering happens before position assignment. When `?gender=K` is passed, only female participants are returned, and position 1 is the fastest woman — not her overall position.

CSV and PDF export endpoints also accept `?gender=M|K` for gender-specific exports.

**No changes to:** schema, categories table, crossing detector, sync, WebSocket events.

### Frontend: Podium Page

**File:** `frontend/src/pages/PodiumPage.jsx`

Auto-rotation expands to cycle through gender views per category. For an event with categories [5km, 10km]:

```
5km Open -> 5km Mezczyzni -> 5km Kobiety -> 10km Open -> 10km Mezczyzni -> 10km Kobiety -> repeat
```

Each rotation step:
1. Fetches results with appropriate `?gender=` param (none for Open, `M`, `K`)
2. Passes filtered results to `estimatePositions()` as before
3. Displays a label: category name + gender view ("OPEN" / "MEZCZYZNI" / "KOBIETY")

Single-category mode (`/events/{eventId}/results/{categoryId}`) also rotates through the 3 gender views for that category.

### Frontend: Results Page

**File:** `frontend/src/pages/Results.jsx`

Within each category tab, add sub-tabs:

```
[Open] [Mezczyzni] [Kobiety]
```

Switching sub-tab re-fetches results with `?gender=` param. Each sub-tab shows its own podium (top 3) + full leaderboard with positions numbered within that gender group.

### Public App: Category Section

**File:** `public/src/pages/CategorySection.jsx`

Same sub-tab pattern as the admin results page: Open | M | K. Fetches results with `?gender=` param. `estimatePositions()` receives the already-filtered list — no changes to the shared lib.

### Shared UI Components

**`packages/ui/`** — No changes needed to:
- `estimatePositions()` — gender-agnostic, ranks whatever list it receives
- `Podium` component — renders top 3 from whatever data it gets
- `CheckpointTrackingTable` — renders full list from whatever data it gets
- `PositionBadge` — already receives `gender` prop (currently unused), may use it later for styling

### What stays unchanged

| Component | Why |
|-----------|-----|
| DB schema | Gender already stored on participants |
| Categories table | Categories stay unified (5km, 10km) — gender split is display-only |
| Crossing detector | Detects crossings regardless of gender |
| Position estimation lib | Receives pre-filtered lists, ranks them |
| Supabase sync | No new tables or columns |
| WebSocket events | Events are per-participant, UI filters on render |

## Edge cases

- **Gender always provided:** Per project rules, every participant has `M` or `K`. No null handling needed.
- **Empty gender group:** If a category has 0 women, the Kobiety sub-tab shows an empty state. In podium rotation, skip gender views with 0 participants.
- **Manual position overrides:** `PATCH /results/:id` with manual position edits apply within the context they were set. Gender-filtered views recalculate positions from the filtered set.
