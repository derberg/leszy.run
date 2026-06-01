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
2. **iCal feed** if WordPress + The Events Calendar plugin → `https://SOURCE/wydarzenia/?ical=1` (or `/events/?ical=1`). Rich structured data: clean `DTSTART;VALUE=DATE`, `SUMMARY`, `LOCATION`, `URL`, `UID` (stable post id as prefix), and full `DESCRIPTION` containing PDF regulamin links (URL-encoded in `vc_btn` shortcodes — decode before regex). No detail page fetches needed. Exemplar: `kepasport.js`.
3. **WP REST API** → `https://SOURCE/wp-json/` (lists all available endpoints/namespaces)
4. **Custom JSON API** → check sitemap, network tab, `/api/` paths (dostartu-style)
5. **HTML scraping with cheerio** → server-rendered listing pages
6. **Playwright** → JS-rendered SPAs only (last resort, slow)

**Always check:** `<source>/wp-json/` first — many Polish race sites are WordPress. Also check `/?ical=1` — The Events Calendar plugin is common and gives better structured data than HTML scraping.

For each candidate event, find:
- `name`, `date` (parseable to YYYY-MM-DD; DROP if not)
- `slug` or stable id → `source_id`
- `permalink` → `source_url` (and often `registration_url` / `website`)
- `distances` (structured taxonomy if available)
- `regulamin_url` (PDF or HTML — HTML is still valuable for enricher price/deadline extraction)
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
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL,
  date                  text NOT NULL,
  location              text,
  distances             text,
  registration_url      text,
  registration_deadline date,
  regulamin_url         text,
  website               text,
  is_kids               boolean DEFAULT false,
  event_types           text[],         -- IMPORTANT: needed for cross-source merges to land
  price_from            numeric,
  price_to              numeric,
  lat                   numeric(9, 6),  -- IMPORTANT: match calendar_events precision
  lng                   numeric(9, 6),
  source_id             text NOT NULL,
  source_url            text,
  merged_at             timestamptz,
  created_at            timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS scraper_<name>_source_id_idx
  ON public.scraper_<name> (source_id);
