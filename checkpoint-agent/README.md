# checkpoint-agent

## What it is

A standalone Node/Fastify agent that runs on a Raspberry Pi paired with an
Impinj R700 RFID reader at a trail checkpoint (an aid station, a mid-course
timing point, anything away from the main start/finish gate). It configures
the R700, listens for tag reads over MQTT, applies a simplified
exit-triggered crossing detector (`src/confirmer.js` — same peak-RSSI /
silence-window idea as the backend's `crossingDetector.js`, but one
confirmed pass per EPC per session, no finish-line fallback timer), resolves
confirmed EPCs to bib numbers against a roster downloaded at setup time, and
uploads the results straight to Supabase's `checkpoint_observations` table.
It has no dependency on the local backend or local Postgres — it talks to
Supabase directly so it keeps working on a trail with no route back to the
race HQ network. See `ARCHITECTURE.md` (`checkpoint_observations` schema) and
`.superpowers/sdd/2026-07-27-checkpoint-agent/` for the full design record.

**Operator guide (Polish, step-by-step):** [../docs/punkty-kontrolne.md](../docs/punkty-kontrolne.md)
— how an admin adds a checkpoint and generates the checkpoint PIN, and how an
operator configures a checkpoint on the trail. This README is the hardware /
install reference; that guide is the race-day walkthrough.

## Hardware & power

- **Board:** any 64-bit Raspberry Pi (tested on Pi 3B and Pi 5). 64-bit is
  required — Node 20+ has no usable 32-bit ARM builds.
- **Power — the #1 cause of a no-boot.** A too-weak supply makes the Pi flash
  its green ACT LED once, then sit on solid red, and never boot. Use:
  - **Pi 3:** a real 5V/2.5A micro-USB supply (a 2A phone charger is under spec
    and fails).
  - **Pi 5:** 5V/5A (27W) USB-C. A generic USB-C PD charger boots it with a
    "not a 5A supply" warning that only limits downstream USB — harmless here,
    since the R700 is powered separately over PoE, not off the Pi.
  - A short, thick cable matters as much as the charger rating (voltage drop).
- **RTC (Pi 5):** fitting the optional RTC battery means a correct clock on boot
  with no network — the agent won't have to wait for NTP before it can record
  (it blocks recording until the clock is sane).
- **R700 link:** the reader connects to the Pi over Ethernet and is powered by a
  PoE+ (802.3at) injector — not from the Pi.

## Flashing the SD card (macOS)

The steps below assume the Pi already boots Raspberry Pi OS. To get there from a
blank card:

1. Install **Raspberry Pi Imager**: `brew install --cask raspberry-pi-imager`
   (or download from raspberrypi.com/software).
2. **Device:** your Pi model. **OS:** *Raspberry Pi OS (other)* →
   **Raspberry Pi OS Lite (64-bit)** (Lite = no desktop; we only need a shell).
   **Storage:** the SD card.
3. **Next → Edit Settings** (OS customisation) and set:
   - **Hostname** — e.g. `leszyrun-checkpoint1` → reachable as
     `leszyrun-checkpoint1.local`.
   - **Username + password** — these are your SSH login.
   - **Wi-Fi** — see the note below on which network to bake in.
   - **Locale / timezone** — for correct log + observation timestamps.
   - **Services → Enable SSH → password authentication.**
4. **Save → Write**, confirming the overwrite. Eject, insert into the Pi, boot.

**Which Wi-Fi to bake in — you won't know the trail network in advance.** The
fix is to make the field network one you control with a *fixed* name/password,
so you never re-flash per race:

- **Simplest (no extra hardware):** set your phone's personal hotspot to a
  permanent SSID + password and bake *that* in. At the race, turn the hotspot on
  → the Pi auto-joins → you drive the agent from the same phone's browser. Bring
  a power bank; the hotspot drains the phone.
- **More robust:** a dedicated 4G/LTE travel router with its own SIM + battery;
  set its Wi-Fi once, bake it in. Better for an unmanned checkpoint or all-day
  race.
- **For desk testing, bake in your home Wi-Fi** (which you know) and do the whole
  dry-run there; add the field hotspot later (no re-flash needed —
  `sudo nmcli device wifi connect "SSID" password "pw"` adds networks live, and
  you can preload several).

