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
  `git push -u origin feature/<name>` → `gh pr create --fill` → `gh pr merge --squash` → confirm `gh pr view --json state` says
  `MERGED` → `git push origin --delete feature/<name>` → `scripts/worktree.sh rm feature/<name>`.
  Never delete the branch before `MERGED`: a deleted head branch closes the PR unmerged.
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
- Public legal pages: `/polityka-prywatnosci`, `/privacy-policy`, `/regulamin`, `/reklamacje`, `/podmioty-przetwarzajace`

**Bumping privacy policy version:** edit `POLICY_VERSION` in [public/src/lib/policyVersion.js](public/src/lib/policyVersion.js). The cookie banner detects mismatch and re-prompts every user automatically.

**Data subject rights endpoints:**
- `POST /functions/v1/export-my-data` — returns JSON export of user data (Art. 15/20). Covers the profile, badges, consent log, favourites, contributions, club membership + `club_membership_log` + owned clubs, **race entries** (`participants` matched by email — the same rows `delete-my-account` anonymises, so the system already treats them as this person's data) and **club invitations addressed to them**. Race registrations are included too: `registrations` matched by `profile_id` or email, their `consent_acceptances`, and `registrations_as_guardian` (rows where the person is the guardian of a minor).
- `POST /functions/v1/delete-my-account` — two-step OTP soft delete (Art. 17). It erases the profile's PII, deletes the favourites and club rows, **revokes every `auth_sessions` row** (a soft delete fires no FK cascade, so without this the browser that just deleted the account kept a valid 90-day cookie and could write the erased fields back), and **retires the address in `deleted_email_hashes`** — a SHA-256, never the plaintext. `auth-request-code` and `auth-verify-code` refuse a retired address, which is what makes "email is NOT released after deletion" true. It previously rested on a `supabase.auth.admin` ban, which could never work: this app creates no `auth.users` rows (`auth-verify-code` mints a profile with `crypto.randomUUID()`), so the ban failed and was swallowed. For race registrations it **anonymises the person's `registrations`** (the slot stays taken, so `taken` never drops), **clears the guardian fields on rows where they are the guardian**, and **nulls `ip` and `user_agent` on the `consent_acceptances` they gave**.

**Username is claimed once, at onboarding, and cannot be changed** (`_shared/usernameChange.js`, 409 from `update-profile`). There is no rename and no redirect: `/u/<username>` is a public page other pages link to and has no history table behind it — unlike a club slug, which parks former slugs in `club_slug_history` and keeps redirecting — so a rename would break every inbound link AND free the old handle for somebody else to claim. Someone who needs a change writes in and it is done by hand.

**Consent audit trail:** every accept/reject choice on the cookie banner is logged client-side (localStorage with timestamp + policyVersion + userAgent) and, for authenticated users, server-side to the `consent_log` table via the `log-consent` edge function.

**Retention:** `gate_events` and `gate_crossings` are purged 90 days post-race by the scheduler container's daily cron job at 03:00 Europe/Warsaw. At 03:40 the same container runs `backend/scripts/purge-auth-tables.js --apply`, which deletes `auth_sessions` more than 7 days past expiry, `auth_codes` more than a day past expiry and `otp_throttle` windows older than a day — nothing used to delete them, so every session token and code hash ever issued accumulated, and `auth_sessions` rows carry the plaintext email of accounts since deleted. Run it by hand without `--apply` to see the counts. **Registration contact data:** the `purge_registration_contact_data()` pg_cron job `purge-registration-contact` runs at 01:30 UTC (02:30 Warsaw in winter, 03:30 in summer) and nulls the registration phone and ICE (emergency contact) data, plus `participants.phone` for registration participants, for events whose Warsaw event date is at least 30 days past. What it guarantees: Supabase holds no such phone after the night's run. What it does not: a timing host's copy. configSync carries the null to every host row that is clean (`synced_at` set); a host row that is dirty when the job runs (an operator edited that participant) is not overwritten, and its next push sends the old phone back to Supabase, where it stays until the next night's run nulls it again. A host that is offline or has sync disabled keeps its copy indefinitely. So after the race the operator runs `cd backend && node --env-file=../.env scripts/purge-registration-contact.js` on each host (dry run by default, `--apply` writes). It nulls the phone on that host whether the row is clean or dirty, and the push then sends the null. No other automatic retention purges.

**Admin actions:** every admin write (calendar event approval, club merge, contribution review, etc.) is logged to `admin_actions` table with admin_user_id, target, payload, ip, user_agent. Append-only, service_role only.

**Organizer actions:** every organizer write (agreement acceptance, payout change, waitlist join) is logged to `organizer_actions` (`actor_id`, `club_id`, `event_id`, `action`, `target`, `payload`, `ip`, `user_agent`). Append-only, service_role only, written by `logOrganizerAction`. `export-my-data` returns the person's `organizer` block (agreements, actions, payout changes, waitlist requests). `delete-my-account` keeps `organizer_agreements` including ip and user agent (evidence of the contract, Art. 17(3)(e)), `club_payout_history` and `registration_waitlist`, and nulls `ip`/`user_agent` on the person's `organizer_actions` rows.

**Club membership lifecycle log:** every join/leave/remove/role-change on a club is appended to `club_membership_log` (`club_id`, `user_id`, `event` — `joined`/`left`/`removed`/`role_changed`, `role`, `actor_id`, `occurred_at`). Append-only, service_role only — same access pattern as `admin_actions`, but scoped to club membership rather than admin actions.

## Race devices: read `readme-internal.md` first

Before connecting to, deploying to or debugging a race Pi (checkpoint1,
checkpoint2) or an R700 reader, read `readme-internal.md` in the root of the
main checkout. It holds each device's Tailscale address, the SSH user, the
passwords and the per-host setup. It is local only: `.git/info/exclude` keeps it
out of git, so it is absent from worktrees and from every clone. Read it at
`/Users/derberg/Documents/GitHub/BeepBeep/readme-internal.md`, and never copy
its contents into a tracked file.

Reach a Pi by its Tailscale address before trying `.local`. On 2026-10-14 the
phone hotspot stopped passing traffic between the Mac and checkpoint1, even
though both were on it and both had internet.

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

## Registration test stack (local Supabase, never production)

Online-registration tests live in `tests/registration/` and run against a local Supabase stack
(`supabase start` + `supabase functions serve`). `localEnv()` refuses any URL that is not
`http://127.0.0.1`; the older `supabase/functions/tests/` suite (production smoke) is not extended.
Emails the functions send go to an email capture server on `:54399` (`helpers/emailCaptureServer.js`,
`messagesTo` / `lastCodeFor`); `sessionFor(email)` logs a test user in without email. Playwright
actors (`tests/registration/e2e/`) drive the public app against the same stack. Needs Docker and the
Supabase CLI. Full instructions: [tests/registration/README.md](tests/registration/README.md).

```bash
node tests/registration/helpers/emailCaptureServer.js &
tests/registration/start-stack.sh && supabase db reset && (supabase functions serve --env-file tests/registration/functions.env &)
node --test --test-concurrency=1 "tests/registration/**/*.test.js" && npx playwright test -c tests/registration/playwright.config.js
```

CI runs the same steps (plus backend and public unit tests) in `.github/workflows/registration-tests.yml`
on every pull request. Every scenario and the test that covers it is listed in
[docs/registration/scenario-matrix.md](docs/registration/scenario-matrix.md): add a row for each new one.
Never run the backend from a worktree against the Mac's real database or a production `SUPABASE_URL`.

## Environment variables

Backend (native process reads repo-root `.env` via `--env-file-if-exists`; the pipeline's
one-shot containers get theirs from docker-compose.yml):
- `DATABASE_URL` — postgres connection string (native default: `localhost:5432`)
- `MQTT_URL` — native default `mqtt://localhost:1883` (in-container: `mqtt://host.docker.internal:1883`)
- `PORT` — default 3001
- `SUPABASE_URL` — optional, sync disabled if missing
- `SUPABASE_SERVICE_ROLE_KEY` — service_role key (NOT anon/publishable), bypasses RLS. Backend only. Sync disabled if missing.

Frontend (both optional — unset, the admin panel calls port 3001 on whatever host
served the page, so one build works over `localhost`, `.local` and Tailscale; set
them only when the backend runs on a different machine):
- `VITE_API_URL` — e.g. http://localhost:3001
- `VITE_WS_URL` — e.g. ws://localhost:3001

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
- **A migration's timestamp must be LATER than every migration already applied to Supabase.** `supabase db push` refuses a file that sorts before the last applied one ("Found local migration files to be inserted before the last migration on remote database") and fails the whole release — so nothing after it deploys either, including the edge functions. This bites when two branches are open at once and the one with the EARLIER timestamp merges second, which is exactly what happened on 2026-09-29. Check `mcp__supabase__list_migrations` (or the last green release) before naming the file, and if it has already been overtaken, rename it to a later timestamp — safe precisely because it was never applied.
- **DDL changes MUST be applied to both local DB and Supabase.** Local DB uses Drizzle migrations (auto-run on backend start). **Supabase schema changes are a committed SQL migration in `supabase/migrations/` (create with `supabase migration new <name>`), applied to prod by `supabase db push` in the CI release pipeline (`.github/workflows/supabase-release.yml`) on merge to `main` — NOT via MCP `apply_migration` or ad-hoc SQL.** Every schema change touching a table that exists in both DBs requires both the Drizzle migration (local) and a committed Supabase migration. See [docs/supabase-release-runbook.md](docs/supabase-release-runbook.md).
- **`clubs` is readable by `anon` only where `is_public = true`**, and the club tables (`clubs`, `club_members`, `club_invites`, `club_membership_log`, `club_slug_history`) plus `event_notifications` and `event_favorites` have `REVOKE ALL … FROM anon, authenticated` — the same lockdown the `scraper_*` tables get, because RLS does not govern TRUNCATE. The club picker is unaffected: `search_clubs` is SECURITY DEFINER. Every other club read goes through an edge function on the service role.
- **Client roles never hold TRUNCATE on any `public` table** (`20261029120000_revoke_client_truncate.sql`): it is revoked from `anon` and `authenticated` on every table, and from the `postgres` default privileges too, so a table created by a later migration does not get it back.
- **Every edge function starts with `guardRequest(req)`** (`_shared/cors.js`): it answers the preflight AND refuses a request whose `Origin` is not ours. CORS headers alone never stopped anything — they decide whether the browser hands the *response* back, while the request already ran, so a page on any origin could POST to `/edge/delete-club` with `credentials: 'include'` and `Content-Type: text/plain` (no preflight) and the session cookie went along. A request with no `Origin` passes: that is a server, not a browser, and every local dev port (`localhost`/`127.0.0.1`) is allowed because `scripts/dev.sh` serves the public app on 3002 while `public/package.json` uses 5173 and `vite preview` uses 4173. The load-bearing half of the fix is the cookie: `SameSite=Lax`, never `None` — it is set through the same-origin `/edge` proxy, so `None` bought nothing and cost exactly this. The cookie is host-scoped to `www.leszy.run` and is never sent to `*.supabase.co`, so the `Origin` check is defence in depth for the proxied path.
- **Rate limits and attempt counters must be one statement.** `_shared/throttle.js` and the login-code attempt counter both used to SELECT, decide, then UPDATE, which under concurrency lets every request read the same value and pass. They now go through `claim_throttle_slot` / `claim_auth_code_attempt` (migration `20260929230000_atomic_auth_throttles.sql`), where the write IS the check. A new SECURITY DEFINER function needs an explicit `REVOKE … FROM anon, authenticated` — Supabase grants EXECUTE to both by default.
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
| `vision:sighting` | the `vision_sightings` row, roster-resolved | camera reader closed a track |
| `vision:health` | `{ sessionId, health, verdict }` | every camera ingest poll (~1 s) |

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

**FINISH = the peak of the pass.** A started participant's first read past
`min_finish_seconds` opens a finish pass. Every stronger read becomes the new peak. The
pass closes once 2 s go by with no stronger read (`FINISH_QUIET_MS`), and never later
than 6 s after its first read (`FINISH_MAX_PASS_MS`), so a finisher who stops under the
antenna cannot keep moving their own time. The finish gets the peak's timestamp. The
checkpoint agent (`checkpoint-agent/src/confirmer.js`) uses the same rule
(`PASS_QUIET_MS`, `PASS_MAX_MS`).

The pass used to be a fixed 3 s window from the first read. At the 2026-10-15 rehearsal
the gate heard bib 4 4.5 s before its peak. The window closed while the runner was still
walking in, and the finish came out 1.58 s early at −64.5 dBm instead of the −33 dBm
read at the line. Two more runners peaked within 0.12 s of that window closing.
After confirmation (`finishedParticipants`) later reads never re-time the finish, but
are still written to `gate_events` for 10 s (`FINISH_AUDIT_WINDOW_MS`).

Finish used to be first-read: the first read above `rssi_threshold` was the finish.
That let the floor decide the finish time. At the 2026-08-07 night race the floor was
`-6500` and all 36 finish peaks sat between `-6000` and `-6500`, the histogram rising
right up to the floor: the floor was cutting the passes off. Three runners got no
finish, and five got one from a read minutes later, when they walked back past the
gate. A lower first-read floor only moves the finish earlier, to wherever the tag is
first heard. There is no force-confirm timer (`fallback_seconds` is unused).

State maps:
- `inRange`: open passes. Start key `"${epc}:${raceRunId}"`, finish key `"${epc}:${raceRunId}:finish"`, value `{ epc, raceRunId, firstAt, peakRssi, peakTime, antennaPort, topic, goneTimer }`
- `recentWindow`: dedup within 200 ms per EPC
- `startedParticipants`: `Set<participantId>` per race (in-memory, avoids DB lookup per crossing)

Flow per reading (above `rssi_threshold`; weaker reads are ignored entirely):
1. Participant already started (or finish topic in separate mode) and past `min_finish_seconds` → open the finish pass on the first read; a stronger read moves the peak and re-arms a 2 s timer, capped at 6 s after the first read; the pass closes when the timer fires
2. Not started, tag not in `inRange` → create entry, arm `goneTimer` (goneWindowMs)
3. Not started, tag in `inRange` → update peak if improved; reset `goneTimer`
4. `goneTimer` fires (silence for goneWindowSeconds) → `confirmCrossing(peakTime)` → `gate = start`, add to `startedParticipants`
5. When `confirm_rssi_cdbm` is set, a pass, start or finish, whose peak is below it is dropped: a dropped start falls through to gun-time backfill, a dropped finish leaves the runner on course

See the mermaid flowchart at the top of `crossingDetector.js` for a full diagram.

Configurable per event (stored in `events` table):
- `rssi_threshold`: default `-9000` cdbm (was `-6500` until 2026-10-15, `-5000` before 2026-08-17), below anything the R700 reports, so every read is followed. The **tracking floor**: reads weaker than it are ignored and not persisted to `gate_events`. Raw `rfid:raw` broadcast is unaffected. Peak-of-pass timing on both gates is what makes a missing floor safe: a weak read can no longer set a time. Events created before the change keep their stored value, so check it before a race: Wilczy Półmaraton 2026 still had `-5000`, which would have timed almost nobody.
- `confirm_rssi_cdbm`: **NULL by default = disabled.** The **crossing bar**: when set, the PEAK of a start or finish pass must reach it, or the pass is dropped. It is the per-event answer to a tag heard from far away (a runner on a stretch of course near the gate, a bib in a bag by the tent) becoming a crossing. `stopRace`'s pending flush applies the same bar. It stays off by default because a runner 5 m before the antennas reads −70…−77 dBm (measured 2026-10-15), so a bar near the old floor drops real passes.

  **Set it only after measuring a separation at your gate.** Measured at the 2026-08-07 race: runners who physically passed *right next to the antenna* peaked at **−62…−64,5 dBm**, while others on the same pass peaked at −32 dBm. That **~32 dB spread between identical passes** is almost certainly tag orientation/placement (900 MHz is heavily absorbed by the body; a bib worn flat and forward vs. curled or against skin easily accounts for 20–30 dB), possibly antenna coverage nulls. **No threshold fixes that**; it can only choose whom to lose. Widen the gap with geometry instead: narrow the lane, bring runners within ~1.5 m of the antenna.

  Diagnose weak runners per antenna:
  ```sql
  SELECT p.bib_number, p.last_name, ge.antenna_port,
         count(*) AS pings, min(ge.rssi_cdbm) AS worst, max(ge.rssi_cdbm) AS best
  FROM gate_events ge JOIN participants p ON p.rfid_epc = ge.epc
  WHERE ge.race_run_id = '<RACE_RUN_ID>'
  GROUP BY 1,2,3 ORDER BY best ASC;
  ```
  Weak runners clustered on one port → antenna problem. Spread across all ports → tag/bib problem. `gate_crossings.peak_rssi_cdbm` records each confirmed crossing's peak, so low-confidence crossings can be reviewed **after** a race.
- `gone_window_seconds`: default `3` s. The silence that closes a START pass. The finish does not use it
- `min_finish_seconds`: default `300` s (was `30`). Reads within this window after the gun never open a finish pass. With no floor a runner leaving the shared start/finish gate stays audible for well over 30 s; lower it only for short test loops
- `gun_backfill_seconds`: default `60` s — after this long from the gun, checked-in runners not read at the start line get gun time as their start (`startTimeSource='gun'`, `startTimeTrigger='auto_backfill'`) so their next crossing counts as a finish. A runner with no check-in never gets gun time, from this timer or from the finish-crossing fallback, so stopping the race leaves them DNS rather than DNF. Check-ins are read when the gun time is assigned, not at race start, because a last-minute check-in reaches the local DB through `checkinSync` up to 30 s later
- `gun_backfill_enabled`: default `true` — set `false` to disable automatic gun-time backfill entirely: neither the timer nor the finish-crossing fallback assigns gun time, so start-less runners stay start-less until manual backfill (`POST /races/:id/assign-gun-start`, UI "Nadaj czas strzałki"). Runners read normally at start keep both netto (`duration_ms`) and brutto (`gun_duration_ms`)
- `fallback_seconds`: **unused** (column kept for compat): the old finish force-confirm timer
- `decline_threshold_cdbm`: **unused** (column kept for compat) — no reference anywhere in `crossingDetector.js`; it is PATCHable but does nothing. Use `confirm_rssi_cdbm` for strength gating.
- `rfid_mode`: `'single'` (default) or `'separate'`
- `rfid_topic_main`: default `'leszyrun'`
- `rfid_topic_finish`: default `'leszyrun/finish'` (only used when `rfid_mode = 'separate'`)

**Chip vs volunteer finish: the chip decides, the admin view flags.** A checkpoint marked
`is_finish` ("Ręczna meta" in the checkpoint dialog) holds the volunteer's finish entries.
The live view (`Przegląd trasy`, `frontend/src/pages/Results.jsx`) highlights the finish
cell in amber when the chip finish and the volunteer entry differ by more than 60 s
(`FINISH_MISMATCH_MS` in `frontend/src/lib/volunteerFinish.js`), or when the volunteer saw a
runner the chip never finished. Clicking it opens the editor pre-filled with the volunteer's
time. Nothing changes a result automatically: the user chose to keep the chip on top and
review by hand. On 2026-08-07 five chip finishes came 1.4 to 15.5 min after the volunteer's
entry, read when the runners walked back past the gate; a volunteer normally types the bib
1 to 26 s after the chip.

**Chip tie: the admin view flags, a person orders.** Two finishers of one race run whose
chip finishes are less than 500 ms apart (`CHIP_TIE_MS` in `frontend/src/lib/chipTie.js`)
get a cyan finish cell in `Przegląd trasy` and a "Remisy chipowe" count in the header. The
chip cannot order them: each finish is its own tag's peak read, and a tag is read every 50
to 250 ms. At Wilczy Półmaraton 2026-10-17 bibs 203 and 201 finished 28 ms apart in that
order, while the photo and the volunteer had 201 first. The popover's "#N pierwsza" / "#N pierwszy" button
sets that runner's finish 1 ms before the group's earliest one, or re-saves it when that runner is
first already. Either save sets `manual_override`, and a group holding a manual finish is
no longer flagged.
"Zdjęcia" in the same popover opens the camera frames from 3 s before to 1 s after the
group's first chip finish (`TieFramesDialog`, the review panel's frames endpoint), on the
frame nearest it, with each frame's wall time against each runner's chip time. It appears
only where a `vision_sessions` row was recording at that moment, so only on the host that
ran the camera. The camera takes a frame every 200 ms, so a frame shows the order, not the
millisecond.

