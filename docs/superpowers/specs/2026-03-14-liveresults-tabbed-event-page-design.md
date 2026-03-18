# Design: Liveresults Tabbed Event Page

**Date:** 2026-03-14
**Status:** Approved

## Problem

The current liveresults event page (`/events/:eventId`) shows a plain list of category links. Users must navigate to each category separately. There is no single-page view and no shareable link for a specific category.

## Solution

Replace the event page with a tabbed view:
- **All tab** (default) — all categories stacked vertically, each showing full content
- **Per-category tabs** — one tab per category, shows that category's content only
- **Shareable URLs** — `All` maps to `/events/:eventId`, individual category maps to `/events/:eventId/:categoryId`

## URL Structure

| URL | Active tab |
|-----|-----------|
| `/events/:eventId` | All |
| `/events/:eventId/:categoryId` | That category |

Both routes render the same `EventPage` component. The component reads `categoryId` from URL params to determine the active tab.

## Component Architecture

### `EventPage` (replaces current `Event.jsx`)

Responsibilities:
- Fetch event info (name, date, location) and all categories for the event
- While fetching: render a skeleton/placeholder tab bar (e.g. a few grey blocks)
- Render tab bar once loaded: "ALL" tab first, then one tab per category
- Clicking "All" → `navigate(/events/${eventId})`
- Clicking a category tab → `navigate(/events/${eventId}/${cat.id})`
- Render content: if `categoryId` in params → one `<CategorySection>`; else → one `<CategorySection>` per category stacked
- Set `document.title` to event name in All view, or `${category.name} — ${event.name}` in single-category view

### `CategorySection` (new file: `liveresults/src/pages/CategorySection.jsx`)

Extracted from `Category.jsx`. Self-contained unit. Receives `eventId` and `categoryId` as props.

Responsibilities:
- All data fetching currently in `Category.jsx` (category info, race run, results, checkpoints, observations)
- Supabase Realtime subscription (scoped to this category's race run), with channel cleanup in `useEffect` return (already present in current `Category.jsx`)
- Renders: race timer, Podium component, results table, CheckpointTrackingTable
- Renders the "waiting / race not started" state when there is no active race run
- Does NOT render the back-link or page-level heading (those stay in `EventPage`)

### `App.jsx` changes

Add a second route so both URLs render `EventPage`:

```
<Route path="/events/:eventId" element={<EventPage />} />
<Route path="/events/:eventId/:categoryId" element={<EventPage />} />
```

Remove the old `CategoryPage` route. The URL shape `/events/:eventId/:categoryId` is unchanged so all existing shared links keep working.

## Tab Bar Design (style A — horizontal)

- Sharp-edged tabs (no border-radius), matching apex theme
- Active tab: yellow background (`#D4FF00`), dark text
- Inactive tabs: transparent, muted text, bottom border
- Scrollable horizontally if many categories (CSS `overflow-x: auto` on container)
- "ALL" label for the first tab
- On page load (including direct navigation to a category URL), the active tab must be scrolled into view using `scrollIntoView({ inline: 'nearest' })` so it is visible even if it is off-screen

## Data Loading

Each `<CategorySection>` fetches its own data independently via `useEffect`. In the "All" view, N sections fetch in parallel — same behaviour as if a user opened N tabs. No aggregation at the `EventPage` level.

## Files Changed

| File | Change |
|------|--------|
| `liveresults/src/App.jsx` | Add second route for `/:eventId/:categoryId` pointing to `EventPage`; remove `CategoryPage` route |
| `liveresults/src/pages/Event.jsx` | Full rewrite — tabbed page with tab bar and `CategorySection` rendering |
| `liveresults/src/pages/CategorySection.jsx` | New file — extracted from `Category.jsx` |
| `liveresults/src/pages/Category.jsx` | Delete |

## Deployment

`liveresults/vercel.json` already has a catch-all rewrite (`/(.*) → /index.html`). No changes needed.

## Out of Scope

- No changes to backend or Supabase schema
- No changes to the frontend admin app
- No changes to the volunteer app
