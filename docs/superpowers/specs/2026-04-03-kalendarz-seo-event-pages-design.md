# Kalendarz SEO — Individual Event Pages & Static OG Images

## Problem

The `/kalendarz` page is a client-side SPA. All events live behind JS-rendered filters with no individual URLs. This means:
- No indexable pages per event (Google can index the list, but not individual events)
- Social sharing of a specific event shows the generic leszy.run OG image
- No structured data per event for rich search results
- Queries like "bieg 7 szczytow 2026 zapisy" can't land on a dedicated page

## Solution

Three additions:
1. **Individual event pages** at `/kalendarz/:slug` with per-event SEO
2. **Static OG images** generated at build time per event
3. **Static sitemap** generated at build time

## 1. Individual Event Pages

### Slug format

`{slugified-name}-{YYYY-MM-DD}` computed from event data. No new DB column.

Slugify function:
- Lowercase
- Polish diacritics to ASCII (ś→s, ł→l, ó→o, ż→z, ź→z, ą→a, ć→c, ę→e, ń→n)
- Strip non-alphanumeric except spaces
- Spaces → hyphens, collapse multiples
- Append `-YYYY-MM-DD` from event date

Example: `"Bieg 7 Szczytów Ultra Trail" + 2026-07-12 → bieg-7-szczytow-ultra-trail-2026-07-12`

Edge case — duplicate name+date (rare due to dedup): append first 4 chars of event ID.

### Lookup

Shared `slugify()` function used identically at build time and runtime. No DB query needed for direct URL hits (data embedded in static HTML). SPA navigation falls back to Supabase query: filter by date extracted from slug suffix, then match slugified name.

### Manifest (`public/kalendarz/.manifest.json`)

Source of truth for event page generation. Committed to repo. Updated by `scripts/run-publish.js` after scraper pipeline.

Structure: `{ [slug]: { id, name, date, end_date, location, voivodeship, lat, lng, distances, event_type, registration_url, website, regulamin_url, price_from, price_to, registration_deadline, max_participants, elevation_gain_m, surface, is_night, is_charity, is_kids } }`

### Publish script (local, `scripts/run-publish.js`)

Runs after scraper pipeline. Responsible for:
1. Query all `calendar_events` where `status = 'active'` from Supabase
2. Compute slug for each event
3. Compare with existing manifest — identify new, updated, and removed events
4. Generate OG images (`public/kalendarz/{slug}/og.png`) only for new/changed events using `sharp`
5. Remove OG images for events no longer active
6. Write updated manifest
7. Commit manifest + OG images to repo

OG images live in `public/` (committed) because they're expensive to generate and don't depend on the JS bundle hash.

### Vercel build (automated on push)

Post-`vite build` script reads the manifest and generates HTML + sitemap into `dist/`:
1. Read `public/kalendarz/.manifest.json` for event data (no Supabase query)
2. Read `dist/index.html` to extract the hashed JS bundle filename
3. For each event in manifest, write `dist/kalendarz/{slug}/index.html` containing:
   - Full `<head>` with baked-in meta tags (title, description, OG, Twitter Card, canonical)
   - JSON-LD `SportsEvent` structured data
   - OG image URL pointing to `og.png` in same directory (already in `public/`, copied by Vite)
   - Event data embedded as `<script id="event-data" type="application/json">`
   - Same `<script type="module" src="/assets/index-[hash].js">` as the main SPA
4. Write `dist/sitemap.xml` with all event URLs
5. Fast — just reading manifest and writing small HTML files, no network calls

### Page layout

**Header:**
- Breadcrumb: Kalendarz / Event Name
- Date badge with countdown (if upcoming)
- Event title (h1, Barlow Condensed uppercase)
- Location with map pin icon

**Tags row:** Event type badges (trail, nocny, ultra, ocr, nordic, charytatywny, uliczny) + distance badges. Special colors: cyan for types, yellow-dim for distances, purple for nocny, green for charytatywny.

**CTA buttons:** Only rendered if URL exists.
- "Zapisy" → `registration_url` (primary, yellow filled)
- "Strona wydarzenia" → `website` (secondary, border only)
- "Regulamin" → `regulamin_url` (secondary, border only)

**Info grid:** 2-column grid, cells only rendered when data exists.
| Field | Source | Always present? |
|-------|--------|----------------|
| Data | `date` + `end_date` | Yes |
| Lokalizacja | `location`, `voivodeship` | Yes |
| Dystanse | `distances[]` | Usually |
| Cena | `price_from`, `price_to` | Enriched only |
| Termin zapisów | `registration_deadline` | Enriched only |
| Max. uczestników | `max_participants` | Enriched only |
| Przewyższenie | `elevation_gain_m` | Enriched only (trail) |
| Nawierzchnia | `surface` | Enriched only (trail) |

