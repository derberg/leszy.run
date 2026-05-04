tl;dr

1. Make sure connection from `https://169.254.1.1/ui` or `https://impinj-17-0a-30.local/` to proper IP `ifconfig en8 | grep "inet "`
1. Start docker `docker compose up --build`
1. Start mosquitto `/opt/homebrew/sbin/mosquitto -c mosquitto/config/mosquitto.conf`

# LeszyRun

RFID-based race timing system for running events. Impinj R700 readers detect participants crossing start/finish gates via MQTT. Results update in real-time with a public podium view.

```
Impinj R700(s) ──MQTT──▶ Mosquitto (native macOS)
                                  │
                          host.docker.internal:1883
                                  │
                         ┌────────▼────────┐
                         │  Node.js/Fastify │
                         │  + Crossing      │
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

**4. Build and start the app**

```bash
docker compose up --build
```

`--build` is required on the first run and after changing `package.json` or Dockerfiles. Subsequent starts can use `docker compose up`.

| Service  | URL                   |
|----------|-----------------------|
| Frontend | http://localhost:3000 |
| Backend  | http://localhost:3001 |

## Development

Use `docker compose watch` instead of `up` for hot reload:

```bash
docker compose watch
```

- Backend source changes → container restart (sync+restart)
- Frontend source changes → synced into container (Vite HMR)
- `package.json` changes → full rebuild

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

The `scheduler` container runs `node-cron` jobs at 08:00 (full pipeline) and 09:00 (watchdog) Europe/Warsaw. On any failure it sends an email via SendGrid to `PIPELINE_ALERT_EMAIL`.

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

## Jak działa wykrywanie przejścia przez bramkę

Czytnik RFID wysyła odczyty co ~200 ms. Dla każdego zawodnika system śledzi siłę sygnału (RSSI) w cDbm — im bliżej 0, tym silniejszy (np. -2000 to sygnał lepszy niż -6000).

**Algorytm (exit-triggered — wyzwalany wyjściem z zasięgu):**

```
Kowalski zbliża się do bramki startowej:

  odczyt 1:  -5200  (5m przed bramką)
  odczyt 2:  -4100  (3m)
  odczyt 3:  -2800  (1m)
  odczyt 4:  -1900  ← szczyt RSSI = Kowalski PRZY bramce
  odczyt 5:  -2400  (odbiega)
  odczyt 6:  -3500
  odczyt 7:  -5100  (5m za bramką)
  [cisza przez 3 sekundy]
               ↑
               brak odczytu przez 3 s → POTWIERDZONE ✓

  startTime = timestamp odczytu 4 (-1900) — moment szczytu
```

Potwierdzenie odpala się gdy sygnał znika na `Okno ciszy` sekund (domyślnie 3 s).
**Zapisany timestamp to zawsze moment szczytu** — kiedy zawodnik był fizycznie przy bramce, nie moment zniknięcia sygnału.

**Start masowy** — zawodnicy stojący w korytarzu startowym dają ciągłe odczyty. Timer ciszy jest co chwilę resetowany → brak potwierdzenia. Potwierdzenie następuje dopiero gdy zawodnik faktycznie odejdzie od bramki.

**Zawodnik zatrzymuje się przy mecie** — odczyty trwają, timer ciszy się resetuje. Po upływie `Wymuszony zapis` (domyślnie 10 s) od pierwszego odczytu timer fallback odpala potwierdzenie. Dotyczy **tylko mety** — start nigdy nie jest wymuszony.

**Dwa timery:**
- `goneTimer` (domyślnie 3 s) — resetuje się przy każdym nowym odczycie; odpala gdy zawodnik odejdzie
- `maxTimer` (domyślnie 10 s, **tylko meta**) — nie resetuje się; odpala gdy zawodnik zbyt długo stoi przy mecie

Oba parametry konfigurowane per-event w zakładce **Ustawienia RFID**.

---

## Docs

- [ARCHITECTURE.md](ARCHITECTURE.md) — full system design, DB schema, crossing detection algorithm, CSV formats
- [CLAUDE.md](CLAUDE.md) — development conventions