```

Apply via `mcp__supabase__apply_migration`.

**lat/lng MUST be `numeric(9, 6)`** — calendar_events uses that precision; unbounded numeric causes phantom diffs in publish reports (saw 449 fake diffs in 2026-05-06 audit).

**`event_types` is not optional** — see section 5b. Skipping it means your scraper's rows will be rejected as duplicates of every same-event row that's already been LLM-enriched (the distinguishing-tag guard in `findScraperAllMatch` rejects on tag-presence mismatch). Bgtimesport rollout 2026-05-07 hit this for Magurki/Żar/X Leśne until we added trail/NW detection from name keywords.

## 5. Write the scraper

`backend/src/scrapers/sources/<name>.js` — exports `async function scrape({ knownIds })`.

Returns array of:
```js
{
  name, date,                            // both required, drop row if either missing
  location: null,                        // ok if source doesn't expose
  distances: '5 km, 10 km',              // string, comma-separated — see section 5c
  registration_url, regulamin_url, website,
  registration_deadline: null,           // YYYY-MM-DD; include column in Supabase table too
  is_kids: false,                        // see section 5b
  event_types: ['trail'],                // see section 5b — required for merges to land
  price_from, price_to,                  // PLN integers
  source: '<name>',
  source_id: <slug or stable id>,
  source_url: <permalink>,
}
```

`knownIds` is a Set of `source_id`s already in the DB. Honor it for incremental runs.

**Two valid patterns for `knownIds`** — pick one and stick to it:

| Pattern | Used by | Trade-off |
|---|---|---|
| **Emit only new events** (filter listing → only fetch+emit non-known) | timekeeper, bgtimesport | Simpler. Known rows untouched. Price/distance changes don't refresh until force re-scrape. |
| **Emit all events, fetch detail only for new** | lumisport (Phase 1 = bulk API) | Refreshes prices/distances on every run. But pipeline's UPDATE path will overwrite known rows' regulamin/website with `null` if your scrape didn't re-fetch detail — make sure you DON'T return null for fields you only fetch on first encounter. |
| **Emit all events, no detail fetches** | sporttime | Safe when ALL fields come from the listing page. Re-emitting known rows is harmless — the upsert is idempotent and no field can be nulled by re-emitting. `knownIds` still accepted but ignored. |

The bgtimesport rollout initially mixed the two patterns (emitted all but only fetched detail for new) and would have cleared distances/prices/regulamin from known rows on every re-run. Switched to the timekeeper pattern.

Rate limit detail-page fetches: `await new Promise(r => setTimeout(r, 1100))` between requests. Use `User-Agent: 'leszy.run/1.0 (kontakt@leszy.run)'`.

## 5b. Detect event_types and is_kids correctly

These two fields determine whether your scraper's rows merge with existing same-event rows from other scrapers. The merge code's distinguishing-tag guard treats absence as a tag-set difference — a row with `event_types=null` will NOT merge with a row that has `event_types=['trail']`, even when names + dates + cities match perfectly. Get these wrong and you ship duplicates.

### `event_types` — default to umbrella name; subdivisions only when safe

Default source is the umbrella event name (not bieg subdivision headings). Mirrors the categories `distinguishingTags()` recognizes: `trail`, `nordic walking`, `ultra`, `ocr`. Polish keywords:

```js
function detectEventTypes(name) {
  const blob = (name || '').toLowerCase()
  const tags = new Set()
  if (/g[oó]rsk[aiey]|leśn[aey]|\btrail\b|cross(?:owy|owa|owe)?\b/i.test(blob)) tags.add('trail')
  if (/nordic\s*walking|\bnw\b/i.test(blob)) tags.add('nordic walking')
  if (/\bultra\b|\b\d{1,3}\s*h\s*run\b/i.test(blob)) tags.add('ultra')
  if (/\bocr\b/i.test(blob)) tags.add('ocr')
  return [...tags]
}
```

Pass BOTH umbrella name AND the raw distances string to catch type signals in distances. Some sources write `nw 6km` in the distances field — `\bnw\b` in the name alone won't see it:

```js
const eventTypes = detectEventTypes(`${name} ${distancesRaw || ''}`)
```

**Why umbrella name is the default:** including subdivision headings over-tags. If the umbrella has running + NW subdivisions, picking up `'nordic walking'` from a subdivision can create a tag-set mismatch with biegiwpolsce/maratonypolskie which only tag from umbrella names. Bgtimesport's `X Leśne Bieganie` failed to merge with biegiwpolsce until we restricted detection to the umbrella.

**The exception — when subdivision tagging is safe (and worth it).** Read `hasDistinguishingConflict` (`dedup.js`) before deciding. The guard compares per-category (audience/distance/style) and **tolerates one-sided absence** — if one row has zero `style:` tags, that category is skipped, no conflict. A conflict fires only when *both* rows have style tags in a category and they differ (including different *counts* — `{trail}` vs `{trail,nw}`). So:

- **Safe:** the umbrella name carries NO style keyword and a sub-competition reveals a style (e.g. a plain `Bieg "Letnia Forma"` with a "Nordic walking" sub-race → `{style:nw}` vs an aggregator's `{}` → merges). Registration hosts that expose per-competition names (zapisyonline's `.competitions .event .item.name`) can mine this for real signal the umbrella hides. zapisyonline does this as of 2026-06-01.
- **Dangerous:** the umbrella name ALREADY triggers a style regex AND a sub-competition adds a *different* style (e.g. a `Cross …` event → `style:trail` from the name, plus an NW sub-race → `{trail,nw}`; an umbrella-only aggregator emits `{trail}` → count mismatch → merge rejected → duplicate). Never let a subdivision add a *second* style on top of a style the umbrella already carries.

Practical rule for a registration host: detect style from `umbrella name + all competition names`, but if you find the umbrella name itself matches a style regex, do NOT also append a sub-race style — fall back to umbrella-only for that event.

### `is_kids` — true if ANY subdivision is kids (lumisport rule)

Opposite direction: `is_kids` should look at *all* signals, not just the umbrella. Lumisport sets `is_kids=true` whenever any product variant is in the `dzieci` category. Follow that pattern. The downstream merge guard's `audience:kids` tag matches between rows that have `is_kids=true` and rows whose enriched `event_types` contain `'dzieci'` — get this wrong and Magurki-style umbrella events with kids variants fail to merge with their LLM-enriched counterparts.

```js
// Watch out: \b doesn't recognize Polish letters in JS regex.
// Use a manual non-letter boundary instead.
const NB = '[^a-ząćęłńóśźż]'
function hasKidsSignal(name) {
  if (!name) return false
  const s = ` ${name.toLowerCase()} `
  if (new RegExp(`(?:biegi|dla)\\s+dzieci`).test(s)) return true
  if (new RegExp(`${NB}dzieci${NB}`).test(s)) return true  // catches standalone "- DZIECI"
  if (new RegExp(`${NB}m[lł]odzie[zż]`).test(s)) return true
  if (new RegExp(`${NB}świetlik`).test(s)) return true
  if (new RegExp(`${NB}kids?${NB}`).test(s)) return true
  if (new RegExp(`${NB}mini[\\-a-ząćęłńóśźż]`).test(s)) return true
  return false
}