## Connecting over SSH

First boot takes ~1-2 min. The Pi must be on the **same network as your Mac** —
if the Pi is on your phone hotspot, join your Mac to that hotspot too. Then:

```bash
ssh <user>@leszyrun-checkpoint1.local     # or the Pi's IP, e.g. ssh <user>@10.80.179.35
```

If `.local` doesn't resolve (some phone hotspots block the mDNS it relies on),
use the Pi's IP instead — it's printed on the Pi's console (`My IP address is …`)
or visible in your hotspot's client list. Accept the host-key fingerprint on
first connect. In the field you'll typically skip SSH entirely and just open the
agent UI at `http://<pi-ip>:8080` from your phone.

## Raspberry Pi setup

Run these on the Pi (over SSH, or at its console). Copy-paste each block.

1. **Install Node.js (current LTS — 24.x)** (e.g. via NodeSource or `nvm`).
   The agent requires `>=20.11`, but Node 20 reached end-of-maintenance in 2026,
   so install the current LTS; the agent is validated on Node 24:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
   sudo apt install -y nodejs
   node --version   # confirm v24.x (any >= 20.11 works)
   ```
2. **Install Mosquitto** on the Pi itself (this broker is separate from the
   dev-machine one in the monorepo root — the R700 needs to reach it over
   the trail LAN, not over localhost):
   ```bash
   sudo apt install -y mosquitto
   ```
   Configure it to listen on the Pi's LAN interface and allow the R700 to
   connect anonymously — the trail LAN is an isolated hotspot with no other
   clients, so there's nothing to authenticate against:
   ```
   # /etc/mosquitto/conf.d/checkpoint.conf
   listener 1883 0.0.0.0
   allow_anonymous true
   ```
   ```bash
   sudo systemctl restart mosquitto
   sudo systemctl enable mosquitto
   ```
3. **Clone the repo and install dependencies.** A checkpoint Pi is usually on a
   phone hotspot / weak LTE, and a full clone of this monorepo (all its history)
   routinely dies mid-transfer over HTTP/2 with `RPC failed ... CANCEL` /
   `early EOF`. Force HTTP/1.1 and do a **shallow** clone (latest snapshot only —
   a fraction of the transfer):
   ```bash
   git config --global http.version HTTP/1.1
   git config --global http.postBuffer 524288000
   git clone --depth 1 <repo-url> leszyrun
   cd leszyrun/checkpoint-agent
   npm install
   ```
   If even the shallow clone can't finish on a poor signal, fetch just this
   package with a sparse checkout:
   ```bash
   git clone --depth 1 --filter=blob:none --sparse <repo-url> leszyrun
   cd leszyrun
   git sparse-checkout set checkpoint-agent
   cd checkpoint-agent
   npm install   # still works — the package declares all its own deps
   ```
4. **Set environment variables** (e.g. in `/etc/leszyrun-checkpoint.env`, or
   export them in the systemd unit below):

   | Var | Required | Default | Notes |
   |---|---|---|---|
   | `SUPABASE_URL` | yes | — | agent refuses to start without it |
   | `SUPABASE_ANON_KEY` | yes | — | agent refuses to start without it |
   | `AGENT_PORT` | no | `8080` | wizard/dashboard UI + API |
   | `MQTT_URL` | no | `mqtt://localhost:1883` | the Pi's own Mosquitto — leave as localhost |
   | `MQTT_TOPIC` | no | `leszyrun/checkpoint` | agent also subscribes to `<topic>/#` |
   | `DATA_DIR` | no | `./data` | session, roster, and per-checkpoint queue files |
   | `GONE_WINDOW_MS` | no | `3000` | silence window before a pass is confirmed |
   | `UPLOAD_INTERVAL_MS` | no | `5000` | how often the queue drains to Supabase |
   | `READER_POLL_MS` | no | `15000` | how often the agent checks the R700's `/status` while a session is running and reconfigures+restarts it if it was unreachable or isn't actively running inventory (auto-recovery after a reader power cycle) |

5. **Build the UI** (served by the agent itself at `AGENT_PORT`):
   ```bash
   cd ui && npm install && npm run build && cd ..
   ```
   If `ui/dist` doesn't exist, the agent still starts and serves the JSON
   API only — useful for headless testing, but the operator wizard needs the
   built UI.
