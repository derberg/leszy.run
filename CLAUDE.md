# LeszyRun — Development Guide for Claude

## Project summary

Race timing system. RFID readers detect participants crossing start/finish gates.
Events are published via MQTT. Backend processes them and stores results in local
PostgreSQL. Syncs to Supabase when online. See ARCHITECTURE.md for full design.

## Development workflow (worktree → PR → merge — enforced)

**Never commit to `main` directly, and never leave work stranded on a branch.**
Every change goes: worktree off fresh `origin/main` → push → PR → merge back →
done. A feature branch that piles up commits but never gets a PR/merge is a bug,
not a state to leave the repo in.

- **The shared main checkout is read-only for edits** (on any branch). All topic
  work happens in an isolated git worktree — one worktree : one branch : one
  session: `scripts/worktree.sh new feature/<name>`, then work in `.worktrees/<name>`.
- Before editing OR before answering "what does the code do", run `git status -sb`.
  If HEAD is behind `origin/main`, reason about `origin/main`, not the stale tree.
- Flow: `scripts/worktree.sh new feature/<name>` → edit in `.worktrees/<name>` →
  `git push -u origin feature/<name>` → `gh pr create --fill` → `gh pr merge --squash --delete-branch`
  → `scripts/worktree.sh rm feature/<name>`.
- This is enforced by hooks: a PreToolUse **branch-guard** denies edits in the
  main checkout and on `main`/`master` anywhere, and a SessionStart reminder
  front-loads the `dev-workflow` skill. The full rules, deploy model, and
  post-merge steps live in `.claude/skills/dev-workflow/SKILL.md` — invoke that
  skill before the first edit.

## GDPR compliance

This project is RODO/GDPR-compliant. Reference documents:
- [docs/gdpr/ropa.md](docs/gdpr/ropa.md) — Rejestr Czynności Przetwarzania (Art. 30, public)
- [docs/gdpr/dpia-participants.md](docs/gdpr/dpia-participants.md) — DPIA for participant data (Art. 35)
- [docs/gdpr/breach-response.md](docs/gdpr/breach-response.md) — Breach response runbook (Art. 33/34)
- [docs/gdpr/rls-audit.md](docs/gdpr/rls-audit.md) — Supabase RLS audit
- [docs/gdpr/profile-exposure.md](docs/gdpr/profile-exposure.md) — Public profile field exposure audit
- [docs/gdpr/dpa-checklist.md](docs/gdpr/dpa-checklist.md) — Operator action items (gitignored)
- Public legal pages: `/polityka-prywatnosci`, `/privacy-policy`, `/regulamin`, `/podmioty-przetwarzajace`

**Bumping privacy policy version:** edit `POLICY_VERSION` in [public/src/lib/policyVersion.js](public/src/lib/policyVersion.js). The cookie banner detects mismatch and re-prompts every user automatically.

**Data subject rights endpoints:**
- `POST /functions/v1/export-my-data` — returns JSON export of user data (Art. 15/20)
- `POST /functions/v1/delete-my-account` — two-step OTP soft delete (Art. 17). Email is NOT released after deletion — re-registration with same email is permanently blocked.

**Consent audit trail:** every accept/reject choice on the cookie banner is logged client-side (localStorage with timestamp + policyVersion + userAgent) and, for authenticated users, server-side to the `consent_log` table via the `log-consent` edge function.

**Retention:** `gate_events` and `gate_crossings` are purged 90 days post-race by the scheduler container's daily cron job at 03:00 Europe/Warsaw. No other automatic retention purges.

**Admin actions:** every admin write (calendar event approval, club merge, contribution review, etc.) is logged to `admin_actions` table with admin_user_id, target, payload, ip, user_agent. Append-only, service_role only.

**Club membership lifecycle log:** every join/leave/remove/role-change on a club is appended to `club_membership_log` (`club_id`, `user_id`, `event` — `joined`/`left`/`removed`/`role_changed`, `role`, `actor_id`, `occurred_at`). Append-only, service_role only — same access pattern as `admin_actions`, but scoped to club membership rather than admin actions.

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
  scheduler/    Node.js + node-cron daemon, runs the daily scrape→enrich→publish pipeline at 08:00 Europe/Warsaw, deadline notifications at 08:30, a watchdog at 10:00, and the weekly digest Monday 09:00. Sends SendGrid alerts on failure.
  enricher/     Python (Crawl4AI + Docling + local Ollama) for LLM enrichment, run-once container in compose
  mosquitto/    native macOS, NOT dockerized (hardware constraint)
  checkpoint-agent/  Node/Fastify agent for a Raspberry Pi + Impinj R700 at a trail checkpoint: records tag passes, uploads checkpoint_observations to Supabase (see checkpoint-agent/README.md)
```

**`packages/ui/` rule:** All race result rendering (status badges, position estimation, podium, results tables) MUST use shared components from `@leszyrun/ui`. Never duplicate result display logic in `frontend/` or `public/` — if a component is missing, add it to `packages/ui/` first, then import in both apps.

## Running locally

**Hybrid split:** backend + frontend run NATIVELY on macOS (the backend must see the
Mac's real LAN interfaces to talk to the R700 — impossible from inside the Docker VM);
PostgreSQL, scheduler, and SearXNG stay in Docker.

**One command starts everything** (Ctrl+C stops all): `./scripts/dev.sh` (or `npm run dev`;
add `--public` for the public app). Individual dependencies, one copy-paste block each:

```bash
# Mosquitto (MQTT broker — native, from project root)
/opt/homebrew/sbin/mosquitto -c mosquitto/config/mosquitto.conf
```

```bash
# Docker services: PostgreSQL + scheduler + SearXNG
docker compose up -d
```

```bash
# Backend API (native, port 3001; reads ../.env, auto-restarts on change)
cd backend && npm run dev
```

```bash
# Admin frontend (native Vite, port 3000)
cd frontend && npm run dev
```

```bash
# Public app (landing page + kalendarz, port 3002)
cd public && npx vite --port 3002
```

Admin frontend: http://localhost:3000
Backend API: http://localhost:3001
PostgreSQL: localhost:5432
Public app: http://localhost:3002

The compose `backend`/`frontend` services sit behind `profiles: [docker]` — not started
by default. The scheduler's nightly pipeline runs each backend step as a one-shot
container (`docker compose --profile docker run --rm backend …`), so after backend code
changes rebuild its image: `docker compose --profile docker build backend`.

## Environment variables

Backend (native process reads repo-root `.env` via `--env-file-if-exists`; the pipeline's
one-shot containers get theirs from docker-compose.yml):
- `DATABASE_URL` — postgres connection string (native default: `localhost:5432`)
- `MQTT_URL` — native default `mqtt://localhost:1883` (in-container: `mqtt://host.docker.internal:1883`)
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

