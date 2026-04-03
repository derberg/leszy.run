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

### Static HTML generation (build-time)

Post-`vite build` script:
1. Query all `calendar_events` where `status = 'active'` from Supabase
2. Read `dist/index.html` to extract the hashed JS bundle filename
3. For each event, compute slug and write `dist/kalendarz/{slug}/index.html` containing:
   - Full `<head>` with baked-in meta tags (title, description, OG, Twitter Card, canonical)
   - JSON-LD `SportsEvent` structured data
   - OG image URL pointing to static `og.png` in same directory
   - Event data embedded as `<script id="event-data" type="application/json">`
   - Same `<script type="module" src="/assets/index-[hash].js">` as the main SPA
4. Takes seconds even for 2000+ events (each file ~2KB)

### Incremental generation (scraper pipeline)

A separate script for post-pipeline runs:
1. Read manifest from `dist/kalendarz/.manifest.json` (map of `{ slug: { eventId, generatedAt } }`)
2. Query `calendar_events` where `created_at > last_run_timestamp` or events not in manifest
3. Generate HTML only for new/missing events
4. Remove HTML for rejected/cancelled events
5. Update manifest

This runs as the last step of `scripts/run-publish.js`.

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

## 2. Static OG Images — Build-time Generation

Generated alongside the HTML files by the same post-build script using `sharp` (already a dependency).

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

Output: `dist/kalendarz/{slug}/og.png`

### Image spec

- 1200x630px (standard OG)
- Light theme (readability on dark social card backgrounds)
- Colors from `html.light` CSS variables
- Fonts: Barlow Condensed available locally via Google Fonts download in the build script, or use SVG text with system font fallbacks (same as existing OG generator)

### Incremental

Same manifest-based skip as HTML files. If `dist/kalendarz/{slug}/og.png` already exists for an unchanged event, skip regeneration. New/updated events get a fresh image.

## 3. Static Sitemap — Build-time Generation

Generated by the same post-build script, written to `dist/sitemap.xml`.

### Content

1. Static entries: `/`, `/kalendarz`, `/kalendarz/dodaj`, `/events` (same as current)
2. One `<url>` per active event page: `<loc>https://leszy.run/kalendarz/{slug}</loc>`, `<lastmod>` from event `updated_at` or `created_at`, `<changefreq>weekly</changefreq>`

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
