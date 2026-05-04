# Dockerized Pipeline Scheduler — Design Spec

**Date:** 2026-05-04
**Status:** Approved

## Problem

The daily scrape→enrich→publish pipeline is scheduled via macOS user crontab. It fails silently:

- macOS TCC Full Disk Access does not propagate from cron → bash → grandchild binaries (`node`), so `node --env-file=.env` fails with "ENOENT" inside the cron context. The 2026-04-30 and 2026-05-04 runs both died at step 1 of 11 with no notification.
- A 0-byte `pg_dump` problem went undetected for ~24h in late April until the 09:00 backup watchdog caught it. There is no equivalent watchdog for the pipeline.
- macOS cron is not visible: there is no `ps`-style way to confirm "the scheduler is running and healthy". Failures are only discoverable by reading the per-day log file.
- Cron's environment is opaque and brittle across macOS upgrades (FDA grants periodically reset).

The user is willing to accept that scheduled work is skipped while the laptop is off. The user is **not** willing to accept silent failures while the laptop is on.

## Goals

1. Move pipeline scheduling out of macOS cron into a long-running container, eliminating TCC/FDA flakiness.
2. Detect failures (non-zero exit at any step) and email an alert with enough context to debug.
3. Detect "ran but produced nothing" — pipeline exited 0 but no `calendar_events` rows changed today.
4. Detect missed runs (laptop was off, container was down, scheduler didn't fire) via a 09:00 watchdog.
5. Keep the existing `daily-pipeline.sh` workflow runnable by hand for ad-hoc execution and debugging.

## Architecture

Three new services added to the existing root [docker-compose.yml](../../../docker-compose.yml). The native macOS Ollama (port 11434) stays on host and is reached via `host.docker.internal:11434`.

```
┌──────────────────── leszyrun docker compose ────────────────────┐
│                                                                  │
│  scheduler (long-running)                                        │
│   ├── node-cron @ 08:00 → runPipeline()                          │
│   ├── node-cron @ 09:00 → runWatchdog()                          │
│   └── on failure → SendGrid → lpgornicki@gmail.com               │
│         │                                                        │
│         ├── docker compose exec backend node scripts/...         │  (steps 1–6, 8–11)
│         ├── docker compose run --rm enricher python -m ...       │  (step 7)
│         └── checks calendar_events row count via Supabase REST   │  (output verification)
│                                                                  │
│  enricher (run-once)                                             │
│   └── python 3.11 + crawl4ai + docling + playwright              │
│                                                                  │
│  searxng (long-running)                                          │
│   └── moved from enricher/docker-compose.yml                     │
│                                                                  │
│  backend, db, frontend (unchanged, already in compose)           │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
                          ↓                ↓                  ↓
              host Ollama :11434     Supabase REST          SendGrid
                                     (output verification)  (alert emails)
```

## Components

### 1. `scheduler/` (new directory)

Node application, separate from `backend/`. Runs as PID 1 in its own container.

**Files:**
- `scheduler/Dockerfile` — `node:20-alpine` base. Installs the docker CLI (`apk add docker-cli docker-compose`) so the scheduler can shell out to `docker compose exec/run` against sibling services. Installs node deps: `node-cron`, `@sendgrid/mail`, `html-to-text`, `@supabase/supabase-js`.
- `scheduler/package.json` — pinned deps.
- `scheduler/index.js` — entrypoint, wires up the two cron jobs, exits never.
- `scheduler/pipeline.js` — `runPipeline()` orchestrator. Defines the 11 steps, runs them sequentially, handles errors.
- `scheduler/watchdog.js` — `runWatchdog()`. Reads heartbeat file, alerts if stale.
- `scheduler/mailer.js` — SendGrid wrapper, mirrors [zatyrani.pl/api/shared/email.js](../../../../zatyrani.pl/api/shared/email.js).
- `scheduler/exec.js` — small helper that wraps `child_process.spawn` to capture exit code + last 50 lines of stderr.

**Container config (in root docker-compose.yml):**

```yaml
scheduler:
  build:
    context: .
    dockerfile: scheduler/Dockerfile
  environment:
    SENDGRID_API_KEY: ${SENDGRID_API_KEY}
    SENDGRID_FROM_EMAIL: ${SENDGRID_FROM_EMAIL:-noreply@leszy.run}
    PIPELINE_ALERT_EMAIL: ${PIPELINE_ALERT_EMAIL:-lpgornicki@gmail.com}
    SUPABASE_URL: ${SUPABASE_URL}
    SUPABASE_SERVICE_ROLE_KEY: ${SUPABASE_SERVICE_ROLE_KEY}
    TZ: Europe/Warsaw
    COMPOSE_PROJECT_NAME: leszyrun
  volumes:
    - /var/run/docker.sock:/var/run/docker.sock
    - ./logs:/app/logs
    - ./scheduler:/app/scheduler:ro
  depends_on:
    backend:
      condition: service_started
  restart: unless-stopped
```

The bind-mounted Docker socket lets the scheduler invoke `docker compose exec backend …` and `docker compose run --rm enricher …` against sibling containers in the same project.

`TZ=Europe/Warsaw` is critical — node-cron evaluates schedules in the container's local time. Without TZ, the container defaults to UTC and the 08:00 trigger would fire at 09:00 or 10:00 Polish time depending on DST.

### 2. `scheduler/pipeline.js`

```js
const STEPS = [
  { name: 'run-scrapers',      type: 'backend', cmd: ['node', 'scripts/run-scrapers.js'] },
  { name: 'run-merge',         type: 'backend', cmd: ['node', 'scripts/run-merge.js', '--apply'] },
  { name: 'run-dedup-1',       type: 'backend', cmd: ['node', 'scripts/run-dedup.js', '--apply'] },
  { name: 'run-geocode',       type: 'backend', cmd: ['node', 'scripts/run-geocode.js', '--apply'] },
  { name: 'run-enrich-flags',  type: 'backend', cmd: ['node', 'scripts/run-enrich-flags.js', '--apply'] },
  { name: 'run-normalize-1',   type: 'backend', cmd: ['node', 'scripts/run-normalize.js', '--apply'] },
  { name: 'enricher',          type: 'enricher', cmd: ['python', '-m', 'enricher', 'run'] },
  { name: 'run-enrich-search', type: 'backend', cmd: ['node', 'scripts/run-enrich-search.js', '--apply'] },
  { name: 'run-dedup-2',       type: 'backend', cmd: ['node', 'scripts/run-dedup.js', '--apply'] },
  { name: 'run-normalize-2',   type: 'backend', cmd: ['node', 'scripts/run-normalize.js', '--apply'] },
  { name: 'run-publish',       type: 'backend', cmd: ['node', 'scripts/run-publish.js', '--apply'] },
];
```

**Per step:**
- `type: 'backend'` → `docker compose exec -T backend <cmd>` — uses the already-running backend container (env, deps, network all resolved).
- `type: 'enricher'` → `docker compose run --rm enricher <cmd>` — one-shot container.
- Capture exit code; tee stdout/stderr to `logs/daily-pipeline-<YYYYMMDD>.log` (same path as today, preserving operator habits) **and** keep last 50 lines of stderr in memory for the alert email.
- On non-zero exit → abort remaining steps, send failure email, return.

**On all 11 steps OK:**
1. Query Supabase: `select count(*) from calendar_events where updated_at >= today_start_warsaw` and `… where created_at >= today_start_warsaw`.
2. If `updated + created == 0` → send `[WARN] pipeline ran clean but 0 calendar_events rows changed` email.
3. Write heartbeat: `logs/last-pipeline-ok.json` = `{ ts: ISO, durationMs, steps: [{name, durationMs, exitCode}], rowsCreated, rowsUpdated }`.

The verification rationale: a successful run that touches zero rows almost always means a structural break (Supabase down, all sources had no new events, run-publish silently no-oped). Worth investigating even if exit codes are all 0.

### 3. `scheduler/watchdog.js`

Runs at 09:00 Europe/Warsaw via the same node-cron instance.

```js
async function runWatchdog() {
  const heartbeatPath = '/app/logs/last-pipeline-ok.json';
  if (!exists(heartbeatPath)) {
    return sendMissedRunEmail({ reason: 'heartbeat file does not exist', lastSeenAt: null });
  }
  const { ts } = JSON.parse(read(heartbeatPath));
  const ageHours = (Date.now() - new Date(ts)) / 36e5;
  if (ageHours > 26) {
    return sendMissedRunEmail({ reason: `heartbeat ${ageHours.toFixed(1)}h old`, lastSeenAt: ts });
  }
}
```

26 hours, not 24, to absorb DST shifts and minor scheduling skew without false positives.

### 4. `scheduler/mailer.js`

Three exported functions, each loads `SENDGRID_API_KEY` lazily and throws if missing:

- `sendFailureEmail({ stepName, stepIndex, exitCode, stderrTail, logPath })` — subject: `[FAIL] LeszyRun pipeline step ${stepIndex}/11 (${stepName})`. Body: HTML with step info, exit code, last 50 lines of stderr in `<pre>`, log path on host (`/Users/derberg/Documents/GitHub/BeepBeep/logs/...`).
- `sendNoOutputEmail({ rowsCreated, rowsUpdated, durationMs })` — subject: `[WARN] LeszyRun pipeline ran but 0 rows changed`. Body: summary + suggestion to check Supabase health and source sites.
- `sendMissedRunEmail({ reason, lastSeenAt })` — subject: `[ALERT] LeszyRun pipeline did not run`. Body: reason + last successful run timestamp.

All three call a shared `send(msg)` that uses `@sendgrid/mail` and `html-to-text` to produce both HTML and plain-text variants — same pattern as zatyrani.pl.

### 5. `enricher/Dockerfile` (new)

Replaces the host-based `enricher/.venv/`. The enricher itself stays the same Python source; only the runtime location changes.

```dockerfile
FROM python:3.11-slim

# Crawl4AI / playwright deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates wget gnupg \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libxkbcommon0 libxcomposite1 \
    libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app/enricher
COPY enricher/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
RUN playwright install --with-deps chromium

COPY enricher/ ./
CMD ["python", "-m", "enricher", "run"]
```

`enricher/requirements.txt` will be derived from the existing `enricher/.venv/` (`pip freeze > requirements.txt`).

**Service definition in root compose:**

```yaml
enricher:
  build:
    context: .
    dockerfile: enricher/Dockerfile
  environment:
    OLLAMA_HOST: http://host.docker.internal:11434
    SEARXNG_URL: http://searxng:8080
    SUPABASE_URL: ${SUPABASE_URL}
    SUPABASE_SERVICE_ROLE_KEY: ${SUPABASE_SERVICE_ROLE_KEY}
    TZ: Europe/Warsaw
  extra_hosts:
    - "host.docker.internal:host-gateway"
  depends_on:
    - searxng
  profiles: [run-once]   # not started by `docker compose up` — only via `docker compose run`
```

The `profiles: [run-once]` keeps `docker compose up -d` from auto-starting it; the scheduler invokes it with `docker compose --profile run-once run --rm enricher`.

### 6. `searxng` service (moved from enricher/docker-compose.yml)

Identical config, just lifted into the root compose. `enricher/docker-compose.yml` is deleted.

## Data flow & networking

| Caller            | Target                       | Address                                       |
|-------------------|------------------------------|-----------------------------------------------|
| scheduler         | backend (exec node scripts)  | docker socket → `compose exec`                |
| scheduler         | enricher (run python)        | docker socket → `compose run --rm`            |
| scheduler         | Supabase (verification)      | `${SUPABASE_URL}` (public DNS)                |
| scheduler         | SendGrid (alerts)            | `api.sendgrid.com`                            |
| backend (existing)| db                           | `db:5432` (compose network, unchanged)        |
| backend (scripts) | Supabase                     | `${SUPABASE_URL}`                             |
| enricher          | Ollama (host)                | `host.docker.internal:11434`                  |
| enricher          | searxng                      | `searxng:8080` (compose network)              |

All three new services join the existing default compose network. No new networks.

## Migration steps

1. Generate `enricher/requirements.txt` from current `enricher/.venv/` (`pip freeze`).
2. Add `enricher/Dockerfile`.
3. Delete `enricher/docker-compose.yml`. (Confirmed: only contains `searxng` definition; no other consumers in repo.)
4. Add `scheduler/` directory with all 7 files listed in §1.
5. Extend root `docker-compose.yml` with `scheduler`, `enricher`, `searxng` services.
6. Add `SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL=noreply@leszy.run`, `PIPELINE_ALERT_EMAIL=lpgornicki@gmail.com` to `.env` and document them in CLAUDE.md.
7. **Verify `noreply@leszy.run` is a verified single-sender or domain in SendGrid before first deploy.** If not yet verified, the first email will silently 403. Solution: verify in SendGrid dashboard, or temporarily fall back to `biuro@zatyrani.pl` (already verified for zatyrani.pl).
8. Replace [scripts/daily-pipeline.sh](../../../scripts/daily-pipeline.sh) with a thin wrapper:
   ```bash
   #!/usr/bin/env bash
   exec docker compose exec scheduler npm run pipeline
   ```
9. Disable the `0 8 * * *` cron entry in user crontab. Keep the 6h pg_dump and 09:00 backup watchdog.
10. `docker compose up -d --build scheduler searxng` (enricher is build-only at this stage; will be invoked by scheduler).
11. Manual smoke test: `docker compose exec scheduler npm run pipeline` — confirm all 11 steps run, heartbeat is written, no email fired.
12. Force-failure test: temporarily set `SUPABASE_URL=` invalid → run pipeline → confirm failure email arrives at lpgornicki@gmail.com.
13. Force-watchdog test: delete heartbeat file → run watchdog manually → confirm missed-run email arrives.

## Failure modes & mitigations

| Failure                                              | Detection                                | Mitigation                                                                          |
|------------------------------------------------------|------------------------------------------|-------------------------------------------------------------------------------------|
| Step exits non-zero                                  | `child_process.spawn` exit code          | Failure email + abort. Operator inspects log on host filesystem.                    |
| Step hangs forever                                   | Per-step timeout (default 30 min)        | Kill with SIGTERM, treat as exit code 124, send failure email.                      |
| All steps OK, 0 rows changed                         | Supabase REST count query                | "[WARN] 0 rows changed" email.                                                      |
| Container crashed overnight (Docker Desktop quit)    | Heartbeat older than 26h at 09:00        | Watchdog email.                                                                     |
| Laptop off at 08:00                                  | Same — heartbeat stale at 09:00 next day | Watchdog email next time machine boots and watchdog fires.                          |
| SendGrid down                                        | `sgMail.send()` rejects                  | Logged to stderr (visible in `docker logs scheduler`). No retry — don't compound.   |
| Ollama not running on host                           | enricher step exits non-zero             | Failure email naming `enricher` step.                                               |
| `noreply@leszy.run` not verified in SendGrid         | First send returns 403                   | Documented in migration step 7. Fallback `biuro@zatyrani.pl`.                       |

## Out of scope

- **Pipeline-step content changes.** This refactor moves *where* the pipeline runs, not *what* it does. Step ordering, dedup logic, enrichment behavior all remain identical.
- **Catching up on missed runs.** If the laptop was off at 08:00, the run is skipped; the operator can manually invoke `daily-pipeline.sh` after boot. (Per user direction.)
- **Multiple alert recipients.** Single recipient for now. Easy to extend `PIPELINE_ALERT_EMAIL` to comma-separated later.
- **Slack/Telegram alerts.** Email only for v1.
- **Backups.** The 6h pg_dump cron and 09:00 backup watchdog stay in user crontab — they work and are unrelated to this refactor.
- **Scheduling jobs other than the daily pipeline.** Future scheduled work (e.g. weekly reports) can reuse this scheduler container, but is not in this design.

## Testing

After implementation:

1. **Unit-light smoke tests** for `scheduler/exec.js` (exit code capture) and `scheduler/mailer.js` (constructs valid SendGrid payload). No full network test in CI — manual SendGrid send during migration step 12 is the integration test.
2. **Manual end-to-end smoke** as described in migration steps 11–13.
3. **Observe one full overnight cycle** before disabling the cron entry — run new scheduler in parallel with old cron for 1 day, compare logs, then cut over.

## Decisions taken (no further input needed)

- Email recipient: `lpgornicki@gmail.com`.
- From: `noreply@leszy.run` (operator to verify in SendGrid before cutover).
- Searxng: moved into root compose; per-app compose file deleted.
- Docker socket mount over `dockerode`: shell out to `docker` CLI from scheduler. Less abstraction, fewer deps, easier to reason about. The scheduler's `Dockerfile` installs the docker CLI binary.
- node-cron over agenda/bull/etc: in-process scheduler is sufficient for two jobs/day. No persistence layer needed; missed runs are caught by the watchdog.
- 26-hour staleness threshold for the watchdog (not 24h) to absorb DST and minor skew.
- Per-step 30-min timeout default. Step 7 (Python enricher) often runs 30+ min on large batches — its timeout is overridden to 4 hours.
