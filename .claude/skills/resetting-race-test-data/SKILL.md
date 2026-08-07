---
name: resetting-race-test-data
description: Use when clearing race data from a test run so the event can be re-run clean — "remove all race data", "wyczyść dane z testu", "reset the race", "delete results and re-test", "lemme test again". Covers the multi-host topology (every backend has its own local Postgres), the fact that deletes do NOT sync, the FK order that avoids orphans, and what must survive so you don't re-check-in the whole field.
---

# Resetting race test data

Clearing a test run is not one DELETE. Race data lives in **N+1 independent
copies** — one local Postgres per backend host, plus Supabase — and **the sync
workers never propagate deletes**. Miss a host and the old run reappears on the
screen you're actually testing on.

## The Iron Law

```
DELETE ON EVERY HOST + SUPABASE, OR YOU HAVE NOT DELETED ANYTHING
```

`configSync.js` and `checkinSync.js` are **additive/update-only** (CLAUDE.md:
"Deletes are NOT propagated"). Consequences:

- Deleting on Supabase does **not** remove the row from any backend's local DB.
- A local row with `synced_at IS NULL` is queued to **push back** to Supabase, so
  clearing Supabase first can silently undo itself within 30 s.
- A local row that still exists after you cleared Supabase will re-push and
  resurrect the Supabase row too.

**Neither ordering is safe with the backends running** — that's why stopping them
is the rule, not a precaution:

- *Supabase first, then hosts* — any host row still `synced_at IS NULL` re-pushes
  within 10 s and resurrects the Supabase row.
- *Hosts first, then Supabase* — each host's `configSync` pull re-adds `race_runs`
  and `results` from the still-populated Supabase within 30 s.

So: **stop the backends first**, delete everywhere, then start them. If you can't
stop them (live event, someone else mid-task), you can still win by checking
`synced_at IS NOT NULL` on every host row first — a clean row won't re-push, so
Supabase-then-hosts holds. Verify, don't assume.

## Step 1 — enumerate the hosts. Do not assume.

Ask or verify which backends are bound to this Supabase project. There is
typically more than one, and the one the user is looking at is the one that
matters. As of 2026-08-07:

| Host | Postgres | How to reach it |
|---|---|---|
| Mac (dev) | Docker `leszyrun-db-1` | `docker exec -i leszyrun-db-1 psql -U leszyrun -d leszyrun` |
| `leszyrun-checkpoint1.local` (main race host, Pi5) | **native PG17**, localhost-only (5432 closed on the LAN) | **over ssh** — `ssh leszyrun@leszyrun-checkpoint1.local "psql -U leszyrun -d leszyrun …"` |
| Supabase | remote | PostgREST + service-role key from repo-root `.env` |

**ssh to the Pi — the two traps:**

1. The user is **`leszyrun`**, not the Mac's login name. Omitting it gives
   `Permission denied (publickey,password)`, which reads like a missing key.
2. The Mac's `~/.ssh/id_ed25519` **is** in the Pi's `authorized_keys`, but it is
   **passphrase-protected**. So an agentless `ssh -o BatchMode=yes` still fails
   with `Permission denied (publickey,password)`. That error means "cannot unlock
   the local key", NOT "key not installed" — **do not re-run `ssh-copy-id`
   chasing it.**

If the passphrase isn't in the agent, drive password auth with `expect`
(`/usr/bin/expect` is present; `sshpass` is **not** installed). Pass the password
via env, never argv:

```tcl
# expect -f wrapper.exp "<remote command>"   with PIPASS set in the environment
spawn ssh -o PubkeyAuthentication=no leszyrun@leszyrun-checkpoint1.local $cmd
expect { -re "(P|p)assword:" { send "$env(PIPASS)\r"; exp_continue } eof }
```

There is no `docker exec` on the Pi — its Postgres is native. Verify reachability
before claiming a host is clean:

```bash
ssh -o ConnectTimeout=8 leszyrun@leszyrun-checkpoint1.local "psql -U leszyrun -d leszyrun -c 'select 1'"
```

If a host is unreachable, **say so explicitly and hand the user the SQL** — do
not report the reset as done. A reset that skipped the host under test is worse
than no reset, because it looks finished.

## Step 2 — know which tables are "race data"

**DELETE (per race run):**

| Table | Lives on | Note |
|---|---|---|
| `gate_events` | host-local only (never synced) | raw pings; only reads **above** `rssi_threshold` are here |
| `gate_crossings` | host-local **+ pushed to Supabase** | confirmed crossings |
| `results` | host-local + Supabase | start/finish times, positions, statuses |
| `checkpoint_imports` → `checkpoint_readings` | host-local | cascade from `race_runs` |
| `race_runs` | host-local + Supabase | delete last |

