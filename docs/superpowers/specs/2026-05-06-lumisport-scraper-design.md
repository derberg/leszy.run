# Lumisport.eu Scraper — Design Spec

## Overview

New scraper source for `lumisport.eu` — a Polish race timing company that hosts event registration directly on its own WordPress + WooCommerce site. Each event is a WooCommerce product at `/produkt/<slug>/`. Lumisport exposes a public WooCommerce Store API (`/wp-json/wc/store/v1/products`) that returns structured data, so most fields come from a single JSON call. One extra HTML fetch per event is needed to grab the regulamin PDF link.

## Why this source matters

Verified against current `calendar_events` and `scraper_all` content (2026-05-06):

- **6 active events** currently listed on `/elektroniczne-zapisy/` (a 7th, `bieg-konstytucji-3-go-maja`, was on May 3 — already past).
- Of the 6 active events, **4 are not in `calendar_events` at all** (Półmaraton Zegrzyński, SFORA, Wieliszewska Piątka, Ultramaraton Powstańca). Lumisport is currently the **only** scrape-able source for them.
- The other 2 (Bolimowski Maraton Tura, Bieg Lisewski) are present via aggregators but with incomplete data: Bolimowski has only `["42.2 km"]` while lumisport exposes 4 distances (5 km / 21 km / 42 km / kids), and prices are null.

So lumisport is high-value despite the small volume.

## Data source

| Property | Value |
|----------|-------|
| Listing URL | `https://lumisport.eu/elektroniczne-zapisy/` |
| Primary API | `https://lumisport.eu/wp-json/wc/store/v1/products?per_page=100` |
| Detail page | `https://lumisport.eu/produkt/<slug>/` (1 extra GET per event for regulamin PDF) |
| Method | Public WC Store API (JSON) + cheerio for product page HTML |
| Pagination | None — all active products in one API call |
| Estimated events | ~5–15 active at any time (timing company, not aggregator) |

The 7th past event (May 3) is automatically excluded — WC Store API only returns purchasable products and the pipeline drops `date < today` rows during merge.

## Pipeline integration

### Priority: 3 (tied with timekeeper)

Lumisport hosts the canonical registration page AND the regulamin AND the price tiers for its own events. The same logic that puts timekeeper at priority 3 — direct timing company, owns the official event URLs — applies. Aggregator data (e.g., elektronicznezapisy listing for Bieg Lisewski) is stale by construction and should be **replaced** by lumisport's URLs when both are present.

No collision risk with timekeeper at the same priority — they don't host the same events. When two priority-3 sources collide on a future shared event, the first to merge wins for shared fields, and `mergeSourceLinks` retains both `source_links` entries.

| Priority | Source |
|----------|--------|
| 1 | dostartu |
| 2 | biegiwpolsce |
| **3** | **timekeeper, lumisport** (new) |
| 4 | elektronicznezapisy |
| 5 | supersport |
| 6 | zmierzymyczas |
| 7 | datasport |
| 8 | pomiarczasuatelier, b4sport, raatiming |
| 9 | maratonypolskie |

Concrete consequence for the 2 overlap events:
- **Bieg Lisewski** (currently elektronicznezapisy=4): lumisport's `registration_url`, `regulamin_url`, `website` overwrite elektronicznezapisy's stale links in `scraper_all`.
- **Bolimowski Maraton Tura** (currently maratonypolskie=9): lumisport overwrites distances, fills in prices, replaces the Facebook `website` with the canonical lumisport page.

### New Supabase table: `scraper_lumisport`

Standard schema matching other per-source tables (mirrors `scraper_pomiarczasuatelier`):

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid | PK, default `gen_random_uuid()` |
| `name` | text | Event name (from `product.name`) |
| `date` | text | `YYYY-MM-DD`, parsed from description |
| `location` | text | NULL — not in API; geocoder fills from name later |
| `distances` | text | Comma-separated, e.g. `"5 km, 21 km, 42 km"` (kids excluded) |
| `is_kids` | boolean | `true` if any distance term is `"biegi dla dzieci"` |
| `price_from` | numeric | PLN (groszy ÷ 100) |
| `price_to` | numeric | PLN (groszy ÷ 100) |
| `registration_url` | text | Permalink (= product page) |
| `regulamin_url` | text | First PDF link found on product page HTML; nullable |
| `website` | text | Same as permalink — lumisport hosts the canonical event page |
| `source_id` | text | Product slug (e.g., `9-polmaraton-zegrzynski`) |
| `source_url` | text | Permalink |
| `merged_at` | timestamptz | Set by merge step |
| `created_at` | timestamptz | Default `now()` |

Unique constraint on `source_id`.

## Scraper implementation

### File: `backend/src/scrapers/sources/lumisport.js`

