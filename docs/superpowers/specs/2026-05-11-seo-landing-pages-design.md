# SEO Landing Pages (`/biegi/*`) — Design

## Overview

Programmatic SEO landing pages generated from `calendar_events` Supabase data. Each page
targets a specific facet combination (event type, voivodeship, year/month) and serves as a
static HTML file — the same pattern already used for individual event pages. Google indexes
static HTML directly without JS rendering. Pages regenerate nightly as part of the daily
pipeline.

**Estimated scope:** ~300–500 valid pages across all combinations. Special pages always
generated; faceted combos only when they meet minimum event thresholds.

---

## URL structure

All under `/biegi/` prefix. Polish slugs throughout (no English terms, no diacritics in URLs).

| Pattern | Example URL | Label |
|---|---|---|
| `/biegi` | `/biegi` | Hub — all types and regions |
| `/biegi/[type]` | `/biegi/przelajowe` | Type only |
| `/biegi/[region]` | `/biegi/slaskie` | Region only |
| `/biegi/[type]/[region]` | `/biegi/przelajowe/slaskie` | Type + region |
| `/biegi/[year]/[month]` | `/biegi/2026/lipiec` | Month only |
| `/biegi/[type]/[year]/[month]` | `/biegi/przelajowe/2026/lipiec` | Type + month |
| `/biegi/[region]/[year]/[month]` | `/biegi/slaskie/2026/lipiec` | Region + month |
| `/biegi/[type]/[region]/[year]/[month]` | `/biegi/przelajowe/slaskie/2026/lipiec` | All three |
| `/biegi/polmaratony` | — | Half marathons (distance-based) |
| `/biegi/maratony` | — | Marathons (distance-based) |
| `/biegi/dla-dzieci` | — | Kids events (`is_kids = true`) |
| `/biegi/darmowe` | — | Free events (`price_from = 0`) |

---

## Type slug mapping

Maps `event_type[]` DB values → URL slug → Polish display forms.

| DB value | URL slug | H1 noun phrase | Polish search keywords |
|---|---|---|---|
| `trail` | `przelajowe` | Biegi przełajowe | biegi przełajowe, bieg przełajowy, trail running, biegi terenowe, biegi górskie |
| `uliczny` | `uliczne` | Biegi uliczne | biegi uliczne, bieg uliczny, biegi miejskie, bieg po asfalcie |
| `ultra` | `ultramaratony` | Ultramaratony | ultramaratony, biegi ultra, ultramaraton, ultra trail, biegi długodystansowe |
| `nocny` | `nocne` | Biegi nocne | biegi nocne, bieg nocny, night run, nocny bieg |
| `ocr` | `ocr` | Biegi OCR | biegi OCR, obstacle run, biegi z przeszkodami, OCR race |
| `nordic walking` | `nordic-walking` | Nordic Walking | nordic walking, marsze nordic walking, NW |
| `charytatywny` | `charytatywne` | Biegi charytatywne | biegi charytatywne, charytatywny bieg, bieg na cel |

For type-only pages, secondary keywords are folded into the meta description (comma-separated,
after the event count sentence).

---

## Region slug mapping

Maps `voivodeship` DB value (capitalized, e.g. `Śląskie`) → URL slug → locative form for
copy ("w Śląskiem"). Locative is required for natural Polish grammar in h1/title.

| DB voivodeship | URL slug | Locative (for copy) |
|---|---|---|
| Dolnośląskie | `dolnoslaskie` | w Dolnośląskiem |
| Kujawsko-Pomorskie | `kujawsko-pomorskie` | w Kujawsko-Pomorskiem |
| Lubelskie | `lubelskie` | w Lubelskiem |
| Lubuskie | `lubuskie` | w Lubuskiem |
| Łódzkie | `lodzkie` | w Łódzkiem |
| Małopolskie | `malopolskie` | w Małopolsce |
| Mazowieckie | `mazowieckie` | na Mazowszu |
| Opolskie | `opolskie` | w Opolskiem |
| Podkarpackie | `podkarpackie` | na Podkarpaciu |
| Podlaskie | `podlaskie` | na Podlasiu |
| Pomorskie | `pomorskie` | na Pomorzu |
| Śląskie | `slaskie` | w Śląskiem |
| Świętokrzyskie | `swietokrzyskie` | w Świętokrzyskiem |
| Warmińsko-Mazurskie | `warminsko-mazurskie` | na Warmii i Mazurach |
| Wielkopolskie | `wielkopolskie` | w Wielkopolsce |
| Zachodniopomorskie | `zachodniopomorskie` | w Zachodniopomorskiem |

