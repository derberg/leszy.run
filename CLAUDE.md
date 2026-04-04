# LeszyRun — Development Guide for Claude

## Project summary

Race timing system. RFID readers detect participants crossing start/finish gates.
Events are published via MQTT. Backend processes them and stores results in local
PostgreSQL. Syncs to Supabase when online. See ARCHITECTURE.md for full design.

## Hardware documentation

- `docs/impinj-r700-api/endpoints.md` — known R700 REST API endpoints (system status, antennas, MQTT, inventory presets)
- `docs/impinj-r700-api/mqtt.md` — full `MqttConfiguration` schema with all field names, types, constraints, and common wrong-name mistakes
- `docs/impinj-r700-api/inventory-preset-fields.md` — inventory preset field reference: `transmitPowerCdbm` range, `inventorySession` values, `inventorySearchMode` options, `estimatedTagPopulation` sizing, `rfMode` IDs (note: R700 does NOT support mode 1000)

## Language and runtime

- **JavaScript only** — no TypeScript. Plain JS with JSDoc where helpful.
- Node.js backend (Fastify)
- React frontend (Vite)

## Stack decisions (do not change without discussion)

- ORM: **Drizzle** (not Prisma, not raw SQL)
- Backend framework: **Fastify** (not Express)
- Frontend build: **Vite** (not CRA, not Next.js)
- UI: **shadcn/ui** + **Tailwind v4**
- Tables: **TanStack Table v8** (inline editing)
- Server-side real-time: **WebSockets** via `ws` npm package (not Socket.io)
- Database: **PostgreSQL 16** in Docker with named volume `pgdata`
- MQTT client: `mqtt` npm package
- Supabase sync: `@supabase/supabase-js`
- PDF export: `pdf-lib`

## Monorepo structure

```
LeszyRun/
  backend/      Node.js + Fastify
  frontend/     React + Vite (admin UI)
  public/       React + Vite (public-facing: live results, volunteer bib entry, self-service check-in)
  packages/ui/  Shared UI components (@leszyrun/ui)
  mosquitto/    native macOS, NOT dockerized (hardware constraint)
```

**`packages/ui/` rule:** All race result rendering (status badges, position estimation, podium, results tables) MUST use shared components from `@leszyrun/ui`. Never duplicate result display logic in `frontend/` or `public/` — if a component is missing, add it to `packages/ui/` first, then import in both apps.

## Running locally

```bash
# Start Mosquitto (native, from project root)
/opt/homebrew/sbin/mosquitto -c mosquitto/config/mosquitto.conf

# Start everything else
docker compose up
```

Admin frontend: http://localhost:3000
Backend API: http://localhost:3001
PostgreSQL: localhost:5432

Public app (landing page + kalendarz) — run separately:
```bash
cd public && npx vite --port 3002
```
Public app: http://localhost:3002

## Environment variables

Backend (set in docker-compose.yml or .env):
- `DATABASE_URL` — postgres connection string
- `MQTT_URL` — mqtt://host.docker.internal:1883
- `PORT` — default 3001
- `SUPABASE_URL` — optional, sync disabled if missing
- `SUPABASE_SERVICE_ROLE_KEY` — service_role key (NOT anon/publishable), bypasses RLS. Backend only. Sync disabled if missing.

Frontend:
- `VITE_API_URL` — http://localhost:3001
- `VITE_WS_URL` — ws://localhost:3001

SMS (backend, optional — SMS disabled if missing):
- `SMSAPI_TOKEN` — API token for SMSAPI.pl
- `SMSAPI_SENDER` — sender name registered with SMSAPI

Scraper (backend, optional — URL resolver disabled if missing):
- `BRAVE_SEARCH_API_KEY` — API key from https://brave.com/search/api/ (1000 queries/month free tier)

## Backend conventions