// In scrape(): is_kids = hasKidsSignal(umbrellaName) || anyBiegMatchedKids
```

**Why "Mini" needs care:** match `MiniKierpce`, `Mini-Maraton` (kids events that start with Mini), and `miniBucze` as a subdivision (kids subdivision inside an adult umbrella). But don't match arbitrary words containing `mini`. The non-letter boundary `${NB}mini[\\-a-ząćęłńóśźż]` handles all three.

## 5c. Distances field format

`distances` must be **clean numbers + unit only** — no activity-type prefixes, no noise phrases:

- **Correct:** `"8 km, 6 km"`, `"5 km, 10 km, 21.1 km"`
- **Wrong:** `"bieg 8km, nw 6km"`, `"8km,6km"`, `"8 km, biegi dla dzieci"`

If the source stores distances mixed with category labels (common on Polish timing-co sites), strip them:

```js
// Input: "bieg 8km, nw 6km, biegi dla dzieci i młodzieży, rolki"
// Output: "8 km, 6 km"
function cleanDistances(raw) {
  if (!raw) return null
  let s = raw
    .replace(/biegi dla dzieci i m[lł]odzie[żz]y?/gi, '')
    .replace(/biegi dla dzieci/gi, '')
    .replace(/biegi dla m[lł]odzie[żz]y?/gi, '')
    .replace(/rolki/gi, '')
    .replace(/\bnw\s+(?=\d)/gi, '')           // "nw 6km" → "6km"
    .replace(/\bbieg\s+(?=\d)/gi, '')          // "bieg 8km" → "8km"
    .replace(/(\d+)\s*km\b/gi, (_, n) => `${n} km`)   // "8km" → "8 km"
    .replace(/(\d{2,})\s*m\b/g,  (_, n) => `${n} m`)  // "400m" → "400 m"
    .trim()
    .replace(/^[,\s]+|[,\s]+$/g, '')
    .replace(/,\s*,+/g, ',')
    .trim()
  return s || null
}
```

Always return `null` (not empty string) when the source has no distance data — the merge code treats empty string and null differently.

## 5d. Automatic dostartu API enrichment

**You don't need to add enrichment code to your scraper.** The pipeline in `index.js` automatically calls `enrichFromUrl()` from `backend/src/scrapers/apiEnrich.js` for every scraped event whose `registration_url` points to a dostartu-like platform (`dostartu.pl`, `zapisy.mktime.pl`, `zapisy.o-timing.pl`).

`enrichFromUrl()` fills (without overwriting existing scraper data):
- `price_from`, `price_to`, `registration_deadline` — from dostartu classifications API
- `regulamin_url`, `website` — from dostartu competition API
- `distances`, `is_kids` — from classification names (scraper wins if it already has distances)
- `location`, `lat`, `lng` — from dostartu competition API

**How it works in the pipeline:**
```js
// index.js — after scraping, before upsert
if (!SELF_ENRICHING_SOURCES.has(source.name)) {
  for (let j = 0; j < rawEvents.length; j++) {
    if (!isDostartuLikeUrl(rawEvents[j].registration_url)) continue
    rawEvents[j] = await enrichFromUrl(rawEvents[j])
    await new Promise(r => setTimeout(r, 300))  // rate limit
  }
}
```

**`SELF_ENRICHING_SOURCES`** (currently `dostartu` and `elektronicznezapisy`): scrapers that call the dostartu API themselves in-scraper (because their dostartu URL is in a different field, not `registration_url`). Don't add your scraper here unless it has special enrichment logic inside the scraper itself.

**If your scraper's dostartu URL lives in a field other than `registration_url`** (e.g. in `externalWebsite`), call `enrichFromUrl({ registration_url: externalWebsite, name, ... })` inside the scraper, and add your source to `SELF_ENRICHING_SOURCES` to skip the pipeline-level enrichment.

**`registration_deadline` requires a Supabase column.** If your scraper's table doesn't have `registration_deadline date`, the enrichment result gets silently dropped when `mapRow` extracts it. Add the column to the CREATE TABLE in section 4 AND to `mapRow` in section 6.

## 5e. Registration hosts: prices live one click deeper

On a registration *host* (the source hosts the actual sign-up, not just a listing), the detail page often shows distances + an organizer link but NO prices. Prices and the per-tier deadline live on the per-competition registration page behind the **"Zapisz się"** button. Pattern (zapisyonline, 2026-06-01):

```
/wydarzenie/<eventId>,<slug>      ← detail page: distances, website, regulamin
   └─ .competitions .event .item.btn a[href^="/zapisy/"]   ← one per sub-race
        → /zapisy/<competitionId>,<slug>    ← THIS page has prices
             .price.has              → "159,00 zł" (one per packet/wave)
             .msg "obowiązuje do <YYYY-MM-DD>"  → that tier's expiry
