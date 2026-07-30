# LeszyRun — Architecture Design

## Overview

Race timing system for managing start/finish tracking at running events.
Uses RFID readers (Impinj R700) connected via MQTT to detect when participants
cross the start/finish gate. Stores data locally in PostgreSQL and syncs to
Supabase when online.

---

## Use Case Breakdown

| Scenario | Frequency | Setup |
|---|---|---|
| Single reader, start = finish gate (out-and-back) | 95% | One R700, topic `leszyrun`. 1st crossing = start, 2nd = finish. |
| Single reader + checkpoint reader mid-course | 4% | Preferred: `checkpoint-agent/` on a Raspberry Pi + R700 at the checkpoint, uploading `checkpoint_observations` to Supabase live over LTE (see checkpoint-agent/README.md). Fallback: checkpoint operator exports CSV, main operator imports it with timestamps. |
| Separate readers for start and finish | 1% | Set different topic prefixes on each R700 web UI (`leszyrun/start`, `leszyrun/finish`). Configured per event in app. |

---

## System Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                         Browser (React)                         │
│  ┌──────────────┐  ┌───────────────┐  ┌──────────────────────┐ │
│  │ Event Manager│  │  Race Control │  │  Results / Podium    │ │
│  │ Participants │  │  Live Feed    │  │  (real-time, public) │ │
│  │ CSV Import   │  │  RFID Assign  │  │                      │ │
│  └──────────────┘  └───────────────┘  └──────────────────────┘ │
└───────────────────────────┬────────────────────────────────────┘
                    REST API + WebSocket
┌───────────────────────────▼────────────────────────────────────┐
│                    Node.js + Fastify                            │
│  ┌────────────┐  ┌─────────────────┐  ┌──────────────────────┐ │
│  │ REST API   │  │  MQTT Client    │  │  Supabase Sync Worker│ │
│  │            │  │  + Crossing     │  │  (background, runs   │ │
│  │            │  │    Detector     │  │   when online)       │ │
│  └────────────┘  └─────────────────┘  └──────────────────────┘ │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                  WebSocket broadcaster                      │ │
│  └────────────────────────────────────────────────────────────┘ │
└───────────────────────────┬────────────────────────────────────┘
                            │ Drizzle ORM
         ┌──────────────────▼─────────────────────┐
         │        PostgreSQL 16 (Docker + volume)   │
         └──────────────────┬─────────────────────┘
                            │ sync when online
                   ┌────────▼────────┐
                   │    Supabase     │
                   │ (kojoxazlnxncrp │
                   │  xmnxiq)        │
                   └─────────────────┘

Mosquitto (native macOS) ←── Impinj R700(s)
        ↕ mqtt://localhost:1883
   Node.js backend (native macOS)
