# Scraper Pipeline — Source-by-Source Documentation

## Quick run — full pipeline copy-paste

All commands from project root. Requires `backend/.env` with `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
Also requires `claude` CLI installed for steps 5 and 5.1.

```bash
# Step 1: Scrape raw data (6 sources → per-source tables)
cd backend && node --env-file=../.env scripts/run-scrapers.js

# Step 2: Merge into scraper_all (cross-source dedup) — dry run first, then --apply
cd backend && node --env-file=../.env scripts/run-merge.js
cd backend && node --env-file=../.env scripts/run-merge.js --apply

# Step 2.5: Dedup scraper_all — dry run first, then --apply
cd backend && node --env-file=../.env scripts/run-dedup.js
cd backend && node --env-file=../.env scripts/run-dedup.js --apply

# Step 3: Geocode missing voivodeships/coordinates — dry run first, then --apply
cd backend && node --env-file=../.env scripts/run-geocode.js
cd backend && node --env-file=../.env scripts/run-geocode.js --apply

# Step 4: Enrich flags (types, kids, distances from keywords) — dry run first, then --apply
cd backend && node --env-file=../.env scripts/run-enrich-flags.js
cd backend && node --env-file=../.env scripts/run-enrich-flags.js --apply

# Step 4.5: Normalize voivodeships and event types — dry run first, then --apply
cd backend && node --env-file=../.env scripts/run-normalize.js
cd backend && node --env-file=../.env scripts/run-normalize.js --apply

# Step 5: Enrich via Python enricher (LOCAL LLM — PRIMARY TOOL)
cd enricher && source .venv/bin/activate
docker compose up -d  # Start SearXNG
python -m enricher run --limit 5 --dry-run  # Test first
python -m enricher run  # Full run

# If the enricher hangs (e.g. stuck on LLM warm-up):
#   1. Ctrl+C to kill the native process
#   2. Kill any stale Docker enricher containers (scheduler may have launched one):
#        docker ps --filter name=enricher          # check
#        docker rm -f <container-id>               # kill it
#   3. The warm-up swaps out whatever model Ollama has loaded (~4 min for qwen2.5:72b).
#      If qwen2.5 is loaded and you don't want to wait, kill it first:
#        curl -s -X POST http://localhost:11434/api/generate \
#          -d '{"model":"qwen2.5:72b-instruct-q4_0","prompt":"","stream":false,"keep_alive":0}'
#      Then re-run — warm-up will be instant.

# Step 5.1: OPTIONAL — Enrich via web search (Claude CLI fallback for fields enricher missed)
cd backend && node --env-file=../.env scripts/run-enrich-search.js --limit 5
cd backend && node --env-file=../.env scripts/run-enrich-search.js --apply

# Step 5.5: Dedup scraper_all — dry run first, then --apply
cd backend && node --env-file=../.env scripts/run-dedup.js
cd backend && node --env-file=../.env scripts/run-dedup.js --apply

# Step 6: Publish to calendar_events — dry run first, then --apply
cd backend && node --env-file=../.env scripts/run-publish.js
cd backend && node --env-file=../.env scripts/run-publish.js --apply

# Step 7: Regenerate static event pages manifest + OG images — dry run first, then --apply
cd backend && node --env-file=../.env scripts/publish-event-pages.js
cd backend && node --env-file=../.env scripts/publish-event-pages.js --apply
cd backend && node --env-file=../.env scripts/publish-landing-pages.js --apply
# Use --regen-og to regenerate ALL OG images (e.g. after changing the OG template)

# Step 8a: Local Postgres backup (race-timing data: events, participants, results, gate_events, …)
# Same command as the 6-hourly cron job. --verbose streams progress; final `ls -lh` confirms size.
f=~/backups/leszyrun/leszyrun_$(date +%Y%m%d_%H%M).dump && \
  docker exec leszyrun-db-1 pg_dump -U leszyrun -d leszyrun --format=custom --verbose > "$f" && \
  ls -lh "$f"

