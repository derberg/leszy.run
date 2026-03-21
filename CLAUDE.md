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

Frontend: http://localhost:3000
Backend API: http://localhost:3001
PostgreSQL: localhost:5432

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

**Supabase-only table:** `event_secrets` stores per-event check-in PINs. It lives only in
Supabase (not in local DB or Drizzle schema) and is accessed via the Supabase client directly.

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

## Data that persists across docker compose down

Named volume `pgdata` in docker-compose.yml. Never use anonymous volumes.
`docker compose down` is safe. `docker compose down -v` DELETES ALL DATA — warn user.

## UI Design Theme — "Rugged Terrain"

Designed for trail running, OCR, ultramarathons. Feels gritty and functional.

### Palette
- Primary: Forest Green `#2D5A27`
- Dark surface: Slate `#1E293B`
- Neutral: Concrete Gray `#78716C`
- Danger/Accent: Deep Burgundy `#7F1D1D`
- Background: Warm off-white `#F5F3F0` with subtle grain texture
- Surfaces (cards): `#FFFFFF` with `#E7E5E4` borders

### Typography
- Headers (h1–h4): **Bebas Neue** (Google Fonts), letter-spacing wide
- Body: **Inter** (400/500/600)

### Component rules
- Buttons: `rounded-none` — sharp angular edges, no pill shapes
- Badges: rectangular, thick border, look like physical bib number patches
- Cards: flat, thin border (`border border-stone-200`), no shadow by default
- Inputs: `rounded-none`, `border-stone-300`, focus ring in forest green
- Status colors: green=finished, blue=active/started, yellow=dns/dnf, red=dsq

### Grain texture
Apply via CSS pseudo-element on `body::before` — SVG noise, opacity 3–4%, pointer-events none.

### Import in index.html
```html
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Inter:ital,opsz,wght@0,14..32,400..700;1,14..32,400..700&display=swap" rel="stylesheet">
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