```

### Additional Apps

- **`public/`** — Public-facing app combining live results, volunteer bib entry, and participant self-service check-in. Reads/writes directly to Supabase (anon key + RLS). Runs on port 5173. Deployed to Vercel.
- **`packages/ui/`** — Shared UI component library (`@leszyrun/ui`). Contains `Podium`, `CheckpointTrackingTable`, `PositionBadge`, and `estimatePositions` algorithm. **All race result rendering (status badges, position estimation, podium, results tables) MUST use these shared components.** Never duplicate result display logic in `frontend/` or `public/` — if a component is missing from `@leszyrun/ui`, add it there first, then import it in both apps.
- **`volunteer/`** and **`liveresults/`** — Legacy apps, migrated into `public/`. Pending removal.
- **`checkpoint-agent/`** — Standalone Node/Fastify agent for a Raspberry Pi + Impinj R700 at a trail checkpoint. Confirms tag passes (peak-RSSI/gone-window), resolves EPC → bib from a PIN-guarded roster (`checkpoint-roster` edge function, bib+EPC only), queues observations on disk, and inserts them into Supabase `checkpoint_observations` — indistinguishable from volunteer entries downstream. See checkpoint-agent/README.md.

### Supabase Realtime (bidirectional sync)

The backend subscribes to Supabase Realtime for `participants` and `checkpoint_observations` tables. Changes from the volunteer app (Supabase → local) flow instantly. The sync worker handles local → Supabase. Recently-synced participant IDs are tracked to prevent echo loops.

**Key constraint:** Mosquitto AND the backend run natively on macOS (not in
Docker). Mosquitto must be reachable from the R700 — a physical device on the
LAN — and the backend must see the Mac's real network interfaces (Docker's VM
hides them, which made reader diagnostics like Host MQTT detection impossible).
The backend connects to Mosquitto via `localhost:1883` and to PostgreSQL (still
in Docker, port published) via `localhost:5432`. The compose `backend` service
remains behind `profiles: [docker]` solely for the scheduler's nightly pipeline,
which runs each step as a one-shot container.

---

## Tech Stack

| Layer | Technology | Reason |
|---|---|---|
| Frontend | React 19 + Vite | Fast dev, good ecosystem |
| UI components | shadcn/ui + Tailwind v4 | Flexible, no overhead |
| Table (inline edit) | TanStack Table v8 | Built for inline editing |
| Data fetching | TanStack Query | Cache + real-time invalidation |
| Backend | Node.js + Fastify | Fast, low overhead |
| ORM | Drizzle ORM | Type-safe, lightweight migrations |
| Database | PostgreSQL 16 (Docker) | Named volume = data survives `docker compose down` |
| Real-time | WebSockets (`ws` library) | Push RFID events to browser |
| MQTT client | `mqtt` npm package | Subscribe to R700 events |
| Cloud sync | `@supabase/supabase-js` | Background sync when online |
| PDF export | `pdf-lib` | Pure JS, no native deps |

---

## Database Schema

```sql
-- Events
events (
  id          uuid PK DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  description text,
  date        date,
  location    text,
  -- RFID configuration (with sane defaults)
  rfid_mode              text DEFAULT 'single'          -- 'single' | 'separate'
  rfid_topic_main        text DEFAULT 'leszyrun',       -- used when mode='single' or start topic for 'separate'
  rfid_topic_finish      text DEFAULT 'leszyrun/finish',-- only used when mode='separate'
  rssi_threshold         int  DEFAULT -5000,            -- cdbm, events weaker than this are ignored
  gone_window_seconds    int  DEFAULT 3,                -- silence window (s) to confirm a crossing
  fallback_seconds       int  DEFAULT 10,               -- force-confirm timeout (s) for finish crossings only
  created_at  timestamptz DEFAULT now(),
  synced_at   timestamptz
)

-- Categories per event
categories (
  id              uuid PK DEFAULT gen_random_uuid(),
  event_id        uuid FK → events.id,
  name            text NOT NULL,
  slug            text NOT NULL,  -- human-readable import ID, unique per event, e.g. 'bieg-5km'
  distance_meters int,
  created_at      timestamptz DEFAULT now(),
  synced_at       timestamptz,
  UNIQUE(event_id, slug)
)

-- Participants
participants (
  id          uuid PK DEFAULT gen_random_uuid(),
  event_id    uuid FK → events.id,
  category_id uuid FK → categories.id,
  first_name  text NOT NULL,
  last_name   text NOT NULL,
  email       text,
  gender      text,        -- 'M' | 'F' | 'X' | null
  birth_year  int,
  club        text,        -- shown on podium
  bib_number  int,         -- auto-assigned, editable
  rfid_epc    text UNIQUE, -- base64 EPC from reader events
  created_at  timestamptz DEFAULT now(),
  synced_at   timestamptz,
  UNIQUE(event_id, bib_number)
)

-- Race runs — one per category start
race_runs (
  id          uuid PK DEFAULT gen_random_uuid(),
  category_id uuid FK → categories.id,
  started_at  timestamptz,
  finished_at timestamptz,
  status      text DEFAULT 'pending',  -- 'pending' | 'active' | 'finished' | 'cancelled'
  created_at  timestamptz DEFAULT now(),
  synced_at   timestamptz
)

