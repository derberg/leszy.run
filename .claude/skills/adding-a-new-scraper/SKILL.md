---
name: adding-a-new-scraper
description: Use when adding a new event source to the BeepBeep scraper pipeline. Covers source investigation, priority decision, table migration, scraper code, pipeline wiring, smoke testing, manual backfill of overlap events, manifest refresh.
---

# Adding a new scraper

End-to-end checklist for adding a 13th, 14th, … scraper. Mirrors the lumisport rollout (2026-05-06).

## Reference

- Existing scrapers: [backend/src/scrapers/sources/](../../../backend/src/scrapers/sources/)
- Pipeline glue: [backend/src/scrapers/index.js](../../../backend/src/scrapers/index.js)
- Priority + merge: [backend/src/scrapers/dedup.js](../../../backend/src/scrapers/dedup.js)
- Closest exemplars: `pomiarczasuatelier.js` (HTML, timing co), `lumisport.js` (WC Store API), `dostartu.js` (REST), `timekeeper.js` (HTML, timing co with regulamin)
- Last full rollout spec: [docs/superpowers/specs/2026-05-06-lumisport-scraper-design.md](../specs/2026-05-06-lumisport-scraper-design.md)

## 1. Investigate the source (15 min)

In order of preference:
1. **WC Store API** if WordPress + WooCommerce → `https://SOURCE/wp-json/wc/store/v1/products?per_page=100` (lumisport-style, structured)
2. **WP REST API** → `https://SOURCE/wp-json/` (lists all available endpoints/namespaces)
3. **Custom JSON API** → check sitemap, network tab, `/api/` paths (dostartu-style)
4. **HTML scraping with cheerio** → server-rendered listing pages
5. **Playwright** → JS-rendered SPAs only (last resort, slow)

**Always check:** `<source>/wp-json/` first — many Polish race sites are WordPress.

For each candidate event, find:
- `name`, `date` (parseable to YYYY-MM-DD; DROP if not)
- `slug` or stable id → `source_id`
- `permalink` → `source_url` (and often `registration_url` / `website`)
- `distances` (structured taxonomy if available)
- `regulamin_url` (PDF link)
- `prices` (in PLN — convert from groszy if needed)
- `location` / `voivodeship` (often missing — let enricher fill)

**No date in any field?** Drop the event. Do NOT try to derive from regulamin PDF in the scraper — Docling stays in the Python enricher.

## 2. Decide priority (in `dedup.js` SOURCE_PRIORITY)

| Tier | Priority | When |
|---|---|---|
| Direct organizer / timing co | 3 | Hosts the canonical registration URL for its own events (timekeeper, lumisport). Beats aggregators. |
| Structured big aggregator | 1–2 | dostartu (1), biegiwpolsce (2) — clean APIs, broad coverage |
| Mid aggregator | 4–6 | elektronicznezapisy (4), supersport (5), zmierzymyczas (6) |
| Weak aggregator / listing | 7–9 | datasport (7), maratonypolskie (9), pomiarczasuatelier/b4sport/raatiming (8) |

Ties are fine. Lower number wins on field conflict; mergeSourceLinks keeps both.

## 3. URL verification BEFORE writing the scraper

Per CLAUDE.md "URL verification — REQUIRED": don't reverse-engineer URL patterns. Scrape the source's own UI to find what its "Zapisz się" button uses as `href`. Verify with `curl -sIL` and grep the destination page for the event id/name. If automated check fails (SPA, anti-bot), generate 3–6 sample URLs and ask the user to click them.

## 4. Create the Supabase table (Supabase-only, no Drizzle)

Mirror `scraper_supersport` schema, add columns the source exposes that others don't (e.g. `is_kids`, `price_from`, `price_to`, `lat`, `lng`).

```sql
CREATE TABLE IF NOT EXISTS public.scraper_<name> (
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
  lat              numeric(9, 6),  -- IMPORTANT: match calendar_events precision
  lng              numeric(9, 6),
  source_id        text NOT NULL,
  source_url       text,
  merged_at        timestamptz,
  created_at       timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS scraper_<name>_source_id_idx
  ON public.scraper_<name> (source_id);
```

