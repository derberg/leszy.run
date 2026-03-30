# Timekeeper.pl Scraper — Design Spec

## Overview

New scraper source for `competitions.timekeeper.pl` — a Polish race timing company that hosts event registration pages. Cheerio-based, two-phase scraper (listing page + detail pages). Only internal events (hosted on timekeeper.pl) are scraped; external-registration events are skipped.

## Data source

| Property | Value |
|----------|-------|
| URL | `https://competitions.timekeeper.pl/` |
| Method | Cheerio (server-rendered HTML) |
| Pagination | None — all events on one page |
| Detail pages | Yes — `/<slug>` for each internal event |
| Estimated events | 50-150/year (timing company, not aggregator) |

## Pipeline integration

### Priority: 3

Timekeeper provides structured, high-quality data (ISO dates, category names, regulamin PDFs, organizer websites). Inserted at priority 3, shifting existing sources down:

| Priority | Source |
|----------|--------|
| 1 | dostartu |
| 2 | biegiwpolsce |
| **3** | **timekeeper** |
| 4 | elektronicznezapisy |
| 5 | datasport |
| 6 | maratonypolskie |
| 7 | pomiarczasuatelier |

### New Supabase table: `scraper_timekeeper`

Standard schema matching other per-source tables:

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid | PK, default `gen_random_uuid()` |
| `name` | text | Event name |
| `date` | text | `YYYY-MM-DD` |
| `location` | text | City name |
| `distances` | text | Comma-separated (e.g., `"Półmaraton, Bieg na 5 km"`) |
| `registration_url` | text | Detail page URL on timekeeper.pl |
| `regulamin_url` | text | Download link (`/download/{id}`) |
| `website` | text | Organizer website from sidebar |
| `source_id` | text | Slug from URL (e.g., `19-polmaraton-rzeszowski`), unique |
| `source_url` | text | Full detail page URL |
| `merged_at` | timestamptz | Set by merge step |
| `created_at` | timestamptz | Default `now()` |

Unique constraint on `source_id`.

## Scraper implementation

### File: `backend/src/scrapers/sources/timekeeper.js`

### Phase 1 — Listing page

Fetch `https://competitions.timekeeper.pl/` and parse all events.

**HTML structure per event:**
- Container: `section.container > div.row.py-4.border-bottom`
- Date: `<h2>` in `div.data.text-center` (day number), two `div.miesiac` (Polish month, day of week)
- Name: `<a>` in div with `font-size: 28px` (desktop variant: `d-none d-md-block`)
- Location: `div.text-danger` with `font-size: 20px`
- "Wiecej informacji" button: `a.btn.btn-primary.btn-block`

**Internal vs external detection:**
- Internal: button `href` starts with `/` (relative path)
- External: button `href` is a full URL (starts with `http`)
- Skip external events entirely

**Extract from listing:**
- `slug` from button href (e.g., `/19-polmaraton-rzeszowski` → `19-polmaraton-rzeszowski`)
- `name` from link text
- `location` from red text div
- Day + Polish month for date fallback (detail page has better `YYYY-MM-DD`)

### Phase 2 — Detail pages

For each internal event, fetch `https://competitions.timekeeper.pl/<slug>`.

**Extract:**

| Field | Selector / location | Notes |
|-------|---------------------|-------|
| `date` | `p.text-primary.h3` under "Data zawodow" heading | Format: `YYYY-MM-DD` |
| `location` | `p.text-primary.h3` under "Lokalizacja" heading | City name |
| `distances` | `h6.font-weight-bolder.m-0` inside "Koszt uczestnictwa" card | Category names (e.g., "Półmaraton", "Bieg na 5 km") |
| `regulamin_url` | `a.btn.btn-success[href*="/download/"]` | Full URL to PDF download |
| `website` | `<a>` inside "Organizator zawodow" card body | Organizer website URL |

**Skip:** The "Lista zawodników" section (identifiable by `show-members` Livewire component or `<h4>` with "Lista zawodników" text). We don't parse any participant data.

**Distance extraction from categories:**
- Take category names as-is from the pricing card (e.g., "Półmaraton", "Bieg na 5 km")
- Join with comma separator
- The normalizer + enrich-flags pipeline will handle converting named distances ("Półmaraton" → "21.1 km") downstream

### Rate limiting

1 second delay between detail page fetches. User-Agent: `leszy.run/1.0 (kontakt@leszy.run)`.

### `knownIds` optimization

Same pattern as other scrapers: accept `{ knownIds }` set, skip detail page fetch for events already in `scraper_timekeeper`.

## Output format

Each event returned as:

```js
{
  name: '19. Półmaraton Rzeszowski',
  date: '2026-04-12',
  location: 'Rzeszów',
  distances: 'Półmaraton, Półmaraton + grawerowanie medalu',
  registration_url: 'https://competitions.timekeeper.pl/19-polmaraton-rzeszowski',
  regulamin_url: 'https://competitions.timekeeper.pl/download/959',
  website: 'https://runrzeszow.pl/',
  source: 'timekeeper',
  source_id: '19-polmaraton-rzeszowski',
  source_url: 'https://competitions.timekeeper.pl/19-polmaraton-rzeszowski',
}
```

## Registration in pipeline

### `backend/src/scrapers/index.js`

Add timekeeper to the `sources` array with `mapRow`:

```js
{
  name: 'timekeeper',
  scrape: scrapeTimekeeper,
  table: 'scraper_timekeeper',
  mapRow: (raw) => ({
    name: raw.name,
    date: raw.date,
    location: raw.location || null,
    distances: raw.distances || null,
    registration_url: raw.registration_url || null,
    regulamin_url: raw.regulamin_url || null,
    website: raw.website || null,
    source_id: raw.source_id,
    source_url: raw.source_url || null,
  }),
}
```

### `backend/src/scrapers/dedup.js`

Add to `SOURCE_PRIORITY`:

```js
const SOURCE_PRIORITY = {
  dostartu: 1,
  biegiwpolsce: 2,
  timekeeper: 3,
  elektronicznezapisy: 4,
  datasport: 5,
  maratonypolskie: 6,
  pomiarczasuatelier: 7,
}
```

### `KNOWN_SOURCE_DOMAINS`

Add `timekeeper.pl` and `competitions.timekeeper.pl` to the known source domain lists in `elektronicznezapisy.js` and `biegiwpolsce.js` so they don't try to follow timekeeper links.

## Changes summary

| File | Change |
|------|--------|
| `backend/src/scrapers/sources/timekeeper.js` | **New** — scraper implementation |
| `backend/src/scrapers/index.js` | Add timekeeper to `sources` array + import |
| `backend/src/scrapers/dedup.js` | Update `SOURCE_PRIORITY` (timekeeper=3, shift others) |
| `backend/src/scrapers/sources/elektronicznezapisy.js` | Add timekeeper.pl to `KNOWN_SOURCE_DOMAINS` |
| `backend/src/scrapers/sources/biegiwpolsce.js` | Add timekeeper.pl to `KNOWN_SOURCE_DOMAINS` |
| Supabase | Create `scraper_timekeeper` table via migration |
| `docs/scrapers.md` | Update pipeline docs with new source |

## What this does NOT include

- No changes to merge, geocode, enrich, normalize, dedup, or publish scripts — timekeeper flows through the existing pipeline like any other source
- No new run-* script — timekeeper runs as part of `run-scrapers.js` like all sources
- No Playwright/headless browser — site is cheerio-compatible