Pipeline scheduler / alerting (scheduler container, optional — alerts disabled if missing):
- `SENDGRID_API_KEY` — SendGrid API key (reused from zatyrani.pl). Without this the scheduler still runs the pipeline but cannot send failure emails.
- `SENDGRID_FROM_EMAIL` — verified sender, e.g. `"Stowarzyszenie ZATYRANI <biuro@zatyrani.pl>"`. Default falls back to `biuro@zatyrani.pl`.
- `PIPELINE_ALERT_EMAIL` — recipient for `[FAIL]`, `[WARN]`, `[ALERT]` emails. Default `lpgornicki@gmail.com`.

## Backend conventions

- All routes in `src/routes/`, one file per resource
- Register routes in `src/server.js` with prefix (`/api/events`, `/api/participants`, etc.)
- Drizzle schema in `src/db/schema.js`, client in `src/db/index.js`
- Use Drizzle migrations (`drizzle-kit generate` + `drizzle-kit migrate`)
- **Migrations MUST be registered in `src/db/migrations/meta/_journal.json`** — Drizzle ignores SQL files not listed there. When writing a migration manually: create the `.sql` file AND add an entry to the journal (`idx`, `version: "7"`, `when`, `tag` matching filename without `.sql`, `breakpoints: true`). If a migration already ran (backend started and logged "Migrations complete"), do NOT modify the SQL file — create a new numbered file + new journal entry instead.
- **DDL changes MUST be applied to both local DB and Supabase.** Local DB uses Drizzle migrations (auto-run on backend start). **Supabase schema changes are a committed SQL migration in `supabase/migrations/` (create with `supabase migration new <name>`), applied to prod by `supabase db push` in the CI release pipeline (`.github/workflows/supabase-release.yml`) on merge to `main` — NOT via MCP `apply_migration` or ad-hoc SQL.** Every schema change touching a table that exists in both DBs requires both the Drizzle migration (local) and a committed Supabase migration. See [docs/supabase-release-runbook.md](docs/supabase-release-runbook.md).
- **Edge functions deploy via the same CI pipeline** (`supabase functions deploy` on merge to `main`) — not via MCP. Every function needs a block in `supabase/config.toml` (`verify_jwt = false`, `entrypoint = "./functions/<name>/index.js"` — this app uses custom cookie auth, not Supabase JWTs). **Supabase edge functions cannot serve `text/html`** — the runtime coerces would-be-HTML responses to `text/plain` + `nosniff`; serve HTML pages from Vercel instead.
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

**START = exit-triggered** — confirmed when a tag's signal disappears for
`gone_window_seconds` (default 3 s). The confirmed timestamp is the **peak** reading —
when the runner was physically closest to the antenna. Required for mass starts:
runners standing in the corral generate continuous readings, goneTimer keeps
resetting → no confirmation until they actually run through.

**FINISH = first-read** — the FIRST reading above the event's `rssi_threshold` from an
already-started participant confirms the finish immediately with that reading's
timestamp; all subsequent readings are ignored for detection (`finishedParticipants`)
but are still written to `gate_events` for 60 s (`FINISH_AUDIT_WINDOW_MS`) so the whole
finish pass stays auditable — before that window existed, every finish recorded exactly
one gate event and there was no way to tell a solid crossing from one lucky ping. There is no
force-confirm timer anymore (`fallback_seconds` is unused — with sensitive tags it
fired during the far-field approach and recorded weak early "finishes"). Finish reads
within `min_finish_seconds` of the gun are ignored (ghost reads at the start line).

State maps:
- `inRange`: `Map<"${epc}:${raceRunId}", { peakRssi, peakTime, antennaPort, topic, goneTimer }>` (start tracking only)
- `recentWindow`: dedup within 200 ms per EPC
- `startedParticipants`: `Set<participantId>` per race (in-memory, avoids DB lookup per crossing)

Flow per reading (above `rssi_threshold`; weaker reads are ignored entirely):
1. Participant already started (or finish topic in separate mode) → past `min_finish_seconds`? → **confirm finish immediately** with this reading; else ignore
2. Not started, tag not in `inRange` → create entry, arm `goneTimer` (goneWindowMs)
3. Not started, tag in `inRange` → update peak if improved; reset `goneTimer`
4. `goneTimer` fires (silence for goneWindowSeconds) → `confirmCrossing(peakTime)` → `gate = start`, add to `startedParticipants`

See the mermaid flowchart at the top of `crossingDetector.js` for a full diagram.