Apply via `mcp__supabase__apply_migration`.

**lat/lng MUST be `numeric(9, 6)`** — calendar_events uses that precision; unbounded numeric causes phantom diffs in publish reports (saw 449 fake diffs in 2026-05-06 audit).

## 5. Write the scraper

`backend/src/scrapers/sources/<name>.js` — exports `async function scrape({ knownIds })`.

Returns array of:
```js
{
  name, date,                            // both required, drop row if either missing
  location: null,                        // ok if source doesn't expose
  distances: '5 km, 10 km',              // string, comma-separated
  registration_url, regulamin_url, website,
  is_kids: false,
  price_from, price_to,                  // PLN integers
  source: '<name>',
  source_id: <slug or stable id>,
  source_url: <permalink>,
}
```

`knownIds` is a Set of `source_id`s already in the DB. Honor it for incremental runs (skip detail-page fetches for known events; data still flows).

Rate limit detail-page fetches: `await new Promise(r => setTimeout(r, 1100))` between requests. Use `User-Agent: 'leszy.run/1.0 (kontakt@leszy.run)'`.

## 6. Wire into the pipeline

[backend/src/scrapers/index.js](../../../backend/src/scrapers/index.js):

```js
import { scrape as scrape<Name> } from './sources/<name>.js'
// …
const sources = [
  …,
  {
    name: '<name>',
    scrape: scrape<Name>,
    table: 'scraper_<name>',
    mapRow: (raw) => ({
      name: raw.name, date: raw.date,
      location: raw.location || null,
      distances: raw.distances || null,
      registration_url: raw.registration_url || null,
      regulamin_url: raw.regulamin_url || null,
      website: raw.website || null,
      is_kids: raw.is_kids || false,
      price_from: raw.price_from ?? null,
      price_to: raw.price_to ?? null,
      lat: raw.lat ?? null,
      lng: raw.lng ?? null,
      source_id: raw.source_id,
      source_url: raw.source_url || null,
    }),
  },
]
```

[backend/src/scrapers/dedup.js](../../../backend/src/scrapers/dedup.js):

```js
const SOURCE_PRIORITY = {
  …,
  '<name>': <chosen priority>,
}
```

## 7. CLAUDE.md

Bump `### Data sources (N scrapers)` count and append a row to the table.

## 8. Smoke test (in this order)

### Destructive-write authorization rules (read first)

The pipeline has multiple `--apply` steps that write to Supabase. Each one needs **its own explicit user OK** — do not infer cascading authorization.

- **"Fix the bug" ≠ "apply the merge."** If the user authorizes a code change to merge/scraper logic, that authorizes the *code edit only*. After the edit, **re-run the dry-run and show the new output**. Do not `--apply` without a fresh OK that names the apply step.
- **"Yes, that's a separate event" ≠ "apply the merge."** Confirmations of data interpretations are not write authorizations.
- **"Proceed" / "go ahead" / "fix" are scoped to whatever the assistant just proposed.** If the proposal was "I'll fix X and re-show dry-run," then `--apply` is not yet OK'd. Re-ask explicitly: "Apply now?"
- **A clean dry-run does not authorize --apply.** Show the dry-run and wait. Each `--apply` is its own decision point.
- **Don't suggest the next step ("Next: publish to calendar_events") unprompted.** After a successful --apply, *stop*. Let the user direct what comes next.
- **If the user expresses surprise** ("wtf why" / "you were supposed to dry-run only") — STOP. Do not write anything else. Acknowledge, propose a rollback, and wait.

If --apply produced state the user didn't want, rolling back has a critical ordering trap:

**`DELETE WHERE source = '<name>'` catches more than just "rows the new scraper created."** When a high-priority new scraper merges into an existing row, `incomingWins` replaces the row's primary `source/source_id/source_url`, so a `maratonypolskie` row whose primary became `protiming24` will get deleted by the naive query — destroying a legitimate cross-source row whose original maratonypolskie data is then lost from `scraper_all`. The restore-primary UPDATE that's supposed to "fix this" runs on already-deleted rows = no-op = silent data loss.

**Correct rollback order:**

```sql
-- 1. FIRST restore primary on rows that were taken over by --apply.
--    Identify by: source = '<name>' AND has another source in source_links.
--    For each such row, restore primary to the highest-priority remaining
--    source_links entry (e.g. maratonypolskie/88574, biegiwpolsce/2080, etc.).
--    Inspect each manually — there's no generic restore.
UPDATE scraper_all SET source = 'maratonypolskie', source_id = '<id>', source_url = '<url>' WHERE id = '<row_id>';
-- ... repeat per row

-- 2. THEN remove the new scraper's entries from source_links of all rows
UPDATE scraper_all
SET source_links = COALESCE(
  (SELECT jsonb_agg(elem) FROM jsonb_array_elements(source_links) elem
   WHERE elem->>'source' != '<name>'),
  '[]'::jsonb
)
WHERE source_links::text LIKE '%<name>%';

-- 3. NOW delete only rows that are exclusively from the new scraper.
--    By this point, cross-source rows have their primary restored → won't match.
DELETE FROM scraper_all WHERE source = '<name>';

-- 4. Reset merged_at on raw rows so they re-merge cleanly next time
UPDATE scraper_<name> SET merged_at = NULL;
```

Before running ANY rollback, query first to identify which scraper_all rows have `source = '<name>'` AND another source in `source_links` — those are the takeover cases that need primary restored. If you skip this and run DELETE first, the cross-source row data is gone and you'll need to reconstruct from raw tables (`INSERT ... SELECT FROM scraper_<other>`).

### Run the steps

```bash
# Container may not have new file unless watch is running. If needed:
docker cp backend/src/scrapers/sources/<name>.js leszyrun-backend-1:/app/backend/src/scrapers/sources/<name>.js

# 1. Standalone — verify shape of scraped rows
docker compose exec --workdir /app/backend backend node -e "
import('./src/scrapers/sources/<name>.js').then(async m => {
  const rows = await m.scrape({ knownIds: new Set() })
  console.log('count:', rows.length)
  console.log(JSON.stringify(rows, null, 2))
})
"

# 2. Pipeline run for just this source — verifies wiring + DB upsert
docker compose exec --workdir /app/backend backend node -e "
import('./src/scrapers/index.js').then(async m => {
  console.log(await m.runPipeline({ only: ['<name>'] }))
})
"

# 3. DRY-RUN merge → review scraper output AND what scraper_all writes would happen
#    Output sections per source:
#      - Data coverage: name=N/N, distances=N/N, event_types=N/N, ... — at-a-glance
#        check that required fields are populated and nice-to-haves are reasonable
#      - Rows: per-row dump (date | location | name | [distances] | {tags} | flags)
#        with reg/rul/web/geo presence flags — verify each row's data is sensible
#      - Match decisions: + created or ~ merged with reason (source_link,
#        jaccard=0.42, city+jaccard=0.55, etc.) — spot wrong fuzzy matches
#        BEFORE writing
#      - Skipped count: how many rows the merge filter dropped (non-running
#        events, past dates, junk patterns)
docker compose exec --workdir /app/backend backend node scripts/run-merge.js

# 4. Stop and ask the user to review the dry-run output. Do not --apply
#    until the user confirms the matches look correct.
#
#    The merger has two layered guards. Both `findScraperAllMatch` (raw →
#    scraper_all merge) and `run-dedup.js` (within-scraper_all dedup) use
#    them, so identical semantic decisions are made at both stages and
#    dedup can't undo a correct merge:
#
#    a) Distinguishing-tag guard (semantic) — `distinguishingTags(event)`
#       extracts tags in three categories: audience (kids vs adult, via
#       is_kids and keywords like "dzieci"/"świetlik"/"młodzież"), distance
#       (full Maraton vs Półmaraton vs Ćwierćmaraton), style (trail/nw/ocr/
#       ultra, both from event_types and from name regexes). Any category
#       conflict → match rejected, events stay distinct. Add new tags in
#       `distinguishingTags()` (in `dedup.js`) if you spot a category gap.
#
#    b) Best-jaccard among remaining candidates — picks the highest-jaccard
#       row instead of first-match. Prevents weaker matches from "winning"
#       just because they appear earlier in the candidates list.
#
#    If the dry-run shows a wrong fuzzy match anyway, extend
#    `distinguishingTags()` with the missing semantic category. Don't bolt
#    on per-scraper pre-insert workarounds.

# 6. Apply merge after user OK
docker compose exec --workdir /app/backend backend node scripts/run-merge.js --apply

# 7. Dry-run publish
docker compose exec --workdir /app/backend backend node scripts/run-publish.js

# 8. Apply publish after user OK
docker compose exec --workdir /app/backend backend node scripts/run-publish.js --apply
```