---

## Month slug mapping

| Month number | URL slug | Locative (for copy) |
|---|---|---|
| 1 | `styczen` | w styczniu |
| 2 | `luty` | w lutym |
| 3 | `marzec` | w marcu |
| 4 | `kwiecien` | w kwietniu |
| 5 | `maj` | w maju |
| 6 | `czerwiec` | w czerwcu |
| 7 | `lipiec` | w lipcu |
| 8 | `sierpien` | w sierpniu |
| 9 | `wrzesien` | we wrześniu |
| 10 | `pazdziernik` | w październiku |
| 11 | `listopad` | w listopadzie |
| 12 | `grudzien` | w grudniu |

---

## Generation thresholds

Pages with zero or near-zero events are omitted to avoid thin-content penalties.

| Page type | Generate when |
|---|---|
| Hub (`/biegi`) | Always (1 page) |
| Type-only (`/biegi/[type]`) | Always (7 pages) |
| Region-only (`/biegi/[region]`) | Always (16 pages) |
| Special pages (polmaratony, maratony, dla-dzieci, darmowe) | Always |
| Type + region | ≥ 2 events |
| Month-only | ≥ 5 events |
| Type + month | ≥ 3 events |
| Region + month | ≥ 3 events |
| Type + region + month | ≥ 3 events |

Two separate filters apply:

- **Threshold computation** (deciding whether to generate a page): `status = 'active'`,
  `date >= today - 30 days`. The 30-day lookback prevents a page from dropping below threshold
  and vanishing overnight just because its last event date passed yesterday.
- **Display + metadata counts** (event counts used in titles, intros, and what users see on the
  page): `status = 'active'`, `date >= today`, `registration_deadline IS NULL OR
  registration_deadline >= today`. Future events only; hides events where registration is
  definitively closed while keeping events with no deadline data (most events).

A page can be generated (threshold met via lookback) while showing fewer events than its title
count suggests. This is acceptable — the title count comes from the display filter, not the
threshold filter, so they stay in sync.

**Below-threshold URL handling:** When a previously-generated page drops below its threshold on a
subsequent run, the static file is removed and the manifest entry deleted. The Vite SPA route
(`/biegi/*`) catches the missing static page on client-side navigation and renders a live query
normally. For direct URL access (crawlers, bookmarks) the missing `index.html` causes a 404 at
the CDN level — configure a CDN-level redirect rule: any `/biegi/*` URL without a matching static
file → `302` to the nearest parent (type-only or region-only page if determinable from path, else
`/biegi`).

---

## Keyword strategy per page

### Titles

Format: `[Polish noun phrase] ([count] [inflected noun]) — Leszy.run`

Polish event count inflection:
- 1 → "1 wydarzenie"
- 2–4 → "N wydarzenia"
- 5+ → "N wydarzeń"

Examples:
- `Biegi przełajowe (47 wydarzeń) — Leszy.run`
- `Biegi przełajowe w Śląskiem (23 wydarzenia) — Leszy.run`
- `Biegi przełajowe w Śląskiem — lipiec 2026 (8 wydarzeń) — Leszy.run`

Year is always explicit in title when a month is in the URL (time-sensitive content).

### Meta descriptions

Format: `[Count] [noun phrase] [optional locative region] [optional month]. [Secondary keywords]. Zapisy, dystanse, ceny.`

Examples:
- `47 biegów przełajowych w Polsce. Trail running, biegi terenowe, biegi górskie. Zapisy, dystanse, ceny.`
- `23 biegi przełajowe w Śląskiem. Sprawdź najbliższe trailrunning śląsk, biegi górskie śląskie 2026.`
- `8 biegów przełajowych w Śląskiem w lipcu 2026. Zapisz się przed zamknięciem list.`

### H1

Simpler than title — no count, just the keyword phrase:
- `/biegi` → `Biegi w Polsce — kalendarz biegów 2026`
- `/biegi/przelajowe` → `Biegi przełajowe w Polsce`
- `/biegi/slaskie` → `Biegi w Śląskiem`
- `/biegi/przelajowe/slaskie` → `Biegi przełajowe w Śląskiem`
- `/biegi/2026/lipiec` → `Biegi w lipcu 2026`
- `/biegi/przelajowe/2026/lipiec` → `Biegi przełajowe w lipcu 2026`
- `/biegi/przelajowe/slaskie/2026/lipiec` → `Biegi przełajowe w Śląskiem — lipiec 2026`

### Secondary keywords in meta description (per type)

