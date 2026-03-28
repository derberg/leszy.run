# Scraper Pipeline — Source-by-Source Documentation

## Running the pipeline

All commands run from project root. Requires `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in `backend/.env`.
No backend server or Docker needed — scripts talk directly to Supabase.

### Step 1: Scrape raw data

Fetches events from all 5 sources and stores in per-source tables (`scraper_dostartu`, `scraper_biegiwpolsce`, etc.).

```bash
cd backend && node --env-file=../.env scripts/run-scrapers.js

# Force re-scrape specific sources (clears their table first)
cd backend && node --env-file=../.env scripts/run-scrapers.js --force dostartu
cd backend && node --env-file=../.env scripts/run-scrapers.js --force dostartu,elektronicznezapisy
```

### Step 2: Dedup and merge into `scraper_all`

Reads all raw tables, deduplicates cross-source, merges into `scraper_all` with priority-based field resolution. dostartu data wins over all others.

Priority: dostartu (1) > biegiwpolsce (2) > elektronicznezapisy (3) > datasport (4) > maratonypolskie (5)

```bash
cd backend && node --env-file=../.env scripts/run-merge.js
```

After this, review `scraper_all` in Supabase to verify data quality before proceeding.

### Step 3: Fill missing voivodeships

Geocodes rows in `scraper_all` that have no `voivodeship`. Tries fast city→voivodeship map first, falls back to Nominatim (rate-limited ~1 req/s, results cached in `geocode_cache`). Also fills `lat`/`lng` if missing.

```bash
cd backend && node --env-file=../.env scripts/run-geocode.js
```

Output: `.` = city map hit, `G` = Nominatim geocoded, `MISS` = couldn't resolve.

### Step 4: Enrich flags (charity, kids)

Sets `charytatywny` event type from name keywords and `is_kids=true` when any distance is ≤ 1 km.

```bash
cd backend && node --env-file=../.env scripts/run-enrich-flags.js
```

Output: `C` = charity tagged, `K` = kids flagged.

### Step 5: Normalize into `calendar_events` (TODO)

Not yet implemented. Will normalize `scraper_all` (parse distances, classify types) and upsert into `calendar_events`.

## Supabase `calendar_events` table schema

| Column | Type | Nullable | Default | Notes |
|--------|------|----------|---------|-------|
| id | uuid | NO | gen_random_uuid() | PK |
| name | text | NO | | Event name |
| date | date | NO | | Start date |
| end_date | date | YES | | Multi-day events |
| location | text | YES | | City or venue |
| voivodeship | text | YES | | Polish region |
| lat | numeric | YES | | Latitude |
| lng | numeric | YES | | Longitude |
| event_type | text[] | YES | | `[trail, nocny, ocr, nordic, ultra, charytatywny, uliczny]` |
| distances | text[] | YES | | `["5 km", "10 km", "21.1 km"]` or `["4h", "6h"]` |
| registration_url | text | YES | | Link to sign up |
| registration_deadline | date | YES | | |
| price_from | integer | YES | | PLN |
| price_to | integer | YES | | PLN |
| website | text | YES | | Official event site |
| is_recurring | boolean | YES | false | |
| recurring_event_id | uuid | YES | | Links editions |
| edition_number | integer | YES | | e.g. XIII |
| surface | text[] | YES | | e.g. `[asphalt, trail, gravel]` |
| elevation_gain_m | integer | YES | | |
| max_participants | integer | YES | | |
| is_night | boolean | YES | false | |
| is_charity | boolean | YES | false | |
| source | text | NO | | Scraper name |
| source_url | text | YES | | Listing page URL |
| source_id | text | YES | | ID within that source |
| leszyrun_event_id | uuid | YES | | Links to local events table |
| status | text | YES | 'pending' | `pending` / `active` / `rejected` |
| last_verified_at | timestamptz | YES | now() | Last scraper touch |
| scraped_at | timestamptz | YES | now() | First scrape |
| updated_at | timestamptz | YES | now() | Last modification |
| created_at | timestamptz | YES | now() | Row creation |
| enriched_at | timestamptz | YES | | LLM enrichment timestamp |

---

## Source tables (Supabase)

Each scraper writes raw data into its own table. These are the raw scraper outputs — no normalization, no dedup.

### `scraper_maratonypolskie`
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| name | text | NOT NULL |
| date | date | NOT NULL |
| location | text | City from listing |
| distances | text | Single distance from listing cell (e.g., "10 km") |
| source_id | text | UNIQUE, code param or name-date |
| source_url | text | |
| scraped_at | timestamptz | |

### `scraper_datasport`
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| name | text | NOT NULL |
| date | date | NOT NULL |
| location | text | From listing |
| distances | text | From h4 headings (e.g., "10 km, 5 km") |
| regulamin_url | text | PDF link |
| source_id | text | UNIQUE, zawody number |
| source_url | text | |
| scraped_at | timestamptz | |

### `scraper_elektronicznezapisy`
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| name | text | NOT NULL |
| date | date | NOT NULL |
| location | text | From detail page |
| distances | text | From Cennik pricing section |
| registration_url | text | Signup link |
| regulamin_urls | text[] | Event-specific download links |
| external_website | text | From description content |
| known_source_link | text | If external link is a known source domain |
| source_id | text | UNIQUE, event number |
| source_url | text | |
| scraped_at | timestamptz | |

### `scraper_biegiwpolsce`
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| name | text | NOT NULL |
| date | date | NOT NULL |
| location | text | City from detail page |
| voivodeship | text | From detail page |
| distances | text | Extracted from tags: `5 km`, `10 km`, `21.1 km`, `42.2 km`, `ultra` |
| registration_url | text | Zapisy button link |
| regulamin_url | text | Regulamin button link (PDF or page) |
| event_types | text[] | Pure types only (e.g. `Przełaj/Cross`, `Uliczny`, `Górski`) — distance and kids tags split out |
| is_kids | boolean | NOT NULL, default false — true when tagged `Dla dzieci` |
| known_source_link | text | If reg URL is a known source domain |
| source_id | text | UNIQUE, URL slug |
| source_url | text | Per-event detail page URL |
| scraped_at | timestamptz | |

### `scraper_dostartu`
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| name | text | NOT NULL |
| date | date | NOT NULL |
| end_date | date | Multi-day events |
| location | text | From API |
| lat | numeric | From API |
| lng | numeric | From API |
| distances | text | From classifications API — see distance formats below |
| event_type | text | Mapped from numeric type |
| registration_url | text | websitePl or dostartu permalink |
| regulamin_url | text | statuteFilePl (hosted PDF) or statuteLinkPl (external) |
| is_kids | boolean | NOT NULL, default false — true when all classifications are kids-only |
| source_id | text | UNIQUE, API id |
| source_url | text | dostartu permalink (`/permalink-v{id}`) |
| scraped_at | timestamptz | |

---

## Source 1: maratonypolskie.pl

**URL:** `https://maratonypolskie.pl/mp_index.php?dzial=3&action=1&grp=13&trgr=1&bieganie&wyswietl=Tekstowo&region=Polska`
**Method:** Playwright (headless browser) — required because month/year selection is via `<select>` with `onchange` form submission. Retries 3 times on failure, logs loud error if all attempts fail.
**Encoding:** UTF-8 via Playwright
**Rate limit:** 1.5s between month navigations
**Events/year:** 500+

