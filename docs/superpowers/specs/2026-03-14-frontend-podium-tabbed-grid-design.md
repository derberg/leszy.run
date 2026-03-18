# Design: Frontend Podium Tabbed Grid View

**Date:** 2026-03-14
**Status:** Approved

## Problem

The frontend's public podium view (`/events/:id/podium`) shows all categories in a single scrolling column. On large screens this wastes space and makes it impossible to see multiple categories simultaneously. There are also no tabs — switching to a specific category requires navigating to a separate URL with no way back.

## Solution

Merge `AllResults.jsx` and `CategoryResults.jsx` into a single `PodiumPage` component that handles both routes with a tab bar and a responsive grid layout:

- **All tab** (default): 2-column fixed-height grid on desktop, single column on mobile. Each cell scrolls independently. Odd number of active categories: last cell spans full width (`col-span-2`).
- **Per-category tabs**: single category full-width, with checkpoint tracking table.
- **Shareable URLs**: All = `/events/:id/podium`, single category = `/events/:id/results/:categoryId`.

## URL Structure

| URL | Active tab |
|-----|-----------|
| `/events/:id/podium` | All |
| `/events/:id/results/:categoryId` | That category |

Both routes render the same `PodiumPage` component.

**Note:** The existing internal admin route `/events/:id/results` (no `categoryId`) is a separate route inside `<Layout>` that renders the `<Results>` admin page — it is unaffected. Only `/events/:id/results/:categoryId` (with a category segment) is changed.

## Component Architecture

### `PodiumPage` (new file: `frontend/src/pages/PodiumPage.jsx`)

Replaces both `AllResults.jsx` and `CategoryResults.jsx`.

Responsibilities:
- Fetch event info via `api.events.get(eventId)` (TanStack Query)
- Fetch all categories + results via `api.results.listForEvent(eventId)` (TanStack Query, `refetchInterval: 5000`)
- Fetch checkpoints via `api.checkpoints.list(eventId)` (TanStack Query)
- Fetch observations only in single-category view: `api.checkpoints.observationsForRace(run?.id)` (`enabled: !!run?.id`, `refetchInterval: 5000`)
- Subscribe to `result:update` and `race:update` WebSocket events → invalidate results query
- Subscribe to `checkpoint:observation` WebSocket event → invalidate observations query (single-category view only; `checkpoint:observation` is used in the existing `CategoryResults.jsx` and is assumed to be emitted by the backend)
- Read `categoryId` from `useParams()` to determine active tab
- Render tab bar — see Tab Bar Design below
- Set `document.title` to event name (All) or `${cat.name} — ${event.name}` (single)

**Tab bar scope:** Show **all** categories for the event in the tab bar (not just active ones). This allows navigating to a category that hasn't started yet. The All grid only renders active categories (those with `raceRuns?.length > 0`).

### `RaceTimer` (inline in `PodiumPage.jsx`)

Copy `RaceTimer` and `formatElapsed` from `AllResults.jsx` directly into `PodiumPage.jsx`. Do not extract to a shared file — it is only used here.

### `CategoryCard` component (inline in `PodiumPage.jsx`)

Used in both the grid (All view) and the single-category view.

**Props:** `{ cat, checkpoints }` — no `observations` prop. Observations are only used in the single-category view's checkpoint tracking table, which is rendered by `PodiumPage` directly (not inside `CategoryCard`).

Renders:
- Category name + distance header
- `<RaceTimer>` (live if active, total time if finished)
- Podium top 3 via `<Podium>` from `@leszyrun/ui`
- Results table: finished runners sorted by `gunDurationMs` (same logic as current `AllResults.jsx` — simple sort, no `estimatePositions`)
- On-track list: runners with `status === 'started'` and no `finishTime`
- "Oczekiwanie" state if no active race run

**`estimatePositions` usage:**
- In the **All grid view**: `CategoryCard` uses the simple `gunDurationMs` sort (no observations available, no checkpoint-count ordering). This is intentional — the grid is a quick overview.
- In the **single-category view**: `PodiumPage` calls `estimatePositions(results, checkpoints, observations)` (copied from `CategoryResults.jsx`) before passing enriched results to both `CategoryCard` and `CheckpointTrackingTable`. This preserves the current behaviour of the single-category page.