- All routes in `src/routes/`, one file per resource
- Register routes in `src/server.js` with prefix (`/api/events`, `/api/participants`, etc.)
- Drizzle schema in `src/db/schema.js`, client in `src/db/index.js`
- Use Drizzle migrations (`drizzle-kit generate` + `drizzle-kit migrate`)
- **Migrations MUST be registered in `src/db/migrations/meta/_journal.json`** — Drizzle ignores SQL files not listed there. When writing a migration manually: create the `.sql` file AND add an entry to the journal (`idx`, `version: "7"`, `when`, `tag` matching filename without `.sql`, `breakpoints: true`). If a migration already ran (backend started and logged "Migrations complete"), do NOT modify the SQL file — create a new numbered file + new journal entry instead.
- **DDL changes MUST be applied to both local DB and Supabase.** Local DB uses Drizzle migrations (auto-run on backend start). Supabase must be updated separately via `mcp__supabase__apply_migration`. Every schema change (new table, alter column, add index, etc.) requires both — never apply to one without the other.
- WebSocket broadcaster in `src/ws/broadcaster.js` — export a `broadcast(event, data)` function
- MQTT client starts on server boot, crossing detector subscribes to it
- Supabase sync runs as a `setInterval` in background, does not block requests
- All IDs are UUIDs (`gen_random_uuid()` in Postgres, `crypto.randomUUID()` in JS)
- Timestamps as `timestamptz` in DB, ISO strings in API responses

## API conventions

- REST: `GET /api/:resource`, `POST /api/:resource`, `PATCH /api/:resource/:id`, `DELETE /api/:resource/:id`
- Always return `{ data }` wrapper for single items, `{ data: [] }` for lists
- Errors: `{ error: 'message' }` with appropriate HTTP status
- PATCH uses partial updates — only send changed fields
- Import endpoints: `POST /api/events/:id/import/categories`, `POST /api/events/:id/import/participants`
- Import returns: `{ imported: N, updated: N, skipped: N, errors: [{ row, message }] }`

## WebSocket events (backend → frontend)

All messages are JSON: `{ type, payload }`

| type | payload | when |
|---|---|---|
| `rfid:raw` | `{ epc, rssi, antennaPort, topic }` | every MQTT event (during scan mode or active race) |
| `rfid:crossing` | `{ participantId, gate, confirmedAt, raceRunId }` | confirmed gate crossing |
| `race:update` | `{ raceRunId, status }` | race started, stopped |
| `result:update` | `{ raceRunId, participantId, position, durationMs, status }` | new finish or position change |
| `sync:status` | `{ status, pendingCount, lastSyncedAt }` | sync worker status changes |

## Frontend conventions

- Use TanStack Query for all API calls (not raw fetch in components)
- Inline table editing: cell blur or Tab/Enter triggers `PATCH`, optimistic update, revert on error
- All forms use controlled inputs
- No page-level loading spinners — use skeleton placeholders
- shadcn/ui components only (no mixing other component libraries)
- File naming: PascalCase for components, camelCase for lib/utils

## RFID Crossing Detector

Lives in `src/mqtt/crossingDetector.js`. In-memory state only.

**Exit-triggered algorithm** — a crossing is confirmed when a tag's signal disappears for
`gone_window_seconds` (default 3 s). The confirmed timestamp is always the **peak** reading —
when the runner was physically closest to the antenna.

Works for mass starts: runners standing in the corral generate continuous readings, goneTimer
keeps resetting → no confirmation until they actually run through.

State maps:
- `inRange`: `Map<"${epc}:${raceRunId}", { peakRssi, peakTime, antennaPort, topic, goneTimer, maxTimer }>`
- `recentWindow`: dedup within 200 ms per EPC
- `startedParticipants`: `Set<participantId>` per race (in-memory, avoids DB lookup per crossing)

Flow per reading:
1. Tag not in `inRange` → create entry, arm `goneTimer` (goneWindowMs); arm `maxTimer` (fallbackMs) **only if already started** (finish crossings only)
2. Tag in `inRange`, RSSI improved → update peak; reset `goneTimer`; `maxTimer` keeps running
3. Tag in `inRange`, RSSI not improved → reset `goneTimer` only
4. `goneTimer` fires (silence for goneWindowSeconds) → `confirmCrossing(peakTime)`
5. `maxTimer` fires (fallbackSeconds elapsed, finish only) → `confirmCrossing(peakTime)`
6. 1st confirmed crossing → `gate = start`, add to `startedParticipants`
7. 2nd confirmed crossing → `gate = finish`, add to `finishedParticipants`, calc `durationMs`

See the mermaid flowchart at the top of `crossingDetector.js` for a full diagram.

Configurable per event (stored in `events` table):
- `gone_window_seconds`: default `3` s — silence window to confirm a crossing
- `fallback_seconds`: default `10` s — force-confirm timeout for **finish crossings only**
- `rfid_mode`: `'single'` (default) or `'separate'`
- `rfid_topic_main`: default `'leszyrun'`
- `rfid_topic_finish`: default `'leszyrun/finish'` (only used when `rfid_mode = 'separate'`)