### What it scrapes

**Listing pages only (12 months ahead):**
Parses HTML `<td>` cells in a table. Looks for the "wyszukane" marker, then reads triplets of cells:
1. Cell 1: Date (`DD.MM.YYYY`)
2. Cell 2: City + optional distance suffix (`Kraków10 km`) — distance parsed from the same cell
3. Cell 3: Event name (from `<a>` link)

**No detail pages** — the listing data (name, date, city, single distance) is all we take. Detail pages on this site are junk quality and not worth the requests.

### Raw output fields
```
{ name, date, location, distances (single value from listing cell or empty),
  registration_url: null,
  source: 'maratonypolskie', source_url, source_id (code param or name-date) }
```

### Known issues
- `source_id` falls back to `name-date` when no `code=` param in href (unstable key)
- No registration URL from this source (always null)
- Distance from listing is a single value only (e.g., "10 km") — no multi-distance info
- Requires Playwright (heavy dependency)

### Flow diagram
```
┌──────────────────────────────┐
│  Launch Playwright browser   │
│  (retry up to 3 times)       │
└──────────┬───────────────────┘
           │
           ▼
┌──────────────────────────────┐
│  For each month (12 ahead):  │
│  Select year → Select month  │◄─── onchange triggers page reload
│  Parse HTML table cells      │
│  Extract: date, city+dist,   │
│  name                        │
└──────────┬───────────────────┘
           │
           ▼
┌──────────────────────────────┐
│  Return array of raw events  │
│  (no detail page fetching)   │
└──────────────────────────────┘
```