```

Follow every competition's button, then aggregate across ALL packets of ALL competitions:
- `price_from` = `Math.min(...)`, `price_to` = `Math.max(...)` — exactly the lowest (usually kids) and highest (usually longest adult distance) registration price. A single price → from == to.
- `registration_deadline` = the **latest** "obowiązuje do" date seen (registration stays open through the final price tier; ISO dates sort as strings).

Rate-limit the extra fetches like any detail fetch (`setTimeout(r, 1100)`). This multiplies requests per event by the number of sub-races, so only do it for NEW events (timekeeper `knownIds` pattern).

**Donation-tier trap — verify the prices are entry fees, not "cegiełki".** Charity events list donation packets ("Pakiet 35/50/100/.../1000 zł") on the same registration page, identical markup to real entry fees. Blind min/max turns those into a bogus `price_to` (saw zapisyonline `Wiosna na sportowo` → 0–500 on a 30 m run). Before trusting a wide price spread, inspect the packet names (`.pname`): tiered "Pakiet N zł" with no distance = donations → leave price null. There is no clean automated signal — spot-check events whose price_to dwarfs the distance.

## 5f. `website` — trust the source's DECLARED official link

When the source has a dedicated official-site field (zapisyonline's "Oficjalna strona" / `.item.www` block), use it as `website` **even if it's a Facebook page** — many Polish events have no standalone site and FB is their real presence (user directive, 2026-06-01). Only strip the timing platform's own/asset hosts (`zapisyonline`, `triso`, `googleapis`, `gstatic`, `skype`).

The "first external link" *fallback heuristic* (used when there's no declared field) must STILL skip social (`facebook`, `instagram`, `youtube`, …): there a Facebook hit is a share-widget guess, not a declared link. Two filters, not one:

```js
const isPlatformHost = (href) => /zapisyonline\.pl|triso\.pl|googleapis|gstatic|skype/i.test(href)
const isSocialHost   = (href) => /facebook|fb\.com|fb\.me|instagram|youtube/i.test(href)
let website = $('.item.www .value a[href^="http"]').first().attr('href') || null
if (website && isPlatformHost(website)) website = null          // declared link: only strip platform
if (!website) $('a[href^="http"]').each((_, a) => {             // fallback: also skip social
  if (website) return
  const href = $(a).attr('href') || ''
  if (isPlatformHost(href) || isSocialHost(href)) return
  website = href
})
```

(The Python enricher still validates/rejects social when it has no declared link to trust — this exception is scraper-side only, for fields the source itself labels official.)

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
      registration_deadline: raw.registration_deadline || null,  // DATE — add column in section 4
      regulamin_url: raw.regulamin_url || null,
      website: raw.website || null,
      is_kids: raw.is_kids || false,
      event_types: raw.event_types && raw.event_types.length > 0 ? raw.event_types : null,
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

- **Auto mode does NOT relax these rules.** The auto-mode reminder explicitly says "Auto mode is not a license to destroy. Anything that deletes data or modifies shared or production systems still needs explicit user confirmation." DB writes to `scraper_all` and `calendar_events` are shared production data. "Prefer action over planning" applies to local code edits and read-only investigation, not to `--apply` commands.
- **Confirmations are scoped to the most-recently-asked specific question.** A "yes" / "ok" / "sey" / "proceed" applies ONLY to the proposal in your previous message. It does NOT carry across topics, tasks, or open todos. If two tasks are in flight (e.g. "enrich event X" + "scraper rollout pending --apply") and the user answers a one-word "yes," it answers the most recent specific ask — NOT both. When in doubt, re-ask: *"To confirm — you mean apply the merge for `<name>`, right? Not the enrichment update I asked about earlier."*
- **A "ready to apply, awaiting OK" status line is not the same as an open question.** If you said "awaiting OK" three turns ago, then asked something else and got "yes," that "yes" answered the recent question — not the earlier awaiting-OK item. Treat awaiting-OK items as inert until the user explicitly returns to them.
- **"Fix the bug" ≠ "apply the merge."** If the user authorizes a code change to merge/scraper logic, that authorizes the *code edit only*. After the edit, **re-run the dry-run and show the new output**. Do not `--apply` without a fresh OK that names the apply step.
- **"Yes, that's a separate event" ≠ "apply the merge."** Confirmations of data interpretations are not write authorizations.
- **"Proceed" / "go ahead" / "fix" are scoped to whatever the assistant just proposed.** If the proposal was "I'll fix X and re-show dry-run," then `--apply` is not yet OK'd. Re-ask explicitly: "Apply now?"
- **A clean dry-run does not authorize --apply.** Show the dry-run and wait. Each `--apply` is its own decision point.
- **Don't suggest the next step ("Next: publish to calendar_events") unprompted.** After a successful --apply, *stop*. Let the user direct what comes next.
- **If the user expresses surprise** ("wtf why" / "you were supposed to dry-run only" / "are you fucking mental") — STOP. Do not write anything else. Acknowledge, propose a rollback, and wait.

### Confirmation hygiene — pre-apply checklist

Before running ANY `--apply` command, verify all of these in the most recent user message (not earlier in the session):

1. The user named the specific operation (`run-merge.js --apply`, `run-publish.js --apply`, the table name being written, etc.) — or unambiguously referred to the proposal you made one turn earlier
2. There is no other open "awaiting OK" item that could plausibly be what they're answering
3. You proposed THIS specific apply step in your immediately-preceding message

If any of those is unclear, re-ask. The cost of one re-confirmation is low; the cost of unauthorized writes to shared tables is high (rollback work, lost trust, possibly lost data if the rollback ordering trap below isn't followed).

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
# Container may not have new/updated files unless watch is running. Copy all three:
docker cp backend/src/scrapers/sources/<name>.js leszyrun-backend-1:/app/backend/src/scrapers/sources/<name>.js
docker cp backend/src/scrapers/index.js leszyrun-backend-1:/app/backend/src/scrapers/index.js
docker cp backend/src/scrapers/dedup.js leszyrun-backend-1:/app/backend/src/scrapers/dedup.js

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

## 10. Update docs

Two files track the scraper list — update both:

**CLAUDE.md** — bump `### Data sources (N scrapers)` count and append a row to the table.