## Calendar event status values (Supabase `calendar_events` table)

`pending` → `active` (admin approves via "Do przeglądu" tab)
`pending` → `rejected` (admin rejects — hidden forever, prevents scraper re-adding)

- Scraped events default to `pending` (Supabase column default)
- Manual events created via admin UI are set to `active` immediately
- Public kalendarz only shows `active` events
- Admin "Do przeglądu" tab shows `pending` events with OK/NIE/X actions
- Dedup finds rejected events by `source + source_id` but skips updating them
- URL resolver and LLM enricher process both `active` and `pending` events

## Participant status values

`registered` → `checked_in` → `started` → `finished`
                                         → `dnf`    (manual)
`registered` / `checked_in`             → `dns`    (manual)
any                                      → `dsq`   (manual, requires `status_note`)

## Race run lifecycle

- `pending` → `active` (on start) → `finished` or `cancelled`
- Multiple race_runs can exist per category (restarts create a new one)
- Previous runs are not deleted, just have status `cancelled`

## Supabase project

Project ID: `<your-supabase-project-id>`
Sync is primarily one-way: local PostgreSQL → Supabase.
Sync is disabled when `SUPABASE_URL` env var is missing.

**Reverse sync exception:** `checkins` and `checkin_documents` tables flow Supabase → local.
The public self-service check-in page and volunteer app write directly to Supabase.
A reverse sync worker (`src/sync/checkinSync.js`) polls Supabase every 30s and pulls
new/updated checkin rows into local PostgreSQL. Admin check-in from the backend also
writes to Supabase first (not local), so all check-in data has a single source of truth in Supabase.

**Supabase-only tables** (no Drizzle schema, no local migration — apply via `mcp__supabase__apply_migration` only):
- `event_secrets` — per-event check-in PINs
- `calendar_events` — aggregated race calendar from scrapers + manual entry
- `geocode_cache` — Nominatim geocoding results cache
- `url_suggestions` — Brave Search URL candidates pending admin review

## Supabase sync — how it works

The sync worker (`src/sync/supabase.js`) runs every 30s and pushes all local rows
where `synced_at IS NULL`. After a successful upsert it sets `synced_at = now()` locally.

**A Postgres trigger (`0010_sync_trigger` migration) automatically resets `synced_at = NULL`
whenever a row is updated with real data changes.** This means any UPDATE to an already-synced
row (crossing detector setting `start_time`, API updating `category_id`, etc.) will be
re-synced automatically on the next cycle.

How the trigger decides what counts as a "real" change vs. the sync worker marking a row:
- Sync worker does `SET synced_at = now()` → `OLD.synced_at ≠ NEW.synced_at` → trigger passes through
- Any other UPDATE → `synced_at` unchanged → trigger sets it to `NULL` → sync picks it up

**Rules when adding new tables or mutation paths:**
- Every new table that syncs to Supabase needs a `trg_reset_synced_at_<table>` trigger added to the migration
- You do NOT need to manually reset `syncedAt` in route handlers — the trigger handles it
- If you bypass Drizzle and write raw SQL updates, the trigger still fires automatically
- `gate_crossings` and `checkpoint_observations` are insert-only — no trigger needed there

## SMS check-in API endpoints

- `POST /api/events/:eventId/sms/checkin` — send check-in SMS to specific participants (`{ participantIds }`)
- `POST /api/events/:eventId/sms/checkin-all` — send check-in SMS to all participants with phone numbers who haven't been sent one yet
- `POST /api/participants/:id/checkin` — admin check-in (writes to Supabase, reverse sync pulls to local)
- `GET /api/events/:eventId/documents` — list event documents (acknowledgements, required docs)
- `POST /api/events/:eventId/documents` — create event document
- `PATCH /api/documents/:id` — update event document
- `DELETE /api/documents/:id` — delete event document
- `GET /api/events/:eventId/secrets/checkin-pin` — get check-in PIN from Supabase
- `POST /api/events/:eventId/secrets/checkin-pin` — generate new check-in PIN
- `POST /api/events/:eventId/sync/checkins` — trigger immediate checkin reverse sync

## Public app — Landing page & Kalendarz