| Type | Secondary keywords to include |
|---|---|
| przelajowe | trail running, biegi terenowe, biegi górskie, bieg w terenie |
| uliczne | biegi miejskie, bieg po asfalcie, bieg uliczny |
| ultramaratony | biegi ultra, ultramaraton, ultra trail, biegi długodystansowe |
| nocne | bieg nocny, night run, nocny bieg uliczny |
| ocr | biegi z przeszkodami, obstacle run, obstacle race |
| nordic-walking | marsze nordic walking, NW |
| charytatywne | charytatywny bieg, bieg na cel, bieg dobroczynny |
| polmaratony | bieg na 21 km, półmaraton, half marathon |
| maratony | bieg na 42 km, maraton, marathon polska |
| dla-dzieci | biegi rodzinne, bieg dla dzieci, biegi juniorów |
| darmowe | bezpłatne biegi, darmowy bieg, biegi za darmo |

### Above-the-fold intro paragraph

Every landing page renders a short auto-generated intro paragraph immediately below the H1,
before the event list. Generated entirely from manifest data — no LLM, no manual writing.

**Template per page type:**

- **Hub** (`/biegi`): `"[N] biegów w Polsce w [year] roku — trailowe, uliczne, ultramaratony i więcej. Sprawdź pełny kalendarz według typu i województwa."`
- **Type-only**: `"[N] [noun-phrase] w Polsce w [year] roku[, od [min_dist] km do [max_dist] km]. Najbliższe zawody: [top 3 city list]."`
- **Region-only**: `"[N] biegów [locative-region] w [year] roku, w tym [top 2 types by count]. Zawody w: [top 4 city list]."`
- **Type + region**: `"[N] [noun-phrase] [locative-region] w [year] roku[, od [min_dist] km do [max_dist] km]. Zawody w: [top 3 city list]."`
- **Month combos**: append `" Zapisy otwarte do [nearest deadline date]."` if any event has `registration_deadline` set.
- **Special — polmaratony/maratony**: `"[N] [półmaratonów|maratonów] w Polsce w [year] roku. Dystans [21/42] km, ceny od [min_price] do [max_price] zł. Zawody w: [top 3 city list]."`
- **Special — dla-dzieci**: `"[N] biegów dla dzieci w Polsce w [year] roku. Krótkie dystanse dla najmłodszych biegaczy. Zawody w: [top 3 city list]."`
- **Special — darmowe**: `"[N] darmowych biegów w Polsce w [year] roku. Bezpłatny udział, bez opłaty startowej. Zawody w: [top 3 city list]."`

Fields: `N` = event count, `min/max_dist` = from `distances[]` across matched events (omit if no distance data), `top N city list` = cities with most events in the facet. All derived from the Supabase query result at manifest-generation time and stored in the manifest entry.

Add a `intro` field to the manifest entry so `generate-landing-pages.js` can embed it in the
static HTML without a second DB query at build time.

---

## Manifest format

`publish-landing-pages.js` writes `public/public/biegi/.manifest.json`:

```json
{
  "biegi/przelajowe/slaskie": {
    "path": "biegi/przelajowe/slaskie",
    "filters": {
      "event_type": "trail",
      "voivodeship": "Śląskie"
    },
    "h1": "Biegi przełajowe w Śląskiem",
    "title": "Biegi przełajowe w Śląskiem (23 wydarzenia) — Leszy.run",
    "description": "23 biegi przełajowe w Śląskiem. Trail running, biegi górskie śląsk. Zapisy, dystanse, ceny.",
    "intro": "23 biegi przełajowe w Śląskiem w 2026 roku, od 5 km do 50 km. Zawody w: Katowicach, Gliwicach, Bielsku-Białej.",
    "eventCount": 23,
    "canonicalUrl": "https://www.leszy.run/biegi/przelajowe/slaskie",
    "sitemapPriority": "0.8",
    "sitemapChangefreq": "weekly"
  }
}
```

Special pages encode their filter type:
```json
{
  "biegi/polmaratony": {
    "path": "biegi/polmaratony",
    "filters": { "distanceType": "halfmarathon" },
    "h1": "Półmaratony w Polsce",
    ...
  },
  "biegi/ostatnia-szansa": {
    "path": "biegi/ostatnia-szansa",
    "filters": { "deadlineDays": 14 },
    "h1": "Zapisy zamykają się wkrótce",
    ...
  }
}
```

---

## Static HTML structure per page

Each `dist/biegi/[path]/index.html` contains:

- Full `<head>` with title, meta description, canonical, robots
- Open Graph + Twitter Card meta tags
- JSON-LD `CollectionPage` + `ItemList` + `SportsEvent` schema:
  ```json
  {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    "name": "[h1]",
    "description": "[meta description]",
    "url": "[canonicalUrl]",
    "inLanguage": "pl-PL",
    "breadcrumb": {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Leszy.run", "item": "https://www.leszy.run" },
        { "@type": "ListItem", "position": 2, "name": "Biegi w Polsce", "item": "https://www.leszy.run/biegi" },
        { "@type": "ListItem", "position": 3, "name": "[h1]", "item": "[canonicalUrl]" }
      ]
    },
    "mainEntity": {
      "@type": "ItemList",
      "itemListElement": [
        {
          "@type": "ListItem",
          "position": 1,
          "item": {
            "@type": "SportsEvent",
            "name": "[event name]",
            "startDate": "[event date]",
            "location": {
              "@type": "Place",
              "name": "[city]",
              "address": {
                "@type": "PostalAddress",
                "addressLocality": "[city]",
                "addressRegion": "[voivodeship]",
                "addressCountry": "PL"
              }
            },
            "offers": {
              "@type": "Offer",
              "price": "[price_from]",
              "priceCurrency": "PLN",
              "availability": "https://schema.org/InStock"
            },
            "url": "[registration_url or website]"
          }
        }
      ]
    }
  }
  ```
  Generate one `ListItem` per event in the page's result set (capped at 50 for schema size).
  Omit `offers` block when `price_from` is null. Omit `url` when neither `registration_url` nor
  `website` is available.
- `<script id="landing-data" type="application/json">` — embeds the manifest entry (filters,
  h1, title) so the SPA can read it on hydration without a Supabase round-trip for metadata
- Vite CSS/JS assets (same hashed links extracted from `dist/index.html`)
- Theme flash prevention script

---

## Internal linking architecture

Each static page includes a "Related pages" section rendered from manifest data — no client-side
Supabase query needed, links are baked into the HTML.

### Hub page (`/biegi`)
- Navigation-only page — no event list
- Renders grouped link blocks: one block per type (7 links), one block per region (16 links),
  one block for special pages (4 links: polmaratony, maratony, dla-dzieci, darmowe)
- Each link shows the h1 label and event count from the manifest
- No `FilterBar`, no event cards
- Linked from main site navigation in `public/src/App.jsx` header

### Type-only pages (`/biegi/[type]`)
- Link up to `/biegi` hub
- Link to all type+region combos that meet threshold, sorted by event count descending
- Link to next 3 months of type+month combos that exist in the manifest

### Region-only pages (`/biegi/[region]`)
- Link up to `/biegi` hub
- Link to all type+region combos for that region that meet threshold
- Link to next 3 months of region+month combos that exist in the manifest

### Type + region pages
- Link up to parent type-only page and parent region-only page
- Link to 5 sibling regions with most events for the same type (from manifest)
- Link to next 2 months of type+region+month combos that exist in the manifest

### Month combo pages
- Link up to the parent without the month (e.g. `/biegi/przelajowe/slaskie/2026/lipiec` → `/biegi/przelajowe/slaskie`)
- Link to adjacent months (previous and next) if those manifest entries exist

### Special pages
- Link up to `/biegi` hub
- No sibling links between special pages

### Implementation
`publish-landing-pages.js` computes the link sets from the complete manifest in memory and adds
a `relatedLinks: [{ path, h1 }]` array to each manifest entry. `generate-landing-pages.js` renders
these as an `<nav aria-label="Powiązane strony">` block in the static HTML.

---

## New scripts

### `backend/scripts/publish-landing-pages.js`

Runs from the project root with `--env-file=../.env`. Dry run by default, `--apply` to write.

Steps:
1. Connect to Supabase (same credentials as `publish-event-pages.js`)
2. Query A — threshold set: `status = 'active'`, `date >= today - 30 days`; fetch
   `date, voivodeship, event_types, distances, price_from, is_kids, registration_deadline`
3. Query B — display set: `status = 'active'`, `date >= today`,
   `registration_deadline IS NULL OR registration_deadline >= today`; fetch same fields
   plus `city`. This is the set used for counts, metadata, and what users see on the page.
4. Compute all valid type × region × month combinations against thresholds using Query A;
   always include hub, all 7 type-only, all 16 region-only, and 4 special pages