---

## Source 2: datasport.pl (liveds.datasport.pl)

**URL:** `https://liveds.datasport.pl/lista.html`
**Method:** HTTP fetch + Cheerio (listing) → fetch + Cheerio (detail pages)
**Encoding:** Windows-1250
**Rate limit:** 1.1s between detail page fetches
**Events/year:** 200+

### What it scrapes

**Phase 1 — Listing page (single page, all events):**
Parses `.event-list-box` elements:
- Name: `h5 a` text
- Date: first `YYYY-MM-DD` match in box text
- Location: first `<li>` text
- Source ID: `zawodyNNN` from href

**Phase 2 — Detail pages:**
Fetches `zawody_files/zawodyNNN.html` for each event.
- Finds `<section id="features">` (buttons area), then reads `<h4>` headings in the next `<section>` — these are race category names (e.g., "Bieg 10km", "Półmaraton 21,0975 km", "Nordic Walking 10 km")
- Extracts km from heading text, plus named distances (półmaraton → 21.1, maraton → 42.2) and time durations (e.g., "4h")
- Extracts regulamin PDF URL: `https://online.datasport.pl/zapisy/portal/regulaminy/regulamin_{eventId}.pdf`

### Raw output fields
```
{ name, date, location, distances (comma string from h4 headings),
  registration_url: null, regulamin_url (PDF link),
  source: 'datasport', source_url (per-event detail page), source_id (event number) }
```

### Known issues
- No registration URL from this source (regulamin PDF is captured separately)
- Single listing page — no pagination, may miss events if page structure changes

### Flow diagram
```
┌──────────────────────────────┐
│  Fetch lista.html            │
│  Decode Windows-1250         │
│  Parse .event-list-box       │
│  Extract: name, date, loc    │
└──────────┬───────────────────┘
           │
           ▼
┌──────────────────────────────┐
│  For each event:             │
│  Fetch zawody_files/NNN.html │
│  Decode Windows-1250         │
│  Find section after #features│
│  Parse <h4> race categories  │
│  Extract km / named / hours  │
│  Extract regulamin PDF URL   │
└──────────┬───────────────────┘
           │
           ▼
┌──────────────────────────────┐
│  Return array of raw events  │
└──────────────────────────────┘
```

---

## Source 3: elektronicznezapisy.pl

**URL:** `https://elektronicznezapisy.pl/1/bieg.html` + `/2/nordic-walking.html`
**Method:** HTTP fetch + Cheerio (listing) → fetch + Cheerio (detail pages)
**Encoding:** UTF-8
**Rate limit:** 1.1s between detail page fetches
**Events/year:** 300-500

### What it scrapes

**Phase 1 — Listing pages (2 category pages):**
Parses `<tr>` rows with 4+ `<td>` cells:
- Event ID: from href `/event/NNN`
- Date: `YYYY-MM-DD` from 3rd cell
- Signup link: from `a[href*="signup"]`