## Vision bib recognition (`vision/`)

A camera at the finish gate reads bib numbers from photographs, as a second
source for runners the chip missed. Phase 0 only: the goal is a measured read
rate, not a running system. Design:
`docs/superpowers/specs/2026-09-30-vision-bib-recognition-design.md`, plan:
`docs/superpowers/plans/2026-09-30-vision-bib-phase0.md`. Both paths are
gitignored, so specs and plans here are never committed and never get a pull
request.

**What it is.** A second source at the finish gate. It never outranks a chip
read, and it is not a photo finish. The timestamp target is 0.5 s.

**Time source precedence: chip, then camera, then volunteer.** Sources never
cancel each other. Each keeps its own value and the displayed result is
derived, so changing the precedence later re-derives correctly instead of
discovering the old value is gone. Precedence applies only where two sources
both hold a value for the same runner: a volunteer entry with no camera
sighting is never touched, because a bib under a zipped jacket is invisible to
the camera and obvious to a person.

**A sighting auto-applies only into an empty chip slot.** Where a chip time
exists the sighting is stored for the record and never offered. Where none
exists it applies, including over a volunteer time, and one click in the admin
screen switches back. None of that is built yet; it is Plan 2, and only if
phase 0 passes.

**`vision/` is Python.** Second carve-out from the JavaScript-only rule after
`enricher/`, because `picamera2` and the recognition runtimes are Python only.
Anything touching a database stays Node.

**Nothing in `vision/` reaches the network or a database.** Photographs never
leave the machine that captured them. No Supabase client, no cloud, no
processor, no cross-border transfer. That property is most of why the data
protection position is defensible, so keep it even when it is inconvenient.
**The transport out is a file, and only a file:** `read_queue.py` appends to
`sightings.jsonl`, writes bib crops and rewrites `health.json`; the Fastify
backend on the same Pi tails those and owns every database write. If you ever
need the camera to tell the app something new, add a field to that log — do
not give Python a socket.
The one file going the other way is `recording.json` in the queue directory,
which the backend writes and capture only reads.
Clauses for the regulamin, the privacy policy and the ROPA are drafted in
[docs/gdpr/vision-bib-recognition-klauzule.md](docs/gdpr/vision-bib-recognition-klauzule.md).
The basis is contract performance, not consent, and the system reads numbers,
never faces.

**The digit recognizer trains on synthetic renders**, generated by
`vision/synth/render.py` from the real bib design using the bundled
`fonts/BarlowCondensed-ExtraBold.ttf`.