# Step 8b: Supabase backup (calendar_events, scraper_*, event_secrets, checkins, …)
# One-time setup: add SUPABASE_DB_URL to /Users/derberg/Documents/GitHub/BeepBeep/.env.
# MUST be the Session pooler URL (port 5432) — Direct URL needs IPv6 (container has none),
# Transaction pooler (port 6543) breaks pg_dump (no session features).
# Get it from Supabase Dashboard → green "Connect" button → "Session pooler" tab. Format:
#   SUPABASE_DB_URL=postgresql://postgres.<ref>:<password>@aws-1-<region>.pooler.supabase.com:5432/postgres
# Password is passed via PGPASSWORD (not embedded in URL flags) to avoid URL-encoding pitfalls.
mkdir -p ~/backups/leszyrun && \
  f=~/backups/leszyrun/supabase_$(date +%Y%m%d_%H%M).dump && \
  set -a && source /Users/derberg/Documents/GitHub/BeepBeep/.env && set +a && \
  PGPASSWORD=$(python3 -c "
import re, urllib.parse, os
url = os.environ.get('SUPABASE_DB_URL', '')
m = re.search(r'://[^:]+:([^@]+)@', url)
if not m: raise SystemExit('no password in SUPABASE_DB_URL')
print(urllib.parse.unquote(m.group(1)), end='')
") && \
  [ -n "$PGPASSWORD" ] || { echo "ERROR: couldn't extract password from SUPABASE_DB_URL" >&2; false; } && \
  docker run --rm -e PGPASSWORD="$PGPASSWORD" postgres:17 \
    pg_dump --host=aws-1-eu-west-1.pooler.supabase.com --port=5432 \
            --username=postgres.kojoxazlnxncrpxmnxiq --dbname=postgres \
            --format=custom --verbose --no-owner --no-privileges > "$f" && \
  ls -lh "$f"
```

After publishing, review new events in admin UI: `/calendar-events` → "Do przeglądu" tab.
After step 7, commit the updated manifest and OG images in `public/public/kalendarz/`.

---

## Run logs

Every `--apply` run writes a JSON summary to disk so you can see what happened in past runs (and which failures are persistent vs. new).

| Script | Log location |
|---|---|
| `run-scrapers.js` | `backend/logs/scrapers-<ts>.json` |
| `run-merge.js` | `backend/logs/merge-<ts>.json` |
| `run-dedup.js` | `backend/logs/dedup-<ts>.json` |
| `run-geocode.js` | `backend/logs/geocode-<ts>.json` |
| `run-enrich-flags.js` | `backend/logs/enrich-flags-<ts>.json` |
| `run-normalize.js` | `backend/logs/normalize-<ts>.json` |
| `run-enrich-search.js` | `backend/logs/enrich-search-<ts>.json` |
| `run-publish.js` | `backend/logs/publish-<ts>.json` |
| `publish-event-pages.js` | `backend/logs/publish-event-pages-<ts>.json` |
| `python -m enricher run` | `enricher/logs/run-<ts>.jsonl` (per-event JSONL) |
| `python -m enricher sync` | `enricher/logs/sync-<ts>.json` |
| `python -m enricher audit` | `enricher/logs/audit-<ts>.jsonl` |

`run-geocode.js` additionally compares failures against the previous run's log and tags each as `[NEW]` or `[PERSISTENT]`. It also skips events that are already `rejected` in `calendar_events` so previously-rejected events don't keep showing up as failures.

Quick inspection:
```bash
ls -t backend/logs | head -10                 # latest runs
jq '.failures' backend/logs/geocode-*.json    # all failure histories
```

---

## Restoring from backup

Backups produced by Step 8 are PostgreSQL custom-format dumps. The cleanest restore pattern is `docker run --rm postgres:17` with `~/backups/leszyrun` volume-mounted to `/dumps` so the container can read the file by name. Both steps below follow that pattern.

### Restore the local Postgres dump (Step 8a)

Step 8a dumps are produced by leszyrun-db-1 (Postgres 16). To restore them, use a Postgres 16 client container — same major version is required.

```bash
# Inspect the dump's table-of-contents first (read-only, no changes)
docker run --rm -v ~/backups/leszyrun:/dumps:ro postgres:16 \
  pg_restore -l /dumps/leszyrun_<TIMESTAMP>.dump | less

# Pull the local DB password from docker-compose.yml so we don't hardcode it
LOCAL_PG_PASSWORD=$(grep -E '^\s*POSTGRES_PASSWORD:' /Users/derberg/Documents/GitHub/BeepBeep/docker-compose.yml | head -1 | sed -E 's/.*POSTGRES_PASSWORD:\s*//; s/\s*$//; s/"//g')

# Full restore — DESTRUCTIVE. Drops every table in the local DB before reloading.
# A sibling container joins the leszyrun_default network so it can reach leszyrun-db-1 as host "db".
docker run --rm --network=leszyrun_default \
  -v ~/backups/leszyrun:/dumps:ro \
  -e PGPASSWORD="$LOCAL_PG_PASSWORD" postgres:16 \
  pg_restore --host=db --port=5432 --username=leszyrun --dbname=leszyrun \
             --clean --if-exists --no-owner --no-privileges --verbose \
             /dumps/leszyrun_<TIMESTAMP>.dump
```

Notes on the restore:
- `--network=leszyrun_default` joins the docker-compose network so the sibling container can resolve `db` to `leszyrun-db-1`. Verify with `docker network ls | grep leszyrun` if it ever differs.
- The compose file lives at the project root and defines `POSTGRES_PASSWORD` — the snippet above pulls it.

Single-table restore (e.g. accidentally-truncated `results`):

```bash
LOCAL_PG_PASSWORD=$(grep -E '^\s*POSTGRES_PASSWORD:' /Users/derberg/Documents/GitHub/BeepBeep/docker-compose.yml | head -1 | sed -E 's/.*POSTGRES_PASSWORD:\s*//; s/\s*$//; s/"//g')

docker run --rm --network=leszyrun_default \
  -v ~/backups/leszyrun:/dumps:ro \
  -e PGPASSWORD="$LOCAL_PG_PASSWORD" postgres:16 \
  pg_restore --host=db --port=5432 --username=leszyrun --dbname=leszyrun \
             --table=results --data-only --verbose \
             /dumps/leszyrun_<TIMESTAMP>.dump
```

### Restore the Supabase dump (Step 8b)

The Supabase dump contains the full database — `public` schema (calendar_events, all scraper_*, event_secrets, geocode_cache, dismissed_duplicates, etc.) **plus** Supabase-internal schemas (`auth`, `storage`, `realtime`, `extensions`, `vault`, …). The internal schemas reference Supabase-specific roles (`supabase_admin`, `authenticator`, …) that don't exist in vanilla Postgres, so partial errors during restore are normal — table data in `public` still loads.

**A) Inspect the dump locally** (safe, no production touched). Load into a throwaway Postgres 17 container so you can run SELECTs against it:

```bash
# Start a temporary Postgres 17 with the dump volume-mounted
docker run -d --name supabase-restore-tmp \
  -e POSTGRES_PASSWORD=tmp -e POSTGRES_DB=supabase_restore \
  -v ~/backups/leszyrun:/dumps:ro -p 5433:5432 postgres:17

# Wait for it to be ready
until docker exec supabase-restore-tmp pg_isready -U postgres; do sleep 1; done

# Restore — limit to public schema to skip the failing internal-schema objects.
# Some errors will still print (extensions, missing roles); ignore unless data tables fail.
docker exec supabase-restore-tmp pg_restore \
  -U postgres -d supabase_restore \
  -n public --no-owner --no-privileges --verbose \
  /dumps/supabase_<TIMESTAMP>.dump

# Query — confirm the tables loaded
docker exec -it supabase-restore-tmp \
  psql -U postgres -d supabase_restore \
       -c "SELECT COUNT(*) AS calendar_events FROM calendar_events;"

# Tear down when done
docker rm -f supabase-restore-tmp
```

**B) Restore back into Supabase production** — destructive; do this only as a last resort. Supabase has built-in Point-in-Time Recovery (Dashboard → Database → Backups) which is safer for full restores. Manual `pg_restore` into Supabase often leaves orphaned grants / RLS policies because `--no-owner --no-privileges` was used at dump time.

```bash
# DESTRUCTIVE — overwrites every table in Supabase 'public' schema.
# Strongly consider PITR via Supabase Dashboard instead.
set -a && source /Users/derberg/Documents/GitHub/BeepBeep/.env && set +a && \
  PGPASSWORD=$(python3 -c "
import re, urllib.parse, os
url = os.environ.get('SUPABASE_DB_URL', '')
m = re.search(r'://[^:]+:([^@]+)@', url)
if not m: raise SystemExit('no password in SUPABASE_DB_URL')
print(urllib.parse.unquote(m.group(1)), end='')
") && \
  docker run --rm -e PGPASSWORD="$PGPASSWORD" \
    -v ~/backups/leszyrun:/dumps:ro postgres:17 \
    pg_restore --host=aws-1-eu-west-1.pooler.supabase.com --port=5432 \
               --username=postgres.kojoxazlnxncrpxmnxiq --dbname=postgres \
               -n public --clean --if-exists \
               --no-owner --no-privileges --verbose \
               /dumps/supabase_<TIMESTAMP>.dump
```

**Single-table restore to Supabase** (much less destructive — reloads just one table):

```bash
# Replaces just calendar_events. Drops the table first, then reloads its data.
# Use this for surgical recovery rather than full restore.
set -a && source /Users/derberg/Documents/GitHub/BeepBeep/.env && set +a && \
  PGPASSWORD=$(python3 -c "
import re, urllib.parse, os
url = os.environ.get('SUPABASE_DB_URL', '')
m = re.search(r'://[^:]+:([^@]+)@', url)
if not m: raise SystemExit('no password in SUPABASE_DB_URL')
print(urllib.parse.unquote(m.group(1)), end='')
") && \
  docker run --rm -e PGPASSWORD="$PGPASSWORD" \
    -v ~/backups/leszyrun:/dumps:ro postgres:17 \
    pg_restore --host=aws-1-eu-west-1.pooler.supabase.com --port=5432 \
               --username=postgres.kojoxazlnxncrpxmnxiq --dbname=postgres \
               --table=calendar_events --clean --if-exists \
               --no-owner --no-privileges --verbose \
               /dumps/supabase_<TIMESTAMP>.dump
```

### General tips

- **List a dump's TOC**: `docker run --rm -v ~/backups/leszyrun:/d postgres:17 pg_restore -l /d/<file>.dump | less` — shows every TABLE/INDEX/SEQUENCE/etc. inside.
- **Data-only restore** (skip schema): add `--data-only`. Useful when the schema is already correct.
- **Schema-only restore**: add `--schema-only`. Useful for inspecting structure without loading data.
- **Selective restore via TOC list**: `pg_restore -l <file> > toc.list`, edit (comment out unwanted lines with `;`), then `pg_restore -L toc.list <file>`.
- **Limit to public schema**: add `-n public`. Skips Supabase-internal schemas that fail with permission errors.

---

## Running the pipeline (detailed)

All commands run from project root. Requires `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in `backend/.env`.
No backend server or Docker needed — scripts talk directly to Supabase.

### Step 1: Scrape raw data

Fetches events from all 6 sources and stores in per-source tables (`scraper_dostartu`, `scraper_biegiwpolsce`, `scraper_timekeeper`, etc.).

```bash
cd backend && node --env-file=../.env scripts/run-scrapers.js

# Force re-scrape specific sources (clears their table first)
cd backend && node --env-file=../.env scripts/run-scrapers.js --force dostartu
cd backend && node --env-file=../.env scripts/run-scrapers.js --force dostartu,elektronicznezapisy
```

### Step 2: Dedup and merge into `scraper_all`

Reads all raw tables, deduplicates cross-source, merges into `scraper_all` with priority-based field resolution. dostartu data wins over all others.

Priority: dostartu (1) > biegiwpolsce (2) > timekeeper (3) > elektronicznezapisy (4) > supersport (5) > zmierzymyczas (6) > datasport (7) > b4sport (8) = pomiarczasuatelier (8) > maratonypolskie (9)

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

Enriches `scraper_all` from event name keywords:
- **Event types** — classifies from name when no type exists (górski, nocny, ocr, nordic walking, ultra, charytatywny). Also adds `charytatywny` to events that already have types.
- **Distances** — extracts from name when missing (półmaraton → 21.1 km, maraton → 42.2 km, dycha/dyszka → 10 km, piątka → 5 km, explicit N km)
- **Kids flag** — sets `is_kids=true` when any distance is ≤ 1 km

```bash
cd backend && node --env-file=../.env scripts/run-enrich-flags.js
```

Output: `T` = type classified, `K` = kids flagged, `D` = distances extracted from name.

### Step 5: Enrich via Python enricher (LOCAL LLM — RECOMMENDED)

**PRIMARY enrichment tool** — uses local Ollama (gemma3:27b) + SearXNG search + Crawl4AI + Docling PDF extraction. Comprehensive, cost-free, processes ALL missing fields.

```bash
cd enricher && source .venv/bin/activate

# Start SearXNG (required for URL discovery)
docker compose up -d

# Dry-run first 5 events
python -m enricher run --limit 5 --dry-run

# Process all un-enriched future events
python -m enricher run

# Force re-enrich already-processed events (e.g., after fixing bugs)
python -m enricher run --force --limit 10
```

**What it fills:**
- **registration_url** — LLM extracts from page content, fallback to SearXNG search
- **regulamin_url** — LLM extracts from page content or PDF links, fallback to SearXNG search
- **website** — official event site (SearXNG search + LLM validates it's not news/social/aggregator)
- **distances** — from regulamin PDFs (via Docling), registration pages, or website content (all crawled via Crawl4AI)
- **event_types** — `[trail, uliczny, nocny, ocr, nordic walking, ultra, charytatywny]` extracted from all content sources
- **price_from / price_to** — entry fees in PLN (prioritizes regulamin PDF over registration page, looks for "opłata startowa" tables with date tiers)
- **registration_deadline** — from regulamin or registration page (format: YYYY-MM-DD)
- **voivodeship** — only fills empty, never overwrites scraper's geocoded value
- **is_kids** — true if any distance ≤ 1 km or dedicated children's category exists

**Performance:** ~2 min/event (LLM inference on 32B model).

See [enricher/README.md](../enricher/README.md) for full documentation.

### Step 5.1: Enrich from regulamin PDFs (Claude CLI — LEGACY)

**DEPRECATED** — the Python enricher (Step 5) handles PDFs better via Docling. Only use this for quick spot-checks.

```bash
cd backend && node --env-file=../.env scripts/run-enrich-from-regulamin.js
```

### Step 5.2: Enrich via web search (Claude CLI — LEGACY FALLBACK)

**DEPRECATED** — the Python enricher (Step 5) is better (local model, no API costs, more comprehensive). Only use this as a last-resort cleanup pass for specific fields that the enricher missed.

```bash
# Dry-run first 5 events
cd backend && node --env-file=../.env scripts/run-enrich-search.js --limit 5

# Apply results to DB (only fills fields the enricher missed)
cd backend && node --env-file=../.env scripts/run-enrich-search.js --apply
```

Requires `claude` CLI installed locally. Uses `--model sonnet` with web search. ~2 sec between calls.

**Only processes events missing registration_url, distances, or event_types** — skips events the enricher already filled.

### Step 4.5: Normalize voivodeships and event types

Normalizes `scraper_all` data before AI enrichment steps — ensures LLM sees clean type names, not raw scraper values.
- Voivodeship → Title-Case (`dolnośląskie` → `Dolnośląskie`, `Śląsk` → `Śląskie`)
- Event types: merges `event_type` (dostartu) + `event_types` (biegiwpolsce) into a single normalized `event_types` array

Type mapping:
| Raw | Normalized |
|-----|-----------|
| `Przełaj/Cross` | `przełajowy` |
| `trail`, `Górski` | `górski` |
| `Uliczny` | `uliczny` |
| `NW`, `nordic`, `nordic-walking` | `nordic walking` |
| `Z przeszkodami`, `ocr` | `ocr` |
| `Charytatywny` | `charytatywny` |
| `nocny` | `nocny` |
| `ultra` | `ultra` |
| `Na orientację` | `na orientację` |
| `bieg`, `Inny` | dropped (generic) |

```bash
cd backend && node --env-file=../.env scripts/run-normalize.js
```

Output: `V` = voivodeship fixed, `T` = event types normalized, `c` = raw event_type cleared.

### Step 5.5: Dedup scraper_all

Finds duplicate rows within `scraper_all` (same date + similar name / same city) and merges the lower-priority source into the higher-priority one. The loser row is deleted; its source_link is preserved on the winner. Empty fields on the winner get backfilled from the loser.

```bash
# Dry-run (default) — shows all matches, changes nothing
cd backend && node --env-file=../.env scripts/run-dedup.js

# Apply — merges winners, deletes losers
cd backend && node --env-file=../.env scripts/run-dedup.js --apply
```

Output: `M` = merged pair. Each line in dry-run shows Jaccard score, city match, winner/loser names and sources.

### Step 6: Publish to `calendar_events`

Pushes `scraper_all` rows into the public `calendar_events` table. No normalization needed — data is already clean from previous steps. No fuzzy dedup — rows are inserted as-is.

- Skips rows whose `source`+`source_id` (or any entry in `source_links`) already exists in `calendar_events`
- New rows get `status = 'pending'` — admin must approve them to appear on public kalendarz
- Duplicates that slip through are caught by the **Duplikaty** tab in the admin calendar view (`/calendar-events`)

```bash
cd backend && node --env-file=../.env scripts/run-publish.js
```

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

### `scraper_timekeeper`
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| name | text | NOT NULL |
| date | text | NOT NULL, `YYYY-MM-DD` |
| location | text | City from detail page |
| distances | text | Category names from pricing card (e.g., "Półmaraton, Bieg na 5 km") |
| registration_url | text | Detail page URL on timekeeper.pl |
| regulamin_url | text | PDF download link (`/download/{id}`) |
| website | text | Organizer website from sidebar |
| source_id | text | UNIQUE, URL slug |
| source_url | text | Per-event detail page URL |
| merged_at | timestamptz | Set by merge step |
| created_at | timestamptz | |

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

## Source 6: timekeeper.pl

**URL:** `https://competitions.timekeeper.pl/`
**Method:** HTTP fetch + Cheerio (listing) → fetch + Cheerio (detail pages)
**Encoding:** UTF-8
**Rate limit:** 1.1s between detail page fetches
**Events/year:** 50-150

### What it scrapes

**Phase 1 — Listing page (single page, all events):**
Parses `section.container > div.row.py-4.border-bottom` blocks:
- Name: `<a>` inside desktop div (`d-none d-md-block`)
- Location: `div.text-danger` with `font-size: 20px`
- Date fallback: day number from `<h2>` + Polish month from `div.miesiac`
- "Więcej informacji" button href determines internal vs external

**External events (href starts with `http`) are skipped entirely** — they link to raceresult.com or other platforms and have no timekeeper detail page.

**Phase 2 — Detail pages (internal events only):**
Fetches `/<slug>` for each internal event:
- Date: `YYYY-MM-DD` from `p.text-primary.h3` under "Data zawodów" heading
- Location: city name from under "Lokalizacja" heading
- Distances: category names from `h6.font-weight-bolder.m-0` inside "Koszt uczestnictwa" pricing card
- Regulamin: PDF download link from `a.btn.btn-success[href*="/download/"]`
- Organizer website: link inside "Organizator zawodów" card
- "Lista zawodników" section is ignored

### Raw output fields
```
{ name, date, location,
  distances (comma-joined category names from pricing card),
  registration_url (detail page URL on timekeeper.pl),
  regulamin_url (PDF download link),
  website (organizer URL),
  source: 'timekeeper', source_url (detail page), source_id (URL slug) }
```

### Data quality assessment
- **Good structured dates** — detail pages use `YYYY-MM-DD` format
- **HAS regulamin PDFs** — downloadable from `/download/{id}`
- **HAS organizer websites** — from sidebar card
- **HAS registration URLs** — the detail page itself is the registration page
- **Distances are category names** — e.g., "Półmaraton" (normalizer handles conversion to km)
- **No coordinates** — geocoder fills these in

### Known issues
- External events are skipped (no detail page on timekeeper.pl)
- Distance values are raw category names, not structured km — depends on enrich-flags pipeline
- `source_id` is the URL slug (e.g., `19-polmaraton-rzeszowski`) — stable but verbose

### Flow diagram
```
┌──────────────────────────────┐
│  Fetch listing page          │
│  Parse section.container     │
│  rows with border-bottom     │
│  Extract: name, slug, loc    │
│  Date fallback from h2+month │
│  Skip external events        │
└──────────┬───────────────────┘
           │
           ▼
┌──────────────────────────────┐
│  For each internal event:    │
│  Fetch /<slug>               │
│  Extract: date (YYYY-MM-DD) │
│  Location from heading       │
│  Distances from pricing card │
│  Regulamin PDF download link │
│  Organizer website           │
│  (skip Lista zawodników)     │
└──────────┬───────────────────┘
           │
           ▼
┌──────────────────────────────┐
│  Return array of raw events  │
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
6. timekeeper
7. supersport
8. zmierzymyczas
9. b4sport

Each scraper writes raw data into its own Supabase table (upsert by `source_id`):

| Scraper | Table | Unique key |
|---------|-------|------------|
| maratonypolskie | `scraper_maratonypolskie` | `source_id` |
| datasport | `scraper_datasport` | `source_id` |
| elektronicznezapisy | `scraper_elektronicznezapisy` | `source_id` |
| biegiwpolsce | `scraper_biegiwpolsce` | `source_id` |
| dostartu | `scraper_dostartu` | `source_id` |
| timekeeper | `scraper_timekeeper` | `source_id` |
| supersport | `scraper_supersport` | `source_id` |
| zmierzymyczas | `scraper_zmierzymyczas` | `source_id` |
| b4sport | `scraper_b4sport` | `source_id` |

**All steps are manual** — run each script in order. No automatic chaining.

### Full pipeline flow
```
Step 1: Scrape raw data
┌─────────────────────────────────────────────────┐
│  For each source (sequential):                   │
│  ┌─────────┐    ┌────────────────────────────┐  │
│  │ Scrape  │───►│  Upsert into source table  │  │
│  │ (raw)   │    │  (scraper_<name>)          │  │
│  └─────────┘    └────────────────────────────┘  │
└─────────────────────────────────────────────────┘
           │
           ▼
Step 2: Merge (cross-source dedup by priority)
┌─────────────────────────────────────────────────┐
│  scraper_* tables ───► scraper_all              │
└─────────────────────────────────────────────────┘
           │
           ▼
Steps 3-4.5: Enrich scraper_all (keyword + normalize)
┌──────────────────┐  ┌──────────────────┐
│  Geocode         │  │  Enrich flags    │
│  (voivodeship,   │  │  (charity, kids) │
│   lat/lng)       │  │                  │
└──────────────────┘  └──────────────────┘
┌──────────────────┐
│  Normalize       │
│  (voivodeships,  │
│   event types)   │
└──────────────────┘
           │
           ▼
Step 5: PRIMARY enrichment (Python enricher)
┌──────────────────────────────────────────┐
│  Ollama (gemma3:27b)              │
│  + SearXNG search                        │
│  + Crawl4AI (page crawling)              │
│  + Docling (PDF extraction)              │
│  ───────────────────────────────────────│
│  Fills: registration_url, regulamin_url, │
│  website, distances, event_types,        │
│  prices, deadline, voivodeship, is_kids  │
└──────────────────────────────────────────┘
           │
           ▼
Step 5.1: OPTIONAL fallback (Claude CLI)
┌──────────────────┐
│  Web search for  │
│  fields enricher │
│  missed          │
└──────────────────┘
           │
           ▼
Step 5.5: Dedup
┌──────────────────┐
│  Dedup           │
│  (cross-source   │
│   merge)         │
└──────────────────┘
           │
           ▼
Step 6: Publish to calendar_events
┌─────────────────────────────────────────────────┐
│  scraper_all ───► calendar_events (pending)     │
│  Skip existing source+source_id matches         │
│  No fuzzy dedup — Duplikaty view handles it     │
└─────────────────────────────────────────────────┘
           │
           ▼
Admin review in /calendar-events:
  • Do przeglądu — approve/reject pending events
  • Duplikaty — find and delete duplicate entries
```

---

## Source comparison matrix

| | maratonypolskie | b4sport | datasport | elektronicznezapisy | biegiwpolsce | dostartu |
|---|---|---|---|---|---|---|
| **Method** | Playwright | fetch+Cheerio | fetch+Cheerio | fetch+Cheerio | fetch+Cheerio | REST API |
| **Encoding** | UTF-8 (Playwright) | UTF-8 | Windows-1250 | UTF-8 | UTF-8 | JSON |
| **Detail pages** | No (listing only) | No (listing + AJAX pagination) | Yes (fetch) | Yes (fetch) | Yes (fetch) | Classifications API |
| **Volume** | 500+ | 100+ | 200+ | 300-500 | 1000+ | 250+ |
| **Has reg URL** | No | Yes | No | Yes | Yes (Zapisy btn) | Yes |
| **Has regulamin** | No | No | Yes (PDF) | Yes (download links) | Yes (red button) | Yes (statuteFilePl PDF or statuteLinkPl) |
| **Has location** | Yes (listing) | Yes (listing) | Yes (listing) | Yes (detail) | Yes (detail, structured) | Yes (API) |
| **Has coordinates** | No | No | No | Via dostartu enrichment | No | Yes (API) |
| **Has distances** | Single from listing | From multi-distance child list text | h4 headings | Cennik pricing + dostartu enrichment | Yes (from tag split) | Classifications API (km, time, meters, named) |
| **Distance quality** | Low | Low-Medium (only multi-distance cards) | **High** | **Medium-High** (High when enriched) | **Medium** (coarse: 5/10/21/42/ultra) | **Highest** |
| **Has event type** | No | No | No | No | Yes (pure types after split) | Yes (numeric codes) |
| **Has kids flag** | No | No | No | No | Yes ("Dla dzieci" tag) | Yes (playerType + keywords) |
| **Has end_date** | No | No | No | No | No | Yes |
| **Source ID stability** | Medium (code param) | High (numeric event ID) | High (zawody number) | High (event number) | Medium (URL slug) | High (API id) |