The `public/` app serves two purposes:
1. **Landing page** (`/`) — leszy.run marketing site for organizers and runners
2. **Kalendarz** (`/kalendarz`) — aggregated calendar of all running/NW events in Poland
3. **Event pages** (`/events/:slug/*`) — live results, check-in, volunteer views

The landing page and kalendarz read directly from Supabase (`calendar_events` table for kalendarz, `events` table for upcoming leszy.run events). No backend API needed for these pages.

### Logo
- `public/public/logo-bez-napisu.svg` — Leszy character without text. Two green leaves (top-left, top-right), black body/roots.
- `public/public/logo.svg` — full logo with text (used as watermark in `app.css`)

## Event scraper pipeline

Scrapes Polish running event websites and aggregates into the `calendar_events` Supabase table.

### Data sources (4 scrapers)

| Source | URL | Events/year | Cheerio? |
|--------|-----|-------------|----------|
| maratonypolskie.pl | `mp_index.php?dzial=3&action=1&grp=13...` | 500+ | Yes (HTML tables) |
| datasport.pl | `liveds.datasport.pl/lista.html` | 200+ | Yes (`.event-list-box`) |
| elektronicznezapisy.pl | `/1/bieg.html`, `/2/nordic-walking.html` | 300-500 | Yes (HTML tables) |
| biegiwpolsce.pl | `/?page=N` | 1000+ | Yes (paginated, `h2`/`h3`) |

### Running scrapers

```bash
# Trigger manually (backend must be running)
curl -X POST http://localhost:3001/api/scrapers/run

# Response: { data: { sources: [...stats per source], urlResolver: { processed, suggestions } } }
```

The pipeline runs automatically **daily at 03:00** via `node-cron` when the backend is up.

### Pipeline flow
1. **Scrape** — each source scraper fetches and parses HTML with cheerio
2. **Normalize** — parse dates (ISO/EU/Polish months), extract distances, classify event type (trail/nocny/ocr/nordic/charytatywny/uliczny) from keywords
3. **Dedup** — match by `source + source_id` (exact), then cross-source by name similarity (Levenshtein > 0.8) + same date
4. **Upsert** — insert new events or merge metadata into existing ones in Supabase
5. **URL resolve** — events with no `registration_url` get searched via Brave Search API, top 3 candidates saved to `url_suggestions` for admin review

### Scraper file structure
```
backend/src/scrapers/
  index.js              -- orchestrator (runPipeline)
  sources/
    maratonypolskie.js
    datasport.js
    elektronicznezapisy.js
    biegiwpolsce.js
  normalizer.js         -- date/distance/type parsing
  dedup.js              -- Levenshtein cross-source matching
  geocoder.js           -- Nominatim + geocode_cache
  urlResolver.js        -- Brave Search for missing URLs
```

### Admin tools for calendar management

- **URL review** — `http://localhost:3000/url-review` — approve/reject URL suggestions from Brave Search
- **Manual event entry** — `http://localhost:3000/calendar-events/new` — add events found on Facebook or elsewhere
- **Calendar events API** — `GET/POST/PATCH/DELETE /api/calendar-events`

### Adding a new scraper source

1. Create `backend/src/scrapers/sources/<name>.js` exporting `async function scrape()` that returns array of `{ name, date, location, distances, registration_url, source, source_url, source_id }`
2. Add import + entry to `sources` array in `backend/src/scrapers/index.js`
3. The normalizer, dedup, and geocoder handle the rest automatically

### Sites investigated but not scraped (for reference)

- **dostartu.pl** — JavaScript SPA, requires Puppeteer (not cheerio-compatible)
- **kalendarzbiegowy.pl** — JS-heavy, likely needs headless browser
- **go.decathlon.pl** — React SPA, only ~27 events total across all sports, not worth it
- **bieganie.pl** — not a calendar, uses kalendarzbiegowy.pl widget
- **biegamy.pl** — training content, not an event calendar
- **enduhub.com** — results database, not a forward-looking calendar
- **parkrun.pl** — recurring weekly events at 106 fixed locations, not race events

### Potential future scraper targets

- **extremalny.pl** — OCR/obstacle races (50-100 events)
- **przeszkodowo.pl** — OCR/obstacle races
- **biegigorskie.pl** — mountain/trail only, yearly HTML tables (easy)
- **zawodybiegowe.pl** — all types (200-500 events)
- **ligabiegowa.pl** — road running league

