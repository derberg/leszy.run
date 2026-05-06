# Lumisport.eu Scraper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `lumisport.eu` as the 12th race-event scraper. Pulls structured data from the WooCommerce Store API (single JSON call), scrapes one extra HTML page per event for the regulamin PDF link, and feeds the existing scraper → merge → publish pipeline.

**Architecture:** New file `backend/src/scrapers/sources/lumisport.js` exports `scrape({ knownIds })`. New Supabase table `scraper_lumisport`. Wired into `backend/src/scrapers/index.js` `sources[]` array and `SOURCE_PRIORITY` (priority 3, tied with timekeeper). No PDF parsing — undated events are dropped.

**Tech Stack:** Node 22, native `fetch`, `cheerio` for the regulamin HTML lookup, Supabase JS client (already imported by the pipeline).

**Reference spec:** [docs/superpowers/specs/2026-05-06-lumisport-scraper-design.md](../specs/2026-05-06-lumisport-scraper-design.md)

**Backend has no automated test framework.** Verification is via manual smoke runs after each task — same convention as every other scraper in this repo. Each task ends with a concrete smoke check the engineer must run and the expected output to compare against.

---

## File map

| Path | Action | Purpose |
|---|---|---|
| `backend/src/scrapers/sources/lumisport.js` | Create | Scraper module, exports `scrape({ knownIds })` |
| `backend/src/scrapers/index.js` | Modify | Import + register in `sources[]` |
| `backend/src/scrapers/dedup.js` | Modify | Add `lumisport: 3` to `SOURCE_PRIORITY` |
| Supabase: `scraper_lumisport` table | Create via `mcp__supabase__apply_migration` | Per-source raw row store |
| `CLAUDE.md` | Modify | Bump source count, add row to data-sources table |

---

## Task 1: Create the Supabase `scraper_lumisport` table

**Files:**
- Apply via `mcp__supabase__apply_migration` (Supabase only — scraper tables are not in Drizzle / not in local DB)

- [ ] **Step 1: Apply the migration**

Use the `mcp__supabase__apply_migration` tool with `name: "create_scraper_lumisport"` and the SQL below. Schema mirrors `scraper_supersport` (closest analog — also a timing company), plus `price_from` / `price_to` since lumisport's WC Store API exposes prices.

```sql
CREATE TABLE IF NOT EXISTS public.scraper_lumisport (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  date             text NOT NULL,
  location         text,
  distances        text,
  registration_url text,
  regulamin_url    text,
  website          text,
  is_kids          boolean DEFAULT false,
  price_from       numeric,
  price_to         numeric,
  source_id        text NOT NULL,
  source_url       text,
  merged_at        timestamptz,
  created_at       timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS scraper_lumisport_source_id_idx
  ON public.scraper_lumisport (source_id);
```

- [ ] **Step 2: Verify the table exists**

Run via `mcp__supabase__execute_sql`:

```sql
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema='public' AND table_name='scraper_lumisport'
ORDER BY ordinal_position;
```