**DELETE only if checkpoints were used (event-scoped, not race-run-scoped):**
`checkpoint_observations` — keyed by `checkpoint_id`, so deleting `race_runs`
does **not** touch it. Find the event's checkpoints first.

**KEEP unless the user explicitly says otherwise:**
`checkins`, `checkin_documents` (else 20 people re-scan), `participants`
(including `rfid_epc` tag assignments), `categories`, `events` (including the
`rssi_threshold` they just tuned), `checkpoints`, `settings` (device-local
reader/MQTT config). Say in your summary that you kept these.

## Step 3 — FK order (the orphan trap)

`gate_events.race_run_id` is **`onDelete: 'set null'`**, not cascade
(`backend/src/db/schema.js`). Deleting `race_runs` first leaves every raw ping
behind with a NULL `race_run_id` — invisible, unattributable, and they
accumulate every reset. **Delete `gate_events` explicitly, first.**

`gate_crossings`, `results`, and `checkpoint_imports` DO cascade from
`race_runs`, but delete them explicitly anyway so the row counts are visible in
the output and you can verify.

## Step 4 — run it

**On each backend host** (adjust the psql invocation per host):

```sql
BEGIN;
CREATE TEMP TABLE rr_del AS
  SELECT rr.id FROM race_runs rr
  JOIN categories c ON c.id = rr.category_id
  WHERE c.event_id = '<EVENT_ID>';
SELECT count(*) AS runs_to_delete FROM rr_del;
DELETE FROM gate_events    WHERE race_run_id IN (SELECT id FROM rr_del);  -- MUST be first
DELETE FROM gate_crossings WHERE race_run_id IN (SELECT id FROM rr_del);
DELETE FROM results        WHERE race_run_id IN (SELECT id FROM rr_del);
DELETE FROM race_runs      WHERE id IN (SELECT id FROM rr_del);
COMMIT;
```

`docker exec` needs **`-i`** or the heredoc is silently swallowed and you get
zero output and zero deletions:

```bash
docker exec -i leszyrun-db-1 psql -U leszyrun -d leszyrun -v ON_ERROR_STOP=1 <<'SQL'
...
SQL
```

**On Supabase** — MCP is often unauthenticated in non-interactive sessions; the
service-role key in repo-root `.env` works via PostgREST. Order matters, same as
above. `Prefer: return=representation` makes the deleted-row count visible:

```bash
set -a; . ./.env; set +a
AUTH=(-H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY")
R=<RACE_RUN_ID>
for t in gate_crossings results; do
  curl -s -X DELETE "$SUPABASE_URL/rest/v1/$t?race_run_id=eq.$R" "${AUTH[@]}" \
    -H "Prefer: return=representation" | python3 -c "import sys,json;print('$t:',len(json.load(sys.stdin)))"
done
curl -s -X DELETE "$SUPABASE_URL/rest/v1/race_runs?id=eq.$R" "${AUTH[@]}" \
  -H "Prefer: return=representation" | python3 -c "import sys,json;print('race_runs:',len(json.load(sys.stdin)))"
```

`backend/src/sync/supabase.js` → `syncDeleteEvent()` is the reference for the
full Supabase cascade order (it also covers checkpoints and checkins — more than
a race reset needs).

## Step 5 — verify, after at least one sync cycle

Sync polls every 30 s, so an immediate re-read proves nothing. **Wait ≥45 s**,
then confirm zero rows on **every host and Supabase**:

```bash
# per host
psql … -c "SELECT count(*) FROM race_runs rr JOIN categories c ON c.id=rr.category_id WHERE c.event_id='<EVENT_ID>';"
# any host's API, no DB access needed
curl -s "http://<host>:3001/api/events/<EVENT_ID>/races"
# orphan check — must be 0
psql … -c "SELECT count(*) FROM gate_events WHERE race_run_id IS NULL;"
```

Then restart the backends you stopped.

## Red flags — STOP

- About to delete only on Supabase because "it syncs everywhere" → it does not.
  Deletes are additive-only; the local rows survive and re-push.
- Reporting "race data removed" when a host was unreachable → name the host you
  could not reach and hand over the SQL.
- Deleting `race_runs` before `gate_events` → silent NULL orphans.
- `docker exec` without `-i` → no output, nothing deleted, looks like success.
- About to delete `checkins` or `participants` because they're "race data" →
  they're not. The user will have to re-check-in the whole field.
- Verifying within a few seconds of the delete → a sync cycle hasn't run yet.
- Wiping the whole event (`DELETE /api/events/:id`) to reset one run → that
  nukes participants, checkins, and config too.

## Prefer "Wznów" when a reset isn't actually needed

Starting a new run leaves the old one as `finished`/`cancelled` — it does not
overwrite anything, and podium/results views include both `active` and
`finished`. If the user only wants another timing attempt, "Wznów" is the
designed path and needs no deletion at all. Reset only when they want the
history genuinely gone.
