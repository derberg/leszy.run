# Leszy.run Landing Page, Kalendarz & Data Pipeline

**Date:** 2026-03-23
**Status:** Design approved
**Implementation order:** Landing page → Kalendarz UI → Data pipeline

## Overview

Transform the `public/` app from a minimal event-listing tool into a full marketing + runner service platform for leszy.run. Three components:

1. **Landing page** (`/`) — promotes timing services to organizers and helps runners find events
2. **Kalendarz** (`/kalendarz`) — aggregated calendar of all running/NW events in Poland
3. **Data pipeline** — scrapes events from multiple Polish running portals into Supabase

## Target audiences

- **Race organizers** — learn about timing services, contact for booking
- **Runners/participants** — find upcoming races, check results, browse the kalendarz

## 1. Landing Page

### Route & placement

- Route: `/` in the existing `public/` Vite+React app
- The current `/events` list page stays as-is
- Add `<Route path="/" element={<Landing />} />` before the catch-all in `App.jsx`
- The catch-all (`*` → `/`) stays, now landing on the new landing page

### Logo

- File: `public/public/logo-bez-napisu.svg` (Leszy character without text)
- Two leaf elements (top-left img1, top-right img2) have green fills from `logo-green.svg`
- Main character paths remain black (`fill: #000000`)
- On the hero, use CSS `filter: drop-shadow()` for a green glow effect

### Sections (top to bottom)

#### 1.1 Navbar (fixed)
- Left: `LESZY.RUN` text logo (Barlow Condensed 800, yellow dot)
- Center: nav links — Start, Oferta, Wydarzenia, Kalendarz, Kontakt
- Right: CTA button "Organizujesz bieg?" (border style, yellow)
- `backdrop-filter: blur(12px)`, border-bottom
- Mobile: hamburger menu replaces nav links

#### 1.2 Hero (full viewport)
- Leszy `logo-bez-napisu.svg` as centerpiece (~400px wide, auto height)
- Radial green glow behind logo (animated pulse, 6s ease-in-out)
- Scanline overlay (repeating-linear-gradient, yellow at 1.5% opacity)
- `h1`: "LESZY.RUN" — Barlow Condensed 800, 72px, white, yellow `.RUN`
- Subtitle: "POMIAR CZASU · ZAPISY · WYNIKI NA ŻYWO" — Rajdhani 600, 18px, muted
- Tagline: "Profesjonalna obsługa biegów i wydarzeń sportowych..." — 17px, text color
- Two CTAs:
  - Primary (filled yellow): "ZNAJDŹ BIEG" → `/kalendarz`
  - Outline: "ORGANIZUJESZ WYDARZENIE?" → `#kontakt`
- Scroll indicator at bottom (animated bob)

#### 1.3 Co oferujemy
- Section label: "CO OFERUJEMY" (IBM Plex Mono, yellow-dim)
- Title: "WSZYSTKO CZEGO POTRZEBUJESZ" (Barlow Condensed 800, 42px)
- Description text
- 4-column grid of feature cards:
  1. **Pomiar czasu** — precyzyjny pomiar, wyniki natychmiast po mecie
  2. **Wyniki na żywo** — śledzenie w czasie rzeczywistym na telefonie
  3. **Zapisy online** — formularz zapisów, kategorie, lista startowa
  4. **Obsługa od A do Z** — przyjedziemy, ustawimy bramki, zajmiemy się resztą
- Cards: dark surface, thin border, yellow left-edge stripe on hover
- Non-technical language (no "RFID")
- Mobile: 2-column grid

#### 1.4 Charity section
- Full-width dark surface, yellow top border (3px)
- `h2`: "WYDARZENIA CHARYTATYWNE? ZA DARMO." (Barlow Condensed 800, 48px, yellow)
- Body: "Organizujesz bieg charytatywny? Zapisy, obsługa i pomiar czasu — wszystko za darmo. Jedyne co musisz zrobić to skontaktować się z nami i ustalić termin."
- CTA: "SKONTAKTUJ SIĘ" (primary yellow button) → `#kontakt`

#### 1.5 Nadchodzące wydarzenia
- Section label + title: "NAJBLIZSZE BIEGI"
- Event rows fetched from Supabase (`events` table, ordered by date ascending, future only)
- Each row: date (IBM Plex Mono, yellow) | event name + location | arrow
- Links to `/events/:slug`
- Show max 5 upcoming events