**docs/scrapers.md** — find the scraper → table mapping (search for `scraper_wbtiming` or similar) and append a row:
```
| <name> | `scraper_<name>` | `source_id` |
```

## 11. Refresh manifest

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
| Distinguishing-tag guard rejects legitimate merges | Dry-run shows `created=N` for events you know exist in scraper_all from another source | Your scraper's rows have `event_types=null` while existing rows have LLM-enriched tags. Tag-presence mismatch → guard rejects. Add `detectEventTypes(name)` per section 5b |
| `runPipeline({ force: [x] })` doesn't actually clear | Re-scrape reports duplicate-key errors, table still has stale rows | The `.delete().neq('id', '')` silently no-ops on this Supabase setup. Workaround: `DELETE FROM scraper_x` via `mcp__supabase__execute_sql` before re-scraping |
| Polish word boundaries miss | Regex `\bświetlik\b` doesn't match "Świetlik Run" because JS `\b` doesn't recognize `ś` | Lowercase the input and use a manual non-letter boundary: `[^a-ząćęłńóśźż]świetlik` |
| Forgot SOURCE_PRIORITY | Lower priority (defaults to 99) — your scraper never wins on field conflicts | Add to `dedup.js` |
| Container has stale code | "ERR_MODULE_NOT_FOUND" on standalone test; pipeline test imports old wiring | `docker cp` all three: `sources/<name>.js`, `index.js`, `dedup.js` — or restart with `docker compose up --watch` |
| Distances store activity-type labels | `distances = "bieg 8km, nw 6km"` instead of `"8 km, 6 km"` — merge code can't parse distances, enricher sees junk | Strip `bieg`/`nw` prefixes and normalize spacing with `cleanDistances()` (section 5c) |
| `detectEventTypes` misses NW from distances | Source writes `nw 6km` only in distances, not in event name — tag missing, guard rejects NW-event merge | Pass `${name} ${distancesRaw || ''}` to `detectEventTypes` |
| `registration_deadline` silently dropped | enrichFromUrl fills deadline but it never lands in DB | Scraper table needs `registration_deadline date` column AND mapRow must include `registration_deadline: raw.registration_deadline || null` |
| dostartu enrichment duplicated in-scraper | Scraper calls dostartu API itself for events whose `registration_url` points to dostartu, but pipeline also calls `enrichFromUrl` | Add your source to `SELF_ENRICHING_SOURCES` in `index.js` to skip pipeline-level enrichment |
| `enrichFromUrl` lat/lng overwrites with null | Pipeline calls `enrichFromUrl` on event that has no lat/lng from scraper; enrichFromUrl returned undefined for those fields | `enrichFromUrl` uses `event.lat ?? comp?.locationLat ?? null` — safe. If you see nulls, check that mapRow includes `lat: raw.lat ?? null` |
| Donation tiers scraped as entry fees | `price_to` wildly high vs distance (e.g. 0–500 on a 30 m run) | Charity "Pakiet N zł" packets aren't entry fees. Inspect `.pname`/packet names; leave price null if tiered donations with no distance (section 5e) |
| Subdivision style tag breaks merge | New registration-host row won't merge with biegiwpolsce/maratonypolskie even though name+date+city match; ends up duplicated | Umbrella name already carries a `style:` tag (e.g. `Cross …` → trail) and you appended a second style (nw) from a sub-race → `{trail,nw}` vs `{trail}` count mismatch. Only add sub-race style when the umbrella has none (section 5b exception) |
| Facebook stripped from declared website | `website` null for events whose only official presence is a FB page | Don't run the social filter on a source's DECLARED official-site field — only on the fallback heuristic (section 5f) |

## Don't

- Don't dockerize Mosquitto.
- Don't add a Drizzle migration for scraper tables (Supabase-only).
- Don't try to parse PDFs in the scraper — Docling stays in the Python enricher.
- Don't permanently delete rejected calendar_events while testing — they prevent the scraper re-adding the same junk.
- Don't store activity-type labels in `distances` (`"bieg 8km"`, `"nw 6km"`) — strip them with `cleanDistances()`.
- Don't add dostartu API enrichment code inside a new scraper — the pipeline does it automatically via `apiEnrich.js` when `registration_url` points to a dostartu-like domain.
- Don't blanket-reject Facebook as `website` — when the source labels a field "official site," keep it; only the first-external-link fallback skips social (section 5f).
- Don't take min/max of registration prices without checking they're entry fees and not charity donation tiers (section 5e).
- Don't append a sub-race style tag (nw/ocr/trail) on top of a style the umbrella name already carries — it breaks merges with umbrella-only aggregators (section 5b exception).