-- Raw RFID events received from MQTT
gate_events (
  id           uuid PK DEFAULT gen_random_uuid(),
  race_run_id  uuid FK → race_runs.id,  -- null if no active race at time of event
  topic        text NOT NULL,            -- MQTT topic the event arrived on
  epc          text NOT NULL,            -- base64 EPC
  antenna_port int NOT NULL,
  rssi_cdbm    int NOT NULL,
  frequency    int,
  raw          jsonb NOT NULL,           -- full original payload
  received_at  timestamptz NOT NULL,
  crossing_id  uuid                      -- FK → gate_crossings.id, set when attributed
)

-- Confirmed gate crossings (output of the crossing detector algorithm)
gate_crossings (
  id              uuid PK DEFAULT gen_random_uuid(),
  race_run_id     uuid FK → race_runs.id,
  participant_id  uuid FK → participants.id,
  gate            text NOT NULL,     -- 'start' | 'finish' (derived from topic or crossing count)
  crossing_number int NOT NULL,      -- 1 = first crossing, 2 = second, etc.
  confirmed_at    timestamptz NOT NULL,
  peak_rssi_cdbm  int,
  antenna_port    int,
  synced_at       timestamptz
)

-- Race results (computed from crossings, updated in real-time)
results (
  id                  uuid PK DEFAULT gen_random_uuid(),
  race_run_id         uuid FK → race_runs.id,
  participant_id      uuid FK → participants.id,
  start_time          timestamptz,
  finish_time         timestamptz,
  duration_ms         bigint,            -- finish_time - start_time in ms
  start_crossing_id   uuid FK → gate_crossings.id,
  finish_crossing_id  uuid FK → gate_crossings.id,
  position            int,               -- recalculated whenever a new finish is recorded
  status              text DEFAULT 'registered',
                      -- 'registered' | 'checked_in' | 'started' | 'finished'
                      -- | 'dnf' | 'dns' | 'dsq'
  status_note         text,              -- required for 'dsq', optional for others
  manual_override     bool DEFAULT false,-- true if time was set manually (RFID failure)
  synced_at           timestamptz,
  UNIQUE(race_run_id, participant_id)
)

-- Checkpoint imports (from external operators)
checkpoint_imports (
  id           uuid PK DEFAULT gen_random_uuid(),
  race_run_id  uuid FK → race_runs.id,
  label        text NOT NULL,   -- e.g. '10km checkpoint'
  imported_at  timestamptz DEFAULT now(),
  file_name    text
)

checkpoint_readings (
  id             uuid PK DEFAULT gen_random_uuid(),
  import_id      uuid FK → checkpoint_imports.id,
  epc            text NOT NULL,
  participant_id uuid FK → participants.id,  -- resolved on import, null if unknown EPC
  recorded_at    timestamptz NOT NULL,
  rssi_cdbm      int
)

-- Volunteer checkpoints (live observation points along the course)
checkpoints (
  id         uuid PK DEFAULT gen_random_uuid(),
  event_id   uuid FK → events.id ON DELETE CASCADE,
  name       text NOT NULL,
  km_marker  int,
  created_at timestamptz DEFAULT now(),
  synced_at  timestamptz
)

checkpoint_categories (
  checkpoint_id uuid FK → checkpoints.id ON DELETE CASCADE,
  category_id   uuid FK → categories.id ON DELETE CASCADE,
  PRIMARY KEY (checkpoint_id, category_id)
)

-- Observations submitted by volunteers via the volunteer app or by RFID
-- checkpoint agents (checkpoint-agent/ on a Raspberry Pi)
checkpoint_observations (
  id              uuid PK DEFAULT gen_random_uuid(),
  checkpoint_id   uuid FK → checkpoints.id ON DELETE CASCADE,
  bib_number      int NOT NULL,
  participant_id  uuid FK → participants.id ON DELETE SET NULL,
  observed_at     timestamptz NOT NULL,
  synced_at       timestamptz,
  UNIQUE(checkpoint_id, bib_number)
)
```

---

## RFID Crossing Detection Algorithm

### Input
MQTT messages on topic `leszyrun` (or `leszyrun/#`). Each message contains:
```json
{
  "timestamp": "2026-02-26T17:13:37.432087177Z",
  "eventType": "tagInventory",
  "tagInventoryEvent": {
    "epc": "ikUCJA==",
    "antennaPort": 3,
    "peakRssiCdbm": -7400,
    "frequency": 866900,
    "transmitPowerCdbm": 3150
  }
}
```