**Phase 2 — Detail pages:**
Fetches `/event/NNN/strona.html` for each event:
- Name: `<h1>` text
- Location: from `<a href="/m/city">` or "Miejsce:" in `li.list-group-item`
- Date: from "Początek imprezy:" in list-group-item, fallback to body text
- Distances: from **Cennik (pricing) section** — reads `<td>` cells in pricing tables, extracts km from category names like "5 km - dorośli", "21 km - open". Deduplicates. Also detects named distances (półmaraton) and time durations.
- Regulamin: event-specific PDF download links from "Regulamin" `list-group` section (e.g., `download/xxxx/open`)
- External website: links from the description content area. If the link is to a known scraper source domain (datasport, dostartu, etc.), it's flagged as `known_source_link` — save but don't process further.

**Phase 3 — Signup page fallback (sparse events only):**
When the detail page has no distances (sparse), fetches `/event/NNN/signup.html` to find external registration links. Many elektronicznezapisy events are just stubs that redirect signups to external platforms (dostartu.pl, zapisy.mktime.pl, etc.).

**Phase 4 — Dostartu API enrichment (dostartu-like external links only):**
If the external link from the signup page points to a dostartu-like domain (`dostartu.pl`, `zapisy.mktime.pl`, `zapisy.o-timing.pl`), extracts the competition ID from the `-v{id}` URL pattern and calls the dostartu API (`api.dostartu.pl/competitions/{id}` + `/classifications`) to fill in missing distances, location, and coordinates. These sites all share the same backend API.

### Raw output fields
```
{ name, date, location, distances (from Cennik or dostartu API enrichment),
  registration_url: external signup link or elektronicznezapisy signup page,
  regulamin_urls: [download links], external_website, known_source_link,
  source: 'elektronicznezapisy', source_url (detail page), source_id (event number) }
```

### Known issues
- Cennik section is not always present on the detail page (some events link to separate `pricelist.html`)
- **HAS registration URLs** — from signup links or external redirects
- **HAS regulamin PDFs** — can be scraped for detailed distance/rules data in the future
- Dostartu API enrichment only works for `-v{id}` URL patterns

### Flow diagram
```
┌──────────────────────────────┐
│  Fetch 2 category pages:     │
│  /1/bieg.html                │
│  /2/nordic-walking.html      │
│  Parse <tr> rows → event IDs │
└──────────┬───────────────────┘
           │
           ▼
┌──────────────────────────────┐
│  For each event:             │
│  Fetch /event/NNN/strona.html│
│  Extract: name, location     │
│  Distances from Cennik tbl   │
│  Regulamin download links    │
│  External website links      │
│  (flag known source domains) │
└──────────┬───────────────────┘
           │
           ▼ (if no distances)
┌──────────────────────────────┐
│  Fetch /event/NNN/signup.html│
│  Find external signup link   │
│  (e.g., zapisy.mktime.pl)   │
└──────────┬───────────────────┘
           │
           ▼ (if dostartu-like URL)
┌──────────────────────────────┐
│  Extract competition ID from │
│  -v{id} URL pattern          │
│  GET api.dostartu.pl/        │
│    competitions/{id}         │
│  GET .../classifications     │
│  Fill: distances, location,  │
│  lat/lng                     │
└──────────┬───────────────────┘
           │
           ▼
┌──────────────────────────────┐
│  Return array of raw events  │
└──────────────────────────────┘
```

---

## Source 4: biegiwpolsce.pl

**URL:** `https://www.biegiwpolsce.pl` (paginated: `/?page=N`)
**Method:** HTTP fetch + Cheerio (listing pages) → fetch + Cheerio (detail pages)
**Encoding:** UTF-8
**Rate limit:** 1.1s between pages and detail fetches
**Max pages:** 10
**Events/year:** 1000+

### What it scrapes

**Phase 1 — Listing pages (up to 10 pages):**
Finds `<a>` elements containing `<h2>` (event name):
- Name: `<h2>` text
- Date: `.date` class or regex `DD.MM.YYYY` in element text
- Location + voivodeship: from `<p>` with pipe-separated text (`City | voivodeship | Type`)
- Href: detail page path