`estimatePositions` is defined as a module-level function inside `PodiumPage.jsx` (copied from `CategoryResults.jsx`).

### Single-category view

When `categoryId` is present:
- Find the matching category and its `raceRuns[0]`
- Call `estimatePositions(results, checkpoints, observations)` to enrich results
- Render one `CategoryCard` full-width inside `max-w-3xl mx-auto`
- Below it, if `checkpoints.length > 0`: render `<CheckpointTrackingTable>` from `@leszyrun/ui`

## Tab Bar Design

Identical to liveresults `Event.jsx`:
- Sharp-edged buttons (`rounded-none`), no border-radius, `shrink-0`
- Active: `bg-apex-yellow-bright text-apex-bg` (`#D4FF00`)
- Inactive: `text-apex-muted hover:text-apex-text`
- Container: `overflow-x-auto [&::-webkit-scrollbar]:hidden` + `style={{ scrollbarWidth: 'none' }}`
- Border bottom separating tabs from content
- Active tab ref: `scrollIntoView({ inline: 'nearest', behavior: 'smooth' })` triggered by `useEffect([categoryId, categories])`
- Skeleton placeholder (3 grey blocks, `animate-pulse`) while data loads

## Data Flow

```
PodiumPage
  ├── useQuery: api.events.get(eventId)                           → event
  ├── useQuery: api.results.listForEvent(eventId)                 → categories[] with raceRuns[0].results[]
  ├── useQuery: api.checkpoints.list(eventId)                     → checkpoints[]
  ├── useQuery: api.checkpoints.observationsForRace(run?.id)      [single-cat only, enabled: !!run?.id]
  ├── useWsEvent: result:update  → invalidate ['event-results', eventId]
  ├── useWsEvent: race:update    → invalidate ['event-results', eventId]
  └── useWsEvent: checkpoint:observation → invalidate ['checkpoint-observations', run?.id]  [single-cat only]
```

`run` (used as the observations query key) is derived from the results data: `categories.find(c => c.id === categoryId)?.raceRuns?.[0]`. If results refetch and `run` changes identity, the observations query key updates automatically.

## Grid Layout Detail

The page wrapper uses `h-screen flex flex-col` so the grid fills remaining height.

```jsx
// Responsive grid — single column on mobile, 2-column fixed-height on md+
<div className="flex-1 grid grid-cols-1 md:grid-cols-2 overflow-hidden min-h-0"
     style={{ gridAutoRows: '1fr' }}>
  {activeCategories.map((cat, i) => (
    <div
      key={cat.id}
      className={cn(
        'overflow-y-auto border-t border-apex-border p-5 [&:nth-child(odd)]:border-l-0 border-l',
        activeCategories.length % 2 !== 0 && i === activeCategories.length - 1
          ? 'md:col-span-2'
          : ''
      )}
    >
      <CategoryCard cat={cat} checkpoints={checkpoints} />
    </div>
  ))}
</div>
```

`gridAutoRows: '1fr'` makes all rows equal height regardless of count. On mobile (`grid-cols-1`) each cell is `auto` height and the page scrolls freely. The `md:col-span-2` on the last odd cell only takes effect at the `md` breakpoint.

For more than 4 active categories: the grid grows to 3+ rows, each row equal height, all scrollable. No special handling needed.

## Error Handling

- TanStack Query loading: show skeleton tab bar while `isLoading`
- Empty active categories: show "Brak aktywnych wyścigów" in the grid area
- Query errors: TanStack Query default retry; on persistent failure the grid area stays empty (acceptable — same as current behaviour)

## Files Changed

| File | Change |
|------|--------|
| `frontend/src/pages/PodiumPage.jsx` | New — merged AllResults + CategoryResults |
| `frontend/src/pages/AllResults.jsx` | Delete |
| `frontend/src/pages/CategoryResults.jsx` | Delete |
| `frontend/src/App.jsx` | Both `/events/:id/podium` and `/events/:id/results/:categoryId` point to `PodiumPage`; internal `/events/:id/results` route is unchanged |

## Out of Scope

- No changes to backend API
- No changes to liveresults app
- No changes to volunteer app
- No changes to `@leszyrun/ui` package