### Phase 1 — Store API

Single GET to `https://lumisport.eu/wp-json/wc/store/v1/products?per_page=100`.

Filter: keep only rows where `is_purchasable === true` AND `categories.some(c => c.slug === 'zawody')`. (`zawody` = "competitions" — excludes any non-event product types they might add later, e.g. equipment/apparel.)

For each kept product, extract:

- `name = product.name`
- `slug = product.slug` → `source_id`, `source_url = registration_url = website = product.permalink`
- `descriptionText` = strip HTML from `product.short_description + ' ' + product.description`, decode `&nbsp;` etc., collapse whitespace
- `date` — see "Date extraction" below
- `distances` from `product.attributes`:
  - find the entry where `taxonomy === 'pa_dystans'`
  - map `terms[].name` → list of strings (already clean: `"5 km"`, `"21 km"`, `"42 km"`, `"biegi dla dzieci"`)
  - if `"biegi dla dzieci"` is present: set `is_kids = true` AND remove that term from the distances list
  - join the remaining terms with `", "` for the `distances` text column
  - if no `pa_dystans` attribute exists or distances list is empty after filtering → leave `distances = null`
- `price_from = prices.price_range.min_amount / 100`
- `price_to = prices.price_range.max_amount / 100`
  - both nullable; if missing or zero, store `null`

### Phase 2 — Regulamin lookup

For each product whose date was parsed successfully (no point fetching regulamin for rows that won't be inserted), make 1 GET to `permalink`. Parse the HTML with cheerio and find the first `<a href="*.pdf">` link. That's the regulamin URL.

Rate limit: `await sleep(1100)` between product page fetches (matches the convention in `zmierzymyczas.js`).

If regulamin fetch fails (timeout, 4xx, no PDF link found) → continue with `regulamin_url = null`. Don't fail the whole event; the LLM enricher can rediscover it.

### Date extraction

The description contains the date in one of two forms (or neither):

1. **Polish month form**: `5 lipca`, `31 maja`, `5 lipca 2026`. Year is often omitted.
2. **Numeric**: `24.05.2026`, `03.07.2026`, `24/05/2026`.

Implementation:

```js
const POLISH_MONTHS = {
  stycznia: 1, lutego: 2, marca: 3, kwietnia: 4, maja: 5, czerwca: 6,
  lipca: 7, sierpnia: 8, września: 9, października: 10, listopada: 11, grudnia: 12,
}

function parseDate(text) {
  // 1. Try DD.MM.YYYY or DD/MM/YYYY first (more reliable when present)
  const numeric = text.match(/(\d{1,2})[./](\d{1,2})[./](\d{4})/)
  if (numeric) {
    const [, dd, mm, yyyy] = numeric
    return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`
  }

  // 2. Polish month form, with optional year
  const polishRe = new RegExp(`\\b(\\d{1,2})\\s+(${Object.keys(POLISH_MONTHS).join('|')})(?:\\s+(\\d{4}))?\\b`, 'i')
  const polish = text.match(polishRe)
  if (polish) {
    const day = parseInt(polish[1], 10)
    const month = POLISH_MONTHS[polish[2].toLowerCase()]
    const year = polish[3] ? parseInt(polish[3], 10) : inferYear(month, day)
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }

  return null
}