**The torso reader (`vision/torso.py`) trains on real race photographs, with
runners held out.** It reads the number from the torso band of each person
box, without locating the bib first, because a block about 30 px tall is too
small for the colour locator: at Wilczy Półmaraton 2026-10-17 the old path
read 3 of 196 finishers. `scripts/train_torso_reader.py` trains it on torso
crops labelled by reading the bibs and checked against the chip roster, plus
bibs pasted onto spectators by `vision/synth/paste.py`. Runners are split by
bib number and the held-out share never reaches training. Quote read rate,
wrong reads and spectator false reads from held-out runners only; a figure
from runners the model trained on proves nothing. The labels, crops and
weights stay next to the frames and out of git, because they come from
photographs of people. `VISION_TORSO_MODEL` points at the weights, several
files separated by `:` are averaged (each on one thread); without
them the pipeline runs the colour locator alone. `read_people()` in
`vision/pipeline.py` combines the two readers: the colour locator's read
counts only for a block no bigger than the person, two different numbers
refuse the person, one number read in two boxes of a frame stays with the
surer box (a runner's torso crop can hold the neighbour's bib), and "no bib"
from the torso reader votes against a number in `Tracker`, but only within
`VOTE_WINDOW_FRAMES` (10) of that number's reads, so a runner who walks
through a spectator's track keeps the number. The person detector runs at a
0.3 floor (`PERSON_CONFIDENCE`), and the colour locator only on people at
least 0.46 of the frame tall, the smallest that can carry a block it reads;
on every box it made a frame half as slow again. `Tracker` pairs boxes with
tracks best overlap first across the whole frame, and never joins boxes whose
heights differ by more than 1.5x (`MAX_HEIGHT_RATIO`): a runner passing in
front of a spectator standing further back is a different person. Predicting
each runner's motion was tried and lost as many finishers as it found. A box
no track matched by overlap still continues an unclaimed track seen in the
previous frame when it is up to 2x taller and holds 70 percent of that
track's last box (`APPROACH_*`): a runner closing on the camera outgrows the
overlap test, and the one-frame fragment's misread (12 for 112) stood alone.
On the 2026-10-17 replay this removed 3 of 5 misreads and lost no finisher;
0.65 lost bib 39 and 0.75 kept a misread, so re-measure before moving it.
Replayed on 2026-10-17 this reads 147 of 196 finishers with 4 confident
misreads.

**Phase 0 is a gate.** `scripts/measure_read_rate.py` prints read rate, wrong
rate and spurious count. Judge the wrong rate first: a missed runner leaves a
gap a person fills, while a wrong number gives somebody else's time to a
runner and nobody notices.

**Pinned dependencies with reasons, per platform.** On macOS
`mediapipe==0.10.21`, because 1.0.x aborts on macOS arm64 asking for a Metal
service that is not there, and `numpy<2` follows. On the Pi the reverse:
0.10.21 has no linux-aarch64 wheel and Python 3.13 has no numpy<2 wheel, so
Linux gets `mediapipe>=1.0` on the apt numpy 2 (plus `libgles2` from apt).
`opencv<5` holds on both. Do not trust OpenCV's `minAreaRect` angle
convention: 4.11 reports an untilted block at +90 and 4.14 at -90, which is
why `_upright()` in `locate.py` folds the correction into [-90, 90). Folding
loses which way up the bib is, so `bib_orientation()` reads it from the
banners: the header lettering is taller than the footer's. A turned crop
needs both banners in view, and a number that is a different bib upside
down (6/9, 16/91) is refused when neither proves the orientation. `torch` is in an optional
`[train]` extra: training runs on a workstation, the Pi only needs
`onnxruntime`.

**The camera audit tab** (`Audyt kamery` on the event page,
`frontend/src/components/VisionAudit/`) is the operator's answer to "is the
camera connected and reading". It works with **no race run started**, like the
RFID reader dashboard, because checking the camera happens before the race.
Design: `docs/superpowers/specs/2026-10-03-vision-audit-tab-design.md`.

- `vision/scripts/read_queue.py` — the long-running reader. Drains the frame
  queue, reuses `Tracker` unchanged (so the tab cannot flatter the pipeline),
  and emits one JSONL line per closed track plus a bib crop. Each line lists
  the sensor timestamps of every frame in the pass (`frame_ts`, stored in
  `vision_sightings.frame_ts`), which is what lets the full-frame view step
  through the whole pass. The Pi 5 has no
  accelerator and reads about 8 frames a second, so capture is pinned to
  `--fps 6` and the reader skips frames more than `--max-lag-s 3` behind the
  newest (moved to `done/` unread, kept on disk). Before both existed the
  reader ran at a 3 fps throttle against a 13 fps camera and fell four minutes
  behind in ten. It reads `--workers` frames at once (default 3) and
  commits them in order: one frame at a time used a single core and capped
  the reader at 5 fps with the CPU 86 percent idle; three measured 15.
  `reader_fps` in `health.json` is the MEASURED rate;
  `capacity_fps` is the flat-out one. The chip still times.
- The reader deletes the frames it read and found **nobody** in, once they are
  older than `VISION_KEEP_EMPTY_MIN` (default 10, `--keep-empty-min`), because
  an empty gate at 5 fps filled the SD card. `vision/vision/empty_frames.py`
  keeps everything else: every frame with a person (so every `frame_ts` of a
  pass, read or not), the empty frames within `MAX_GAP_FRAMES` of one, and
  every frame skipped for lag or torn. Judged-empty names go to
  `empty_frames.txt` in the queue, so a restart loses nothing, and
  `health.json` reports `empty_frames_deleted` / `empty_bytes_deleted`.
- `backend/src/vision/ingest.js` — tails the log from a **byte** cursor stored
  on the session, so a backend restart mid-race resumes exactly where it left
  off. `parseLog` never consumes past the last newline: a half-written line
  would otherwise become a second row with no bib, indistinguishable from a
  genuine unreadable runner. Each row stores its line's byte offset
  (`log_offset`), and that offset is the duplicate key: two passes can share
  a best frame and a time, and keyed on those, 188's read beside 171's was
  dropped at the 2026-10-17 race. Rows go in 1,000 at a time, because a whole
  race read at once passes PostgreSQL's 65,534-parameter limit.
- **Weryfikacja** (review) in the same tab lists every chip finisher the
  session did not read within 20 s of the chip time, leaving out DNS and DNF
  results, which keep a chip finish the operator has overruled
  (`GET /api/vision/sessions/:id/review`), shows the frames from 3 s before
  to 1 s after it, and stores a person's verdict in `vision_reviews`:
  `visible` (with the frame and the clicked point, a training label),
  `covered`, `no_front` or `absent`. Frames map to wall time through
  `vision_sessions.clock_offset`, never `session.json`, which capture
  rewrites on every start.
- Every row of `GET /api/vision/sessions/:id/sightings` carries `suspect`
  (`likelyMisread` in `backend/src/vision/review.js`), and `filter=suspect`
  lists only those: `{ reason: 'neighbour', bib }` when the read number has
  no chip finish within 20 s while a number one digit away finished within
  2 s, `{ reason: 'dns' }` when it belongs to a DNS runner. Every misread at
  the 2026-10-17 race was a real bib, so the roster match caught none; this
  flagged all five and nothing else among 313 reads. It only marks the row.
- `vision_sessions` / `vision_sightings` / `vision_reviews` are **device-local**, like
  `gate_crossings` — absent from `configSync.js`, no `trg_reset_synced_at_*`,
  never pushed. `race_run_id` is nullable by design.
- **It reports `recognitionRate`, never a read rate.** A read rate is measured
  against the numbers people actually wore and nothing here knows those.
  `rosterMatchRate` is the real quality signal available for free: a
  recognised number matching nobody in the race is almost always a misread.
- **Recording switch.** A race runs about three hours and the first runner
  arrives after about one, so the tab pauses and resumes recording.
  `PUT /api/vision/sessions/:id/recording` `{ recording }` writes
  `{"recording": false, "changed_at": …}` to `recording.json` in the queue
  directory (temp file + rename); `GET` reads that file, so the panel shows
  what capture sees. Capture checks it about once a second. Paused, the
  camera keeps running and `next_exposure` keeps adapting, but no frame is
  written. A missing or malformed file means record, on both sides: a
  forgotten pause loses runners, a forgotten resume only costs disk. The
  health verdict reads "Nagrywanie wstrzymane" instead of a dead camera.
- Retention is **30 days**, not 90: `backend/scripts/purge-vision-evidence.js`
  (cron 03:20, `scheduler/src/jobs/purgeVisionEvidence.js`) deletes the image
  files first and the rows second, so an interrupted run leaves rows pointing
  at missing files rather than orphaned photographs.
- The full-frame view shows a face and is behind an explicit click; the list
  shows only the digits-only crop. ROPA section 9 covers this. **The regulamin
  clauses in `docs/gdpr/vision-bib-recognition-klauzule.md` are still not
  adopted** — do not run the camera at a race whose regulamin omits them.

Install on the Pi: [vision/INSTALL-RASPBERRY-PI.md](vision/INSTALL-RASPBERRY-PI.md).
The camera is a **Camera Module 3, standard, never NoIR**. The locator finds the
bib by its olive colour, and a NoIR sensor renders that block dark purple, so
nothing is ever located. Capture defaults to the IMX708's native 2304x1296
mode with the lens held at 3 m (`--focus-m`), because autofocus hunts as
runners cross the frame. Exposure is adapted by capture itself
(`next_exposure`), not by libcamera's AE: gain first, the shutter only once
gain is at its ceiling and never past 3 ms, because a longer shutter smears
the digits. A fixed exposure left an overcast or indoor frame at a block
brightness of 20 of 255, where hue is noise and the locator finds nothing.
On a race Pi, capture and the reader run as systemd services
(`vision/systemd/`, settings in `/etc/default/leszyrun-vision`). Capture is
`Restart=on-failure`, never `always`: a run that ended on its time limit or on
the `--min-free-gb` margin (1 GB) must stay stopped, because frames with a person
in them are never deleted before the retention purge and the SD card also holds
the database.

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

A `dns`, `dnf` or `dsq` result never gets a stored `position` or a place in the gender lists and CSV/PDF exports, even with a finish time (`UNRANKED` in `backend/src/lib/positions.js`). The public views do not read that column. `estimatePositions()` ranks by finish time and keeps these statuses out of the finished tier on its own, so the public places match the stored ones. On the public list DNF comes after everyone still in the race, DSQ after DNF, and DNS last with no place and no times (a DNS can hold a chip finish or a backfilled gun start, neither of which they ran). `position` is only recalculated by the host that made the edit, so a host on older code writes stale places into Supabase. That happened on 2026-10-17, when checkpoint1 ran code from before #272 and three DNS runners kept places 83, 84 and 118. Neither a chip finish nor a finish-time edit turns a `dsq` back into `finished`, and gun-time backfill skips a runner marked `dns`. Operators set these from the Status column of `Przegląd trasy`.

A runner who came but will not start, because they handed the bib back, gets **Nie startuje** in the NS column of the participants table before the race. That calls `POST /api/participants/:id/withdraw`, and `DELETE` on the same path undoes it. It sets `participants.withdrawn_at`, and race start seeds their result as `dns`. Both calls answer 409 once the runner has a result in a race run that was not cancelled: during the race, the status is changed in `Przegląd trasy`. The detector ignores every crossing of a runner whose result is `dns`, so a returned bib near the gate gives nobody a start or a finish. This also covers a DNS set in `Przegląd trasy`, which a chip start used to overwrite.

**`participants.removed_at`** is set only in Supabase (a runner removed from the online registration;
the row is kept, a bib or emoji is never reused). A host treats the runner as absent: no result row at race
start (`seedStatus` returns null), not in the detector start list (`startListFor`, at race start and when a
restarted host reloads its active races in `lib/reloadActiveRaces.js`), SMS lists, roster, audit,
gun-time backfill and manual `assign-gun-start` (reported in `skipped`), vision, checkpoint bib lookups or
`epcMap`; participant counts exclude them, and `POST`/`DELETE /participants/:id/withdraw` of one answer 409
(`PATCH /participants/:id` has no such guard). An event with `events.club_id`
set is a registration event (`isRegistrationEvent` in `backend/src/lib/registrationGuards.js`): deleting it,
its categories or its participants answers 409 locally. The Supabase trigger below is the authority.


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

## Online race registration (Plan 1, foundation)

- **Delete refusal trigger** (`refuse_registration_event_deletes`, BEFORE DELETE) refuses deleting an event
  that has a `registration_settings` row and its `categories`, `participants`, `checkins`,
  `checkin_documents`, `checkpoints`, `race_runs` and `event_documents`. It also covers an old host's
  `syncDeleteEvent`. Deliberately unguarded: `checkpoint_categories` (`pushCheckpointLinks` replaces a
  checkpoint's links by delete + insert), `results`, `gate_crossings`, `checkpoint_observations` (resetting
  race data must keep working). `delete-club` answers 409 for a club owning a registration event and
  `merge_clubs` refuses a club that owns registration data.
