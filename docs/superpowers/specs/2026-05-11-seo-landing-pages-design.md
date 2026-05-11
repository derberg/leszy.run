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
| `/biegi/ostatnia-szansa` | — | Closing soon (deadline within 14 days) |

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
| Type-only (`/biegi/[type]`) | Always (7 pages) |
| Region-only (`/biegi/[region]`) | Always (16 pages) |
| Special pages (polmaratony, maratony, dla-dzieci, darmowe, ostatnia-szansa) | Always |
| Type + region | ≥ 2 events |
| Month-only | ≥ 5 events |
| Type + month | ≥ 3 events |
| Region + month | ≥ 3 events |
| Type + region + month | ≥ 3 events |

Event counts consider: `status = 'active'`, date ≥ today − 30 days (include recent past for pages
that just passed — avoids pages vanishing overnight after an event date passes).

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
- `Biegi przełajowe w Polsce`
- `Biegi przełajowe w Śląskiem`
- `Biegi przełajowe w Śląskiem — lipiec 2026`

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
| ostatnia-szansa | ostatnie miejsca, zamykające się zapisy, biegi ostatnia chwila |

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
- JSON-LD `CollectionPage` schema:
  ```json
  {
    "@type": "CollectionPage",
    "name": "[h1]",
    "description": "[meta description]",
    "url": "[canonicalUrl]",
    "inLanguage": "pl-PL",
    "breadcrumb": { ... }
  }
  ```
- `<script id="landing-data" type="application/json">` — embeds the manifest entry (filters,
  h1, title) so the SPA can read it on hydration without a Supabase round-trip for metadata
- Vite CSS/JS assets (same hashed links extracted from `dist/index.html`)
- Theme flash prevention script

---

## New scripts

### `backend/scripts/publish-landing-pages.js`

Runs from the project root with `--env-file=../.env`. Dry run by default, `--apply` to write.

Steps:
1. Connect to Supabase (same credentials as `publish-event-pages.js`)
2. Query all active events: `status = 'active'`, `date >= today - 30 days`
3. Compute all valid type × region × month combinations against thresholds
4. Compute special page event counts (distance filter, is_kids, price_from, deadline)
5. Generate h1 / title / description strings using the Polish grammar rules above
6. Write `public/public/biegi/.manifest.json` (or log diff in dry-run)

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
- Queries Supabase using the resolved filters (same client-side query as Kalendarz)
- Renders event list reusing existing `FilterBar` and event card components from Kalendarz
- Shows h1 from landing-data (or derived from URL) above the list
- "Przeglądaj i filtruj" button links to `/kalendarz` with the same filters pre-filled as
  query params

No new Supabase query logic needed — the same filter params Kalendarz already supports.

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