After step 6, query `scraper_all` for `source = '<name>'` and confirm field-by-field. Re-check that within-batch collisions didn't sneak in — for each pair of same-date+same-city events from your scraper, both should have their own row.

## 9. Handle overlap events

If the new scraper covers events already in `calendar_events` from another source AND the new scraper has higher priority, merge will change `scraper_all.source` to the new one — but the existing `calendar_events` row was already published and `run-publish.js --apply` will UPDATE only NULL fields (fill-empty). For overlap events with already-populated values:

1. Query CE rows that match scraper_all on source_links
2. For each: state the diff and ask user before UPDATE (CLAUDE.md "Database write safety" rule applies)
3. Skip fields listed in `locked_fields`
4. After updates: `node --env-file=../.env scripts/publish-event-pages.js --apply` to refresh manifest + OG images

## 10. Refresh manifest

After ANY change to `calendar_events` (publish + manual backfill):
```bash
cd backend && node --env-file=../.env scripts/publish-event-pages.js --apply
git add public/public/kalendarz && git commit -m "data: manifest refresh after <name> scraper rollout"
```

## Common pitfalls

| Pitfall | Symptom | Fix |
|---|---|---|
| lat/lng stored as unbounded numeric | publish report shows hundreds of phantom diffs | Use `numeric(9, 6)` matching calendar_events |
| Date drops in scraper_all | Pipeline says "found=N upserted=M" with M < N silently | Pipeline has `if (row.name && row.date)` filter — check scraper logs for date parse failures |
| Reverse-engineered URL pattern | Login redirects strip the event id; URLs look fine but go nowhere | Scrape the source's own "Zapisz się" `href` instead |
| Cross-source fuzzy match collapses distinct events | Świetlików (kids) merged into Bieg Nocny (adults) on same date+city; Maraton merged into Półmaraton | The distinguishing-tag guard now catches audience/distance/style conflicts. If a NEW conflict slips through, extend `distinguishingTags()` rather than pre-insert |
| Within-batch collision | Bieg + NW variant of same race on same date — first creates row, second fuzzy-matches into it | Distinguishing-tag guard (style:nw) handles this. Verify both stay separate in dry-run |
| Cross-source fuzzy match misses | Scraper inserts new row, `calendar_events` ends up with two rows for the same event | After publish, check `fuzzySkipped` log; admin Duplikaty view to merge |
| Forgot SOURCE_PRIORITY | Lower priority (defaults to 99) — your scraper never wins on field conflicts | Add to `dedup.js` |
| Container has stale code | "ERR_MODULE_NOT_FOUND" on smoke test | `docker cp` the new file or restart with `docker compose up --watch` |

## Don't

- Don't dockerize Mosquitto.
- Don't add a Drizzle migration for scraper tables (Supabase-only).
- Don't try to parse PDFs in the scraper — Docling stays in the Python enricher.
- Don't permanently delete rejected calendar_events while testing — they prevent the scraper re-adding the same junk.