- **`clubs.registration_enabled`** (default false). For a disabled club `accept-organizer-agreement`,
  `update-club-payout` and `get-club-payout` answer 404 (after the role check, so a non-member still gets 403
  and cannot tell a disabled club from an enabled one). `organizer-status` and `join-registration-waitlist`
  are deliberately not gated: they are how a disabled club learns its state and asks to be switched on. The
  public app shows the payout form ("Dane do wypłat") and the agreement only when `organizer-status` says
  `enabled: true` (`organizerFeaturesShown` in `public/src/lib/organizerGate.js`); a waitlisted or disabled
  club sees the waitlist copy only. The ZATYRANI club (slug `zatyrani`) is enabled by the migration. Enable or disable another club
  only through the `registration-operator` skill: one row filtered by id, after the operator's explicit
  confirmation, with an `admin_actions` audit row. Event authorization uses
  `registration_settings.club_id` (immutable by trigger), never `events.club_id`.
- **Operator tasks** (waitlist, status, enable/disable a club, new agreement version): invoke the `registration-operator` skill (`.claude/skills/registration-operator/SKILL.md`).
- **Organizer agreement.** The text is `public/src/legal/organizerAgreement.js` (draft in
  `docs/legal/zapisy/umowa-organizatora.md`); the version constant exists in two places,
  `ORGANIZER_AGREEMENT_VERSION` in `supabase/functions/_shared/organizer.js` and `version` in that file.
  Bump both: `public/tests/unit/agreementVersion.test.js` fails otherwise. Only the club `owner` accepts;
  a stale version answers 409. `organizer_agreements` is UNIQUE (club_id, version); a concurrent second
  accept gets the existing row. **Bump `ORGANIZER_AGREEMENT_VERSION` (both places) when the agreement
  text is finalised** (it still carries `[DO UZUPEŁNIENIA]`/`[DO WERYFIKACJI]` markers): an acceptance
  stored now points at the draft, and only a new version makes every owner re-accept the final text.
- **Organizer edge functions:** `organizer-status`, `join-registration-waitlist`,
  `accept-organizer-agreement`, `update-club-payout` (owner only; writes through the `save_club_payout`
  RPC, which takes a per-club advisory lock, updates the details and appends `club_payout_history` in one
  transaction), `get-club-payout` (owner full, admin masked IBAN, member 403).
- **Login refusal of a retired address** answers 403 `{ error: RETIRED_EMAIL_MESSAGE, code: 'email_retired' }`
  from both `auth-request-code` and `auth-verify-code` (`_shared/deletedEmails.js`). Code verification and
  session opening live in `_shared/verifyCode.js`; any form that logs a person in on the way must use it,
  not a copy.


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
`checkpoint_categories` (which categories pass a checkpoint; none = all) has no id or
`synced_at`, so it rides on its checkpoint row (`src/sync/checkpointLinks.js`): a link change
dirties the checkpoint, the push replaces that checkpoint's link set in Supabase before marking
it synced, and the pull replaces a clean local checkpoint's set with the remote one.
Each pulled row is stamped `synced_at = now()` so the push worker never echoes it back (the
0010 trigger passes a `SET synced_at` change through instead of nulling it). The ON CONFLICT
update is guarded by `synced_at IS NOT NULL`, so a locally-dirty row (a pending local edit,
`synced_at` NULL) is NEVER clobbered — local push wins first, then re-pulls. Excludes
`checkpoint_observations` (already reverse-synced live via realtime in `supabase.js`) and
`gate_crossings` (raw/high-volume/device-local). **Deletes are NOT propagated** (additive/
update only) — a row deleted on one device lingers on the others until removed there. For the
same reason it **refuses to pull any `events` row whose name starts with `[e2e-test]`**, plus
everything descending from it: the edge-function suite seeds throwaway events in the same prod
Supabase project, they outlive the 30 s poll, and once pulled the suite's own cleanup can never
reach them again. Keep that marker in step with `E2E_MARKER` in `supabase/functions/tests/helpers.js`.

**configSync host filter (online registration).** An event sold online has a `registration_settings`
row (Supabase-only). A host pulls an event only when that row is absent (every pre-registration event:
syncs as before) or `state <> 'draft'` AND `timing_mode = 'leszyrun'` (`hostSkipsEvent`). Drafts and
`external`/`none` events are refused, with the same cascade as `[e2e-test]` data: their categories,
participants, checkpoints, race_runs, results and event_documents are refused too. The refusal is
recomputed on every poll and never remembered, so a draft skipped on poll 1 is pulled on the poll after
it is published. Remote events are read first and `registration_settings` after them (`loadHostFilter`),
so an event the read sees already has its settings visible. If the settings read fails (`settingsFailed`,
logged as `[ConfigSync] registration_settings: …`), events already on this host keep syncing and unknown
events wait one poll; a half-read settings map is discarded, never used. If the events read itself fails,
the whole poll pulls nothing: a child row is never judged without a complete event decision. A host on code from before this
filter pulls drafts, so update every host before the first club event is created.


**Reverse sync — checkins (`src/sync/checkinSync.js`):** `checkins` and `checkin_documents`
flow Supabase → local. The public self-service check-in page writes them to Supabase through
the `self-checkin` edge function, never with the publishable key (see "Anon key lockdown" below). A reverse sync worker polls Supabase every 30s and pulls new/updated checkin rows
into local PostgreSQL. Admin check-in from the backend also writes to Supabase first (not
local), so all check-in data has a single source of truth in Supabase.

**Anon key lockdown (security review 2026-10-25, migration `20261025210000_anon_lockdown.sql`).**
The publishable key is in every browser, so whatever it may do, anyone may do. It reads, and
writes only through the check-in-PIN RPCs (`checkin_confirm` for the bib office). Every other
write a public page or a Pi makes goes through an edge function on the service role:
- `self-checkin` — the runner's check-in from the SMS link. The link carries `t`, an HMAC of the
  participant id under `event_secrets.checkin_link_key` (`backend/src/lib/checkinLink.js` builds
  it for the SMS, `_shared/checkinToken.js` checks it). A participant id alone is public
  (`participants_public`, `results`), so it is not a credential. It replaced
  `get_participant_for_checkin`, which handed anyone the phone and birth date of every
  participant, and the anon INSERT on `checkins`.
- `checkpoint-write` — volunteer entries, Pi agent passes and Pi heartbeats, authorised by the
  event's `checkpoint_pin`. The admin's volunteer link carries `&pin=`; the volunteer page moves
  it to localStorage and off the address bar, and asks for it when it is missing. The Pi agent
  sends the PIN it already stores for `checkpoint-roster` (`checkpoint-agent/src/edgeWriter.js`).
- Both event PINs go through `event_pin_ok(event, kind, pin)` in SQL: an advisory lock, a count
  of recent failures in `pin_attempts`, the compare and the record in one critical section, so
  parallel guesses cannot share a count (`_shared/pinGuard.js` calls it for the checkpoint PIN).
  Failures are counted per event, not per caller, because there is no caller identity a forger
  cannot change: 100 in 15 minutes lock that PIN for everyone. New PINs are 10 digits
  (`generatePin()`), which that rate never finds. A PIN function must never RAISE on a wrong PIN,
  or the rollback erases the recorded failure. A client holding a refused PIN must stop sending
  it, or it locks out everybody else: the Pi's `edgeWriter` stops until a different PIN is
  stored, and the volunteer page returns to the PIN pad with its entries still queued.
- A new table needs RLS on and `REVOKE ALL … FROM anon, authenticated` in the migration that
  creates it, then a GRANT and a policy only for what the public app reads. Six tables had RLS
  off with full anon CRUD (`event_partners` among them, the sponsor links on event pages).

**Supabase-only tables** (no Drizzle schema, no local migration — a committed `supabase/migrations/` file, deployed by the CI pipeline on merge; see [docs/supabase-release-runbook.md](docs/supabase-release-runbook.md)):
- `event_secrets` — per-event check-in PINs
- `calendar_events` — aggregated race calendar from scrapers + manual entry
- `geocode_cache` — Nominatim geocoding results cache
- `url_suggestions` — Brave Search URL candidates pending admin review
- `event_favorites` — user star/follow shortlist (service-role only, written via `toggle-favorite` edge function)
- `event_notifications` — event-level notification log. Only `registration_opened` is stored now, by a `calendar_events` trigger; UNIQUE(event_id, type). **`deadline_soon` is DERIVED at read time** (`supabase/functions/_shared/deadlineSoon.js`, shared by `get-notifications` and the weekly digest so the badge and the email agree). Storing it could not work: the unique constraint means the fact fires once per event, and every reader drops notifications older than the user's star, so the single row was invisible to everyone who starred the race afterwards — which is precisely the person who needs the warning. `run-deadline-notifications.js` and its 08:30 cron are retired; old `deadline_soon` rows are ignored. No `cancelled` type — cancellation alerts were intentionally dropped (we can't promise them; cancellation data depends on organizers reporting it).
- `event_results_summary` — read-only view aggregating per-event stats (participants, finishers, timed distances, fastest finisher) for past-event public pages; only `participants` + `distances` are currently surfaced. Created via a committed migration (deployed by the CI pipeline).
- `event_category_best_times` — read-only view: best finish time per event × timed category × gender (`M`/`K` only; non-cancelled runs, untimed categories excluded). Feeds the past-event "Najlepsze czasy" table. Created via a committed migration (deployed by the CI pipeline).
- `club_membership_log` — append-only club membership history (joined/left/removed/role_changed), written by the club edge functions; covered by export-my-data / delete-my-account (see GDPR section)
- `prepublish_verdicts` — what the pre-publish review proved about one field of one event (`absent-at-source` / `needs-human`), one row per source+source_id+field. Read by the review step to skip settled fields and by `GET /api/calendar-events` to explain blank columns in the admin queue.
- `deleted_email_hashes` — SHA-256 of every deleted account's address, so the address cannot be re-registered. Holds no plaintext.
- `club_slug_history` — former club slugs (old_slug → club_id) backing get-club's slug fallback. **Renaming a club's slug is no longer possible** (`update-club` returns 409, the field is read-only in Ustawienia) — for the same reason usernames cannot be renamed: it repoints every published link and parks the old address forever. The table stays because it still resolves the renames that already happened, and `create-club`'s `uniqueSlug` must keep refusing to reissue a parked slug. Someone who needs a different address writes in.
- `registration_waitlist` — one row per club that asked to be switched on (`club_id` primary key); joining sends one operator email.
- `organizer_agreements` — one row per accepted agreement (club, version, accepting user, ip, user agent).
- `club_payout_details` / `club_payout_history` — a club's IBAN and NIP, and every change to them; written only by the `save_club_payout` RPC (SECURITY DEFINER, service_role).
- `registration_settings` — per-event online registration settings (`club_id` immutable, `state`, `timing_mode`); read by configSync's host filter.
- `organizer_actions` — append-only audit of organizer writes (see GDPR section). All six tables: RLS on, `REVOKE ALL … FROM anon, authenticated`.

## Race registration (Plan 1 + Plan 2)

Organizers create and publish a registration event in the public app; runners register free of charge. Paid registration is not built. Design and rulings: the plan ledgers under `.superpowers/sdd/` (P2-R1…); scenario matrix: [docs/registration/scenario-matrix.md](docs/registration/scenario-matrix.md), every row names its passing test.