Configurable per event (stored in `events` table):
- `rssi_threshold`: default `-6500` cdbm (was `-5000` until 2026-08-17) — the **tracking floor**. Readings weaker than this are ignored by the detector (far-field pickup from high-sensitivity tags; they don't create/refresh `inRange` entries and are not persisted to `gate_events`). Raw `rfid:raw` broadcast is unaffected. Measured at the 2026-08-07 race: genuine finish crossings came in at −60…−65 dBm and the strongest read of the entire race was −45.5 dBm, so the old `-5000` discarded essentially the whole field and every event had to be hand-tuned before it could time anything. Far-field pickup (tag on a table 15–20 m away) reads −71…−78, so `-6500` still excludes it — but only by ~6 dB, which is the real problem: at that gate the noise band and the crossing band nearly touch. Widen that gap with geometry (narrow the lane, bring runners within ~1.5 m of the antenna), not by chasing the threshold.
- `confirm_rssi_cdbm`: **NULL by default = disabled.** The **crossing bar**, and the second half of a two-tier gate. `rssi_threshold` answers "may this read be followed at all" and must stay permissive or weak tags are lost; this answers "did the tag actually reach the gate". **START** requires the accumulated *peak* to clear it; **FINISH** requires the individual read to clear it (first-read semantics are preserved — a rejected weak read is skipped, NOT added to `finishedParticipants`, so the real crossing still counts). `stopRace`'s pending flush applies the same bar. A start rejected by the bar falls through to gun-time backfill; a rejected finish leaves the runner on course for manual closing.

  **LEAVE IT NULL UNLESS YOU HAVE MEASURED A CLEAN SEPARATION AT YOUR GATE.** It was built on the assumption that real gate passes are strong (−32…−50 dBm) and only far-field pickup is weak, so a bar around `-5500` would drop phantoms while keeping real crossings. **That assumption was wrong and contradicted the documented range above** (−45…−65 dBm for a real crossing). Measured at the 2026-08-07 race: runners who physically passed *right next to the antenna* peaked at **−62…−64,5 dBm**, while others on the same pass peaked at −32 dBm. A bar at `-5500` would therefore have discarded genuine crossings.

  The real finding from that race is a **~32 dB spread between identical passes** (≈40× in power at the same distance) — almost certainly tag orientation/placement (900 MHz is heavily absorbed by the body; a bib worn flat and forward vs. curled or against skin easily accounts for 20–30 dB), possibly antenna coverage nulls. **No threshold fixes that**; it can only choose whom to lose. It also means `rssi_threshold` needs real margin below the weakest genuine pass: at `-6500` the weakest real crossing had 1 dB of headroom, which is why runners were dropped entirely.

  Before reaching for this bar, diagnose instead — per-antenna read strength per runner:
  ```sql
  SELECT p.bib_number, p.last_name, ge.antenna_port,
         count(*) AS pings, min(ge.rssi_cdbm) AS worst, max(ge.rssi_cdbm) AS best
  FROM gate_events ge JOIN participants p ON p.rfid_epc = ge.epc
  WHERE ge.race_run_id = '<RACE_RUN_ID>'
  GROUP BY 1,2,3 ORDER BY best ASC;
  ```
  Weak runners clustered on one port → antenna problem. Spread across all ports → tag/bib problem. Note `gate_crossings.peak_rssi_cdbm` already records each confirmed crossing's peak, so low-confidence crossings can be reviewed **after** a race without risking losing anyone during it.
- `gone_window_seconds`: default `3` s — silence window to confirm a START crossing
- `min_finish_seconds`: default `30` s — finish reads within this window after the gun are ignored (ghost-read guard; lower it for short test loops)
- `gun_backfill_seconds`: default `60` s — after this long from the gun, checked-in runners not read at the start line get gun time as their start (`startTimeSource='gun'`, `startTimeTrigger='auto_backfill'`) so their next crossing counts as a finish
- `gun_backfill_enabled`: default `true` — set `false` to disable automatic gun-time backfill entirely: neither the timer nor the finish-crossing fallback assigns gun time, so start-less runners stay start-less until manual backfill (`POST /races/:id/assign-gun-start`, UI "Nadaj czas strzałki"). Runners read normally at start keep both netto (`duration_ms`) and brutto (`gun_duration_ms`)
- `fallback_seconds`: **unused** (column kept for compat) — the old finish force-confirm timer, removed in favour of first-read finish
- `decline_threshold_cdbm`: **unused** (column kept for compat) — no reference anywhere in `crossingDetector.js`; it is PATCHable but does nothing. Use `confirm_rssi_cdbm` for strength gating.
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

**Wiping a test run's data** (`race_runs`, `results`, `gate_events`, `gate_crossings`)
is not one DELETE — every backend host has its own local Postgres and **deletes are
never propagated by the sync workers**, so the run must be removed on each host AND
Supabase or it reappears (and re-pushes). Invoke the `resetting-race-test-data` skill —
it covers host enumeration, the `gate_events` `SET NULL` orphan trap, and what must
survive (check-ins, participants, tag assignments, event config).

## Supabase project

Project ID: `<your-supabase-project-id>`
Push is one-way: local PostgreSQL → Supabase (`src/sync/supabase.js`). Pull (Supabase →
local) is done by three sanctioned reverse-sync workers below, which together make event
**config + results two-way** across every device bound to the same Supabase project.
Sync is disabled when `SUPABASE_URL` env var is missing.

**Reverse sync — config + results (`src/sync/configSync.js`):** so an event created/edited
on one device (e.g. the Mac) appears automatically on every other device (e.g. a Pi acting
as a second backend). Polls Supabase every 30s and upserts these tables Supabase → local:
`events, categories, participants, checkpoints, race_runs, results, event_documents`.
Each pulled row is stamped `synced_at = now()` so the push worker never echoes it back (the
0010 trigger passes a `SET synced_at` change through instead of nulling it). The ON CONFLICT
update is guarded by `synced_at IS NOT NULL`, so a locally-dirty row (a pending local edit,
`synced_at` NULL) is NEVER clobbered — local push wins first, then re-pulls. Excludes
`checkpoint_observations` (already reverse-synced live via realtime in `supabase.js`) and
`gate_crossings` (raw/high-volume/device-local). **Deletes are NOT propagated** (additive/
update only) — a row deleted on one device lingers on the others until removed there.

**Reverse sync — checkins (`src/sync/checkinSync.js`):** `checkins` and `checkin_documents`
flow Supabase → local. The public self-service check-in page and volunteer app write directly
to Supabase. A reverse sync worker polls Supabase every 30s and pulls new/updated checkin rows
into local PostgreSQL. Admin check-in from the backend also writes to Supabase first (not
local), so all check-in data has a single source of truth in Supabase.

**Supabase-only tables** (no Drizzle schema, no local migration — a committed `supabase/migrations/` file, deployed by the CI pipeline on merge; see [docs/supabase-release-runbook.md](docs/supabase-release-runbook.md)):
- `event_secrets` — per-event check-in PINs
- `calendar_events` — aggregated race calendar from scrapers + manual entry
- `geocode_cache` — Nominatim geocoding results cache
- `url_suggestions` — Brave Search URL candidates pending admin review
- `event_favorites` — user star/follow shortlist (service-role only, written via `toggle-favorite` edge function)
- `event_notifications` — event-level notification log (`registration_opened` / `deadline_soon`); rows produced by a `calendar_events` trigger + `run-deadline-notifications.js`; UNIQUE(event_id, type). No `cancelled` type — cancellation alerts were intentionally dropped (we can't promise them; cancellation data depends on organizers reporting it).
- `event_results_summary` — read-only view aggregating per-event stats (participants, finishers, timed distances, fastest finisher) for past-event public pages; only `participants` + `distances` are currently surfaced. Created via a committed migration (deployed by the CI pipeline).
- `event_category_best_times` — read-only view: best finish time per event × timed category × gender (`M`/`K` only; non-cancelled runs, untimed categories excluded). Feeds the past-event "Najlepsze czasy" table. Created via a committed migration (deployed by the CI pipeline).
- `club_membership_log` — append-only club membership history (joined/left/removed/role_changed), written by the club edge functions; covered by export-my-data / delete-my-account (see GDPR section)
- `club_slug_history` — former club slugs (old_slug → club_id) backing get-club's slug fallback and the static redirect stubs; rows deleted only when a club reclaims its own former slug

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

**Lost-update guard (`markSynced` in `supabase.js`) — do not simplify it away.** The
worker snapshots dirty rows, spends a second or two upserting them, then marks them
synced. Marking by `id` alone silently destroys any local change that landed in
between: Supabase keeps the pre-change value, the row is flagged clean so the push
worker never revisits it, and `configSync` then overwrites the local value with the
stale remote copy (its only protection is "don't touch locally-dirty rows"). On
2026-08-07 this wiped the chip `start_time` of 3 of 19 runners mid-race — snapshot at
14:53:25, starts confirmed 14:53:27, a configSync pull reverted them at 14:53:55,
0.7 s before their finish reads, which then credited gun time instead of real netto.
So the stamp is conditional on Postgres's `xmin` system column (the xid of the last
transaction to write the row) captured in the same snapshot:

```sql
UPDATE <t> SET synced_at = now() WHERE id = $1 AND xmin::text = $2
```

A row that changed keeps `synced_at` NULL and is simply re-pushed next cycle with its
current value. The log reports it: `Synced N rows from <t> (M changed mid-push — left
dirty, will re-push next cycle)`. `__xmin` is stripped in `rowToSnake` so it never
reaches Supabase. The one deliberate exception is the `checkpoint_observations`
23505 retirement path, which stamps unconditionally because that row is being retired
rather than pushed.

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
- `GET /api/events/:eventId/secrets/checkpoint-pin` — get checkpoint-agent PIN from Supabase (separate secret from check-in PIN)
- `POST /api/events/:eventId/secrets/checkpoint-pin` — generate new checkpoint-agent PIN
- `POST /api/events/:eventId/sync/checkins` — trigger immediate checkin reverse sync

## Public app — Landing page & Kalendarz

The `public/` app serves four purposes:
1. **Landing page** (`/`) — leszy.run marketing site for organizers and runners
2. **Kalendarz** (`/kalendarz`) — aggregated calendar of all running/NW events in Poland
3. **Event pages** (`/events/:slug/*`) — live results, check-in, volunteer views
4. **Category/region pages** (`/listy/*`) — static landing pages for event type + voivodeship combinations (trail, maratony, śląskie, etc.)

The landing page and kalendarz read directly from Supabase (`calendar_events` table for kalendarz, `events` table for upcoming leszy.run events). No backend API needed for these pages.

### Feature flag — accounts/community (`useBeta`)

The whole accounts/community product (login, profile, favorites/stars, notifications, clubs, report/feedback, add-event) is **dark-launched** behind `useBeta()` (`public/src/hooks/useBeta.js`): `?beta=1` → persisted to `localStorage` (`leszy.beta`); **off by default**. When off, account routes redirect home, all account/community UI is hidden, and `useAuth` short-circuits to anonymous so **no account edge functions fire**. Legal pages + cookie management stay live regardless (compliance).

**Rule:** any new account/community UI MUST be gated with `useBeta()` (hide when off) — never render it unconditionally. It is a visibility switch, not a security boundary (routes + edge functions stay publicly reachable). The e2e suite forces the flag on via a `storageState` fixture (`public/tests/e2e/beta-storage.json`).

**Auth transport — edge functions go through same-origin `/edge`, NEVER raw `VITE_SUPABASE_URL`.** The session is an httpOnly cookie the edge functions set. A cookie set by `*.supabase.co` while the page is on `leszy.run` is a THIRD-PARTY cookie that browsers block (Safari always, Chrome/Firefox increasingly) — login "succeeds" but the session never persists. So `public/vercel.json` (and the vite dev-server proxy in `public/vite.config.js`) rewrites `/edge/*` → `<project>.supabase.co/functions/v1/*`, making the cookie first-party. **Rule:** any client call to an edge function that depends on the session cookie MUST use the `FUNCTIONS_BASE` (`/edge`) constant from `public/src/lib/auth.js` — never build the URL from `VITE_SUPABASE_URL` directly. (The `supabase-js` DB client in `lib/supabase.js` is exempt: it uses bearer tokens, not cookies, so it hits `*.supabase.co` directly.)

### Logo
- `public/public/logo-bez-napisu.svg` — Leszy character without text. Two green leaves (top-left, top-right), black body/roots.
- `public/public/logo.svg` — full logo with text (used as watermark in `app.css`)

### Static HTML generation (SEO)

The `public/` build is **not a pure SPA**. After `vite build`, several scripts write pre-rendered `index.html` files into `dist/`:
- `scripts/generate-event-pages.js` — one file per `/kalendarz/:slug` (reads `public/public/kalendarz/.manifest.json`)
- `scripts/generate-landing-pages.js` — one file per `/listy/*` page (reads `public/public/listy/.manifest.json`)
- `scripts/generate-leszyrun-event-pages.js` — one file per past, public leszy.run event at `/events/:slug` (reads `public/public/events/.manifest.json`), with baked stats + a "Zobacz wyniki" link to the internal results. The manifest is produced by `backend/scripts/publish-leszyrun-events.js --apply` (host: `cd backend && node --env-file=../.env scripts/publish-leszyrun-events.js --apply`). Re-run after a new event finishes, then commit the refreshed manifest.
- `scripts/generate-club-pages.js` — one file per public club at `/klub/:slug` (reads `public/public/klub/.manifest.json`, a committed JSON array), with member count + visible-member roster + a SportsTeam JSON-LD. The manifest is produced by `backend/scripts/publish-club-pages.js --apply` (host: `cd backend && node --env-file=../.env scripts/publish-club-pages.js --apply`) — query is `clubs` where `is_public = true AND owner_id IS NOT NULL`, applying the same `hidden_public`/`club_public_name` masking as the retired `render-club` function. Re-run whenever a club's public visibility, roster, profile fields, **or slug** change, then commit the refreshed manifest — a slug rename also needs a fresh redirect stub (see below). This REPLACES the old `render-club` Supabase edge function SSR approach (the Supabase edge runtime forced `text/plain` on HTML responses there, breaking crawlers/JSON-LD) — unlike `/events/:slug`, the SPA does not own the bare `/klub/:slug` route; only the sub-paths are SPA routes: `/klub/:slug/dolacz` (invite-accept) and the slug-scoped club area `/klub/:slug/{panel,czlonkowie,zaproszenia,ustawienia}` (member home, roster, invites, settings — index redirects to `panel`, all beta-gated). Renaming a club's slug leaves a redirect stub at the old `/klub/:old-slug` (from `club_slug_history`, regenerated by the same `generate-club-pages.js` run) so old links and bookmarks keep resolving.

All manifests are **committed to the repo** and generated by backend pipeline scripts (`publish-event-pages.js --apply`, `publish-leszyrun-events.js --apply`, `publish-club-pages.js --apply`). Vercel serves the pre-generated files directly; the SPA rewrite in `vercel.json` only catches paths with no matching static file. `vercel.json` also has a permanent redirect from `leszy.run` → `www.leszy.run`.

**SEO crawlability rule:** any new page type that needs Google indexing requires two things:
1. A pre-generated static `index.html` with title, canonical, meta description, and JSON-LD
2. Static `<a href="...">` links to it from already-indexed pages — sitemap alone is not enough for a low-authority site; Google deprioritises sitemap-only URLs with no inbound links from crawled pages

## Event scraper & enrichment pipeline

Standalone scripts (not API endpoints) that scrape Polish running event websites, enrich with AI, and publish to the `calendar_events` Supabase table. See [docs/scrapers.md](docs/scrapers.md) for full pipeline documentation.

### Data sources (33 scrapers)

| Source | Events/year | Method | Data quality |
|--------|-------------|--------|--------------|
| maratonypolskie.pl | 500+ | Playwright (HTML tables) | Low (listing only, no reg URLs) |
| b4sportonline.pl | 100+ | fetch+Cheerio (AJAX pagination) | Medium (city, name, date, reg URL, some distances) |
| datasport.pl | 200+ | Cheerio (detail pages) | High (distances from h4 headings) |
| elektronicznezapisy.pl | 300-500 | Cheerio + dostartu API enrichment | Medium-High |
| biegiwpolsce.pl | 1000+ | Cheerio (paginated) | Medium (tagged distances) |
| dostartu.pl | 250+ | REST API (JSON) | **Highest** (structured classifications) |
| timekeeper.pl | 50-150 | Cheerio (internal events only) | Good (regulamin PDFs, organizer sites) |
| lumisport.eu | 5-15 | WC Store API (JSON) + Cheerio for regulamin | High (structured distances + prices, direct registration URLs; undated events dropped) |
| protiming24.pl | 20-30 | Cheerio (StartMeta listing) | Medium (Szczecin-area timing co; date+city from gcal link, registration + HTML regulamin URLs from listing) |
| superczas.pl | 30-40 | Cheerio (listing + detail pages) | High (Olsztyn/Warmia timing co; date+city+deadline from listing, distances+regulamin PDF from detail page) |
| bgtimesport.pl | 30-50 | Cheerio (listing + detail + regulamin pages) | High (Bielsko-Biała/Silesia timing co; per-bieg prices + distances, regulamin PDF, organizer website) |
| rajsportactive.pl | 8-12 | Cheerio (single listing page) | Medium-High (Sieradz/Łódzkie timing co; date+city+regulamin PDF from listing, distances + kids signal harvested from registration buttons) |
| sport-time.com.pl | 10-20 | Cheerio (single listing page) | Medium (Gryfice/Zachodniopomorskie timing co; name+date+city+registration+HTML regulamin from listing; distances extracted from name where present) |
| wbtiming.pl | 20-40 | Cheerio (calendar listing + detail pages) | High (Grudziądz/Kujawsko-Pomorskie timing co; date+name+badge from listing, location+distances+regulamin PDF+reg URL from detail pages; cycling events skipped) |
| czasomierzyk.pl | 10-20 | Cheerio (single listing page + formularz detail pages) | Medium (Mazowsze-area timing co; date in YYYY-MM-DD from listing, city from Miejscowość column, distances + kids signal + regulamin PDF from formularz.czasomierzyk.pl/<id> detail pages) |
| kepasport.pl | 10-20 | iCal feed (/wydarzenia/?ical=1) | Medium-High (Małopolska/Podkarpacie timing co; date+name+city from iCal, regulamin PDF extracted from URL-decoded DESCRIPTION, registration embedded on event page; no detail page fetches) |
| zapisy.inessport.pl | 15-25 | Cheerio (single listing page) | Medium-High (Łódź-area timing co; grouped + standalone events, date from Polish month spans, regulamin + website from buttons, registration from own form system; cycling events skipped) |
| aleczas.pl | 15-30 | Cheerio (single listing page) + dostartu API enrichment | Medium-High (Mazowsze-area timing co; date+city+distances+registration from listing; dostartu-linked events enriched via API for prices/deadline/regulamin/website; cycling events skipped) |
| maratonczykpomiarczasu.pl | 15-30 | Cheerio (paginated listing, Drupal 7) | Medium-High (Wielkopolska/Zachodniopomorskie/Kujawsko-Pomorskie timing co; date+city+voivodeship+distances+registration from listing; machine-readable ISO dates; non-running events skipped) |
| timing4u.pl | 15-25 | Cheerio (single listing page) | Medium (Śląsk/Silesia timing co; date+city+registration from listing; registration URL points to dostartu.pl or elektronicznezapisy.pl — dostartu events auto-enriched by pipeline; triathlon events skipped) |
| zapisyonline.pl | 30-40 | Cheerio (paginated listing + detail pages) | High (Triso.pl registration platform, Mazowsze/Podkarpacie-heavy; date+city from listing, structured distances + kids/adult type + regulamin PDF + organizer website from detail page; detail page is canonical registration URL; prices/deadline left to enricher; cycling events skipped) |
| foxter-sport.pl | 60-100 | Cheerio (single /list table + /<slug> detail pages) | High (custom-PHP timing co, Wielkopolska/Kujawsko-Pomorskie-heavy; date+city from listing table, structured distances + regulamin PDF + kids flag from detail page; /<slug> detail page is canonical registration URL since the register button needs login; prices/deadline behind login → left to enricher; triathlon/open-water/cycling/moto events skipped) |
| herkules.org.pl | 15-20 | fetch + Tribe REST API (The Events Calendar JSON) | Medium-High (Pomorskie/Zachodniopomorskie timing co "Pomiar Czasu"; name+date+city+registration URL + authoritative event_types from Tribe categories (Bieganie/Nordic Walking/OCR); registration URL points OUT to b4sportonline.pl or inws.info; voivodeship NOT emitted (source region data unreliable) → geocoded from city; distances/prices left to enricher; SUP/cycling/MTB/triathlon-only events skipped) |
| zapisyvaldano.pl | 5-15 | Cheerio (Laravel listing + detail pages) | High (VALDANO organizer/timing co, Pomorskie/Kujawsko-Pomorskie; GRAND PRIX CROSS POLSKA series + standalone runs; date+city from /events listing, structured prices + deadline + regulamin PDF + competition names from /event/<id> detail page; detail page is the canonical registration URL since /register 302s to a login that strips the event id; event_types from umbrella name with NW mined from "Marsz z kijami" sub-races when umbrella has no style; distances in regulamin PDF → left to enricher; voivodeship geocoded from city) |
| pomiaryczasu.pl | 8-15 | Cheerio (homepage table) | Medium (Pomiary Czasu multi-sport timing co, Śląsk/Beskidy — Ustroń/Ujsoły/Daleszyce/Kije; future events in one homepage `table.events_list`; umbrella + grouped sub-races collapsed into one event; RUNNING-TYPE WHITELIST on "Typ zawodów" — only Zawody Biegowe/Nordic Walking/Bieg Przeszkodowy kept, drops Road Maraton=cycling, MTB, Biegi narciarskie=skiing, triathlon, etc.; date+name+type from listing, registration_url=/registration/<slug> (source's own button, id preserved), source_url=/event/<slug>, website from detail "Strona www"; distances mined from sub-race names; location geocoded from city; prices/regulamin/deadline → enricher) |
| e-gepard.eu | 10-30 | Cheerio (Laravel `list-contest-all` table + `show-contest/<id>` detail pages) | Medium (RFID.Zone multi-sport timing/registration co, nationwide; date+name+city from listing table, organizer/regulamin PDF/competition names + per-sub-race "Zapis do" deadline from detail page; registration_url=source_url=`show-contest/<id>` (e-gepard hosts its own registration, status "udostępnione do rejestracji"); NON-RUNNING BLACKLIST on event name drops cycling ("na szosie"/"rajd"/"masa krytyczna"), open-water/ice swimming, XC skiing ("narciar"), du-/triathlon; future-only filter (listing has all events); event_types umbrella-first with NW mined from sub-races; distances mined from names where present; prices/website → enricher; voivodeship geocoded from city) |
| pifsport.com.pl | 3-15 | fetch + WP REST posts API (JSON) | Medium (Pifsport timing co, Małopolska/Podkarpacie; events are WordPress posts in the "aktualne imprezy" category (id 5) — full post HTML returned by the list endpoint, no detail fetches; name+date+location+distances mined from semi-structured prose (`data:`/`miejsce:`/`konkurencja:`) in post content, registration + regulamin PDF hrefs from post-body buttons; SKIING BLACKLIST drops biegi narciarskie/narciarstwo (pifsport's other big line) — merge SKIP_KEYWORDS doesn't cover skiing; date resolved content `data:` → excerpt `data:` → termin → title → slug to survive organizer year typos; registration_url from the source's own "LINK do ZGŁOSZEŃ" button (whitelisted hosts: e-gepard.eu / Google Form), regulamin PDFs on pifsport's server; past events filtered by date; prices/website/voivodeship → enricher + geocoding) |
| time-sport.pl | 30-50 | Cheerio (NinjaTable listing + detail pages) | High (Time-Sport RFID timing co, Śląsk-based but nationwide; all events in one server-rendered NinjaTable on /zapisy/ — date+name+city+**voivodeship**+dyscyplina straight from the table, voivodeship emitted directly (not geocoded); each row's 3rd anchor is the canonical /zapisy-DD-MM-YYYY-<slug>/ detail page = source_url+source_id; DYSCYPLINA gating keeps Bieg/OCR/Nordic Walking/Trail, drops MTB/triathlon/pływanie/kolarstwo; registration flows OUT to dostartu — detail page exposes the dostartu statute PDF, id extracted → registration_url=dostartu.pl/zawody/<id> (auto-enriched by pipeline apiEnrich for prices/distances/deadline); multi-line name cells split on <br>, umbrella=first line, full text drives is_kids; distances → enricher) |
| plus-timing.pl | 6-20 | fetch + JSON API (DataTables source) | Medium-High (Plus Timing co, Wielkopolska/Poznań-area; ALL fields from one call `wyniki.plus-timing.pl/api/api_dt.php?action=api_get_zapisy_biegi` — no detail fetches; not WordPress; multi-sport co → RUNNING-DISCIPLINE WHITELIST on `dyscyplina` keeps only "bieg uliczny"/"bieg(i) przełajow*", drops MTB/gravel/triathlon/kolarstwo/aquathlon/BnO orienteering/standalone kids; registration plus-timing-hosted at /zgloszenia/<slug>/ = registration_url=source_url (ISO-8859-2 form, event-specific content verified); regulamin_url + organizer website from API; is_kids recovered from a kids sibling sharing the umbrella base name; date in YYYY-MM-DD, undated 0000-00-00 rows dropped; distances `|`-split with Bieg/NW prefixes stripped + Polish decimal comma→dot; prices/deadline NOT in API → enricher; voivodeship geocoded from city) |
| biegnijmy.pl | 15-25 | Cheerio (imprezy calendar, custom PHP) | Medium-High (Rozbiegany Koszalin regional portal, Zachodniopomorskie — Koszalin/Białogard/Świdwin/Tychowo/Karlino/Manowo/Świeszyno; all events as `tr.bieg` rows on index.php?plik=imprezy&co=<YEAR>- (fetches current+next year), no detail fetches; clean ISO date+city, name from td.czarny, distances from "Dystans:" row, regulamin PDF + STRONA BIEGU website from anchors; source_url=ZAPISY page index.php?kat=zapisy/<id>-<city>&plik=zapisy (info page, not a form → registration_url left null for enricher search); NO discipline field → RUNNING FILTER by name drops cycling (rowerowy/kolarski/MTB)/triathlon/swim/ski + CANCELLED (odwołane), mixed bieg+rower events keep running distances; is_kids + event_types (trail/NW/charytatywny/uliczny) mined from name+distances; declared STRONA BIEGU kept even if Facebook; voivodeship geocoded from city; prices/deadline → enricher) |

### Pipeline architecture

```
scraper_* tables → scraper_all → calendar_events
        ↓               ↓              ↓
    (raw data)    (merged+enriched)  (public)
```

**Per-source tables:** `scraper_maratonypolskie`, `scraper_datasport`, etc. — raw scraper output, upserted by `source_id`.

**Merge table:** `scraper_all` — cross-source deduped + merged with priority (dostartu > biegiwpolsce > timekeeper > elektronicznezapisy > datasport > maratonypolskie).

**Public table:** `calendar_events` — published rows with `status = 'pending'` or `'active'`. Admin approves via `/calendar-events` → "Do przeglądu" tab.

### Running the full pipeline

The unattended daily pipeline runs automatically via the `scheduler` container at 08:00 Europe/Warsaw. To trigger ad-hoc:

```bash
# Trigger inside the running scheduler container
docker compose exec scheduler npm run pipeline

# Or use the wrapper (which does exactly that)
./scripts/daily-pipeline.sh
```

**The scheduler runs scrape + enrich only — it does NOT publish and does NOT run any claude-CLI step.** Specifically it runs (in `scheduler/src/pipeline.js` `STEPS`): run-scrapers → run-merge → run-dedup → run-geocode → run-enrich-flags → run-normalize → Python enricher (Ollama) → run-dedup → run-normalize → publish-landing-pages. It deliberately omits `run-publish.js` (publishing to `calendar_events` is a manual, human-reviewed host step) and the `claude`-CLI scripts `run-enrich-search.js` / `run-enrich-from-regulamin.js` (the backend image has no `claude`; run those on the host). On any non-zero exit it sends a SendGrid failure email; on full success with zero `scraper_all` rows merged/enriched today it sends a `[WARN]`. A 10:00 watchdog emails `[ALERT]` if the pipeline didn't run in the last 26h.

To run individual steps manually (debugging):

All backend steps run on the HOST (the backend is native; there is no long-running
backend container to exec into):

```bash
cd backend && node --env-file=../.env scripts/run-scrapers.js                            # 1
cd backend && node --env-file=../.env scripts/run-merge.js --apply                       # 2
cd backend && node --env-file=../.env scripts/run-dedup.js --apply                       # 3
cd backend && node --env-file=../.env scripts/run-geocode.js --apply                     # 4
cd backend && node --env-file=../.env scripts/run-enrich-flags.js --apply                # 5
cd backend && node --env-file=../.env scripts/run-normalize.js --apply                   # 6
docker compose --profile run-once run --rm enricher python -m enricher run              # 7
# Step 8 finds source URLs ONLY (registration_url + regulamin_url) — no field extraction.
# Step 8.1 extracts fields (distances, types, is_kids, prices, deadline, location,
# voivodeship) FROM the regulamin that step 8 located. The regulamin can be a PDF,
# a .docx, a plain HTML page, or a public Google Drive folder/file (per-distance
# regulamins) — acquireRegulamin() in run-enrich-from-regulamin.js handles all of
# them (PDF read natively by Claude; docx/html via textutil, Drive folder = download
# every file + pdftotext/textutil + concatenate). Both step 8 and 8.1 need the
# `claude` CLI, which is NOT in the backend Docker image — so neither does real Claude
# work in the automated scheduler (step 8's free dostartu apiEnrich aside). Run them
# from the HOST, where `claude`, `textutil`, and `pdftotext` are installed. Step 8.1
# must run AFTER step 8.
cd backend && node --env-file=../.env scripts/run-enrich-search.js --apply               # 8   (host)
cd backend && node --env-file=../.env scripts/run-enrich-from-regulamin.js               # 8.1 (host)
cd backend && node --env-file=../.env scripts/run-dedup.js --apply                       # 9
cd backend && node --env-file=../.env scripts/run-normalize.js --apply                   # 10
cd backend && node --env-file=../.env scripts/run-publish.js --apply                     # 11
cd backend && node --env-file=../.env scripts/publish-event-pages.js --apply             # post (manifest + OG images)
```

### Python Enricher — PRIMARY enrichment tool

**Location:** `enricher/` directory

**Tech stack:**
- **Ollama** — local LLM (gemma3:27b) for field extraction
- **SearXNG** — Docker-based web search for URL discovery
- **Crawl4AI** — headless browser for crawling SPAs (dostartu.pl, etc.)
- **Docling** — PDF text extraction for regulamin documents

**What it finds (URLs):** SearXNG search for the two source-of-truth URLs only:
- `registration_url` — sign-up page (search + live relevance check)
- `regulamin_url` — rules PDF/page (search + live relevance check)

It does **NOT** enrich `website` — that field was intentionally dropped from the enricher (no search, no extraction, no sync). Scraper-set `website` values still flow to `calendar_events` via the JS publish step.

**What it extracts (FROM THE REGULAMIN ONLY):** all remaining fields are extracted from the regulamin, in whatever format it arrives — a PDF (pypdf), a `.docx` (stdlib zip+XML, see `steps/docs.py`), a plain HTML page (Crawl4AI), or a public Google Drive folder/file of per-distance regulamins (each file downloaded + extracted + concatenated) — never the registration page, website, or navigated followups (those are used only to *discover* the regulamin):
- `distances` — overwrites only if more complete than scraper's
- `event_types` — `[trail, uliczny, nocny, ocr, nordic walking, ultra, charytatywny]`
- `price_from` / `price_to` — "opłata startowa" tables with date tiers
- `registration_deadline` — format YYYY-MM-DD, within 1 year of event date
- `voivodeship` / `location` — only fills empty, never overwrites scraper's geocoded value
- `is_kids` — true if any distance ≤ 1 km or dedicated children's category exists

**Performance:** ~2 min/event (LLM inference on 32B model).

**Why it's the primary tool:** Cost-free (local model), comprehensive (crawls pages + PDFs), more reliable than API-based enrichment.

See [enricher/README.md](enricher/README.md) for detailed documentation.

### Admin tools for calendar management

- **Do przeglądu** — `/calendar-events` → approve/reject pending events
- **Duplikaty** — `/calendar-events` → find and merge duplicate entries
- **Manual event entry** — `/calendar-events/new` — add events found on Facebook or elsewhere
- **Calendar events API** — `GET/POST/PATCH/DELETE /api/calendar-events`

### Potential future scraper targets

- **extremalny.pl** — OCR/obstacle races (50-100 events)
- **przeszkodowo.pl** — OCR/obstacle races
- **biegigorskie.pl** — mountain/trail only, yearly HTML tables (easy)
- **zawodybiegowe.pl** — all types (200-500 events)
- **ligabiegowa.pl** — road running league

## Local LLM Enricher

Python-based enrichment pipeline in `enricher/`. Validates URLs, searches SearXNG, crawls pages with Crawl4AI, extracts PDFs with Docling, and uses Ollama (gemma3:27b) for field extraction. Only processes future events (date >= today).

### Running

```bash
cd enricher
source .venv/bin/activate
docker compose up -d          # SearXNG
python -m enricher run         # process all un-enriched future events
python -m enricher run --force              # re-process already-enriched events
python -m enricher run --limit 5 --dry-run  # test run
python -m enricher sync --since today --dry-run  # preview sync to calendar_events
python -m enricher sync --since today            # push to calendar_events
python -m enricher audit                         # audit website URLs on future calendar_events (report-only)
python -m enricher audit --fields website,registration_url --limit 20
python -m enricher audit --apply                 # null mismatched fields on calendar_events AND scraper_all
python -m enricher audit --apply --apply-confidence 0.9  # stricter bar for nulling
```

**Audit command:** reviews outbound URL fields on `calendar_events`. Default is read-only: writes JSONL to `enricher/logs/audit-<ts>.jsonl`. With `--apply`, any `mismatch` verdict at confidence ≥ `--apply-confidence` (default 0.8) causes that URL field to be set to NULL on BOTH `calendar_events` AND the matching `scraper_all` row (joined by `source` + `source_id`, with a safety check that the scraper_all URL still equals the audited URL — prevents overwriting values that drifted post-audit). Match / uncertain / skipped rows are never touched. After applying, run `python -m enricher run --incomplete` to re-fill the nulled fields on scraper_all, then `python -m enricher sync` to push them to calendar_events. See `enricher/README.md` for report shape.

**`calendar_events.locked_fields`:** a `text[]` column listing column names whose values must not be overwritten by automated writers. Admin PATCH auto-appends edited field names here so human corrections stick. The enricher sync respects this list. (publishToCalendar is insert-only and therefore unaffected.)

See `enricher/README.md` for full docs, all flags, merge rules, and architecture.

### Dependencies
- Ollama (native macOS, `gemma3:27b` — 128K context window, strong instruction-following for structured extraction)
- SearXNG (Docker via `enricher/docker-compose.yml`, port 8888)
- Crawl4AI + Docling (Python libs in `enricher/.venv/`)

### Key merge safety rules
- Never downgrades trail/ocr/charytatywny/nordic walking → uliczny (scraper keyword evidence preserved)
- Never nulls a working URL without a replacement candidate
- Never overwrites existing voivodeship (geocoding is more reliable than LLM)
- Rejects deadlines >1 year from event date (catches hallucinated years)
- Allows price 0 for free events, rejects price_from > price_to
- Keyword chunk extraction feeds focused price/deadline sections to LLM (not raw 6k char dumps)

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

### Fonts (self-hosted in `public/`)
Fonts are self-hosted, NOT loaded from Google Fonts (a cross-origin font stylesheet
was the biggest render-blocking cost on mobile PageSpeed). The woff2 files (latin +
latin-ext subsets) live in `public/public/fonts/` with `@font-face` rules in
`public/public/fonts.css`; every page (`public/index.html` + the static page
generators) loads them via:
```html
<link rel="stylesheet" href="/fonts.css">
```
The admin `frontend/` app still uses the Google Fonts link — it is not public-facing.

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

## URL verification — REQUIRED before writing any URL to the DB

**A 200 OK response is NOT proof a URL is correct.** If you write registration_url / regulamin_url / website / source_url to scraper_* or calendar_events without doing this, you will hallucinate broken URLs into production. This already happened once in this codebase (datasport `wizardnew` URLs — looked fine, 302'd to a login page that stripped the race id, locked them, had to revert).

Before writing or constructing a URL pattern, you MUST:

1. **Follow the full redirect chain.** Use `curl -sIL` (capital L follows redirects) AND inspect every `HTTP/...` and `location:` header in the chain — not just the final status. A "200 OK" at the end might just be a generic login page or 404 page that returns 200.
2. **Confirm the destination has event-specific content.** Fetch the body and grep for the event name, the race id, the date — something that proves you landed on the right thing and not on a generic page.
3. **Prefer URLs the source's own UI exposes.** If you're trying to construct a registration URL, scrape the source's public event page and grep for what their own "Zapisz się" / "Register" button uses as `href`. That's almost always the correct answer. Don't reverse-engineer URL patterns from query-param guesses.
4. **For platforms that require login** (datasport, online registration sites, etc.) the registration URL must preserve the event identifier through the auth round-trip. Test by following the redirect chain — if the final URL has lost the race id, the URL is wrong even if it returns 200.
5. **If automated verification is impossible** (e.g. the page is a SPA, anti-bot blocks curl, content depends on cookies), STOP. Generate 3–6 concrete example URLs across different IDs and ask the user to click them and confirm. Better to pause than to write broken URLs at scale.

When you do construct a URL pattern in a scraper, the source comment must include: (a) the verification method, (b) the alternatives you ruled out and why, (c) whether user manual verification was used.

## Database write safety

**Before running any INSERT, UPDATE, or DELETE on any database (local Postgres or Supabase), you MUST:**

1. State exactly what will change — which table(s), which rows (with ID ranges or counts), which columns, what values
2. State the damage impact — is it reversible, what happens if it's wrong, does it affect synced data, other tables via cascades, production users
3. Wait for explicit user confirmation ("yes", "ok", "proceed", etc.) before executing

This applies to: `psql -c "DELETE..."`, `psql -c "UPDATE..."`, `psql -c "INSERT..."`, `mcp__supabase__execute_sql` with mutations, `mcp__supabase__apply_migration`, any ORM writes via scripts.

SELECT / read-only queries do NOT need confirmation.

Exception: if the user has just *explicitly* asked for the specific destructive action (e.g. "delete all race data for event X"), proceed without re-confirming, but still briefly state what you're about to do before doing it.

## /listy/* landing pages — URL slug rules

URL slugs for `/listy/*` pages MUST use ASCII-only characters. Polish diacritics are forbidden in slugs. Examples:
- `przelajowe` not `przełajowe`
- `polmaratony` not `półmaratony`
- `lodzkie` not `łódzkie`
- `dla-dzieci` stays `dla-dzieci`

HTML display text (H1, labels, link text, meta title/description, intro, JSON-LD) MUST use correct Polish characters with diacritics. Examples:
- H1: `Biegi przełajowe` not `Biegi przelajowe`
- H1: `Półmaratony w Polsce` not `Polmaratony w Polsce`
- Region display: `Łódź`, `Śląskie` — never strip diacritics for display

The mapping files (`biegi-mappings.js` in both `backend/scripts/lib/` and `public/src/lib/`) encode this: keys are ASCII slugs, values are Polish display text. These two files are duplicates — keep them in sync.

## Things to never do

- Do not use TypeScript (this is a JS project)
- Do not use Express (use Fastify)
- Do not use Prisma (use Drizzle)
- Do not use Socket.io (use `ws`)
- Do not use Next.js (use Vite)
- Do not dockerize Mosquitto (hardware constraint — R700 needs LAN access)
- Do not use `docker compose down -v` unless explicitly asked
- Do not pull data from Supabase into local DB EXCEPT via the sanctioned reverse-sync workers: `checkins`/`checkin_documents` (`checkinSync.js`), `checkpoint_observations` (realtime in `supabase.js`), and event config + results (`configSync.js` — `events, categories, participants, checkpoints, race_runs, results, event_documents`). Any NEW reverse-pull must stamp `synced_at = now()` and guard the ON CONFLICT update with `synced_at IS NOT NULL` (never clobber a locally-dirty row) — see `configSync.js`.
- Do not add TypeScript type annotations or `.ts` files
- Do not use peak RSSI for signal-strength bars — always use live (most recent) reading with decay. See ARCHITECTURE.md → "RSSI display rule — live signal, not peak"
- Do not create local copies of `estimatePositions()` — always import from `@leszyrun/ui` (shared package in `packages/ui/src/lib/positionEstimation.js`). A stale local copy caused a live-race bug where podium ordering ignored checkpoint timestamps. If you think the shared function needs changes, stop and ask the user first — the sorting tiers (finish time → checkpoint index → observation time → start time) are load-bearing for live race display.
- Do not re-run `estimatePositions()` inside `CategoryCard` when `resultsProp` is provided — the caller already enriched results with checkpoint observations. Re-estimating with empty observations discards checkpoint data and breaks podium ordering during live races. See the comment in `frontend/src/pages/PodiumPage.jsx`.
- Do not filter race runs to only `'active'` status in podium or public result views — always include `'finished'` too. Filtering only active causes the podium/results to go blank the moment a race is stopped. The podium and public views must keep showing final results after the race ends.
- Do not commit to `main` directly or leave commits stranded on an unmerged branch — branch → push → PR → merge back. See "Development workflow" above and `.claude/skills/dev-workflow/SKILL.md` (enforced by the branch-guard hook).
- Do not add `Co-Authored-By:` trailers to git commits. Never include Claude authorship in commit messages.
- Do not permanently delete calendar events without asking the user for confirmation first. Prefer rejecting (setting status to `rejected`) over deleting — rejected events prevent the scraper from re-adding the same junk.
- Do not DELETE rows from any Supabase table unless the user explicitly says "delete from [table name]". When asked to "remove" an event, ask which table(s) — never assume. Scraper source tables (`scraper_*`) are raw data and should almost never be touched directly.