**Phase 2 — Detail pages (all events):**
Fetches detail page for every event. Structured HTML, no Playwright needed:
- City + voivodeship: from `<i class="fa-map-marker-alt">` parent → `<strong>City</strong>, voivodeship`
- Tags from badges near `<i class="fa-tags">` — then **split** by `splitTags()`:
  - **Distances**: `5 km` → `5 km`, `10 km` → `10 km`, `Półmaraton` → `21.1 km`, `Maraton` → `42.2 km`, `Ultramaraton` → `ultra`
  - **Kids flag**: `Dla dzieci` → `is_kids = true`
  - **Event types**: everything else stays as-is (e.g., `Przełaj/Cross`, `Uliczny`, `Górski`, `Charytatywny`, `NW`, `Na orientację`, `Z przeszkodami`)
- **Regulamin**: `div.text-red-700 a[href]` — PDF link or external page with rules
- **Zapisy (registration)**: `div.text-green-700 a[href]` — registration link (dostartu, zapisy.info, event website, etc.)
- If the Zapisy URL points to a known scraper source domain, it's flagged as `known_source_link`

### Raw output fields
```
{ name, date, location, voivodeship,
  distances (from tag split: "5 km", "21.1 km", "ultra", etc.),
  registration_url (from Zapisy button), regulamin_url (from Regulamin button),
  event_types (pure types only, distances and kids removed),
  is_kids (boolean, from "Dla dzieci" tag),
  known_source_link (if reg URL is a known source domain),
  source: 'biegiwpolsce', source_url (per-event page), source_id (href or name-date) }
```

### Tag splitting reference

| Original tag | Stored in | Value |
|---|---|---|
| `5 km` | `distances` | `5 km` |
| `10 km` | `distances` | `10 km` |
| `Półmaraton` | `distances` | `21.1 km` |
| `Maraton` | `distances` | `42.2 km` |
| `Ultramaraton` | `distances` | `ultra` |
| `Dla dzieci` | `is_kids` | `true` |
| `Przełaj/Cross` | `event_types` | as-is |
| `Uliczny` | `event_types` | as-is |
| `Górski` | `event_types` | as-is |
| everything else | `event_types` | as-is |

### Known issues
- `source_id` is the URL path slug — decent but not guaranteed stable
- Distance tags are coarse (e.g., a 50 km race just gets `ultra`, no exact distance)

### Flow diagram
```
┌──────────────────────────────┐
│  Paginate listing pages      │
│  (page 1..10, stop on empty) │
│  Find <a> with <h2> name     │
│  Extract: date, city (pipes) │
└──────────┬───────────────────┘
           │
           ▼
┌──────────────────────────────┐
│  Phase 2: Detail pages (all) │
│  Fetch detail → structured:  │
│  City + voivodeship (icon)   │
│  splitTags():                │
│    distances ← 5/10/21/42/u │
│    is_kids ← "Dla dzieci"   │
│    event_types ← the rest   │
│  Regulamin URL (red button)  │
│  Zapisy/reg URL (grn button) │
│  Flag known source domains   │
└──────────┬───────────────────┘
           │
           ▼
┌──────────────────────────────┐
│  Return array of raw events  │
└──────────────────────────────┘
```

---

## ~~Source 5: pomiarczasuatelier.pl~~ (removed)

Removed — dostartu.pl API covers the same events with better data (structured distances, coordinates, event types). The pomiarczasuatelier scraper used brittle Bricks Builder CSS selectors and only provided ~20-30 events with no distances.

---

## Source 5: dostartu.pl (API)

**URL:** `https://api.dostartu.pl/competitions`
**Method:** REST API (JSON) — **no HTML scraping**
**Encoding:** UTF-8/JSON
**Rate limit:** 0.5s between classification fetches
**Events/year:** 250+ (running-related)

### What it scrapes