6. **Run it:**
   ```bash
   npm start
   ```
   The agent prints its LAN IP and port on boot — that's the URL the
   operator opens on a phone or laptop to run the setup wizard.

### Networking: the reader is on a *second* NIC (link-local)

A checkpoint Pi almost always has **two network interfaces**, and getting them
straight is the single most common setup snag:

- **`wlan0` (or the built-in `eth0`)** — the Pi's route to the internet /
  Supabase (Wi-Fi hotspot, LTE, or the venue LAN). This is where the wizard UI
  is served and where uploads go.
- **A USB-Ethernet adapter (shows up as `eth1`/`enxXXXX`)** — a **direct PoE
  cable to the R700**. There's no router/DHCP on this cable, so — exactly like
  the reader's fixed link-local — the R700 sits at **`169.254.1.1`** and the
  Pi's USB NIC comes up with **no IP at all**. Until you give that NIC a
  `169.254.x.x` address, the Pi cannot reach the reader (setup will fail with
  `CZYTNIK NIEDOSTĘPNY … timeout`).

Find the reader NIC and its link state:
```bash
ip link                    # the USB NIC is the one with LOWER_UP + a non-Pi MAC
ip -4 addr                 # confirm it has NO inet address yet
```
Give it a **static** link-local address (static, not auto, so the MQTT host
below never becomes a moving target across reboots), and make it persist via
NetworkManager:
```bash
sudo nmcli con add type ethernet ifname eth1 con-name checkpoint-reader \
  ipv4.method manual ipv4.addresses 169.254.1.100/16 ipv6.method disabled
sudo nmcli con up checkpoint-reader
ping -c2 169.254.1.1        # reader now reachable
```
(Replace `eth1` with the actual USB-NIC name from `ip link`. Any
`169.254.x.x/16` except `.1.1` works.)

**Then, in the wizard, the MQTT host override is mandatory, not optional.** The
agent auto-detects "its own LAN IP" for the reader to publish to — but it will
pick the internet NIC (`wlan0`), which the reader **cannot route to** from the
`169.254.x` segment. Set **MQTT host = the Pi's reader-NIC address**
(`169.254.1.100` above). Reader IP stays `169.254.1.1`. With that, the reader
reaches the Pi's broker over the PoE cable while `wlan0` still carries
Supabase traffic.

### systemd unit (boot-start + restart-on-crash)

```ini
# /etc/systemd/system/leszyrun-checkpoint.service
[Unit]
Description=LeszyRun checkpoint agent
After=network-online.target mosquitto.service
Wants=network-online.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/leszyrun/checkpoint-agent
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=3
Environment=SUPABASE_URL=https://<project>.supabase.co
Environment=SUPABASE_ANON_KEY=<anon-key>
Environment=AGENT_PORT=8080
Environment=MQTT_URL=mqtt://localhost:1883
Environment=MQTT_TOPIC=leszyrun/checkpoint
Environment=DATA_DIR=/home/pi/leszyrun/checkpoint-agent/data
Environment=GONE_WINDOW_MS=3000
Environment=UPLOAD_INTERVAL_MS=5000
Environment=READER_POLL_MS=15000

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now leszyrun-checkpoint
```

`Restart=always` covers reader hiccups and unhandled crashes. Session
auto-resume (see below) is what makes a full Pi *reboot* mid-race safe, not
just a process restart.

## Race-day flow

1. **Admin side:** on the event's settings page in the admin frontend, the
   organizer generates (or views) the checkpoint PIN — a card backed by
   `GET/POST /api/events/:eventId/secrets/checkpoint-pin`, which reads/writes
   `event_secrets.checkpoint_pin` in Supabase. This PIN is deliberately
   separate from the participant-facing check-in PIN: it unlocks the
   bib↔EPC roster, so it should only go to the checkpoint operator.