- **Tables** (Supabase-only plus the display rows below): `registration_settings` (state `draft`/`published`, slug, window, `contact_email`, `regulamin_version`), `competitions`, `competition_prices`/`price_tiers`, `age_groups`, `kids_groups`, `office_hours`, `event_consents`, `registrations`, `consent_acceptances`, `registration_waitlist`, `registration_pending_changes`, `registration_uploads`, `organizer_agreements`, `organizer_actions`, `organizer_messages`, `club_payout_details`/`club_payout_history`. All are service-role only (`REVOKE` from `anon`/`authenticated`); every read and write goes through an edge function or a SECURITY DEFINER RPC.
- **RPCs:** `create_registration_event`, `save_registration_section` / `stage_registration_section` (draft writes, published stages), `publish_registration_event`, `publish_registration_changes`, `claim_competition_slots`, `register_free`, `registration_public` / `registration_raw` (read models), `purge_registration_contact_data`. Edge functions: `create-registration-event`, `save-registration-section`, `upload-registration-file`, `publish-registration-event` (actions `publish`, `preview_changes`, `publish_changes`, `discard_changes`), `get-registration-event`, `preview-registration-event`, `register-free`, `list-event-registrations`, `my-event-registrations`, `organizer-status`, `accept-organizer-agreement`, `join-registration-waitlist`, `list-club-registration-events`.
- **`create_registration_event` sets `rssi_threshold = -9000` and `min_finish_seconds = 300` explicitly** (P2-R1): the column defaults are not trusted for a race the timing host will run.
- **Public read model: `GET /api/event?slug=<slug>`** (`public/api/event.js`), a Vercel Function that returns `registration_public()` with a `version` hash, cached by the CDN like `/api/results`. A bad slug is 400, a draft or unknown slug 404. The public page never queries Supabase per viewer.
- **`@registration` Vite alias** points at `supabase/functions/_shared/registration/` (ages, dates, GPX, slug, checklist, change diff, sections). The same plain-JS modules run in the edge functions, the browser and the tests, so a rule exists once. It is a Vite alias only: a Vercel Function (`public/api/*`) must import by relative path.
- **Ownership rule: the `events` and `categories` display fields (name, date, location, slug, club, category names/slugs) are written only at publish** (`publish_registration_event`, `publish_registration_changes`). Before that the `events` row is `Szkic`/`szkic-<id>`, private. Sections save into `registration_settings` and its child tables; a published event stages edits in `registration_pending_changes` and nothing live changes until „Opublikuj zmiany”. The timing host pulls an event only once it is published and its `timing_mode` is `leszyrun` (`configSync.js`).
- **Post-publish locks** (`registration_check_locks`, mirrored in the checklist): a competition **can never be deleted after publish, only hidden** (`hidden_at`); hiding one with `taken > 0` is 409 `competition_locked`; a limit cannot go below `taken` (slots claimed); the club, slug and `timing_mode` cannot change; the registration window must stay valid and close no later than the end of race day (Warsaw, `closes_at <= event_date + 1`); **a custom consent somebody accepted can be neither deleted nor retyped** (409 `consent_locked`, P2-R30), because `consent_acceptances` stores only the consent id, so new wording is a new consent. The wizard shows such a consent read-only (`accepted` in `get-registration-event`, owner/admin only). A hidden competition is absent from `/api/event`, the form and `register_free`, and counts nowhere.
- **Publishing changes:** `preview_changes` returns the diff, the recipient count and the staged `updatedAt`. `publish_changes` with a stale `expectedUpdatedAt` answers 409 `changed`, applies nothing and sends no mail. The change notice to registered runners is opt-in (unchecked) and throttled per event (429 `notice_throttled`).
- **`registration_settings.contact_email` is required to publish**, is shown to runners and is the reply-to of organizer mail. It is never the owner's personal address.
- **Free registration path:** `register-free` verifies the address (a code unless the session matches it), refuses a retired address, and calls `register_free`, which claims a slot (`claim_competition_slots`, atomic) and inserts the `registrations` and `participants` rows (no bib) in one transaction. One live registration per event and email, case-insensitive; a cancelled one frees the address. The timing host pulls the new participant through `configSync`.
- **Form rulings P2-R31…R33** (migration `20261030000000_registration_form_rulings.sql`). **Nationality** is a switch like city/club/ICE but defaults to off; it is an ISO 3166-1 alpha-2 code (`_shared/registration/countries.js`, the select's Polish names come from `Intl.DisplayNames`) stored on `registrations.nationality` only, never on `participants` or a timing host; export-my-data includes it, delete-my-account nulls it. **The phone is always required**: it is no `form_fields` switch, a stored `phone` mode is ignored by `validatePerson` and dropped by `validateSection`. **Image publication is a system acceptance** (`event_consents.kind = 'image'`, one per event), created with every event like `regulamin` and `data_info` and worded as a term of the regulamin, not a consent (a mandatory consent is not freely given, Art. 7(4) GDPR). The organizer's consents list only ever touches `custom`, so it can be neither removed nor retyped, and `register_free` refuses a registration without it.
- **Runner data information** (`public/src/legal/runnerDataInfo.js`, source `docs/legal/zapisy/informacja-o-danych-zawodnika.md`): change both together and bump `RUNNER_DATA_INFO_VERSION` with the document's „Wersja”; `public/tests/unit/runnerDataInfo.test.js` fails when they differ. Image publication is described there as a regulamin term (Art. 6(1)(b) and (f), art. 81 of the copyright act), never as consent.
- **`list-event-registrations` is owner/admin only.** A club member gets 404: it returns runners' personal data.
- **Storage:** public bucket `registration-files` holds the poster, regulamin PDF and GPX that were already validated. Uploads go first to the private bucket `registration-pending` through a signed PUT, `upload-registration-file` checks type, size and content (a PDF magic number, a GPX parsed with no script, an image of sane dimensions) and only then moves the file. Neither bucket has client storage policies.
- **Tests:** `tests/registration/**` (node:test against a local Supabase stack, Playwright under `e2e/`) runs in `.github/workflows/registration-tests.yml` with a scratch Postgres on port 55432 for the host-pull and purge tests. A new scenario gets a matrix row naming its test.

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

**Push excludes Supabase-owned columns** (`PUSH_EXCLUDED_COLUMNS` / `toPushRow` in `supabase.js`):
`events.club_id`, `participants.registration_id`, `participants.removed_at`. Supabase sets them, hosts only
pull them (configSync still maps them). A PostgREST upsert only updates the columns in the payload, so
omitting them preserves Supabase's value; sending them would let a participant row that went dirty on a
host before Supabase set `removed_at` push `NULL` and silently un-remove the runner. A new column that
only Supabase writes goes in that map. The admin check-in's participant upsert (`checkinParticipantRow` in
`backend/src/lib/checkinParticipantRow.js`) obeys the same map. The push's stale-category cleanup
(`deleteStaleCategories`) skips registration events, whose category deletes the Supabase trigger refuses.


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

### Public results snapshot

The results page (`/events/:slug/results`), "Blisko Mety" and the bib search read one JSON document per event from `GET /api/results?event=<event id>`, a Vercel Function in `public/api/results.js`. It reads Supabase with the anon key, so RLS still decides what is public, and `buildResultsSnapshot()` in `public/src/lib/resultsSnapshot.js` does the reading. `categoryView()` in the same file cuts out what one category section shows.

- The snapshot carries only what the page shows. `buildResultsSnapshot()` leaves out untimed categories and their participants (no times or places to show; a timed kids' category shows like any other, because the regulamin a parent signs covers publishing the child's name and result), private checkpoints other than the near-finish one (the manual "Meta" holds volunteer entries only operators review), and observations from before the event's first gun. The anon key can read all of these, but the snapshot is pushed into every viewer's browser and the CDN, so filtering it in the page is not enough.
- While a run is active, `Vercel-CDN-Cache-Control` is `max-age=5`, and pages poll every 5 s. Otherwise it is `max-age=60`, and pages poll every 60 s. Either way Supabase sees about one build per event per interval per CDN region, whatever the number of viewers. Polling pauses while the tab is hidden.
- `stale-while-revalidate=600, stale-if-error=600` and an 8 s timeout on the Supabase fetch keep a stale copy on screen while Supabase is slow. Vercel collapses background revalidation into one function run, but not requests that find no cached copy, so a short stale window would let every poll start its own build against a struggling database. An error answers `no-store` and is never cached.
- The response carries a `version` hash of the data. `public/src/lib/snapshotStore.js` re-renders only when it changes. A result reaches the page up to about 10 s after it reaches Supabase during a race.
- The endpoint answers 400 to anything but one lowercase `event` id, because the CDN keys its cache on the whole query string.
- The function runs in `dub1` (`regions` in `public/vercel.json`), next to the Supabase project in `eu-west-1`.
- `vite dev` serves the same handler through the `vercelApi` plugin in `public/vite.config.js`.

### Accounts/community

The accounts/community product (login, profile, favorites/stars, notifications, clubs, report/feedback, add-event) is public for everyone. It was dark-launched behind a `?beta=1` flag (`useBeta`) until 2026-10-25; that flag is gone, and links sent out earlier with `&beta=1` still work because the parameter is ignored.

Club invite links come from `inviteUrl()` in `public/src/lib/inviteLink.js`. A logged-out visitor on an invite sees the club's name from `preview-invite`, the one sessionless club function, which returns only the name and whether the invite is still valid. A session with no username always goes through onboarding before any `?from=`, because onboarding is where the regulamin is accepted (`postAuthPath()` in the same file).

**Auth transport — edge functions go through same-origin `/edge`, NEVER raw `VITE_SUPABASE_URL`.** The session is an httpOnly cookie the edge functions set. A cookie set by `*.supabase.co` while the page is on `leszy.run` is a THIRD-PARTY cookie that browsers block (Safari always, Chrome/Firefox increasingly) — login "succeeds" but the session never persists. So `public/vercel.json` (and the vite dev-server proxy in `public/vite.config.js`) rewrites `/edge/*` → `<project>.supabase.co/functions/v1/*`, making the cookie first-party. **Rule:** any client call to an edge function that depends on the session cookie MUST use the `FUNCTIONS_BASE` (`/edge`) constant from `public/src/lib/auth.js` — never build the URL from `VITE_SUPABASE_URL` directly. (The `supabase-js` DB client in `lib/supabase.js` is exempt: it uses bearer tokens, not cookies, so it hits `*.supabase.co` directly.)

**Analytics never sees a runner.** `RouteTracker` (`public/src/components/RouteTracker.jsx`) sends `pathname + search` to GA as `page_path` and `page_location`, minus `nr`, `email` and `code` (`trackedPath()` in `public/src/lib/trackedPath.js`). The cleaned `page_location` is also a global `gtag('set')`, made before `config` (`initGa`, from `CookieBanner`) and on every route change (`sendPageView`), so GA4's automatic events (scroll, outbound click) never carry the raw address either: the results page keeps the searched bib in `?nr=`, a bib names a runner, and the registration magic link carries the address and the login code. A new query parameter that identifies a person must be stripped there too, and a page that rewrites its address while someone types must do it once per pause, not per keystroke, or every keystroke becomes a page view.

**Browser APIs are gated by `Permissions-Policy` in `public/vercel.json`.** A feature that uses the camera, the microphone, geolocation or another gated API needs `<feature>=(self)` there, or Chrome blocks it on www.leszy.run and shows no reason. It happened twice: `geolocation=()` broke "Blisko mnie" for two weeks, and `camera=()` kept the bib-office QR scanner from opening the camera until 2026-10-15. The Vite dev and preview servers copy these headers from `vercel.json`, so the breakage shows up locally too.

**A tab opened before a deploy reloads itself on its first in-app navigation to a page it has not loaded yet.** It still runs the old entry bundle, which asks for page chunks by hashes the new deployment no longer has. Before `public/src/lib/staleChunkReload.js`, that left a white page with "Failed to fetch dynamically imported module" until a manual refresh. The SPA rewrite in `vercel.json` skips `/assets/`, so a missing chunk is a 404, not `index.html` served as a script.

### Logo
- `public/public/logo-bez-napisu.svg` — Leszy character without text. Two green leaves (top-left, top-right), black body/roots.
- `public/public/logo.svg` — full logo with text (used as watermark in `app.css`)

### Static HTML generation (SEO)