// If only "5 lipca" with no year — pick the next occurrence of that day-month
// from today. If today is past July 5 of the current year, infer next year.
function inferYear(month, day, today = new Date()) {
  const thisYear = today.getFullYear()
  const candidate = new Date(thisYear, month - 1, day)
  candidate.setHours(0, 0, 0, 0)
  const today0 = new Date(today)
  today0.setHours(0, 0, 0, 0)
  return candidate >= today0 ? thisYear : thisYear + 1
}
```

If neither form matches, **the event is skipped** (no row emitted). Pipeline orchestrator's `if (row.name && row.date)` filter would drop it anyway, and we'd rather skip cleanly with a log than create half-rows.

Verified against the 6 currently-active products (2026-05-06):
- Bolimowski Maraton Tura → "5 lipca" → infers `2026-07-05` ✓
- Bieg Lisewski → `24.05.2026` ✓
- SFORA → "31 maja" → infers `2026-05-31` ✓
- Wieliszewska Piątka → `03.07.2026` ✓
- 9. Półmaraton Zegrzyński → no date in description → **dropped**
- Ultramaraton Powstańca → no date in description → **dropped**

4 of 6 extract cleanly. The 2 dropped events are not currently in any other scraper either, so accepting this limitation costs us nothing relative to the status quo. If users add them manually via the admin UI later, the Lumisport URL will already be the canonical registration target.

### Wiring

1. **Scraper export**: `backend/src/scrapers/sources/lumisport.js` exports `async function scrape({ knownIds })`. Honor `knownIds` for incremental runs (skip products whose `slug` is already in DB).
2. **Register in pipeline**: append to the `sources` array in `backend/src/scrapers/index.js` with `name: 'lumisport'`, `table: 'scraper_lumisport'`, and a `mapRow` that mirrors `pomiarczasuatelier` plus `is_kids`, `price_from`, `price_to`.
3. **Priority entry**: add `lumisport: 5` to `SOURCE_PRIORITY` in `backend/src/scrapers/dedup.js`.
4. **Migration**: create `scraper_lumisport` table via `mcp__supabase__apply_migration` (Supabase-only; no Drizzle schema needed — scraper tables are not part of the local race-timing DB).
5. **CLAUDE.md update**: bump the "Data sources (7 scrapers)" header — actual count is now **12**. Add a row for lumisport.

## Error handling

- API call fails (5xx, timeout) → log, return empty array, don't crash the pipeline.
- A product fails to parse (malformed attributes, weird description) → log the slug, skip the row, continue.
- Regulamin fetch fails → continue with `regulamin_url = null`.
- Pipeline framework already handles upsert errors per-row.

## Testing

Manual smoke test before merging:

```bash
docker compose exec backend node -e "
import('./src/scrapers/sources/lumisport.js').then(async m => {
  const rows = await m.scrape({ knownIds: new Set() })
  console.log(JSON.stringify(rows, null, 2))
})
"
```

Expected: 4 rows for the 4 datable events listed above, each with `name`, `date`, `distances`, `price_from`, `price_to`, `registration_url`, `website`, `regulamin_url`, `source: 'lumisport'`, `source_id` = slug.

Then run the full pipeline (`docker compose exec scheduler npm run pipeline`) and verify:
- 4 new rows in `scraper_lumisport`
- Bolimowski Maraton Tura's `scraper_all` row gets `distances` upgraded from `"42.2 km"` to the lumisport set, prices filled, `website` switched from Facebook to lumisport (lumisport=3 beats maratonypolskie=9)
- Bieg Lisewski's `scraper_all` row gets its `registration_url`, `regulamin_url`, `website` replaced with lumisport URLs (lumisport=3 beats elektronicznezapisy=4)
- SFORA, Wieliszewska Piątka show up as new `pending` entries in `calendar_events` after the publish step

### Manual backfill of `calendar_events` for the 2 overlap events

The publish step skips rows already in `calendar_events`, so the 2 overlap events won't auto-receive the upgraded data. After the first successful pipeline run, manually run a single UPDATE per event with the post-merge values copied from `scraper_all`. CLAUDE.md "Database write safety" rule applies: state the change, get explicit user confirmation, then execute.

Concretely, for each of `Bolimowski Maraton Tura` and `Bieg na 5 km "Bieg Lisewski"`:

```sql
UPDATE calendar_events
SET registration_url = <new>,
    regulamin_url    = <new>,
    website          = <new>,
    distances        = <new>,
    price_from       = <new>,
    price_to         = <new>,
    source_links     = <merged>
WHERE id = <existing-id>;
```

Locked fields (`calendar_events.locked_fields`) are still respected — if an admin already pinned a field, it stays.

After both updates, run `node scripts/publish-event-pages.js --apply` to refresh the manifest and OG images per the post-DB-change convention, and commit the changes.

## What lumisport's API does NOT expose

Documented here so future-me doesn't re-investigate the same dead ends:

- **No race date field anywhere.** Checked `wc/store/v1/products`, `wp/v2/product`, yoast schema, product `meta`, attributes, variations. Date lives only in human-readable description prose or in the regulamin PDF.
- **No registration deadline.** WooCommerce models registration as stock — when `is_in_stock` flips false, registration closes. There's no explicit cutoff date. The Python enricher could later parse it from regulamin PDFs.
- **No location / city / voivodeship.** Description is marketing prose. Geocoder step 4 fills voivodeship from `location` if the geocoder finds something; `location` itself often stays NULL until the Python enricher resolves it.
- **No event_type tagging.** No `pa_typ`, no category beyond `zawody`. Enricher infers from regulamin / website content.

## Out of scope

- PDF parsing for date extraction. Stays in the Python enricher (Docling). If we ever want to recover the 2 dropped events, the Python enricher's audit pass already runs against `calendar_events` and could be extended to seed entries from lumisport's regulamin PDFs — that's a separate spec.
- Geocoding / voivodeship inference. Existing pipeline step 4 (`run-geocode.js`) handles it from event name + location.
- Event-type tagging (trail/uliczny/nocny/etc.). LLM enricher's job.
- Webhook / push from lumisport. They don't expose one; we'll keep polling daily via the scheduler.