### Multi-antenna deduplication
Within a 200 ms window, if the same EPC is seen on multiple antenna ports,
keep only the reading with the highest (least negative) `peakRssiCdbm`.

### Exit-triggered algorithm (per EPC, per active race run)
Runs in-memory in the backend. State is reset between race runs.

A crossing is confirmed when a tag's signal **disappears for `gone_window_seconds`** (default 3 s).
The confirmed timestamp is always the **peak RSSI reading** — the moment the runner was physically
closest to the antenna.

```
First reading for EPC
  → create inRange entry: { peakRssi, peakTime, goneTimer, maxTimer }
  → arm goneTimer (gone_window_seconds, default 3 s)
  → arm maxTimer (fallback_seconds, default 10 s) — FINISH CROSSINGS ONLY

Subsequent reading for same EPC
  → if rssi > peakRssi: update peakRssi and peakTime
  → reset goneTimer (person still nearby)
  → maxTimer keeps running (never reset)

goneTimer fires (silence for gone_window_seconds)
  → person has left the gate → CROSSING CONFIRMED at peakTime

maxTimer fires (fallback_seconds elapsed, finish only)
  → person still at gate (e.g. collapsed at finish line) → CROSSING CONFIRMED at peakTime

CROSSING CONFIRMED
  → write gate_crossing record to DB
  → update result record (start_time or finish_time)
  → recalculate positions for that race_run
  → broadcast via WebSocket to all connected clients
  → remove from inRange map
```

**Why exit-triggered (not decline-triggered):**
The departure signal from the start gate looks identical to the approach signal for the finish gate.
Confirming on signal drop caused immediate false finish recordings 3–4 s after the start crossing.
Exit-triggered confirmation requires the runner to physically leave the antenna's range — there
is no ambiguity between departure and return.

### Crossing → result mapping

**Mode: single reader (`rfid_mode = 'single'`)**
- Crossing #1 for a participant in a race_run → `start_time`, status = `started`
- Crossing #2 → `finish_time`, `duration_ms` = finish - start, status = `finished`, position recalculated

**Mode: separate readers (`rfid_mode = 'separate'`)**
- Event on `rfid_topic_main` (start topic) → `start_time`
- Event on `rfid_topic_finish` → `finish_time`

---

## RFID Assignment Dialog

When operator clicks "Assign RFID" for a participant:

1. Frontend opens dialog, sends `POST /rfid/scan-mode/start` to backend
2. Backend temporarily listens for all MQTT events (regardless of active race) and
   forwards them to the frontend via WebSocket channel `rfid:scan`
3. Frontend shows live list of recently seen EPCs sorted by RSSI (strongest first)
4. Tags seen within the last 5 seconds are highlighted
5. Operator holds tag near antenna → its EPC dominates the list
6. Operator clicks "Assign" → `PATCH /participants/:id` with `{ rfid_epc }`
7. Backend validates EPC not already assigned to another participant
8. Frontend sends `POST /rfid/scan-mode/stop`

```
┌─────────────────────────────────────────┐
│  Assign RFID — Jan Kowalski (#42)        │
│                                          │
│  Hold tag near antenna...               │
│  ████████░░░░  Scanning...              │
│                                          │
│  ┌──────────────────────────────────┐   │
│  │ ● ikUCJA==   -3200 cdbm  ████▌  │ ← │
│  │   AB12CD==   -6100 cdbm  ██▌     │   │
│  │   EF34GH==   -7800 cdbm  █▌      │   │
│  └──────────────────────────────────┘   │
│                                          │
│  [Assign "ikUCJA=="]    [Cancel]        │
└─────────────────────────────────────────┘
```

### RSSI display rule — live signal, not peak

**All RSSI signal-strength bars in the UI must show the most recent (live) reading,
not the all-time peak.** When a tag leaves antenna range, bars must decay to zero
after a short timeout (3–5 s of silence). This applies everywhere signal strength
is visualized: Reader Dashboard "Live" view, RFID Assign dialog, and any future
RSSI display.