The `public/` build is **not a pure SPA**. After `vite build`, several scripts write pre-rendered `index.html` files into `dist/`:
- `scripts/generate-event-pages.js` — one file per `/kalendarz/:slug` (reads `public/public/kalendarz/.manifest.json`)
- `scripts/generate-landing-pages.js` — one file per `/listy/*` page (reads `public/public/listy/.manifest.json`)
- `scripts/generate-leszyrun-event-pages.js` — one file per past, public leszy.run event at `/events/:slug` (reads `public/public/events/.manifest.json`), with baked stats + a "Zobacz wyniki" link to the internal results. The manifest is produced by `backend/scripts/publish-leszyrun-events.js --apply` (host: `cd backend && node --env-file=../.env scripts/publish-leszyrun-events.js --apply`). Re-run after a new event finishes, then commit the refreshed manifest.
- `scripts/generate-club-pages.js` — **PARKED since 2026-09-29: the public club page is not shipped.** `public/public/klub/.manifest.json` is deliberately `[]`, so this generator writes nothing and `/klub/:slug` belongs entirely to the SPA's member-only club area; the "Publiczna strona klubu" switch in `public/src/pages/klub/Ustawienia.jsx` is rendered disabled with a *wkrótce* note. Every control that only decides what that page shows (the membership visibility choice, and the nickname and hide-me toggles in profile Ustawienia) is hidden behind `PUBLIC_CLUB_PAGE_SHIPPED` in `public/src/lib/clubPage.js`, and new memberships are stored with `hidden_public = true` (clubmates-only) until people can choose. Do NOT run `publish-club-pages.js --apply` until the page is brought back — it would republish the pages. How it works when revived: one file per public club at `/klub/:slug` (reads `public/public/klub/.manifest.json`, a committed JSON array), with member count + visible-member roster + a SportsTeam JSON-LD. The manifest is produced by `backend/scripts/publish-club-pages.js --apply` (host: `cd backend && node --env-file=../.env scripts/publish-club-pages.js --apply`) — query is `clubs` where `is_public = true AND owner_id IS NOT NULL`, applying the same `hidden_public`/`club_public_name` masking as the retired `render-club` function. Re-run whenever a club's public visibility, roster, profile fields, **or slug** change, then commit the refreshed manifest — a slug rename also needs a fresh redirect stub (see below). This REPLACES the old `render-club` Supabase edge function SSR approach (the Supabase edge runtime forced `text/plain` on HTML responses there, breaking crawlers/JSON-LD) — unlike `/events/:slug`, the SPA does not own the bare `/klub/:slug` route; only the sub-paths are SPA routes: `/klub/:slug/dolacz` (invite-accept) and the slug-scoped club area `/klub/:slug/{panel,czlonkowie,zaproszenia,ustawienia}` (member home, roster, invites, settings — index redirects to `panel`, all session-gated). Renaming a club's slug leaves a redirect stub at the old `/klub/:old-slug` (from `club_slug_history`, regenerated by the same `generate-club-pages.js` run) so old links and bookmarks keep resolving.

All manifests are **committed to the repo** and generated by backend pipeline scripts (`publish-event-pages.js --apply`, `publish-leszyrun-events.js --apply`, `publish-club-pages.js --apply`). Vercel serves the pre-generated files directly; the SPA rewrite in `vercel.json` only catches paths with no matching static file. `vercel.json` also has a permanent redirect from `leszy.run` → `www.leszy.run`.

**SEO crawlability rule:** any new page type that needs Google indexing requires two things:
1. A pre-generated static `index.html` with title, canonical, meta description, and JSON-LD
2. Static `<a href="...">` links to it from already-indexed pages — sitemap alone is not enough for a low-authority site; Google deprioritises sitemap-only URLs with no inbound links from crawled pages

## Event scraper & enrichment pipeline

Standalone scripts (not API endpoints) that scrape Polish running event websites, enrich with AI, and publish to the `calendar_events` Supabase table. See [docs/scrapers.md](docs/scrapers.md) for full pipeline documentation.

### Data sources (36 scrapers)