**Phase 1 — Paginated event listing:**
Queries `/competitions` with filters:
- `dateSince`: current ISO date
- `types[]`: `[1, 6, 16, 21]` (running, mountain_running, ocr, nordic_walking)
- `itemsPerPage: 100`

Returns structured JSON: `{ id, name, startedTime, endDate, location, locationLat, locationLng, websitePl, type }`

**Phase 2 — Classifications (distances + kids detection):**
For each event, fetches `/competitions/{id}/classifications`.
Each classification has: `distance` (numeric km), `namePl` (category name), `classificationSetting.playerType` (`"adults"` or `"kids"`).

The `parseClassifications()` function extracts distances using this priority:
1. **API `distance` field** — if `> 0`, use as `{distance} km` (most events)
2. **Time-based** — classification name contains `"N H"` pattern → stored as `"4h"`, `"6h"` etc. Also detects `"backyard"` (last-man-standing format, no fixed distance)
3. **Meter distances** — name contains `"200m"`, `"800m"` etc → stored as `"200m"` (under 1km) or converted to km (≥1000m)
4. **Named distances** — `"mila"` → `"1 mila"`, `"półmaraton"` → `"21.1 km"`, `"maraton"` → `"42.2 km"`, `"cooper"` → `"test coopera"`

**Kids detection:** `is_kids = true` when ALL classifications have `playerType: "kids"`, OR all classification names match kids keywords (`dzieci`, `młodzież`, `junior`), OR the event name itself contains these keywords.

### Raw output fields
```
{ name, date, end_date, location, distances (comma string — see formats above),
  registration_url (websitePl or dostartu permalink),
  regulamin_url (statuteFilePl PDF or statuteLinkPl external link),
  source: 'dostartu', source_url (dostartu permalink), source_id (numeric),
  lat, lng, event_type (from TYPE_MAP), is_kids (boolean) }
```

### Distance format examples
| API data | Stored `distances` |
|---|---|
| `distance: 10`, `distance: 5` | `10 km, 5 km` |
| `namePl: "Bieg 4 H"`, `"Bieg 6 H"` | `4h, 6h` |
| `namePl: "BACKYARD"` | `backyard` |
| `namePl: "200m, dzieci do 6 lat"`, `"800m"` | `200m, 800m` |
| `namePl: "Mila"` | `1 mila` |
| `namePl: "test Coopera"` | `test coopera` |

### Data quality assessment
- **BEST structured data** — real API, not HTML scraping
- **HAS registration URLs** — either the event's own `websitePl` or dostartu permalink
- **HAS coordinates** — `locationLat` / `locationLng` from the API
- **HAS event types** — mapped from numeric type codes
- **HAS end dates** — for multi-day events
- **HAS kids flag** — from classification playerType + name keywords
- **Distances are structured** — from classification API, handles km, time-based, meter, and named formats
- **Only running-related** — filtered by type codes

### Known issues
- Event names differ significantly from other sources (e.g., "Leśny Lament Trail Run 2026" vs "II Leśny Lament") — causes cross-source dedup to fail (Levenshtein < 0.8)

### Flow diagram
```
┌──────────────────────────────┐
│  GET /competitions            │
│  ?dateSince=now               │
│  &types[]=1,6,16,21          │
│  &itemsPerPage=100           │
│  Paginate until empty         │
└──────────┬───────────────────┘
           │
           ▼
┌──────────────────────────────┐
│  For each competition:       │
│  GET /competitions/{id}/     │
│    classifications           │
│  parseClassifications():     │
│  1. distance > 0 → "N km"   │
│  2. name "N H" → "Nh"       │
│  3. name "Nm" → meters/km   │
│  4. named: mila, backyard,  │
│     maraton, cooper          │
│  Detect is_kids from         │
│  playerType + name keywords  │
└──────────┬───────────────────┘
           │
           ▼
┌──────────────────────────────┐
│  Build result with:          │
│  name, date, end_date, loc   │
│  lat/lng, distances, type    │
│  is_kids, registration_url   │
│  source_url (permalink)      │
└──────────────────────────────┘
```

