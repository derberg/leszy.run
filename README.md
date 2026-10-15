tl;dr — start everything with ONE command:

```bash
./scripts/dev.sh            # mosquitto + docker (db/scheduler/searxng) + backend + frontend — Ctrl+C stops all
```

```bash
./scripts/dev.sh --public   # same, plus the public app on :3002
```

Reader sanity check (before a race): `https://169.254.1.1/ui` reachable, Host MQTT matches `ifconfig en8 | grep "inet "`.

Need to (re)start just one piece? Each dependency has its own copy-paste block:

```bash
# Mosquitto (MQTT broker — native, from project root)
/opt/homebrew/sbin/mosquitto -c mosquitto/config/mosquitto.conf
```

```bash
# Docker services: PostgreSQL + scheduler + SearXNG
docker compose up -d
```

```bash
# Backend API (native, http://localhost:3001)
cd backend && npm run dev
```

```bash
# Admin frontend (native, http://localhost:3000)
cd frontend && npm run dev
```

```bash
# Public app — optional (http://localhost:3002)
cd public && npx vite --port 3002
```

# LeszyRun

RFID-based race timing system for running events. Impinj R700 readers detect participants crossing start/finish gates via MQTT. Results update in real-time with a public podium view.

```
Impinj R700(s) ──MQTT──▶ Mosquitto (native macOS)
                                  │
                            localhost:1883
                                  │
                         ┌────────▼────────┐
                         │  Node.js/Fastify │
                         │  + Crossing      │  (native macOS)
                         │    Detector      │
                         └────────┬────────┘
                                  │
                         ┌────────▼────────┐
                         │  PostgreSQL 16   │
                         │  (Docker volume) │
                         └────────┬────────┘
                                  │ sync when online
                         ┌────────▼────────┐
                         │    Supabase     │ (optional)
                         └─────────────────┘
```

## Prerequisites

