# Past Events Pages — Design

**Date:** 2026-06-19
**Branch:** `feat/past-events-pages`
**Status:** Approved

## Problem

The leszy.run landing page only surfaces *upcoming* leszy.run-organized events
(Wilczy Półmaraton, Evolve, etc.). There is no way to navigate from the landing
page to a *past* event (e.g. a previous Canicross / Niebokross edition) to see
that it happened, browse a few stats, and jump to its results. This hurts two
audiences:

- **Runners** who want to find results from an event they ran.
- **Prospective organizers / partners** evaluating leszy.run, who benefit from
  visible proof ("they really do run events, and here's how it looked").

## Goal

1. A compact "past events" entry point on the landing page.
2. A per-event page for each past event showing a few auto-derived stats and a
   prominent link to the (internal) results.
3. The past-event pages are **statically built once** (stats baked into HTML),
   good for SEO/marketing — crawlers see the numbers, not an empty SPA shell.

## Non-goals

- No manual stat entry / curation. All stats are auto-derived from results data.
- No external results links for these pages — the "See results" button goes to
  the internal leszy.run results page (`/events/:slug/results`).
- No separate paginated archive page yet (few events; YAGNI). The landing strip
  lists all past public events; revisit if the count grows large.
- Upcoming-event EventHub behavior is unchanged (still the live-results flow).

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Stats source | **Auto from results data** (no manual curation) |
| "See results" destination | **Internal** `/events/:slug/results` |
| Landing presentation | **Compact strip** under the upcoming-events section |
| Stats shown | participants/finishers · distances/categories · date & location · fastest finisher |
| Compute model | **One Supabase read** via a view; **statically built once** (not dynamic) |
| Fastest | single overall fastest finisher across the event (per-category lives on results page) |

## Architecture

```
Supabase view (1 read)   →   publish script writes committed manifest   →   vite build bakes static HTML
event_results_summary        public/public/events/.manifest.json             dist/events/:slug/index.html
                                                                              (stats + JSON-LD + results CTA)
```

Past leszy.run events get a statically pre-rendered page with baked-in stats.
Upcoming events keep the current dynamic EventHub. The landing page gets a
compact strip linking into the past-event pages.

## Components

### 1. Supabase view — `event_results_summary` (read-only)

One row per event, aggregated server-side so the cancelled-run / untimed-category
logic lives in exactly one place (instead of being reimplemented in the browser
or the build script):

- `event_id`
- `participants` — count from `participants` for the event
- `finishers` — count of `results` with `status='finished'`, counted only from
  the **latest non-cancelled** `race_run` per category (mirrors the Results page
  logic; restarts leave older runs `status='cancelled'`)
- `distances` — distinct **timed** (`untimed = false`) category names
- `fastest_ms` — min `durationMs` among finishers
- `fastest_name` — first/last name of that fastest finisher

Read-only view. Applied to Supabase via `mcp__supabase__apply_migration` (SQL
shown and confirmed before running, per DB-write-safety). No local Drizzle
migration — nothing queries this view from the local backend. Documented as a
Supabase-only object in CLAUDE.md.

> **Note:** the build pipeline only ever does a *single read* of this view per
> publish run, so the documented 1000-row PostgREST cap is a non-issue — the
> view returns one row per event, not per result.

### 2. Build pipeline (mirrors the existing kalendarz pattern)

- **`publish-leszyrun-events.js`** (host script, `--apply`)
  Does the one Supabase read: the `event_results_summary` view joined with the
  `events` table (name, date, location, slug, visibility). Writes
  `public/public/events/.manifest.json` (committed to the repo) containing one
  entry per past, public event with its baked stats. This is the only time stats
  are fetched. Dry-run by default; `--apply` writes the file.

- **`generate-leszyrun-event-pages.js`** (runs during `vite build`, like
  `generate-event-pages.js`)
  Reads the committed manifest, writes `dist/events/:slug/index.html` for each
  **past, public** event with: baked stats, `<title>`, canonical, meta
  description, `SportsEvent` JSON-LD, and a prominent **"Zobacz wyniki →"** link
  to `/events/:slug/results`. The stats are also embedded as JSON in the page so
  the React component can hydrate from them.