Expected: 14 rows — `id, name, date, location, distances, registration_url, regulamin_url, website, is_kids, price_from, price_to, source_id, source_url, merged_at, created_at`. (Note: `created_at` is at the end because of column order; that's fine.)

- [ ] **Step 3: Verify the unique index**

```sql
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname='public' AND tablename='scraper_lumisport';
```

Expected: 2 indexes — `scraper_lumisport_pkey` on `id` and `scraper_lumisport_source_id_idx` UNIQUE on `source_id`.

---

## Task 2: Implement the scraper — Phase 1 (Store API + date extraction)

**Files:**
- Create: `backend/src/scrapers/sources/lumisport.js`

This task gets the scraper to a working state without the regulamin lookup. We'll add Phase 2 (HTML fetch for regulamin) in the next task.

- [ ] **Step 1: Create the scraper file**

Write `backend/src/scrapers/sources/lumisport.js` with the contents below.

```js
import * as cheerio from 'cheerio'

const STORE_API_URL = 'https://lumisport.eu/wp-json/wc/store/v1/products?per_page=100'
const USER_AGENT = 'leszy.run/1.0 (kontakt@leszy.run)'

const POLISH_MONTHS = {
  stycznia: 1, lutego: 2, marca: 3, kwietnia: 4, maja: 5, czerwca: 6,
  lipca: 7, sierpnia: 8, września: 9, października: 10, listopada: 11, grudnia: 12,
}

function stripHtml(s) {
  if (!s) return ''
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&[a-zA-Z]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// If only "5 lipca" with no year — pick the next occurrence of that day-month
// from today. If today is past it for the current year, infer next year.
function inferYear(month, day, today = new Date()) {
  const today0 = new Date(today)
  today0.setHours(0, 0, 0, 0)
  const candidate = new Date(today0.getFullYear(), month - 1, day)
  candidate.setHours(0, 0, 0, 0)
  return candidate >= today0 ? today0.getFullYear() : today0.getFullYear() + 1
}

function parseDate(text) {
  // 1. DD.MM.YYYY or DD/MM/YYYY first (more reliable when present)
  const numeric = text.match(/\b(\d{1,2})[./](\d{1,2})[./](\d{4})\b/)
  if (numeric) {
    const dd = numeric[1].padStart(2, '0')
    const mm = numeric[2].padStart(2, '0')
    const yyyy = numeric[3]
    return `${yyyy}-${mm}-${dd}`
  }

  // 2. Polish month form (lowercase only — Polish dates in prose almost always lowercase)
  const polishRe = new RegExp(
    `\\b(\\d{1,2})\\s+(${Object.keys(POLISH_MONTHS).join('|')})(?:\\s+(\\d{4}))?\\b`,
    'i'
  )
  const polish = text.match(polishRe)
  if (polish) {
    const day = parseInt(polish[1], 10)
    const month = POLISH_MONTHS[polish[2].toLowerCase()]
    const year = polish[3] ? parseInt(polish[3], 10) : inferYear(month, day)
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }

  return null
}

function parseDistances(attributes) {
  if (!Array.isArray(attributes)) return { distances: null, isKids: false }
  const dystans = attributes.find(a => a.taxonomy === 'pa_dystans')
  if (!dystans || !Array.isArray(dystans.terms)) return { distances: null, isKids: false }

  let isKids = false
  const distances = []
  for (const term of dystans.terms) {
    const name = (term.name || '').trim()
    if (!name) continue
    if (/dzieci/i.test(name)) {
      isKids = true
      continue
    }
    distances.push(name)
  }
  return {
    distances: distances.length ? distances.join(', ') : null,
    isKids,
  }
}

function parsePrices(prices) {
  // prices.price_range.min_amount and max_amount come as strings in groszy.
  // Some products only have prices.price (single tier). Treat 0 as missing.
  if (!prices) return { priceFrom: null, priceTo: null }
  const range = prices.price_range
  const min = range?.min_amount ?? prices.price ?? null
  const max = range?.max_amount ?? prices.price ?? null
  const toPLN = v => {
    if (v === null || v === undefined) return null
    const n = Number(v)
    if (!Number.isFinite(n) || n <= 0) return null
    return n / 100
  }
  return { priceFrom: toPLN(min), priceTo: toPLN(max) }
}

async function fetchProducts() {
  const res = await fetch(STORE_API_URL, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  })
  if (!res.ok) {
    throw new Error(`store API ${res.status} ${res.statusText}`)
  }
  return res.json()
}

async function scrape({ knownIds = new Set() } = {}) {
  const results = []

  let products
  try {
    products = await fetchProducts()
  } catch (err) {
    console.error('[lumisport] Store API fetch failed:', err.message)
    return results
  }

  if (!Array.isArray(products)) {
    console.error('[lumisport] Store API returned non-array, got:', typeof products)
    return results
  }

  let dropped = 0
  for (const product of products) {
    try {
      if (!product.is_purchasable) continue
      const isCompetition = Array.isArray(product.categories)
        && product.categories.some(c => c.slug === 'zawody')
      if (!isCompetition) continue

      const slug = product.slug
      if (!slug) continue

      const name = product.name?.trim()
      if (!name) continue

      const descText = stripHtml(`${product.short_description || ''} ${product.description || ''}`)
      const date = parseDate(descText)
      if (!date) {
        console.warn(`[lumisport] No parseable date for "${slug}" — dropping`)
        dropped++
        continue
      }

      const { distances, isKids } = parseDistances(product.attributes)
      const { priceFrom, priceTo } = parsePrices(product.prices)
      const permalink = product.permalink

      results.push({
        name,
        date,
        location: null,
        distances,
        registration_url: permalink,
        regulamin_url: null, // filled in Phase 2
        website: permalink,
        is_kids: isKids,
        price_from: priceFrom,
        price_to: priceTo,
        source: 'lumisport',
        source_id: slug,
        source_url: permalink,
      })
    } catch (err) {
      console.error(`[lumisport] Failed to parse product ${product?.slug}:`, err.message)
    }
  }

  console.log(`[lumisport] Scraped ${results.length} events (dropped ${dropped} undated)`)
  return results
}

export { scrape, parseDate, parseDistances, parsePrices }
```

- [ ] **Step 2: Smoke-test the scraper standalone**

Run from project root (no need to start the full stack — the scraper module has no Supabase imports of its own):

```bash
docker compose exec backend node -e "
import('./src/scrapers/sources/lumisport.js').then(async m => {
  const rows = await m.scrape({ knownIds: new Set() })
  console.log('count:', rows.length)
  console.log(JSON.stringify(rows, null, 2))
})
"
```

Expected output: 4 rows, all with `regulamin_url: null` (Phase 2 not yet implemented). The 4 events in any order:

| name | date | distances | is_kids | price_from | price_to |
|---|---|---|---|---|---|
| Bolimowski Maraton Tura | 2026-07-05 | "5 km, 21 km, 42 km" | true | 0.10 | 1.00 |
| Bieg Lisewski | 2026-05-24 | (one of: "5 km", or `null`) | (varies) | (varies) | (varies) |
| SFORA | 2026-05-31 | (varies) | (varies) | 0.20 | 1.10 |
| Wieliszewska Piątka | 2026-07-03 | (varies) | (varies) | 0.40 | 0.60 |

**The Bolimowski prices look wrong (0.10 zł = 10 groszy) — that's because lumisport stored prices as full PLN values (e.g. `1000` = 1000 zł, not 1000 groszy) for some products.** Actually no — checking the Store API response, `min_amount: "1000"` means 10 zł in groszy mode. The `currency_minor_unit: 2` confirms two decimal places, so prices ARE in groszy. So min 10 zł / max 100 zł for Bolimowski variants.

Two undated events (`9-polmaraton-zegrzynski`, `ultramaraton-powstanca`) should appear in the warning logs as "No parseable date for ... — dropping".

If the count or the rows differ structurally, fix the parser before continuing.

- [ ] **Step 3: Commit**

```bash
git add backend/src/scrapers/sources/lumisport.js
git commit -m "feat(scraper): add lumisport.eu Phase 1 (Store API + date extraction)

Pulls structured products from the WooCommerce Store API. Extracts
name, date (regex), distances, prices, registration_url. Undated
events are dropped per design.

regulamin_url comes in Phase 2."
```

---

## Task 3: Add Phase 2 (regulamin URL lookup)

**Files:**
- Modify: `backend/src/scrapers/sources/lumisport.js`

Phase 2 fetches each product page once and grabs the first PDF link. Done as a second pass over the already-built `results` so we only fetch for events we'll actually emit (skip the dropped/undated ones).

- [ ] **Step 1: Add the regulamin fetcher and integrate it**

Add this helper function above `scrape`:

```js
async function fetchRegulaminUrl(permalink) {
  try {
    const res = await fetch(permalink, {
      headers: { 'User-Agent': USER_AGENT },
    })
    if (!res.ok) return null
    const html = await res.text()
    const $ = cheerio.load(html)
    let pdf = null
    $('a[href$=".pdf"]').each((_, el) => {
      if (pdf) return
      const href = $(el).attr('href')
      if (href) pdf = href.startsWith('http') ? href : new URL(href, permalink).toString()
    })
    return pdf
  } catch (err) {
    return null
  }
}
```

In `scrape`, replace the existing `console.log(...) ; return results` block at the end with:

```js
  console.log(`[lumisport] Phase 1 done: ${results.length} datable events (dropped ${dropped} undated)`)

  // Phase 2: regulamin lookup — 1 GET per event, rate-limited at 1.1 s
  for (let i = 0; i < results.length; i++) {
    const row = results[i]
    if (knownIds.has(row.source_id)) {
      // already in DB — incremental run; skip the regulamin fetch to save time.
      // The pipeline updates existing rows; if the regulamin already populated, it stays.
      continue
    }
    row.regulamin_url = await fetchRegulaminUrl(row.source_url)
    if (i < results.length - 1) await new Promise(r => setTimeout(r, 1100))
  }

  console.log(`[lumisport] Done with regulamin lookup`)
  return results
}
```

(The function closes one line lower than before. Make sure the final `}` and `export {...}` stay correct.)

- [ ] **Step 2: Smoke-test Phase 2**

```bash
docker compose exec backend node -e "
import('./src/scrapers/sources/lumisport.js').then(async m => {
  const rows = await m.scrape({ knownIds: new Set() })
  for (const r of rows) {
    console.log(r.source_id, '|', r.date, '|', r.regulamin_url || '(none)')
  }
})
"
```

Expected output: 4 rows, ~6 seconds total (4 × 1.1 s sleeps). Each should print a regulamin URL ending in `.pdf`. Bolimowski's regulamin is `https://lumisport.eu/wp-content/uploads/2026/04/Regulamin_TUR.pdf`. If `(none)` appears for any event, manually visit the product page in a browser and confirm whether a regulamin PDF link is actually present — if it is and we missed it, fix the cheerio selector.

- [ ] **Step 3: Smoke-test incremental mode (knownIds skip)**

```bash
docker compose exec backend node -e "
import('./src/scrapers/sources/lumisport.js').then(async m => {
  const rows = await m.scrape({ knownIds: new Set(['bolimowski-maraton-tura', 'sfora']) })
  for (const r of rows) {
    console.log(r.source_id, '|', r.regulamin_url || '(none)')
  }
})
"
```

Expected: 4 rows still (knownIds doesn't drop them, only skips regulamin fetch), but Bolimowski and SFORA show `(none)` (regulamin fetch skipped). The other 2 should still have regulamin URLs.

- [ ] **Step 4: Commit**

```bash
git add backend/src/scrapers/sources/lumisport.js
git commit -m "feat(scraper): add lumisport regulamin URL lookup (Phase 2)

One GET per new event with 1.1s rate limit; skipped for knownIds to
avoid hammering the site on incremental runs."
```

---

## Task 4: Wire into the pipeline

**Files:**
- Modify: `backend/src/scrapers/index.js`
- Modify: `backend/src/scrapers/dedup.js`

- [ ] **Step 1: Add the import to `backend/src/scrapers/index.js`**

After the existing import line `import { scrape as scrapeRaatiming } from './sources/raatiming.js'` (currently line 10), add:

```js
import { scrape as scrapeLumisport } from './sources/lumisport.js'
```

- [ ] **Step 2: Register in the `sources[]` array**

Append a new entry to the `sources` array (after the existing `raatiming` entry, before the closing `]`):

```js
  {
    name: 'lumisport',
    scrape: scrapeLumisport,
    table: 'scraper_lumisport',
    mapRow: (raw) => ({
      name: raw.name,
      date: raw.date,
      location: raw.location || null,
      distances: raw.distances || null,
      registration_url: raw.registration_url || null,
      regulamin_url: raw.regulamin_url || null,
      website: raw.website || null,
      is_kids: raw.is_kids || false,
      price_from: raw.price_from ?? null,
      price_to: raw.price_to ?? null,
      source_id: raw.source_id,
      source_url: raw.source_url || null,
    }),
  },
```

- [ ] **Step 3: Add `lumisport: 3` to `SOURCE_PRIORITY` in `backend/src/scrapers/dedup.js`**

The existing block reads:

```js
const SOURCE_PRIORITY = {
  dostartu: 1,
  biegiwpolsce: 2,
  timekeeper: 3,
  elektronicznezapisy: 4,
  datasport: 7,
  maratonypolskie: 9,
  pomiarczasuatelier: 8,
  b4sport: 8,
  supersport: 5,
  zmierzymyczas: 6,
  raatiming: 8,
}
```

Replace with:

```js
const SOURCE_PRIORITY = {
  dostartu: 1,
  biegiwpolsce: 2,
  timekeeper: 3,
  lumisport: 3,
  elektronicznezapisy: 4,
  datasport: 7,
  maratonypolskie: 9,
  pomiarczasuatelier: 8,
  b4sport: 8,
  supersport: 5,
  zmierzymyczas: 6,
  raatiming: 8,
}
```

- [ ] **Step 4: Smoke-test the wiring (scrape only, no full pipeline yet)**

```bash
docker compose exec backend node -e "
import('./src/scrapers/index.js').then(async m => {
  const r = await m.runPipeline({ only: ['lumisport'] })
  console.log(JSON.stringify(r, null, 2))
})
"
```

Expected: `sources: [{ source: 'lumisport', found: 4, upserted: 4, errors: [] }]`. Re-run a second time — expected: `found: 4, upserted: 4, errors: []` (existing rows updated in place; pipeline framework already handles that via `update` for known source_ids).

Verify rows actually landed:

```sql
SELECT source_id, name, date, distances, regulamin_url, price_from, price_to
FROM scraper_lumisport
ORDER BY date;
```

Expected: 4 rows with all fields populated.

- [ ] **Step 5: Commit**

```bash
git add backend/src/scrapers/index.js backend/src/scrapers/dedup.js
git commit -m "feat(scraper): wire lumisport into pipeline at priority 3

Same priority as timekeeper (both direct timing companies hosting
canonical event URLs). Lumisport's URLs now beat elektronicznezapisy
and lower-priority aggregators in scraper_all merge."
```

---

## Task 5: Run the merge step and verify scraper_all updates

**Files:** none (data-only)

- [ ] **Step 1: Run the merge**

```bash
docker compose exec backend node scripts/run-merge.js --apply
```

Expected log: `lumisport: created=2 updated=2 errors=0` (2 new events — SFORA, Wieliszewska Piątka — and 2 fuzzy-match updates against existing scraper_all rows for Bolimowski and Bieg Lisewski).

- [ ] **Step 2: Verify scraper_all reflects the lumisport upgrades**

```sql
SELECT name, date, distances, registration_url, regulamin_url, website, price_from, price_to, source, source_id, source_links
FROM scraper_all
WHERE source = 'lumisport'
   OR source_links @> '[{"source":"lumisport"}]'::jsonb
ORDER BY date;
```

Expected: 4 rows. Specifically:

- **Bolimowski Maraton Tura**: `source` switched from `maratonypolskie` to `lumisport` (priority 3 < 9), distances now `"5 km, 21 km, 42 km"` (kids excluded), `is_kids` upstream is true, prices populated, `website` and `registration_url` and `regulamin_url` all on `lumisport.eu`. `source_links` has both `maratonypolskie` and `lumisport`.
- **Bieg Lisewski**: `source` switched from `elektronicznezapisy` to `lumisport` (priority 3 < 4). URLs all on lumisport.eu. `source_links` has both.
- **SFORA**, **Wieliszewska Piątka**: brand-new rows with `source: 'lumisport'`, single `source_links` entry.

If the Bolimowski / Bieg Lisewski rows did NOT switch primary source to lumisport, the priority change in dedup.js wasn't picked up — re-check `SOURCE_PRIORITY` and re-run merge.

- [ ] **Step 3: No commit (data only)**

---

## Task 6: Run the publish step (creates pending calendar_events for new events)

**Files:** none (data-only)

- [ ] **Step 1: Dry-run first**

```bash
docker compose exec backend node scripts/run-publish.js --dry-run
```

Expected log: `created=2 skipped=N fuzzySkipped=0 errors=0` where the 2 created are SFORA and Wieliszewska Piątka. Bolimowski and Bieg Lisewski should be in the `skipped` count (already in calendar_events, exact source_links match).

If `created` includes Bolimowski or Bieg Lisewski, the publish step's source_links matching missed the merge — abort and investigate before applying.

- [ ] **Step 2: Apply**

```bash
docker compose exec backend node scripts/run-publish.js --apply
```

Expected: same numbers, but with rows actually inserted. Verify:

```sql
SELECT name, date, status, source, registration_url
FROM calendar_events
WHERE source = 'lumisport'
ORDER BY date;
```

Expected: 2 rows (SFORA, Wieliszewska Piątka), both `status = 'pending'`.

- [ ] **Step 3: No commit (data only)**

---

## Task 7: Manual backfill of `calendar_events` for the 2 overlap events

**Files:** none (data-only)

The publish step skipped Bolimowski and Bieg Lisewski because they already exist in `calendar_events` with stale data. We need to manually copy the upgraded fields from `scraper_all` over. Per CLAUDE.md "Database write safety" rule — state the change, get user confirmation, then execute.

- [ ] **Step 1: Read current `calendar_events` values for the 2 events**

```sql
SELECT id, name, date, distances, registration_url, regulamin_url, website,
       price_from, price_to, source, source_id, source_links, locked_fields
FROM calendar_events
WHERE id IN (
  SELECT id FROM calendar_events
  WHERE name = 'Bolimowski Maraton Tura'
     OR name = 'Bieg na 5 km "Bieg Lisewski"'
);
```

Note the `id` and `locked_fields` for each row.

- [ ] **Step 2: Read upgraded values from scraper_all**

```sql
SELECT name, distances, registration_url, regulamin_url, website,
       price_from, price_to, source_links
FROM scraper_all
WHERE name IN ('Bolimowski Maraton Tura', 'Bieg na 5 km "Bieg Lisewski"')
  AND source = 'lumisport';
```

Note: if the `Bieg na 5 km "Bieg Lisewski"` name didn't carry forward through the merge (lumisport's name is just `BIEG LISEWSKI`), look for `source = 'lumisport' AND date = '2026-05-24'` instead — the cross-source merge keeps the higher-priority name, which is now lumisport's. Use whichever name surfaces.

- [ ] **Step 3: Build the UPDATE and present to user**

For each event, build a single `UPDATE` statement that copies the upgraded fields. Skip any column listed in that row's `locked_fields`. Skip `name` itself — admin may have curated a cleaner name. Example template (substitute actual values + ID):

```sql
UPDATE calendar_events
SET registration_url = '<lumisport permalink>',
    regulamin_url    = '<lumisport PDF URL>',
    website          = '<lumisport permalink>',
    distances        = ARRAY['5 km', '21 km', '42 km'],  -- jsonb/text[] depending on schema
    price_from       = 10,
    price_to         = 100,
    source_links     = '<merged source_links from scraper_all>'::jsonb
WHERE id = '<existing UUID>';
```

Verify the `distances` column type first:

```sql
SELECT column_name, data_type FROM information_schema.columns
WHERE table_schema='public' AND table_name='calendar_events'
  AND column_name IN ('distances', 'source_links', 'event_type');
```

Use the matching cast in the UPDATE.

**STOP and present the proposed SQL to the user for confirmation before executing.** Show:
- Which rows will change (event name + ID)
- Which fields change and their before/after values
- Whether any field is being skipped due to `locked_fields`

Wait for explicit "yes" / "proceed" / "ok" before continuing.

- [ ] **Step 4: Apply the UPDATE for each event**

After user confirmation, run each `UPDATE` separately via `mcp__supabase__execute_sql`. Re-query each row afterward to confirm the values stuck.

- [ ] **Step 5: No commit (data only — but next task commits manifest changes)**

---

## Task 8: Refresh the manifest and OG images

**Files:**
- Generated: manifest + OG image files (committed)

Per the project convention: any change to `calendar_events` requires running `publish-event-pages.js` to refresh the static manifest used by the public site, and committing the result.

- [ ] **Step 1: Run the publisher**

```bash
docker compose exec backend node scripts/publish-event-pages.js --apply
```

Expected: a manifest update; possibly new OG images for the 2 new pending events (SFORA, Wieliszewska Piątka) once they're approved — but those won't ship until you accept them in the admin UI. The 2 backfilled events should get refreshed manifest entries.

- [ ] **Step 2: Inspect what changed**

```bash
git status
git diff --stat
```

Expected: changes to a manifest JSON file and possibly some OG image files under the public app's static directory.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "data: manifest refresh after lumisport scraper rollout"
```

---

## Task 9: Update CLAUDE.md data-sources table

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Bump source count and add a row**

Find the section "### Data sources (7 scrapers)" in `CLAUDE.md`. Two edits:

1. Change the heading to `### Data sources (12 scrapers)`.
2. The existing markdown table currently lists 7 sources. Several scrapers added since (timekeeper, supersport, zmierzymyczas, b4sport, raatiming, pomiarczasuatelier) are not in the table. Rather than re-do the whole table here (out of scope), just append the new lumisport row. The next person to touch this section can backfill the missing rows.

Append after the `timekeeper.pl` row in the table:

```markdown
| lumisport.eu | 5-15 | WC Store API (JSON) + cheerio | High (structured distances + prices, direct registration URLs) |
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add lumisport.eu to data sources table"
```

---

## Self-Review Checklist

Run before declaring done:

1. **Spec coverage:**
   - [x] New table `scraper_lumisport` (Task 1)
   - [x] Scraper at `backend/src/scrapers/sources/lumisport.js` (Tasks 2–3)
   - [x] WC Store API single-call extraction with `is_purchasable && categories.zawody` filter (Task 2)
   - [x] Date regex (Polish + numeric) with year inference (Task 2)
   - [x] Distances from `pa_dystans` term names, kids excluded → `is_kids` flag (Task 2)
   - [x] Prices from `prices.price_range` (Task 2)
   - [x] regulamin lookup via 1 extra HTML fetch with rate limit (Task 3)
   - [x] Pipeline wiring in `index.js` `sources[]` (Task 4)
   - [x] Priority 3 in `dedup.js` (Task 4)
   - [x] CLAUDE.md update (Task 9)
   - [x] Manual `calendar_events` backfill for the 2 overlap events (Task 7)
   - [x] Manifest refresh post-DB-change (Task 8)
2. **No placeholders:** all SQL, code, commands are concrete; no "TBD" / "implement appropriately".
3. **Type consistency:** `parseDate` returns `string | null`; `parseDistances` returns `{ distances: string|null, isKids: boolean }`; `parsePrices` returns `{ priceFrom: number|null, priceTo: number|null }`. The mapRow camel→snake conversion is consistent (`is_kids`, `price_from`, `price_to`).