#### 1.6 Kalendarz teaser
- Split layout: left text + CTA, right preview rows
- Title: "WSZYSTKIE BIEGI W POLSCE W JEDNYM MIEJSCU"
- Preview: 5 sample rows from kalendarz data showing date, name, optional LESZY.RUN badge, location
- CTA: "OTWÓRZ KALENDARZ" → `/kalendarz`

#### 1.7 Kontakt
- Section label + title: "POROZMAWIAJMY"
- 3 contact cards in a row: Email, Telefon, Instagram
- Each card: label (IBM Plex Mono uppercase) + value (Barlow Condensed 700)

#### 1.8 Footer
- Thin border-top, centered
- "© 2026 Leszy.run · Pomiar czasu i obsługa wydarzeń sportowych · Polityka prywatności"

### Accessibility (WCAG AA)

- All text must meet 4.5:1 contrast ratio against its background
- Current `--muted` (#6B6980) on `--bg` (#06060A) is ~3.5:1 — bump to `#8886A0` (~4.6:1) for body text areas
- Yellow (#BBDD00) on dark bg passes AA for large text; for small text use on dark surface only
- All interactive elements must have visible focus indicators (yellow outline)
- Images have alt text
- Semantic HTML: `<nav>`, `<main>`, `<section>`, `<footer>`
- Skip-to-content link for keyboard users

### Responsive breakpoints

- Desktop: full layout as designed
- Tablet (≤1024px): features grid → 2 columns, kalendarz teaser stacks vertically
- Mobile (≤768px): single column, hamburger nav, hero text smaller (44px h1), contact cards stack

## 2. Kalendarz Page

### Route

- `/kalendarz` in the `public/` app
- New route in `App.jsx`

### Page structure

#### 2.1 Page header
- Section label: "KALENDARZ BIEGÓW"
- `h1`: "WSZYSTKIE BIEGI W POLSCE" (Barlow Condensed 800, 48px)
- Subtitle explaining data sources

#### 2.2 Sticky filter bar (below navbar)
- `position: sticky; top: 56px` (below navbar)
- Backdrop blur like navbar
- Filters (all `<select>` with custom styling):
  - **Search** — text input, full-text search by name/location
  - **Typ** — Bieg uliczny, Trail, Ultramaraton, Nordic Walking, OCR, Bieg nocny, Charytatywny
  - **Region** — all 16 województwa
  - **Dystans** — do 5km, 5-10km, 10-21km, Półmaraton, Maraton, Ultra (50+km)
  - **Kiedy** — Ten tydzień, Ten miesiąc, Następny miesiąc, Za 3 miesiące, Cały rok
- **Lista/Mapa toggle** — switches between list view and map view
- Filters update URL query params for shareability

#### 2.3 Results count
- "Znaleziono **847** wydarzeń" (IBM Plex Mono)

#### 2.4 List view (default)
- Events grouped by month (yellow month header)
- Each event row (grid: date | info | tags | distances | badge):
  - **Date**: dd.mm format, IBM Plex Mono, yellow
  - **Name**: Barlow Condensed 700, uppercase, text-bright
  - **Meta**: location + województwo, data source (dostartu.pl, maratonypolskie.pl, Facebook, leszy.run)
  - **Tags**: color-coded badges — TRAIL (green), NOCNY (cyan), CHARYTATYWNY (yellow), OCR (red), ULICZNY (default), NORDIC (yellow-dim)
  - **Distances**: available distances (e.g., "5 / 10 / 21 km")
  - **LESZY.RUN badge**: yellow accent badge on events timed by leszy.run
- Pagination at bottom (numbered pages)
- Mobile: simplified rows (date + name only, tags/distances hidden)

#### 2.5 Map view
- Interactive map of Poland using Leaflet.js + OpenStreetMap tiles
- Event pins, clustered at zoom-out
- Click pin → popup with event name, date, location, link
- LESZY.RUN events get a distinct pin color (yellow vs default)
- Dark map tiles (CartoDB dark_matter or similar)

#### 2.6 Event click behavior
- External events: open registration URL in new tab
- LESZY.RUN events: navigate to `/events/:slug`

### Data source
- Reads from Supabase `calendar_events` table (see data pipeline section)
- All filtering and pagination server-side via Supabase query params (`.ilike()`, `.in()`, `.gte()`, `.range()`)
- Uses direct Supabase client calls with React state/effects (matching existing `public/` app pattern — no TanStack Query)
- Filter changes update URL query params → trigger new Supabase query

## 3. Data Pipeline

### Purpose
Scrape running/NW events from Polish portals and aggregate into a single Supabase table for the kalendarz.

### Data sources (scrapers)

| Source | URL pattern | Method | Priority |
|--------|-----------|--------|----------|
| maratonypolskie.pl | Event listings | HTML scraping | High |
| dostartu.pl | Event calendar | HTML scraping or API | High |
| Facebook | Running groups/events | Graph API or scraping | Medium |
| bieganie.pl | Event listings | HTML scraping | Low |
| enduhub.com | Event listings | HTML/API | Low |

### Supabase table: `calendar_events`

```sql
CREATE TABLE calendar_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Core fields
  name TEXT NOT NULL,
  date DATE NOT NULL,
  end_date DATE,                    -- multi-day events
  location TEXT,                    -- city/area name
  voivodeship TEXT,                 -- województwo for filtering
  lat DECIMAL(9,6),                -- for map view
  lng DECIMAL(9,6),

  -- Classification
  event_type TEXT[],                -- ['trail','nocny','charytatywny','ocr','uliczny','nordic']
  distances TEXT[],                 -- ['5km','10km','21.1km','42.2km']
  distances_meters INT[],          -- [5000,10000,21100,42200] for filtering

  -- Rich metadata (for future personalization)
  description TEXT,
  registration_url TEXT,
  registration_deadline DATE,
  price_from INT,                   -- lowest entry fee in PLN grosze
  price_to INT,                     -- highest entry fee
  organizer TEXT,
  website TEXT,
  is_recurring BOOLEAN DEFAULT false,
  recurring_event_id UUID,          -- links yearly editions (e.g., all "Bieg Piastów" editions)
  edition_number INT,               -- e.g., 15th edition
  surface TEXT[],                   -- ['asfalt','szuter','las','góry']
  elevation_gain_m INT,             -- for trail runners
  max_participants INT,
  is_night BOOLEAN DEFAULT false,
  is_charity BOOLEAN DEFAULT false,

  -- Source tracking
  source TEXT NOT NULL,             -- 'maratonypolskie','dostartu','facebook','manual'
  source_url TEXT,                  -- original listing URL
  source_id TEXT,                   -- ID in the source system (for dedup)

  -- Leszy.run integration
  leszyrun_event_id UUID,           -- FK to events table if timed by us

  -- Timestamps
  scraped_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now()
);

  -- Lifecycle
  status TEXT DEFAULT 'active',     -- 'active','cancelled','postponed'

  -- Timestamps
  last_verified_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes
CREATE INDEX idx_calendar_events_date ON calendar_events(date);
CREATE INDEX idx_calendar_events_voivodeship ON calendar_events(voivodeship);
CREATE INDEX idx_calendar_events_source ON calendar_events(source, source_id);
CREATE INDEX idx_calendar_events_recurring ON calendar_events(recurring_event_id);
CREATE INDEX idx_calendar_events_status ON calendar_events(status);

-- RLS: public read access (anon key), write via service role only
ALTER TABLE calendar_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read" ON calendar_events FOR SELECT USING (true);
```

**Note:** Like `event_secrets`, `calendar_events` and `geocode_cache` are Supabase-only tables — no Drizzle schema or local migration. Apply via `mcp__supabase__apply_migration` only.

### Supabase table: `geocode_cache`

```sql
CREATE TABLE geocode_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_query TEXT NOT NULL UNIQUE,
  lat DECIMAL(9,6),
  lng DECIMAL(9,6),
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE geocode_cache ENABLE ROW LEVEL SECURITY;
-- No public read needed; accessed only via service role key from backend
```

### Deduplication strategy

Events appear on multiple sources. Dedup by:
1. **source + source_id** — unique per source
2. **Cross-source matching** — name similarity (Levenshtein) + date + location proximity
3. When matched across sources, merge metadata (take richest data), keep all source_urls

### Pipeline architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  Scraper 1   │────▶│              │     │             │
│ maratonypl   │     │   Normalizer │────▶│  Supabase   │
├─────────────┤     │   + Dedup    │     │  calendar_  │
│  Scraper 2   │────▶│              │     │  events     │
│  dostartu    │     └──────────────┘     └─────────────┘
├─────────────┤            ▲
│  Scraper 3   │────────────┘
│  Facebook    │
└─────────────┘
```

- **Scrapers**: individual modules per source, return normalized event objects
- **Normalizer**: validates, geocodes (location → lat/lng), classifies event type from description
- **Dedup engine**: matches against existing records, upserts
- **Scheduler**: runs daily via cron (or Supabase Edge Function on schedule)

### Scraper location

New directory: `backend/src/scrapers/`
```
scrapers/
  index.js              -- orchestrator: runs all scrapers, normalizes, deduplicates, upserts
  sources/
    maratonypolskie.js  -- scraper for maratonypolskie.pl
    dostartu.js         -- scraper for dostartu.pl
    facebook.js         -- scraper for Facebook events
  normalizer.js         -- normalize scraped data to calendar_events schema
  dedup.js              -- cross-source deduplication logic
  geocoder.js           -- location string → lat/lng (using Nominatim/OSM)
```

### Run schedule

- Backend route: `POST /api/scrapers/run` — triggers a full scrape (localhost-only, backend runs in Docker so not exposed externally)
- Automated: daily at 03:00 via `node-cron` in backend startup
- Each scraper logs results: `{ source, found, new, updated, errors }`

### Geocoding

- Use OpenStreetMap Nominatim (free, no API key)
- Rate limit: 1 req/sec
- Cache results in a `geocode_cache` table to avoid re-geocoding same locations
- Fallback: if geocode fails, store null lat/lng (event still shows in list view, not on map)

### Recurring event linking

- When scraping, detect recurring events by name pattern matching
- E.g., "15. Bieg Piastów 2026" and "14. Bieg Piastów 2025" get the same `recurring_event_id`
- This powers future personalization: "You ran Bieg Piastów last year — 2026 edition is open for registration"

### Future personalization data (not in this spec, but data model supports)

- User accounts (login via email/social)
- Race history tracking (which events a user participated in)
- Reminders when a recurring event opens registration
- Recommendations based on past races (type, distance, location proximity)
- The `calendar_events` metadata fields (`event_type`, `distances`, `surface`, `elevation_gain_m`, `is_night`, `voivodeship`) are specifically designed to power these recommendation queries

## Technical decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Map library | Leaflet.js + OpenStreetMap | Free, no API key, good dark tiles (CartoDB) |
| Geocoding | Nominatim (OSM) | Free, sufficient for Polish cities |
| Scraping | cheerio + fetch | Lightweight, no browser needed for HTML scraping |
| Calendar data storage | Supabase only | Public page reads from Supabase directly, no need for local DB sync |
| Pipeline runtime | Backend (Node.js) | Reuses existing Fastify server, access to Supabase client |
| Scheduling | node-cron in backend | Lightweight, time-of-day scheduling without drift |

## Files to create/modify

### New files
- `public/src/pages/Landing.jsx` — landing page component
- `public/src/pages/Kalendarz.jsx` — kalendarz page component
- `public/src/components/Navbar.jsx` — shared navbar (Landing + Kalendarz)
- `public/src/components/Footer.jsx` — shared footer
- `public/src/components/EventRow.jsx` — reusable event row for kalendarz
- `public/src/components/FilterBar.jsx` — sticky filter bar
- `public/src/components/MapView.jsx` — Leaflet map component
- `backend/src/scrapers/index.js` — scraper orchestrator
- `backend/src/scrapers/sources/maratonypolskie.js`
- `backend/src/scrapers/sources/dostartu.js`
- `backend/src/scrapers/sources/facebook.js`
- `backend/src/scrapers/normalizer.js`
- `backend/src/scrapers/dedup.js`
- `backend/src/scrapers/geocoder.js`
- `backend/src/routes/scrapers.js` — admin route to trigger scraping

### Modified files
- `public/src/App.jsx` — add `/` and `/kalendarz` routes
- `public/src/app.css` — bump muted color contrast for WCAG AA
- `public/index.html` — update `<title>` to "Leszy.run"
- Supabase: new `calendar_events` and `geocode_cache` tables via `mcp__supabase__apply_migration` (Supabase-only, no Drizzle)

### New dependencies
- `public/package.json`: `leaflet`, `react-leaflet`
- `backend/package.json`: `cheerio`, `node-cron`

## Mockups

Visual mockups created during brainstorming are in:
- `.superpowers/brainstorm/` — landing page (v5) and kalendarz HTML mockups