## Local LLM Enricher

Python-based enrichment pipeline in `enricher/`. Validates URLs, searches SearXNG, crawls pages with Crawl4AI, extracts PDFs with Docling, and uses Ollama (qwen2.5:72b) for field extraction. Replaces the paid Claude API enrichment scripts.

### Running

```bash
cd enricher
source .venv/bin/activate
docker compose up -d          # SearXNG
python -m enricher run         # process all un-enriched
python -m enricher run --limit 5 --dry-run  # test run
python -m enricher run --resume             # continue interrupted run
python -m enricher run --force              # re-process already-enriched events
```

### What it enriches (scraper_all fields)
distances, event_types, registration_url, regulamin_url, website, registration_deadline, price_from, price_to, voivodeship, is_kids

### Enrichment tracking
- `enriched_at` column on scraper_all — set after processing, prevents re-runs
- JSONL logs in `enricher/logs/` — one file per run, supports `--resume`

### Dependencies
- Ollama (native macOS, `qwen2.5-coder:32b` — 72b times out due to partial CPU offload)
- SearXNG (Docker via `enricher/docker-compose.yml`, port 8888)
- Crawl4AI + Docling (Python libs in `enricher/.venv/`)

### Smart behaviors
- Validates existing URLs (HEAD check), replaces dead ones via SearXNG search
- LLM confirms URL type (is this regulamin really a regulamin?) and fixes mismatches
- Distances: overwrites only if LLM found MORE entries (count comparison)
- Event types: additive merge, no conflicting terrain types (trail vs uliczny)
- Scalars (price, deadline): always overwrite from LLM (reads actual source material)

## Data that persists across docker compose down

Named volume `pgdata` in docker-compose.yml. Never use anonymous volumes.
`docker compose down` is safe. `docker compose down -v` DELETES ALL DATA — warn user.

## UI Design Theme — "OVERDRIVE"

Dark, tactical theme for trail running timing. Acid yellow on near-black.

### Palette
- Background: `#0A0A10` (near-black)
- Surface: `#0C0C14` / `#12121E` / `#1A1A28`
- Borders: `#1C1C2A` / `#262638` / `#343450`
- Primary accent: `#BBDD00` (acid yellow), bright: `#D4FF00`, dim: `#778800`
- Text: `#B0AEC6` (body), `#DDDCEC` (bright/headings), `#8886A0` (muted)
- Red: `#EF4444`, Cyan: `#00BFEF`
- Forest green (logo leaves): `#2D5A27`

### Typography
- Headers: **Barlow Condensed** ExtraBold (font-display)
- Body: **Rajdhani** 500 (font-sans)
- Numbers/data: **IBM Plex Mono** (font-mono)

### Component rules
- Buttons: `rounded-none` — sharp edges, no pill shapes. Border-style (border+text, fills on hover)
- Badges: rectangular, thin border, color-coded per event type
- Cards: flat, thin border (`border-apex-border`), no shadow, yellow left-edge stripe on hover
- Inputs: `rounded-none`, `border-apex-border`, focus ring in yellow-dim
- Status colors: green=finished, cyan=active, yellow=dns/dnf, red=dsq

### Tailwind v4
Custom tokens defined via `@theme` directive in `app.css`. All use `apex-*` prefix (e.g., `bg-apex-surface`, `text-apex-yellow`).

### WCAG AA contrast
All color combos verified. Key ratios: text-bright on bg = 14.95:1, yellow on bg = 12.96:1, muted on bg = 5.75:1.

### Fonts (import in index.html)
```html
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;800&family=Rajdhani:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet">
```

## RFID Audit Queries

DB credentials: container `leszyrun-db-1`, user `leszyrun`, db `leszyrun`.

**Investigation flow:** start with query 5 to get EPC → query 1 to check R700 saw the tag → if rows exist, use query 2 to check antenna coverage.

**1. Did the R700 see this EPC at all?**
```bash
docker exec -it leszyrun-db-1 psql -U leszyrun -d leszyrun \
  -c "SELECT received_at, antenna_port, rssi_cdbm, topic FROM gate_events WHERE epc = '<EPC>' ORDER BY received_at;"
```
Zero rows = hardware/RF issue. Rows present = detector logic issue.