Refreshing after a new event has finished = re-run the publish script + commit
(same workflow as the existing manifest refresh for kalendarz pages).

### 3. EventHub component (`/events/:slug`)

For a **past** event, render the baked stats card (participants · finishers ·
distances · date/location · fastest) plus the **"Zobacz wyniki →"** CTA to
`/events/:slug/results`. Reads the embedded JSON from the static page (the same
technique `EventPage.jsx` already uses for kalendarz pages), so the page renders
without a live query. **Upcoming** events are untouched — still the live
"Wyniki na żywo" flow.

### 4. Landing page strip

A slim "Minione wydarzenia" strip of compact chips placed directly under the
existing upcoming-events section in `Landing.jsx`. Each chip shows event name +
date and links to `/events/:slug`. Backed by one cheap live query (`events`
where `visibility = 'public'` and `date < today`, ordered by date descending) —
no aggregation, consistent with the existing `EventsSection` pattern. Renders
nothing if there are no past public events.

The strip's chips also serve as static `<a href>` inbound links so Google
actually crawls the past-event pages (sitemap alone is not enough for a
low-authority site).

### 5. SEO / robots

Currently the static generators set past events to `noindex, follow`. Past
leszy.run event pages are the opposite of throwaway — they are marketing assets.
So `generate-leszyrun-event-pages.js` sets them to **`index, follow`** and
includes them in the sitemap, with the landing strip providing crawlable inbound
links. (This only affects the new `/events/:slug` leszy.run pages — the
`/kalendarz/:slug` past-event `noindex` behavior is unchanged.)

## Data flow

1. Event runs, results recorded in local Postgres → synced to Supabase.
2. Host runs `publish-leszyrun-events.js --apply` → reads `event_results_summary`
   view → writes/commits `public/public/events/.manifest.json`.
3. `vite build` runs `generate-leszyrun-event-pages.js` → bakes
   `dist/events/:slug/index.html` per past public event.
4. Vercel serves the pre-generated static HTML directly; the SPA rewrite only
   catches paths with no matching static file.
5. Landing strip live-queries the `events` table for the chip list.

## Error handling / edge cases

- **Event with zero finishers** (cancelled / DNS-only): still show the page with
  participants count; "fastest" and "finishers" gracefully show 0 / hidden.
- **Event with only untimed categories** (e.g. a kids-only fun run): `distances`
  empty → omit the distances line rather than render an empty one.
- **Manifest missing an event** (publish not yet run): no static page is
  generated; the SPA route still resolves but the stats card simply doesn't
  render. The strip only links to events that exist; safe.
- **Upcoming event accidentally in the past manifest**: publish script filters
  `date < today` and `visibility = 'public'`, so only genuine past public events
  are baked.

## Testing

- **View correctness:** `event_results_summary` returns counts matching a
  known past event when spot-checked against the live Results page (participants,
  finishers, fastest).
- **Generated HTML:** for a sample event, the built `index.html` contains the
  stats, the `SportsEvent` JSON-LD, the correct canonical URL, `index, follow`
  robots, and the "Zobacz wyniki" link to `/events/:slug/results`.
- **Strip:** renders past public events only (no upcoming, no private); chips
  link to the correct slugs; renders nothing when there are no past events;
  upcoming events still appear only in the upcoming section.

## Files touched (anticipated)

- `supabase` — new `event_results_summary` view (via `apply_migration`)
- `public/scripts/publish-leszyrun-events.js` — new
- `public/scripts/generate-leszyrun-event-pages.js` — new
- `public/public/events/.manifest.json` — new (committed)
- `public/package.json` — wire the generate script into the build (where
  `generate-event-pages.js` is invoked)
- `public/src/pages/EventHub.jsx` — past-event stats rendering + results CTA
- `public/src/pages/Landing.jsx` — past-events strip (new component)
- `public/scripts/*sitemap*` / robots logic — include past leszy.run event pages
- `CLAUDE.md` — document the new view + publish script in the relevant sections