Why: using `Math.max()` (peak) for bars made them stick at the highest value ever
seen and never drop — the operator had no way to tell if the tag was still in range.

Implementation:
- Store `lastRssi` (most recent reading) alongside `peakRssi` per tag/port.
- Use `lastRssi` for bar width and displayed dBm value.
- Track `lastSeenAt` timestamp; if stale (>timeout), set bar to 0 and dim the row.
- Use CSS `transition-all duration-500` so bars animate smoothly.

**Do not revert this to peak-based display without explicit confirmation from the user.**

---

## Participant Status Flow

```
registered
    │
    ▼ (checked in at race day stand)
checked_in
    │
    ▼ (first RFID crossing or manual)
started
    │
    ├──▶ finished  (second RFID crossing or manual)
    │
    └──▶ dnf       (manual — Did Not Finish)

registered/checked_in ──▶ dns   (manual — Did Not Start)

any status ──▶ dsq   (manual only, requires a note — Disqualified)
```

---

## Race Start / Stop Safety

### Starting
1. Click "Start [Category]" → confirmation modal opens
2. Modal shows: category name, total participants, checked-in count, not checked-in warning
3. 3-second countdown before "Confirm Start" button becomes clickable
4. Confirm → `race_run` created with `started_at = now()`, status = `active`
5. RFID crossing detector begins attributing events to this race_run

### Stopping
1. Click "Stop Race" → slide-to-confirm component (drag slider fully right)
2. Second prompt: "Mark remaining participants as DNF? Yes / No"
3. Confirm → `race_run.finished_at = now()`, status = `finished`

### Restarting
- Creates a new `race_run` for the same category
- Previous race_run archived (status = `cancelled` or `finished`)
- Previous results kept with `archived = true`

---

## CSV Import Formats

### Categories CSV
```csv
id,name,distance_meters
bieg-5km,Bieg 5km,5000
bieg-10km,Bieg 10km,10000
nordic-walking,Nordic Walking 5km,5000
```
- `id` = slug used as human-readable reference in participant CSV
- Import is idempotent: match by `(event_id, slug)`, update if exists

### Participants CSV
```csv
first_name,last_name,email,gender,birth_year,club,category_id
Jan,Kowalski,jan@example.com,M,1990,KS Biegacze,bieg-5km
Anna,Nowak,anna@example.com,F,1985,Klub NW Kraków,nordic-walking
```
- `category_id` references `id` column from categories CSV
- `bib_number` auto-assigned (next available per event), editable after in table
- `rfid_epc` not in import — assigned via RFID assign dialog
- Unknown `category_id` values → skipped with per-row error report shown to user
- Import is idempotent: match by `email` within event, update if exists

### Checkpoint Export CSV (external operator → import by main operator)
```csv
epc,recorded_at,rssi_cdbm
ikUCJA==,2026-02-26T10:43:22.000Z,-4200
AB12CD==,2026-02-26T10:44:01.000Z,-3900
```

---

## Frontend Routes

```
/                                 → redirect to /events
/events                           → event list + create event
/events/:id                       → event detail
  tabs:
    Overview                      → summary, quick stats
    Categories                    → manage categories, import CSV
    Participants                  → inline-edit table, RFID assign, import CSV, check-in
    RFID Settings                 → collapsed by default, reader mode, topic, thresholds
/events/:id/race                  → race control (start/stop per category, live crossing feed)
/events/:id/results               → all categories summary, export buttons
/events/:id/results/:categoryId   → category leaderboard + podium (real-time, public URL)
```

---

## Podium View

- 3 boxes layout: 2nd (left) | 1st (center, elevated) | 3rd (right)
- Each box shows: animal avatar emoji, participant name, club, bib number, finish time
- Animal avatars: 45-emoji pool, shuffled deterministically from participant UUID seed
- Podium guarantees 3 unique avatars (pick positions 1, 2, 3 from shuffled list)
- Updates every 3 seconds from DB during active race (positions change as people finish)
- This view has a public-safe URL — safe to display on a projector