5. For each manifest entry compute from Query B (display set):
   - `eventCount` — matched event count
   - `topCities` — top 3–4 cities by event count within the facet
   - `distanceRange` — `{ min, max }` from `distances[]` across matched events (null if no data)
   - `nearestDeadline` — earliest `registration_deadline` among matched events (null if none)
6. Generate `h1` / `title` / `description` strings using the Polish grammar rules above
7. Generate `intro` string per page type using the templates in "Above-the-fold intro paragraph"
8. Compute `relatedLinks` for each entry from the complete in-memory manifest (hub→children,
   type→region combos, region→type combos, sibling regions, adjacent months)
9. Write `public/public/biegi/.manifest.json` (or log diff in dry-run)

### `public/scripts/generate-landing-pages.js`

Runs post-Vite-build, after `generate-event-pages.js`.

Steps:
1. Read `public/biegi/.manifest.json`
2. Extract CSS/JS asset links from `dist/index.html` (same method as existing script)
3. For each manifest entry: create `dist/biegi/[path]/index.html`
4. Append all landing page URLs to the existing `dist/sitemap.xml`

---

## React SPA changes

New route added to `public/src/App.jsx`:

```
/biegi/*  →  LandingPage.jsx
```

`LandingPage.jsx`:
- On mount: reads `<script id="landing-data">` if present (static page first load);
  otherwise parses URL path segments to reconstruct filters
- Renders the `intro` string from landing-data as a `<p>` immediately below the H1
- Renders the `relatedLinks` block from landing-data as a nav section above the event list
- Queries Supabase using the resolved filters plus the display filter: `date >= today`,
  `registration_deadline IS NULL OR registration_deadline >= today`
- Renders event list reusing existing `FilterBar` and event card components from Kalendarz
- Shows h1 from landing-data (or derived from URL) above the list
- "Przeglądaj i filtruj" button links to `/kalendarz` with the same filters pre-filled as
  query params

**Special page filter logic (new logic required for all four special pages):**

| Special page | Filter | Supabase column |
|---|---|---|
| `polmaratony` | `distanceType: "halfmarathon"` | `distances[]` contains value 19–23 km |
| `maratony` | `distanceType: "marathon"` | `distances[]` contains value 41–44 km |
| `dla-dzieci` | `isKids: true` | `is_kids = true` |
| `darmowe` | `isFree: true` | `price_from = 0` |

All four require a new filter path in `LandingPage.jsx`. The Kalendarz `event_types` filter
does not cover any of these cases.

**Pagination:** The Supabase query uses `.range(0, 99)` (100 events). If `eventCount` in
landing-data exceeds 100, render a "Pokaż więcej" button that fetches the next page. The static
HTML always reflects the first 100 events; pagination beyond that is client-side only and is
not indexed by search engines. This is acceptable — pages with >100 events (type-only, large
regions) get adequate crawlable content from the first 100.

---

## Pipeline integration

`publish-landing-pages.js` is added as **step 12** to the daily pipeline in
`scheduler/pipeline.js`, running after step 11 (`publish-event-pages.js`):

```
step 12: node scripts/publish-landing-pages.js --apply
```

The `public/` npm build script in `package.json` gets `generate-landing-pages.js` appended
after `generate-event-pages.js`:

```json
"build": "node scripts/generate-og-image.js && vite build && node scripts/generate-event-pages.js && node scripts/generate-landing-pages.js"
```

---

## Sitemap

`generate-landing-pages.js` appends landing page entries to the `sitemap.xml` already
written by `generate-event-pages.js`. It reads the XML file, removes the closing `</urlset>`,
appends new `<url>` entries, then re-appends `</urlset>`.

Sitemap priorities:
- Type-only, region-only: `priority=0.8`, `changefreq=weekly`
- Type + region: `priority=0.7`, `changefreq=weekly`
- Month combos (any): `priority=0.6`, `changefreq=daily`
- Special pages: `priority=0.8`, `changefreq=daily`

---

## Out of scope

- City-level pages (`/biegi/krakow`) — requires lat/lng radius query at build time, adds
  complexity. Add after this ships if SEO data shows demand.
- Localization (`/en/*`) — future work; Polish URLs are canonical for now.
- Editorial/content-rich pages — data-only for all pages in this phase.
- OG images per landing page — use a generic type-based OG image (future enhancement).
- Special page + month combos (`/biegi/dla-dzieci/2026/lipiec`, `/biegi/darmowe/2026/lipiec`,
  etc.) — excluded from v1 URL structure. The 4 special pages are flat only.
- `ostatnia-szansa` — removed; deadline-urgency signal is covered by the `registration_deadline`
  display on individual event cards.