---

## Pipeline orchestration (`index.js`)

Runs scrapers **sequentially** in this order:
1. maratonypolskie
2. datasport
3. elektronicznezapisy
4. biegiwpolsce
5. dostartu

Each scraper writes raw data into its own Supabase table (upsert by `source_id`):

| Scraper | Table | Unique key |
|---------|-------|------------|
| maratonypolskie | `scraper_maratonypolskie` | `source_id` |
| datasport | `scraper_datasport` | `source_id` |
| elektronicznezapisy | `scraper_elektronicznezapisy` | `source_id` |
| biegiwpolsce | `scraper_biegiwpolsce` | `source_id` |
| dostartu | `scraper_dostartu` | `source_id` |

**What does NOT run automatically:**
- **Normalizer** (`normalizer.js`) — available but not called by default
- **Dedup** (`dedup.js`) — merging into `calendar_events` is a separate manual step
- **URL resolver** (`urlResolver.js`) — Brave Search, run manually when needed
- **LLM enricher** (`llmEnricher.js`) — Playwright + Claude, run manually when needed

### Full pipeline flow
```
┌─────────────────────────────────────────────────┐
│  For each source (sequential):                   │
│                                                   │
│  ┌─────────┐    ┌────────────────────────────┐  │
│  │ Scrape  │───►│  Upsert into source table  │  │
│  │ (raw)   │    │  (scraper_<name>)          │  │
│  │         │    │  by source_id              │  │
│  └─────────┘    └────────────────────────────┘  │
│                                                   │
└─────────────────────────────────────────────────┘

  ── Manual steps (not triggered by pipeline) ──

  ┌───────────┐    ┌────────────┐    ┌────────────┐
  │ Normalize │───►│   Dedup    │───►│ calendar_  │
  │ + geocode │    │ cross-src  │    │ events     │
  └───────────┘    └────────────┘    └────────────┘
                                            │
                   ┌────────────────────────┘
                   ▼
          ┌─────────────────────────┐
          │  URL Resolver (Brave)   │
          └────────────┬────────────┘
                       ▼
          ┌─────────────────────────┐
          │  LLM Enricher (Claude)  │
          └─────────────────────────┘
```

---

## Source comparison matrix

| | maratonypolskie | datasport | elektronicznezapisy | biegiwpolsce | dostartu |
|---|---|---|---|---|---|
| **Method** | Playwright | fetch+Cheerio | fetch+Cheerio | fetch+Cheerio | REST API |
| **Encoding** | UTF-8 (Playwright) | Windows-1250 | UTF-8 | UTF-8 | JSON |
| **Detail pages** | No (listing only) | Yes (fetch) | Yes (fetch) | Yes (fetch) | Classifications API |
| **Volume** | 500+ | 200+ | 300-500 | 1000+ | 250+ |
| **Has reg URL** | No | No | Yes | Yes (Zapisy btn) | Yes |
| **Has regulamin** | No | Yes (PDF) | Yes (download links) | Yes (red button) | Yes (statuteFilePl PDF or statuteLinkPl) |
| **Has location** | Yes (listing) | Yes (listing) | Yes (detail) | Yes (detail, structured) | Yes (API) |
| **Has coordinates** | No | No | Via dostartu enrichment | No | Yes (API) |
| **Has distances** | Single from listing | h4 headings | Cennik pricing + dostartu enrichment | Yes (from tag split) | Classifications API (km, time, meters, named) |
| **Distance quality** | Low | **High** | **Medium-High** (High when enriched) | **Medium** (coarse: 5/10/21/42/ultra) | **Highest** |
| **Has event type** | No | No | No | Yes (pure types after split) | Yes (numeric codes) |
| **Has kids flag** | No | No | No | Yes ("Dla dzieci" tag) | Yes (playerType + keywords) |
| **Has end_date** | No | No | No | No | Yes |
| **Source ID stability** | Medium (code param) | High (zawody number) | High (event number) | Medium (URL slug) | High (API id) |