2. **Operator side — setup wizard:** the operator opens
   `http://<pi-lan-ip>:8080` on their phone/laptop and works through:
   - **PIN** — the checkpoint PIN from step 1
   - **Event** — picked from a dropdown (`GET /api/events`)
   - **Checkpoint** — picked from that event's checkpoints
     (`GET /api/events/:eventId/checkpoints`)
   - **Reader IP** — the R700's LAN/mDNS address (e.g. `impinj-XX-XX-XX.local`)
   - **Advanced (optional)** — reader username/password (defaults to
     `root`/blank) and an MQTT host override. By default the agent
     auto-detects its own LAN IP and tells the R700 to publish there — only
     override this if auto-detection picks the wrong interface.

     Submitting calls `POST /api/setup`, which authenticates the PIN against
     the `checkpoint-roster` Supabase edge function and downloads the
     roster (bib number + RFID EPC **only** — no participant names or other
     personal data ever touches the Pi).
3. **Start:** the dashboard's Start button (`POST /api/start`) configures
   the R700 (MQTT target + inventory preset), starts it reading, and wires
   up the confirm→resolve→queue→upload pipeline. Start is blocked with a 423
   if the Pi's clock isn't NTP-synchronized (see Troubleshooting) unless the
   operator explicitly overrides it.
4. **Live dashboard** polls `GET /api/state` every 2s and shows: total
   reads, confirmed passes, tags currently in range, queue depth
   (pending/total), time since last successful upload (green < 30s,
   yellow < 2min, red beyond that or on error), and any unknown tags seen
   (EPCs not on the roster — tracked, never uploaded).
5. **Stop** (`POST /api/stop`) pauses the reader and pipeline without
   discarding anything — safe to do between waves.
6. **Reset** ("Zakończ i wyczyść") clears the whole session (roster, queue
   cursor, in-memory state) so the same Pi can be redeployed to a different
   checkpoint or event. It requires a second confirming click within 5s to
   avoid fat-fingering it mid-race.

## Simulator usage

`scripts/simulate-reads.js` publishes canned Impinj `tagInventory` MQTT
payloads to a broker, so the confirm/resolve/queue/upload pipeline can be
exercised without a real R700 in the room — useful for dev-machine testing
against the monorepo's own Mosquitto, or on the Pi itself to sanity-check
wiring before trusting the real reader.

```bash
node scripts/simulate-reads.js --epc AABBCC01 [--topic leszyrun/checkpoint] [--url mqtt://localhost:1883]
```

It publishes a rising-then-falling RSSI curve (7 reads, 200ms apart) and
goes silent — with the default `GONE_WINDOW_MS=3000`, the agent (if running
with a session configured) should confirm the pass about 3 seconds later, at
the peak-RSSI reading's timestamp. The EPC only resolves to a bib number and
gets uploaded if it's present in the downloaded roster — an EPC simulated
against an event where it isn't registered will show up under "unknown
tags" instead.

### Test na sucho (bez czytnika)

For exercising the **full** pipeline (setup → MQTT reads from the simulator
→ confirm → resolve → queue → upload) with no Impinj R700 attached at all —
useful for dev-machine testing or bench-testing the Pi before hardware
arrives. Enable the "Tryb testowy bez czytnika (symulacja)" checkbox in the
wizard's advanced section (or `POST /api/setup` with `noReader: true`, which
also drops the `readerIp` requirement), then hit Start and run:

```bash
node scripts/simulate-reads.js --epc <EPC>
```

This exercises everything except the R700 itself — `POST /api/start` skips
`createReader`/`configure`/`start` and the reader health poll, but MQTT,
the confirmer, resolver, queue and uploader all run exactly as they would
with real hardware. `GET /api/reader/status` returns
`{ data: { simulated: true } }` and the dashboard shows a neutral
"TRYB TESTOWY — BEZ CZYTNIKA" badge instead of polling the reader.

## Hardware dry-run checklist

Run this against real hardware before trusting a checkpoint on race day.
Steps 1-2 can be done pre-merge with the simulator standing in for the R700;
the rest need the real reader.

- [ ] **Cold boot → wizard → real tag pass.** Power on the Pi from cold,
      confirm the agent auto-starts (systemd unit above), open the wizard,
      complete setup, hit Start, walk a test tag past the antenna, and
      confirm it shows up as a confirmed pass on the dashboard.
- [ ] **Pull LTE mid-test → queue grows → reconnect → drains.** With the
      session running, cut the Pi's internet (pull the LTE dongle / disable
      the modem), walk another tag past, confirm the queue's "pending"
      count increases and stays nonzero. Restore connectivity and confirm
      the queue drains back to 0 within `UPLOAD_INTERVAL_MS` and "last
      upload" turns green.