**2. What did each antenna see for a participant?**
```bash
docker exec -it leszyrun-db-1 psql -U leszyrun -d leszyrun \
  -c "SELECT antenna_port, COUNT(*) as pings, MIN(rssi_cdbm) as worst_rssi, MAX(rssi_cdbm) as best_rssi FROM gate_events WHERE epc = '<EPC>' GROUP BY antenna_port ORDER BY antenna_port;"
```

**3. All pings for a race — full timeline**
```bash
docker exec -it leszyrun-db-1 psql -U leszyrun -d leszyrun \
  -c "SELECT ge.received_at, ge.epc, ge.antenna_port, ge.rssi_cdbm, p.first_name, p.last_name FROM gate_events ge LEFT JOIN participants p ON p.rfid_epc = ge.epc WHERE ge.race_run_id = '<RACE_RUN_ID>' ORDER BY ge.received_at;"
```

**4. Participants with no finish crossing**
```bash
docker exec -it leszyrun-db-1 psql -U leszyrun -d leszyrun \
  -c "SELECT p.first_name, p.last_name, p.rfid_epc, r.status, r.start_time, r.finish_time FROM results r JOIN participants p ON p.id = r.participant_id WHERE r.race_run_id = '<RACE_RUN_ID>' AND r.finish_time IS NULL ORDER BY r.start_time;"
```

**5. Find EPC by participant name**
```bash
docker exec -it leszyrun-db-1 psql -U leszyrun -d leszyrun \
  -c "SELECT first_name, last_name, rfid_epc FROM participants WHERE last_name ILIKE '%<NAME>%';"
```

**6. Find race_run_id for a recent race**
```bash
docker exec -it leszyrun-db-1 psql -U leszyrun -d leszyrun \
  -c "SELECT rr.id, rr.started_at, rr.status, c.name as category FROM race_runs rr JOIN categories c ON c.id = rr.category_id ORDER BY rr.created_at DESC LIMIT 10;"
```

**7. Ping density per minute — spot RF blackout windows**
```bash
docker exec -it leszyrun-db-1 psql -U leszyrun -d leszyrun \
  -c "SELECT date_trunc('minute', received_at) as minute, COUNT(*) as pings FROM gate_events WHERE race_run_id = '<RACE_RUN_ID>' GROUP BY 1 ORDER BY 1;"
```

## Things to never do

- Do not use TypeScript (this is a JS project)
- Do not use Express (use Fastify)
- Do not use Prisma (use Drizzle)
- Do not use Socket.io (use `ws`)
- Do not use Next.js (use Vite)
- Do not dockerize Mosquitto (hardware constraint — R700 needs LAN access)
- Do not use `docker compose down -v` unless explicitly asked
- Do not pull data from Supabase into local DB (exception: `checkins` and `checkin_documents` via reverse sync)
- Do not add TypeScript type annotations or `.ts` files
- Do not use peak RSSI for signal-strength bars — always use live (most recent) reading with decay. See ARCHITECTURE.md → "RSSI display rule — live signal, not peak"
- Do not create local copies of `estimatePositions()` — always import from `@leszyrun/ui` (shared package in `packages/ui/src/lib/positionEstimation.js`). A stale local copy caused a live-race bug where podium ordering ignored checkpoint timestamps. If you think the shared function needs changes, stop and ask the user first — the sorting tiers (finish time → checkpoint index → observation time → start time) are load-bearing for live race display.
- Do not re-run `estimatePositions()` inside `CategoryCard` when `resultsProp` is provided — the caller already enriched results with checkpoint observations. Re-estimating with empty observations discards checkpoint data and breaks podium ordering during live races. See the comment in `frontend/src/pages/PodiumPage.jsx`.
- Do not filter race runs to only `'active'` status in podium or public result views — always include `'finished'` too. Filtering only active causes the podium/results to go blank the moment a race is stopped. The podium and public views must keep showing final results after the race ends.
- Do not add `Co-Authored-By:` trailers to git commits. Never include Claude authorship in commit messages.
- Do not permanently delete calendar events without asking the user for confirmation first. Prefer rejecting (setting status to `rejected`) over deleting — rejected events prevent the scraper from re-adding the same junk.
- Do not DELETE rows from any Supabase table unless the user explicitly says "delete from [table name]". When asked to "remove" an event, ask which table(s) — never assume. Scraper source tables (`scraper_*`) are raw data and should almost never be touched directly.