Animal pool:
🐶🐱🐭🐹🐰🦊🐻🐼🐨🐯🦁🐮🐷🐸🐵🦄🐝🦋🐢🦎🦖🐙🦑🦐🦞🦀🐡🐠🐟🦈🐬🐳🦭🦜🦚🦩🦢🦔🐿️🦦🦥🦨🦡🐓🦃

---

## Supabase Sync

- Background worker in Node.js, polls every 30 seconds
- Checks connectivity: HTTP HEAD to Supabase URL
- On success: syncs all rows where `synced_at IS NULL` or `updated_at > synced_at`
- Tables synced: events, categories, participants, race_runs, gate_crossings, results
- Local PostgreSQL is always source of truth — sync is one-way (local → Supabase)
- No pull from Supabase
- UI shows sync status: "Synced 2 min ago — 0 pending" or "Offline — 142 pending"

Supabase project: `<your-supabase-project-id>`

### Reverse Sync: Check-in Data (Supabase → Local)

Check-in is the one exception to the "local → Supabase only" rule. All check-in writes
(admin, volunteer, participant self-service) go to Supabase first. A reverse sync worker
(`src/sync/checkinSync.js`) polls every 30s and pulls `checkins` and `checkin_documents`
rows into local PostgreSQL.

Flow:
1. Participant scans QR code → public app writes to Supabase `checkins` table
2. Reverse sync worker detects new rows → upserts into local `checkins` table
3. Backend queries local DB with `participants.checkin` relation for race seeding

`event_secrets` (check-in PINs) lives only in Supabase — never synced to local DB.

---

## Folder Structure

```
LeszyRun/
├── ARCHITECTURE.md          (this file)
├── CLAUDE.md                (development conventions)
├── README.md                (setup + hardware config)
├── docker-compose.yml
├── mosquitto/               (existing — native macOS, NOT in Docker)
│   ├── config/
│   ├── data/
│   └── log/
├── backend/
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       ├── server.js            entry point, Fastify init, plugin registration
│       ├── db/
│       │   ├── index.js         Drizzle client
│       │   ├── schema.js        all table definitions
│       │   └── migrations/      managed by Drizzle Kit (+ _journal.json)
│       ├── routes/
│       │   ├── events.js
│       │   ├── categories.js
│       │   ├── participants.js
│       │   ├── races.js
│       │   ├── results.js
│       │   ├── checkpoints.js
│       │   ├── eventDocuments.js
│       │   ├── eventSecrets.js
│       │   ├── sms.js
│       │   └── rfid.js
│       ├── mqtt/
│       │   ├── client.js        connects to Mosquitto, parses messages
│       │   └── crossingDetector.js  exit-triggered crossing algorithm
│       ├── ws/
│       │   └── broadcaster.js   WebSocket server, event broadcasting
│       ├── lib/
│       │   ├── emoji.js         emoji assignment for participants
│       │   └── smsapi.js        SMSAPI.pl client wrapper
│       └── sync/
│           ├── supabase.js      forward sync worker (local → Supabase)
│           └── checkinSync.js   reverse sync worker (Supabase → local for checkins)
├── frontend/                    admin UI
│   ├── Dockerfile
│   ├── package.json
│   ├── vite.config.js
│   └── src/
│       ├── main.jsx
│       ├── App.jsx              router setup
│       ├── lib/
│       │   ├── api.js           fetch wrappers (TanStack Query)
│       │   └── ws.js            WebSocket client hook
│       ├── pages/
│       │   ├── Events.jsx
│       │   ├── EventDetail.jsx
│       │   ├── RaceControl.jsx
│       │   └── Results.jsx
│       └── components/
│           ├── ParticipantsTable/
│           │   ├── ParticipantsTable.jsx
│           │   └── RfidAssignDialog.jsx
│           ├── Podium/
│           │   └── Podium.jsx
│           └── ImportWizard/
│               └── ImportWizard.jsx
├── public/                      public-facing app (live results, volunteer, self-service check-in)
│   ├── package.json
│   ├── vite.config.js
│   └── src/
│       ├── pages/               live results, volunteer bib entry, participant check-in
│       └── lib/                 Supabase client
└── packages/ui/                 shared UI component library (@leszyrun/ui)
    └── src/
        └── components/          Podium, CheckpointTrackingTable, PositionBadge
```