- [ ] **Pull reader power → red banner → power back → auto-recovery.**
      Disconnect the R700's PoE/power. Confirm the dashboard's reader status
      row turns into a red "CZYTNIK NIEDOSTĘPNY" banner within one UI poll
      cycle (10s, the browser's own `GET /api/reader/status` poll). Restore
      power and confirm the banner clears within one UI poll cycle, AND
      confirm tag reads resume reaching the dashboard (walk a test tag past)
      within one `READER_POLL_MS` cycle (default 15s) — the agent's own
      background health poll notices the reader coming back and
      automatically reconfigures + restarts it (a power cycle wipes the
      R700's MQTT + inventory-preset config, so the reader being reachable
      again is not the same as it actively reading tags again).
- [ ] **Reboot Pi mid-session → auto-resume, no duplicate observations.**
      With a session running, `sudo reboot` the Pi. Confirm the agent
      auto-resumes the same session on boot (no re-running the wizard),
      the R700 gets reconfigured and restarted automatically, and a tag
      that was already confirmed *before* the reboot does not get
      re-uploaded as a duplicate (the confirmer is seeded from the
      per-checkpoint queue file on restart).
- [ ] **Post-merge only — full pipeline smoke against a real event.** The
      `checkpoint-roster` edge function and the `event_secrets.checkpoint_pin`
      column only exist in prod once this feature's PR merges (Supabase
      schema/function deploys are CI-driven on merge to `main` — see
      `docs/supabase-release-runbook.md`). Once merged: coordinate with the
      user on a throwaway/test event with a checkpoint and a checkpoint PIN,
      complete the wizard against it for real, then
      `node scripts/simulate-reads.js --epc <rfid_epc of a real participant
      in that event>` (or a real tag walk-past) and verify the dashboard's
      confirmed-count increments, the queue drains, and the row appears in
      Supabase `checkpoint_observations` and on the HQ checkpoint views.
      This writes one real row — use a throwaway event, and delete the
      observation afterwards via the admin flow (ask the user before any
      direct DB delete, per this repo's database write safety rule).

## Troubleshooting

- **Every tag shows up as "unknown"** — the wizard was pointed at the wrong
  event (or the right event but wrong race), so the downloaded roster
  doesn't contain the EPCs actually on course. Reset and re-run setup
  against the correct event.
- **Clock banner won't go away** — the Pi's system clock isn't
  NTP-synchronized yet (checked via `timedatectl show -p NTPSynchronized`
  on Linux; a Pi without a working network/RTC can boot into 1970, which
  would corrupt every timestamp downstream). Give it a minute to sync after
  boot, or use the explicit "Wymuś start" override if you're certain the
  clock is fine (e.g. it has a battery-backed RTC you've already verified).
- **Reader banner won't clear** — the agent can't reach the R700's REST API.
  Check PoE power to the reader, check the reader and Pi are on the same
  LAN/subnet, and check the reader IP entered in setup is still correct
  (mDNS `.local` addresses can be flaky — a static IP is more reliable for
  a fixed checkpoint). If the reader is on a direct PoE cable to a USB NIC,
  the Pi's NIC needs a `169.254.x.x` address first — see "Networking: the
  reader is on a second NIC" above.
- **Reader status is green but reads stay at 0** — the reader can reach the
  Pi's REST API but not its MQTT broker. Almost always the MQTT host: the
  wizard auto-detected the internet NIC (`wlan0`) instead of the reader-NIC
  address, so the R700 is trying to publish to an IP it has no route to.
  Reset, re-run setup, and set the MQTT host override to the Pi's reader-NIC
  address (e.g. `169.254.1.100`). Confirm the connection on the Pi with
  `sudo tail -f /var/log/mosquitto/mosquitto.log` — a `LeszyRunCheckpoint …
  connected` line appears the instant it works.
- **`curl localhost:8080/...` returns nothing / connection refused, but the
  browser works** — the agent binds `0.0.0.0` (IPv4), while `localhost` on
  the Pi resolves to IPv6 `::1` first, which nothing is listening on. Use
  `127.0.0.1` or the Pi's LAN IP instead: `curl http://127.0.0.1:8080/api/state`.