When odd number of cells, last cell spans full width.

**Map:** Leaflet single-pin map using `lat`/`lng`. Reuse existing MapView or a simpler single-marker variant.

**Report button:** "Zgłoś poprawkę" — reuses existing `ReportEventModal`.

**Nearby events:** "W okolicy tego weekendu" section.
- Query: same `voivodeship`, date within ±3 days, limit 5, exclude current event
- Shows: date, name, location + distance in km (if user has geolocation), distance tag
- Each row links to that event's `/kalendarz/:slug` page

### Per-page SEO

`useSeo()` hook with:
- **Title:** `{event.name} — {date} — {location}`
- **Description:** `{date formatted Polish} · {location} · {distances joined} · {types joined}`
- **Canonical:** `https://leszy.run/kalendarz/{slug}`
- **OG image:** `https://leszy.run/kalendarz/{slug}/og.png`
- **JSON-LD:** `SportsEvent` schema:
  ```json
  {
    "@context": "https://schema.org",
    "@type": "SportsEvent",
    "name": "...",
    "startDate": "2026-07-12",
    "endDate": "2026-07-13",
    "location": {
      "@type": "Place",
      "name": "Karpacz",
      "address": { "@type": "PostalAddress", "addressRegion": "Dolnośląskie", "addressCountry": "PL" },
      "geo": { "@type": "GeoCoordinates", "latitude": 50.76, "longitude": 15.72 }
    },
    "offers": {
      "@type": "AggregateOffer",
      "lowPrice": 120,
      "highPrice": 380,
      "priceCurrency": "PLN",
      "availability": "https://schema.org/InStock",
      "url": "https://registration-url..."
    },
    "url": "https://leszy.run/kalendarz/bieg-7-szczytow-ultra-trail-2026-07-12"
  }
  ```
  `offers` only included when `price_from` exists. `endDate` only when `end_date` exists.

## 2. Static OG Images — Publish-time Generation

Generated by `scripts/run-publish.js` (locally) using `sharp` (already a dependency). Committed to repo at `public/kalendarz/{slug}/og.png`. Vite copies them to `dist/` during build.

### Per-event image

Same approach as existing `generate-og-image.js` — build an SVG, composite with sharp, output PNG.

Content:
- Top/bottom yellow accent bars
- Leszy logo (smaller, top-center)
- Event name — large Barlow Condensed uppercase
- Date — formatted Polish (e.g. "12 LIPCA 2026")
- Location + voivodeship
- Distance badges in a row
- Type badges
- "leszy.run/kalendarz" branding at bottom

Output: `public/kalendarz/{slug}/og.png`

### Image spec

- 1200x630px (standard OG)
- Light theme (readability on dark social card backgrounds)
- Colors from `html.light` CSS variables
- Fonts: SVG text with system font fallbacks (same as existing OG generator)

Incremental: only generated for new/changed events (publish script compares manifest).

## 3. Static Sitemap — Build-time Generation

Generated by the Vercel post-build script (same one that generates HTML), written to `dist/sitemap.xml`. Reads event data from the manifest.

### Content

1. Static entries: `/`, `/kalendarz`, `/kalendarz/dodaj`, `/events` (same as current)
2. One `<url>` per event in manifest: `<loc>https://leszy.run/kalendarz/{slug}</loc>`, `<changefreq>weekly</changefreq>`

Replaces the current hand-maintained `public/sitemap.xml`. `robots.txt` stays unchanged (already points to `https://leszy.run/sitemap.xml`).

## 4. EventRow navigation change

Currently `EventRow` opens external registration URLs on click. Change to:
- Click → `/kalendarz/{slug}` (internal SPA navigation via React Router)
- Registration URL becomes the CTA on the event subpage
- Keeps users on-site, improves dwell time, each event gets a proper landing page

Exception: events with `leszyrun_event_id` still navigate to `/events/:slug`.

## 5. Router update

Add route in `App.jsx`:
```js
/kalendarz/:slug → EventPage (lazy)
```

`EventPage` component:
1. Check for embedded `#event-data` JSON (direct URL hit with static HTML)
2. If found, use it directly — no fetch
3. If not (SPA navigation), extract date from slug, query Supabase, match by slugified name
4. Render the event page layout

## Not in scope

- SSR / prerendering framework migration
- New DB columns (slug is computed)
- Changes to scraper pipeline data collection
- Hreflang (Polish only)
- Kalendarz list page OG image (keeps using existing generic one)