pomiarczasuatelier.pl was dropped on 2026-03-28: its sign-ups all go through dostartu.pl, which the dostartu scraper already covers with better data.

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
| zapisyonline.pl | 30-40 | Cheerio (paginated listing + detail pages) | High (Triso.pl registration platform, Mazowsze/Podkarpacie-heavy; date+city from listing, structured distances + kids/adult type + regulamin (PDF or .docx, since organizers upload both) + organizer website from detail page; voivodeship emitted from the detail page's `.address` postal code, NOT geocoded, because the listing city alone is ambiguous (bare "Kosakowo" geocodes to the Warmian village, not the Pomeranian one); detail page is canonical registration URL; prices/deadline left to enricher; cycling events skipped) |
| foxter-sport.pl | 60-100 | Cheerio (single /list table + /<slug> detail pages) | High (custom-PHP timing co, Wielkopolska/Kujawsko-Pomorskie-heavy; date+city from listing table, structured distances + regulamin PDF + kids flag from detail page; /<slug> detail page is canonical registration URL since the register button needs login; prices/deadline behind login → left to enricher; triathlon/open-water/cycling/moto events skipped) |
| herkules.org.pl | 15-20 | fetch + Tribe REST API (The Events Calendar JSON) | Medium-High (Pomorskie/Zachodniopomorskie timing co "Pomiar Czasu"; name+date+city+registration URL + authoritative event_types from Tribe categories (Bieganie/Nordic Walking/OCR); registration URL points OUT to b4sportonline.pl or inws.info; voivodeship NOT emitted (source region data unreliable) → geocoded from city; distances/prices left to enricher; SUP/cycling/MTB/triathlon-only events skipped) |
| zapisyvaldano.pl | 5-15 | Cheerio (Laravel listing + detail pages) | High (VALDANO organizer/timing co, Pomorskie/Kujawsko-Pomorskie; GRAND PRIX CROSS POLSKA series + standalone runs; date+city from /events listing, structured prices + deadline + regulamin PDF + competition names from /event/<id> detail page; detail page is the canonical registration URL since /register 302s to a login that strips the event id; event_types from umbrella name with NW mined from "Marsz z kijami" sub-races when umbrella has no style; distances in regulamin PDF → left to enricher; voivodeship geocoded from city) |
| pomiaryczasu.pl | 8-15 | Cheerio (homepage table) | Medium (Pomiary Czasu multi-sport timing co, Śląsk/Beskidy — Ustroń/Ujsoły/Daleszyce/Kije; future events in one homepage `table.events_list`; umbrella + grouped sub-races collapsed into one event; RUNNING-TYPE WHITELIST on "Typ zawodów" — only Zawody Biegowe/Nordic Walking/Bieg Przeszkodowy kept, drops Road Maraton=cycling, MTB, Biegi narciarskie=skiing, triathlon, etc.; date+name+type from listing, registration_url=/registration/<slug> (source's own button, id preserved), source_url=/event/<slug>, website from detail "Strona www"; distances mined from sub-race names; location geocoded from city; prices/regulamin/deadline → enricher) |
| e-gepard.eu | 10-30 | Cheerio (Laravel `list-contest-all` table + `show-contest/<id>` detail pages) | Medium (RFID.Zone multi-sport timing/registration co, nationwide; date+name+city from listing table, organizer/regulamin PDF/competition names + per-sub-race "Zapis do" deadline from detail page; registration_url=source_url=`show-contest/<id>` (e-gepard hosts its own registration, status "udostępnione do rejestracji"); NON-RUNNING BLACKLIST on event name drops cycling ("na szosie"/"rajd"/"masa krytyczna"), open-water/ice swimming, XC skiing ("narciar"), du-/triathlon; future-only filter (listing has all events); event_types umbrella-first with NW mined from sub-races; distances mined from names where present; prices/website → enricher; voivodeship geocoded from city) |
| pifsport.com.pl | 3-15 | fetch + WP REST posts API (JSON) | Medium (Pifsport timing co, Małopolska/Podkarpacie; events are WordPress posts in the "aktualne imprezy" category (id 5) — full post HTML returned by the list endpoint, no detail fetches; name+date+location+distances mined from semi-structured prose (`data:`/`miejsce:`/`konkurencja:`) in post content, registration + regulamin PDF hrefs from post-body buttons; SKIING BLACKLIST drops biegi narciarskie/narciarstwo (pifsport's other big line) — merge SKIP_KEYWORDS doesn't cover skiing; date resolved content `data:` → excerpt `data:` → termin → title → slug to survive organizer year typos; registration_url from the source's own "LINK do ZGŁOSZEŃ" button (whitelisted hosts: e-gepard.eu / Google Form), regulamin PDFs on pifsport's server; past events filtered by date; prices/website/voivodeship → enricher + geocoding) |
| time-sport.pl | 30-50 | Cheerio (NinjaTable listing + detail pages) | High (Time-Sport RFID timing co, Śląsk-based but nationwide; all events in one server-rendered NinjaTable on /zapisy/ — date+name+city+**voivodeship**+dyscyplina straight from the table, voivodeship emitted directly (not geocoded); each row's 3rd anchor is the canonical /zapisy-DD-MM-YYYY-<slug>/ detail page = source_url+source_id; DYSCYPLINA gating keeps Bieg/OCR/Nordic Walking/Trail, drops MTB/triathlon/pływanie/kolarstwo; registration flows OUT to dostartu — detail page exposes the dostartu statute PDF, id extracted → registration_url=dostartu.pl/zawody/<id> (auto-enriched by pipeline apiEnrich for prices/distances/deadline); multi-line name cells split on <br>, umbrella=first line, full text drives is_kids; distances → enricher) |
| plus-timing.pl | 6-20 | fetch + JSON API (DataTables source) | Medium-High (Plus Timing co, Wielkopolska/Poznań-area; ALL fields from one call `wyniki.plus-timing.pl/api/api_dt.php?action=api_get_zapisy_biegi` — no detail fetches; not WordPress; multi-sport co → RUNNING-DISCIPLINE WHITELIST on `dyscyplina` keeps only "bieg uliczny"/"bieg(i) przełajow*", drops MTB/gravel/triathlon/kolarstwo/aquathlon/BnO orienteering/standalone kids; registration plus-timing-hosted at /zgloszenia/<slug>/ = registration_url=source_url (ISO-8859-2 form, event-specific content verified); regulamin_url + organizer website from API; is_kids recovered from a kids sibling sharing the umbrella base name; date in YYYY-MM-DD, undated 0000-00-00 rows dropped; distances `|`-split with Bieg/NW prefixes stripped + Polish decimal comma→dot; prices/deadline NOT in API → enricher; voivodeship geocoded from city) |
| biegnijmy.pl | 15-25 | Cheerio (imprezy calendar, custom PHP) | Medium-High (Rozbiegany Koszalin regional portal, Zachodniopomorskie — Koszalin/Białogard/Świdwin/Tychowo/Karlino/Manowo/Świeszyno; all events as `tr.bieg` rows on index.php?plik=imprezy&co=<YEAR>- (fetches current+next year), no detail fetches; clean ISO date+city, name from td.czarny, distances from "Dystans:" row, regulamin PDF + STRONA BIEGU website from anchors; source_url=the event page linked from the name cell (/<slug>-<year>); registration_url=the row's ZAPISY page index.php?kat=zapisy/<id>-<city>&plik=zapisy, which hosts biegnijmy's own sign-up form (says "ZAPISY ELEKTRONICZNE ZOSTAŁY ZAKOŃCZONE" once closed), null when the row has no ZAPISY button; NO discipline field → RUNNING FILTER by name drops cycling (rowerowy/kolarski/MTB)/triathlon/swim/ski + CANCELLED (odwołane), mixed bieg+rower events keep running distances; is_kids + event_types (trail/NW/charytatywny/uliczny) mined from name+distances; declared STRONA BIEGU kept even if Facebook; voivodeship geocoded from city; prices/deadline → enricher) |
| motivato.pl | 120-150 | Cheerio (single Astro-rendered listing page) | Medium-High (editorial running portal, NOT a registration platform — so it covers events that register on their OWN sites, the structural blind spot every timing-co scraper shares: measured 2026-08-27, ~21 of 123 dated events were absent from calendar_events, skewed to mountain/ultra/trail + marquee city races; ALL fields from ONE fetch of /kalendarz-biegowy/ — detail pages add nothing, zero detail fetches; name+ISO date+city+distances+surface straight off `article[data-race-item]` data-* attributes; current-year window only (Aug→Dec); 16 "termin przybliżony" rows dropped (bare data-date); voivodeship NOT emitted (source files Łomnica-Zdrój under dolnośląskie) → geocoded from city; the single "Sprawdź zapisy" outbound link is editorially curated and often is NOT registration, so it is ROUTED by destination — .pdf/regulamin path → regulamin_url, verified registration-platform host or zapisy./rejestracja./formularz. subdomain → registration_url, everything else → website; malformed `https://http://…` hrefs repaired, tracking params stripped, and a link reused across multiple events is dropped entirely (motivato attaches one URL to unrelated races); prices/deadline → enricher) |
| biegigorskie.pl | 170-180 | Cheerio (one table per year) | Medium-High (the Polish mountain-running calendar — editorial, single-discipline, so it reaches organizer-run mountain/trail/ultra races the timing platforms never list: measured 2026-09-17, 5 of its 40 future rows were absent from calendar_events; one page per year at /kalendarz-<YEAR>/, a server-rendered Supsystic table, no detail fetches; cells addressed by `data-x` column index with values split across `<br>`; STYLE TAGS FROM THE ICONS (`ultra-2.png` → ultra, cross/anglosaski/alpejski/dlugi → trail, `ULICZNY-1.png` → neither) because mountain race names rarely carry a style word; distances filtered to bare number+unit so the interleaved climb figures (`~500mUp`, `(+/-940m)`) never become races; cycling and run-kayak rows dropped by icon; foreign races dropped on the country line; ZAPISY link → registration_url and often an organizer's own b4sport subsite, WYNIKI means the edition is run → null; name cell's link → website; future rows only; no regulamin published → enricher; voivodeship geocoded from city) |
| super-sport.com.pl | n/a | Cheerio (`/zapisy-formularze.html` listing + detail pages) | Medium (date, distances and regulamin from the detail page's label/value table; the detail page is the registration URL) |
| zmierzymyczas.pl | n/a | Cheerio (homepage listing + detail pages) | Medium (Opolskie/Dolnośląskie timing co; town peeled off the free-text "Miejsce" venue cell; regulamin via `pickRegulaminFromDom`; known ids with no registration URL are re-checked until the date passes) |
| zapisy.raatiming.pl | n/a | Cheerio (homepage listing + event and form pages) | Medium (date parsed from the event name in several formats; distances, registration, regulamin and organizer website from the event and form pages) |
| chronotex.pl | 15-25 | Cheerio (`/zawody/` listing + `/opis-zawodow/?id_zawodow=<id>` detail pages) | High (Chronotex timing co, Skierniewice-based, races in Łódzkie/Śląskie/Małopolska/Podkarpacie/Mazowsze/Lubelskie; date+name+town from the listing, distances from the "Opis zawodów" cell, fees + online deadline from "Wpisowe i wpłata", regulamin from its own "Regulamin zawodów" row, declared "Strona WWW"; registration_url = the "Zarejestruj się" button `/rejestracja/?id_zawodow=<id>`, or the detail page once registration closes; a kids subtitle in the listing name cell is kept so the youth races never merge into the main race; every detail page re-read on each run; the detail page lists participants, which is never read) |

### Pipeline architecture

```
scraper_* tables → scraper_all → calendar_events
        ↓               ↓              ↓
    (raw data)    (merged+enriched)  (public)
```

**Per-source tables:** `scraper_maratonypolskie`, `scraper_datasport`, etc. — raw scraper output, upserted by `source_id`.

**Merge table:** `scraper_all` — cross-source deduped + merged with priority (dostartu > biegiwpolsce > timekeeper > elektronicznezapisy > datasport > maratonypolskie).

**Public table:** `calendar_events` — published rows with `status = 'pending'` or `'active'`. Admin approves via `/calendar-events` → "Do przeglądu" tab.

**All `scraper_*` tables are service_role-only** — `ENABLE ROW LEVEL SECURITY` plus
`REVOKE ALL … FROM anon, authenticated`. Supabase's default privileges on `public` grant
every new table to `anon`/`authenticated`, so a new scraper table is readable and
TRUNCATABLE by anyone holding the publishable key until you revoke it. Both writers (the
Fastify backend and the Python enricher) use `SUPABASE_SERVICE_ROLE_KEY`, which has
`rolbypassrls`, so the lockdown costs nothing. Include both statements in the
`CREATE TABLE` migration for every new scraper table.

### Running the full pipeline

The unattended daily pipeline runs automatically via the `scheduler` container at 08:00 Europe/Warsaw. To trigger ad-hoc:

```bash
# Trigger inside the running scheduler container
docker compose exec scheduler npm run pipeline

# Or use the wrapper (which does exactly that)
./scripts/daily-pipeline.sh
```

**The scheduler runs scrape + enrich only — it does NOT publish and does NOT run any claude-CLI step.** Specifically it runs (in `scheduler/src/pipeline.js` `STEPS`): run-scrapers → run-merge → run-dedup → run-geocode → run-enrich-flags → run-normalize → Python enricher (Ollama) → run-dedup → run-normalize → publish-landing-pages → run-data-audit. It deliberately omits `run-publish.js` (publishing to `calendar_events` is a manual, human-reviewed host step) and the `claude`-CLI scripts `run-enrich-search.js` / `run-enrich-from-regulamin.js` (the backend image has no `claude`; run those on the host). On any non-zero exit it sends a SendGrid failure email; on full success with zero `scraper_all` rows merged/enriched today it sends a `[WARN]`. The final `run-data-audit` step is **`warnOnly`**: it writes nothing, and exit 2 means "found suspect rows" — the scheduler mails a `[WARN]` with the report and CONTINUES rather than aborting the run. A 10:00 watchdog emails `[ALERT]` if the pipeline didn't run in the last 26h.

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
# voivodeship) FROM the regulamin that step 8 located. The regulamin wins on
# distances EXCEPT when its set only SUBTRACTS from the scraper's. A rules
# document that drops races and adds none is a stale edition of a recurring
# series, not a correction (dropsDistances() in scripts/lib/distances.js). The regulamin can be a PDF,
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
# Step 10.5 reviews what step 11 is about to publish. It needs the `claude` CLI,
# `pdftotext` and `textutil`, so it is host-only like steps 8 and 8.1. Default is
# report-only. `--apply` lets the fix agents open and merge pull requests.
cd backend && node --env-file=../.env scripts/run-prepublish-review.js                   # 10.5 (host)
cd backend && node --env-file=../.env scripts/run-publish.js --apply                     # 11
cd backend && node --env-file=../.env scripts/publish-event-pages.js --apply             # post (manifest + OG images)
cd backend && node --env-file=../.env scripts/run-data-audit.js                          # post (read-only report; exit 2 = findings)
```

### Python Enricher — PRIMARY enrichment tool

**Location:** `enricher/` directory

**Tech stack:**
- **Ollama** — local LLM (qwen3.6:27b, called with thinking off) for field extraction
- **SearXNG** — Docker-based web search for URL discovery
- **Crawl4AI** — headless browser for crawling SPAs (dostartu.pl, etc.)
- **Docling** — PDF text extraction for regulamin documents

**What it finds (URLs):** SearXNG search for the two source-of-truth URLs only:
- `registration_url` — sign-up page (search + verification gate)
- `regulamin_url` — rules PDF/page (search + verification gate)

**Verification gate: a searched URL is confirmed before it is written.** Only
search-derived candidates are gated. A scraper column is the organizer's own
declaration and a dostartu statute is derived deterministically, so both are
written unchecked. `steps/verify.py` judges each candidate against content the
pipeline already holds: crawled markdown for an HTML page, and extracted text
for a PDF, `.docx` or Google Drive file. The ladder is: no content drops;
`page_matches_event()` failing drops it for free without a model call; otherwise
Ollama returns match / mismatch / uncertain, an `uncertain` gets one rescue via
`url_slug_matches_event()`, and only a `match` survives. A drop leaves the field
empty for a later run and is recorded in `steps.verify` of the run log.

The token check rejects but never approves. Measured 2026-09-05: a regulamin for
the same race in the wrong year passes `page_matches_event()` and is rejected by
the model at 0.95 confidence. A wrong edition is the most common bad URL, so the
model tier is what catches it.

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
- **zawodybiegowe.pl** — all types (200-500 events)
- **ligabiegowa.pl** — road running league

## Local LLM Enricher

Python-based enrichment pipeline in `enricher/`. Validates URLs, searches SearXNG, crawls pages with Crawl4AI, extracts PDFs with Docling, and uses Ollama (qwen3.6:27b) for field extraction. Only processes future events (date >= today).

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
- Ollama (native macOS, `qwen3.6:27b`, which replaced `gemma3:27b` on 2026-10-22. Every call sends `"think": false`, because Qwen 3.x otherwise reasons first and spends the token budget before writing any JSON)
- SearXNG (Docker via `enricher/docker-compose.yml`, port 8888)
- Crawl4AI + Docling (Python libs in `enricher/.venv/`)

### Key merge safety rules
- Never downgrades trail/ocr/charytatywny/nordic walking → uliczny (scraper keyword evidence preserved)
- `ultra` is NOT a merge-distinguishing style (`distinguishingTags` in `dedup.js`). It states a distance, not the character of the course, and sources disagree about it constantly, so treating it as a style rejected correct merges. trail / nordic walking / ocr still do guard the merge.
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
The admin `frontend/` app self-hosts its own set the same way (`frontend/public/fonts/` + `frontend/public/fonts.css`): it used to load Google Fonts, and on 2026-10-28 fonts.googleapis.com accepted connections and never answered, so that render-blocking stylesheet left the admin panel blank.

## RFID Audit Queries

DB credentials: container `leszyrun-db-1`, user `leszyrun`, db `leszyrun`.

The commands below are for the Mac's Docker database. A race timed on checkpoint1 has its
`gate_events` and `gate_crossings` only in that Pi's native Postgres, so run the same SQL
there over ssh: `PGPASSWORD=leszyrun psql -U leszyrun -d leszyrun -h localhost -f q.sql`
(plain `psql` fails authentication). Copy the query over as a file, because quoting through
ssh breaks. The Pi's journald keeps only the current boot, and reads below the event's
`rssi_threshold` are never stored, so `gate_events` is the only record of a past race.

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

## regulamin_url — pick the document that SAYS it is the regulamin

Polish timing sites publish several documents per event on one page: the regulamin
plus an oświadczenie/zgoda (consent form), a GDPR clause, a course map, a poster.
A scraper that grabs "a PDF from the page" writes the wrong one, and because the
enricher extracts prices, deadline and distances FROM the regulamin, one wrong link
silently empties those fields — or fabricates them (a model asked for a fee in a
fee-less document invents one; that is where the `0–500 zł` rows came from).

**Never select a regulamin by link order or by "it ends in .pdf".** Use the shared
picker — `backend/src/lib/pickRegulaminUrl.js`:

```js
import { pickRegulaminFromDom } from '../../lib/pickRegulaminUrl.js'
const regulaminUrl = pickRegulaminFromDom($, { selector: 'a[href$=".pdf"]', baseUrl: BASE_URL })
```

- A positive token (`regulamin`/`statut`) in the document's own filename wins outright,
  deny-list included — combined documents like `Regulamin_..._RODO.pdf` are real.
- Otherwise a known non-regulamin name (`oświadcz`, `zgoda`, `mapa`, `klauzula`, …)
  in the filename or the anchor text disqualifies it.
- The deny-list is matched against the **filename and anchor text only**, never the
  whole URL — datasport's regulamins live under `/zapisy/portal/regulaminy/`.
- Pass `requireToken: false` ONLY when the links already come from a
  regulamin-scoped section or API field (bgtimesport's `/zawody/regulamin/id/<id>`
  page, elektronicznezapisy's opaque `/download/<hash>/open`).

Two further gates run at enrichment time, both in `run-enrich-from-regulamin.js`:

- `looksLikeRegulamin()` (`backend/src/lib/looksLikeRegulamin.js`) — a **structural**
  test on the document text. A keyword test cannot work here: a consent form says
  "zapoznałem się z treścią regulaminu". It returns `regulamin` / `not-regulamin` /
  `unknown`, and **`unknown` is never treated as a rejection** — a scanned PDF or a
  link-hub PDF extracts to nothing, which is not evidence of being wrong.
- `dropUnsupportedFields()` (`backend/src/lib/extractionEvidence.js`) — deletes an
  extracted `price_from`/`price_to` when the source text contains no fee token at
  all, and likewise for `registration_deadline`. It only ever rejects.

`scripts/run-data-audit.js` reports violations that already exist in the DB (see the
pipeline step list below).

## Fixing a scraper is not enough — force the re-merge

`run-merge` only reads raw rows where `merged_at IS NULL`, so re-running a fixed
scraper updates `scraper_<source>` and **`scraper_all` keeps the old value**. To
propagate a correction:

```bash
cd backend && node --env-file=../.env scripts/run-scrapers.js \
  --only <source> --force <source>          # --force re-fetches detail pages for KNOWN ids
# then clear the bookkeeping stamp so the merge reconsiders those rows:
#   UPDATE scraper_<source> SET merged_at = NULL;
cd backend && node --env-file=../.env scripts/run-merge.js --apply
```

`--force` is required: without it the scraper skips ids it already knows, so the
rows you are trying to fix are never re-fetched.

The merge nulls `enriched_at` / `enriched_regulamin_at` / `enriched_search_at` on
any row whose data changed, so re-run the enrichment steps afterwards — a
corrected regulamin usually yields prices, a deadline and distances the previous
pass could not see.

**A re-scrape is authoritative for its own record** (`incomingWinsOver` in
`src/scrapers/index.js`): same source + same source_id replaces stored values, so
source regressions propagate too. That is deliberate — a URL the source no longer
publishes is not worth preserving — and `run-data-audit.js` flags the common case
(a regulamin filename whose year predates the event).

## Duplicate review — `run-dedup` reports what it will not merge

Besides the pairs it merges, `run-dedup.js` prints a **"Possible duplicates — NOT
merged"** list: same city, same date, name similarity above a low floor but below
the auto-merge bar. It never touches these; they are for the admin "Duplikaty"
tab. The auto-merge threshold must NOT be lowered to absorb them — the Krajenka
pair sits at jaccard 0.250 against a `> 0.25` bar, and dropping the bar starts
merging genuinely separate races that share a town and a date.

## Pre-publish review agents

`run-prepublish-review.js` runs between step 10 and step 11. It asks
`run-publish` in dry-run mode which rows it would write, keeps the ones that
fail `isReadyToAccept`, and gives each one to an agent that traces the missing
field down four layers: the projected `calendar_events` row, `scraper_all`,
`scraper_<source>`, and the live source page. The layer where the field
disappears is the layer with the defect.

**A diagnosis answers per field, not per event.** An event missing four fields
gets four verdicts, because those fields usually have four different causes. The
older schema asked for one verdict per event, and on 2026-09-18 an agent looking
at X-RUN Wielki Finał explained `price_from` and said nothing at all about
`voivodeship`, so that field was never diagnosed, never grouped and never fixed.
A field the agent skips now comes back as `needs-human` rather than as silence.

Findings are then grouped by the file they name, so forty events become about
ten defects. One fix agent per defect works in its own worktree, writes a
failing test first, and opens a pull request. A second agent reviews the diff
without seeing the fixer's reasoning, and only an approval reaches
`gh pr merge`. See `.claude/skills/auditing-event-data/SKILL.md` for the method
itself.

**A reviewer asking for changes gets one revision round.** The concerns go back
to the fix agent in the worktree it already has, and the diff is reviewed again.
If it still does not pass, the pull request and its worktree are LEFT IN PLACE
and named in the closing log line, because deleting the worktree throws away the
only checkout where the change can be revised. #163 and #164 were orphaned that
way.

A branch name is derived from the defect, so the same defect asks for the same
branch every run. **A defect whose pull request is already open is skipped, not
re-fixed** — the previous run already offered a fix and a revision and a reviewer
objected to both, so a third agent would spend money repeating the argument. A
leftover branch with no open pull request is deleted before the new worktree is
made.

**Whether a pull request exists is GitHub's answer, not the agent's.** The
orchestrator runs `gh pr list --head <branch>`. #161 was pushed and opened by an
agent that then reported failure, and it appeared in no report at all.

**A merged fix is propagated to the rows it was measured against.** A scraper fix
re-scrapes that source with `--force` and clears `merged_at` so `run-merge`
reconsiders the rows. An **enricher** fix clears `enriched_at`,
`enriched_search_at` and `enriched_regulamin_at` on the rows in its blast radius,
because the enricher only reads rows it has not enriched yet and so never
revisits its own mistakes — on 2026-09-18 a merged enricher fix measured at 60
rows repaired none of them, because only `sources/<name>.js` was recognised. A
fix to shared code (`backend/src/lib/`, the merge) is left to the nightly
re-scrape and said so in the log rather than silently skipped.

**`absent-at-source` and `needs-human` verdicts are recorded in the
`prepublish_verdicts` Supabase table** (`source`, `source_id`, `field`,
`verdict`, `summary`, `evidence`, `decided_at`), one row per field of an event.
Two things read it: the step itself skips a field settled within the last 30 days
instead of paying an agent to re-derive it, and `GET /api/calendar-events`
attaches the verdicts to each row as `field_verdicts` so the admin list shows
*organizator nie podał* next to the blank column. The verdict expires after 30
days because an organizer who has published nothing today may publish next month.
It NEVER writes `locked_fields` — a field is still locked by a person pressing
"brak", since an automatic lock would block the real value forever once the
organizer published it.

Run it by hand the way you run every other step:
`cd backend && node --env-file=../.env scripts/run-prepublish-review.js`, and add
`--apply` when you want the fix agents to open and merge pull requests.

`scripts/prepublish-review.sh` is the adapter for the scheduled run, and nothing
else needs it. It supplies a working directory, a log file, and an exit code
launchd does not read as a failure. It also skips the run unless a scrape
finished today. A host run leaves `backend/logs/scrapers-<timestamp>.json`, and a
scheduler-container run leaves `logs/last-pipeline-ok.json`. The adapter accepts
either, since the container writes no file under `backend/logs` that the host can
read. Pass `--force` to review anyway.
`scripts/launchd/run.leszy.prepublish-review.plist` schedules the adapter at
14:00 with `--apply`. Drop that argument from the plist to make the scheduled run
report-only. launchd also needs Full Disk Access to reach a repository under
`~/Documents`. Without it the job exits 126 and logs `Operation not permitted`.

The step reports and changes nothing unless you pass `--apply`. Nothing opens a
pull request or merges one without it. Measured on 2026-09-11, one diagnose agent costs
about $1, so a queue of forty events is a real amount of money and of plan
usage. `--limit` bounds it.

The orchestrator enforces four limits itself rather than asking an agent to
respect them, because the step merges without a person reading first:

- Diagnose agents run with `SUPABASE_*`, `DATABASE_URL` and the other keys
  stripped from their environment. Every row they need is in the prompt.
- It rejects a pull request that touches anything outside
  `backend/src/scrapers/`, `backend/src/lib/`, `backend/scripts/`,
  `backend/test/` and `enricher/`, before the reviewing agent sees it. `reviewAgents.js` and the orchestrator itself are
  excluded too, so an agent cannot edit the code that holds the limits.
- The orchestrator runs `npm test --workspace=backend` itself. An agent's own
  report that the tests pass is not evidence.
- At most `--max-merges` (default 5) merges per run.

Agents never write to a database. A wrong value is corrected by fixing the code
and re-running the scrape, which is also why the step runs before publishing
rather than after: nothing has reached `calendar_events` yet.

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
- Do not pull data from Supabase into local DB EXCEPT via the sanctioned reverse-sync workers: `checkins`/`checkin_documents` (`checkinSync.js`), `checkpoint_observations` (realtime in `supabase.js`), and event config + results (`configSync.js` — `events, categories, participants, checkpoints, race_runs, results, event_documents`, plus `checkpoint_categories` via `checkpointLinks.js`). Any NEW reverse-pull must stamp `synced_at = now()` and guard the ON CONFLICT update with `synced_at IS NOT NULL` (never clobber a locally-dirty row) — see `configSync.js`.
- Do not add TypeScript type annotations or `.ts` files
- Do not add an AGPL dependency to `vision/`. The YOLOv8 and Ultralytics family is banned; leszy.run is a commercial service and that licence does not belong inside it. Person detection is MediaPipe, Apache 2.0, and it is enough.
- Do not report a vision read rate measured on runners the model trained on. Race photographs may train the torso reader only with runners held out by bib number, and only the held-out runners measure it. Do not commit the torso reader's labels, crops or weights: they come from photographs of people.
- Do not give `vision/` a database client, a Supabase client, or any outbound network call. Photographs staying on the capture machine is what the GDPR position rests on. The only way data leaves `vision/` is a file on disk (`sightings.jsonl`, `health.json`, `crops/`) that the Node backend tails — extend that log rather than opening a socket.
- Do not add a `trg_reset_synced_at_*` trigger or a `configSync.js` entry for `vision_sessions` / `vision_sightings`, and do not add a `synced_at` column to them. They are device-local on purpose; syncing them would push camera evidence to Supabase and break the data protection position outright.
- Do not use peak RSSI for signal-strength bars — always use live (most recent) reading with decay. See ARCHITECTURE.md → "RSSI display rule — live signal, not peak"
- Do not create local copies of `estimatePositions()` — always import from `@leszyrun/ui` (shared package in `packages/ui/src/lib/positionEstimation.js`). A stale local copy caused a live-race bug where podium ordering ignored checkpoint timestamps. If you think the shared function needs changes, stop and ask the user first — the sorting tiers (status group: in the race → DNF → DSQ → DNS; then finish time → checkpoint index → observation time → start time) are load-bearing for live race display.
- Do not resurrect a DNS runner's checkpoint observations. A `dns` result asserts the runner never left the start line, so any observation under their bib is bogus — a mistyped bib on the volunteer numpad, or a stray read. Three read paths drop them and must stay in agreement: `estimatePositions()` discards the observation entirely (so DNS never enters the checkpoint sorting tier), `CheckpointTrackingTable`'s `splitAt()` blanks their split columns, and `NearFinish` filters them out of "Blisko Mety". **DNF and DSQ deliberately keep theirs** — those runners were on course. Guarded by `packages/ui/test/positionEstimation.test.js` (`npm run test:ui`); the regression came from Nocny Zew Wilka 2026-08-07, where bib 1 was DNS and one manual 5 km entry showed him as "NA TRASIE" ranked above runners who had actually started.
- Do not re-run `estimatePositions()` inside `CategoryCard` when `resultsProp` is provided — the caller already enriched results with checkpoint observations. Re-estimating with empty observations discards checkpoint data and breaks podium ordering during live races. See the comment in `frontend/src/pages/PodiumPage.jsx`.
- Do not query Supabase per viewer or subscribe to Postgres Changes on a public results page. Supabase authorizes every change once per subscriber on a single thread, so that load grows with the viewer count and a bigger instance does not raise it. On 2026-10-20 `pg_stat_statements` held about 114,000 s of Realtime change polling against 147 s of public `results` reads since March, and at Wilczy Półmaraton 2026-10-17 Supabase took 15 to 35 s to answer a one-row query with about 170 viewers. Public results, "Blisko Mety" and the bib search read `/api/results` instead (see "Public results snapshot" above).
- Do not filter race runs to only `'active'` status in podium or public result views — always include `'finished'` too. Filtering only active causes the podium/results to go blank the moment a race is stopped. The podium and public views must keep showing final results after the race ends.
- Do not commit to `main` directly or leave commits stranded on an unmerged branch — branch → push → PR → merge back. See "Development workflow" above and `.claude/skills/dev-workflow/SKILL.md` (enforced by the branch-guard hook).
- Do not add `Co-Authored-By:` trailers to git commits. Never include Claude authorship in commit messages.
- Do not permanently delete calendar events without asking the user for confirmation first. Prefer rejecting (setting status to `rejected`) over deleting — rejected events prevent the scraper from re-adding the same junk.
- Do not DELETE rows from any Supabase table unless the user explicitly says "delete from [table name]". When asked to "remove" an event, ask which table(s) — never assume. Scraper source tables (`scraper_*`) are raw data and should almost never be touched directly.