- Docker + Docker Compose
- Node.js 22
- [Homebrew](https://brew.sh) (for Mosquitto)
- [mqttx CLI](https://mqttx.app/cli) (optional, for debugging)

## First-time setup

**1. Install dependencies**

```bash
npm install
```

This installs all workspace dependencies (backend + frontend) and generates `package-lock.json`.

**2. Configure environment**

```bash
cp .env.example .env
# Edit .env — add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY if you want cloud sync
```

**3. Start Mosquitto** (see [MQTT Broker](#mqtt-broker) section below)

**4. Build the backend Docker image** (used only by the nightly pipeline — the live backend runs natively):

```bash
docker compose --profile docker build backend
```

Re-run this after backend code changes so the scheduler's nightly pipeline picks them up.

**5. Start each dependency** — one copy-paste block each, in this order:

```bash
# Mosquitto (MQTT broker — native, from project root)
/opt/homebrew/sbin/mosquitto -c mosquitto/config/mosquitto.conf
```

```bash
# Docker services: PostgreSQL (port 5432) + scheduler + SearXNG (port 8888)
docker compose up -d
```

```bash
# Backend API — native so it can see the reader's LAN interface (port 3001)
cd backend && npm run dev
```

```bash
# Admin frontend (port 3000)
cd frontend && npm run dev
```

```bash
# Public app — landing page + kalendarz, optional (port 3002)
cd public && npx vite --port 3002
```

| Service    | URL                   | Runs        |
|------------|-----------------------|-------------|
| Frontend   | http://localhost:3000 | native (Vite) |
| Backend    | http://localhost:3001 | native (Node) |
| Public app | http://localhost:3002 | native (Vite) |
| PostgreSQL | localhost:5432        | Docker      |
| Mosquitto  | localhost:1883        | native      |

## Development

Backend and frontend run **natively** (not in Docker) — the backend must see the Mac's real network interfaces to talk to the RFID reader, and native Vite gives instant HMR. `npm run dev` in `backend/` uses `node --watch` (auto-restart on change) and reads `.env` from the repo root; `npm run dev` in `frontend/` is plain Vite HMR on port 3000.

Docker runs the stateful/background pieces: PostgreSQL, the scheduler, and SearXNG. The compose `backend`/`frontend` services still exist behind the `docker` profile — the scheduler's nightly pipeline runs each step as a one-shot backend container (`docker compose --profile docker run --rm backend …`), and `docker compose --profile docker up --build` still brings up the old full-Docker stack if ever needed.

Database migrations run automatically on backend startup. Data is stored in the named volume `pgdata` and survives `docker compose down`. Only `docker compose down -v` deletes it.

---

## MQTT Broker

Eclipse Mosquitto runs **natively on macOS**, not in Docker. Docker only forwards ports to `localhost`, making a containerised broker unreachable from the R700 (a physical device on the network).

### Install

```bash
brew install mosquitto
```

### Start

Run from the project root:

```bash
# pkill mosquitto or lsof -ti :1883 | xargs kill -9 - in case already started somewhere
/opt/homebrew/sbin/mosquitto -c mosquitto/config/mosquitto.conf
```

Broker listens on:
- **MQTT**: `localhost:1883`
- **WebSocket**: `localhost:9001`

Logs print to stdout and to `mosquitto/log/mosquitto.log`.

---

## Impinj R700 Configuration

Configure each reader via its web UI at `https://169.254.1.1/ui`. The `.local` mDNS hostname (`impinj-17-0a-30.local`) stops resolving when the laptop IP changes — always use the IP directly.

> **After a power outage or factory reset the R700 loses all configuration.** Follow all steps below in order.

### Step 1 — Find your laptop's IP

The R700 connects via Ethernet cable to a USB adapter. On this machine the adapter is `en8`:

```bash
ifconfig en8 | grep "inet "
```

This returns something like `169.254.x.x` — a link-local address assigned automatically when there is no router. **This IP changes every time the cable is disconnected.** To keep it stable, set it statically:

System Settings → Network → select the Ethernet (en8) adapter → Details → TCP/IP → Configure IPv4 → **Manually** → set IP `169.254.1.100`, Subnet Mask `255.255.255.0` → OK → Apply.

After that `ifconfig en8 | grep "inet "` will always return `169.254.1.100`.

### Step 2 — Configure MQTT (Reader Configuration → MQTT)

Open the R700 web UI and go to **Reader Configuration → MQTT**. Set:

| Setting              | Value                                    |
|----------------------|------------------------------------------|
| Broker host          | Your laptop's IP from Step 1             |
| Broker port          | `1883`                                   |
| Topic prefix         | `leszyrun`                               |
| Client ID            | `reader1` |
| QoS                  | `2`                                      |
| **Enable MQTT Output** | **✓ must be ticked** — easy to miss   |

Save. The reader will reboot. After it comes back up, check `mosquitto/log/mosquitto.log` — you should see a new client connect with the Client ID you set.

### Step 3 — Import the inventory preset

The preset file `leszyrun-inventory-preset.json` (in the project root) configures all 4 antenna ports with the correct settings for race timing (31.5 dBm power, dual-target, session 2).

In the R700 web UI go to **Presets** (or **Inventory Presets**):

1. Click **Import** and select `leszyrun-inventory-preset.json`
2. After import, open the preset and set its **Name** to `leszyrun`
3. Save the preset

### Step 4 — Start Tag Streaming

Still in the preset view:

1. Go to the **Tag Streaming** tab (or section)
2. Select the `leszyrun` preset
3. Click **Start** — the reader begins inventorying and publishing RFID events via MQTT

You should immediately see messages arriving in `mosquitto/log/mosquitto.log` and raw reads appearing in the LeszyRun app under Race Control → Surowe odczyty RFID.

## Daily scrape→enrich→publish scheduler

The `scheduler` container runs `node-cron` jobs at 08:00 (full pipeline) and 10:00 (watchdog) Europe/Warsaw. On any failure it sends an email via SendGrid to `PIPELINE_ALERT_EMAIL`.

Check it's loaded and pick up the latest banner:

```bash
docker compose ps scheduler && docker logs leszyrun-scheduler-1 --tail 5
```

Trigger a manual run:

```bash
docker compose exec scheduler npm run pipeline
```

Full design: [docs/superpowers/specs/2026-05-04-dockerized-pipeline-scheduler-design.md](docs/superpowers/specs/2026-05-04-dockerized-pipeline-scheduler-design.md).

---

## Supabase sync (optional)

Set these in `.env`:

```
SUPABASE_URL=https://<project-id>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service_role_key>
```

Use the **service role** key (not the anon/publishable key) — it bypasses RLS. Sync is one-way, local → Supabase, on a 30-second interval when online. Local PostgreSQL is always the source of truth.

---

## Debugging

Subscribe to all MQTT topics:

```bash
mqttx sub -h localhost -p 1883 -t "#"
```

Publish a test message:

```bash
mqttx pub -h localhost -p 1883 -t "leszyrun" -m '{"timestamp":"2026-01-01T10:00:00Z","eventType":"tagInventory","tagInventoryEvent":{"epc":"ikUCJA==","antennaPort":1,"peakRssiCdbm":-3200}}'
```

---

## How gate crossings are detected

The RFID reader reports reads about every 200 ms. For every runner the system tracks signal strength (RSSI) in cdBm: the closer to 0, the stronger (-2000 is a stronger signal than -6000).

**Start: wait until the runner leaves the gate.**

```
Kowalski runs through the start gate:

  read 1:  -5200  (5 m before the gate)
  read 2:  -4100  (3 m)
  read 3:  -2800  (1 m)
  read 4:  -1900  ← RSSI peak = Kowalski AT the gate
  read 5:  -2400  (running away)
  read 6:  -3500
  read 7:  -5100  (5 m past the gate)
  [3 s of silence]
               ↑
               no read for 3 s → CONFIRMED ✓

  startTime = timestamp of read 4 (-1900), the peak
```

A start is confirmed when the signal has been gone for `gone_window_seconds` (the admin form calls it "Okno przejścia", default 3 s). Every new read resets the countdown, because runners stand in the start corral inside the antennas' range and keep being read. The start is confirmed only once the runner has actually run off.

**Finish and checkpoints: a fixed window from the first read.**

```
Kowalski crosses the finish line:

  0.0 s  read 1:  -7400  (~5 m before the gate) → opens a 3 s window
  0.8 s  read 2:  -5100
  1.4 s  read 3:  -3900  ← RSSI peak
  2.1 s  read 4:  -5600  (stops past the line)
  2.9 s  read 5:  -5500
  3.0 s  window closes → CONFIRMED ✓
  later reads -5400, -5300, … → ignored

  finishTime = timestamp of read 3 (-3900)
```

The first read opens a window of `gone_window_seconds` (default 3 s). Reads inside the window can only move the peak; they never extend the window. After 3 s the crossing is recorded. A runner who stands at the finish or at an aid station cannot hold the pass open, and later reads never change their time. The antennas hear a tag from about 5 m, so a runner is through the gate in under 3 s. The checkpoint agent uses the same rule (`PASS_WINDOW_MS`, default 3000).

**Either way, the recorded time is the peak**, when the runner was closest to the antennas, not the moment the pass closed.

The window is set per event in the **Ustawienia RFID** tab.

---

## Docs

- [ARCHITECTURE.md](ARCHITECTURE.md) — full system design, DB schema, crossing detection algorithm, CSV formats
- [CLAUDE.md](CLAUDE.md) — development conventions
