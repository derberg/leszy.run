# Supabase Release Runbook

How Supabase schema and edge functions ship to production, and the one-time setup
that makes it work. Design: [docs/superpowers/specs/2026-07-16-supabase-ci-release-pipeline-design.md](superpowers/specs/2026-07-16-supabase-ci-release-pipeline-design.md).

## What ships, and when

On every push to `main`, `.github/workflows/supabase-release.yml`:

1. Links the CLI to the project.
2. `supabase db push` — applies any migration in `supabase/migrations/` not yet applied on the remote.
3. `supabase functions deploy` — deploys **all** edge functions (settings come from `supabase/config.toml`).
4. Runs the edge-function integration tests against the just-deployed functions as a smoke check.

No approval gate. The control is **branch → PR → review → merge**. This runs alongside Vercel's existing on-`main` frontend deploy, so frontend and backend ship together.

## One-time bootstrap (operator, local)

This must be done **once** before the workflow can run cleanly. It needs credentials the CI/agent session does not hold, so you run it locally where you're authenticated.

### 1. Authenticate + link

```bash
# from repo root
supabase login                       # or: export SUPABASE_ACCESS_TOKEN=<token>
supabase link --project-ref kojoxazlnxncrpxmnxiq
```

### 2. Create the baseline migration from current prod schema

The schema was built ad-hoc via MCP `apply_migration`, so there are no migration
files yet. Snapshot the current prod schema into a baseline migration:

```bash
supabase db pull                     # writes supabase/migrations/<ts>_remote_schema.sql
```

### 3. Verify local history matches remote

```bash
supabase migration list
```

Both the `Local` and `Remote` columns should line up. If the `Remote` column shows
versions (from the old ad-hoc `apply_migration` calls) that have **no local file**,
mark them as already-applied so `db push` won't try to re-run them:

```bash
supabase migration repair --status applied <version>   # repeat per orphan version
```

### 4. Confirm `db push` is a no-op

The success criterion for the bootstrap — nothing should be pending:

```bash
supabase db push
# expected: "Remote database is up to date." (no migrations applied)
```

If `db push` tries to apply DDL that already exists, STOP — the history isn't
reconciled yet. Do not proceed until `db push` is a clean no-op.

### 5. Commit the baseline

```bash
git add supabase/config.toml supabase/migrations
git commit -m "chore(supabase): baseline migration from current prod schema"
```

> The `supabase db pull` may append extra sections to `supabase/config.toml`.
> Keep the `[functions.*]` blocks already committed here — they carry the
> load-bearing `verify_jwt = false` + `entrypoint = index.js` settings. Merge,
> don't overwrite.

## GitHub secrets (operator)

Add under **Settings → Secrets and variables → Actions → Repository secrets**:

| Secret | Value | Used by |
|---|---|---|
| `SUPABASE_ACCESS_TOKEN` | Supabase personal/CI access token | link, db push, functions deploy |
| `SUPABASE_DB_PASSWORD` | Database password | link, db push |
| `SUPABASE_PROJECT_REF` | `kojoxazlnxncrpxmnxiq` | link, functions deploy |
| `VITE_SUPABASE_URL` | Project URL | smoke tests |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role key | smoke tests |

## Registration jobs: secrets and the check (operator, once)

The `registration-jobs` pg_cron job (`20261030125000_registration_jobs_cron.sql`) POSTs to the
`registration-jobs` edge function every 15 minutes through pg_net. It sends payment reminders,
„Zgłoszenie wygasło” notices, lost confirmations, refund retries, and the operator alert digest.
The other three jobs (`registration-expire-orders`, `registration-release-orphan-orders`,
`registration-purge-expired`) are SQL only and need nothing below.

**1. Function secrets.** `PIPELINE_ALERT_EMAIL` and `REGISTRATION_JOBS_SECRET` are needed from the
day of merge: without the first the function answers 503, without the second 404, and the
watchdog then alerts every day. The `DPAY_*` values are needed only once paid registration is
switched on (P3-R16): until they are set, a run skips the two steps that call dpay (refund retries
and the dpay check), reports them as `"skipped": {"refund_retries": "dpay_not_configured", …}`
with no alert, does everything else and stamps its heartbeat.

| Secret | Value |
|---|---|
| `DPAY_SERVICE`, `DPAY_SECRET` | the dpay service name and secret |
| `DPAY_API_BASE`, `DPAY_PANEL_BASE` | the dpay API and panel base URLs |
| `DPAY_IPN_URL` | `https://kojoxazlnxncrpxmnxiq.supabase.co/functions/v1/dpay-ipn` |
| `PUBLIC_SITE_URL` | `https://www.leszy.run` |
| `PIPELINE_ALERT_EMAIL` | the operator address for alerts |
| `REGISTRATION_JOBS_SECRET` | a random value of 32+ characters; the same value goes into Vault below |

```bash
supabase secrets set REGISTRATION_JOBS_SECRET='<random>' PIPELINE_ALERT_EMAIL='<operator>' \
  PUBLIC_SITE_URL='https://www.leszy.run' --project-ref kojoxazlnxncrpxmnxiq
```

**2. Vault.** The names must be exactly these, because the cron command reads them by name.
`vault.create_secret` refuses a name that already exists, so run this once, and use step 4 to
change a value later.

```sql
-- Supabase SQL editor (production)
SELECT vault.create_secret('https://kojoxazlnxncrpxmnxiq.supabase.co/functions/v1/registration-jobs', 'registration_jobs_url');
SELECT vault.create_secret('<the REGISTRATION_JOBS_SECRET value>', 'registration_jobs_secret');
```

**3. Check the HTTP outcome, not only the cron run.** `cron.job_run_details` says `succeeded`
even when the function answered 404 (wrong secret) or 503 (a function secret missing), because
`net.http_post` only queues the request. After the next quarter hour, read the answer pg_net
stored. pg_net keeps responses about 6 hours, and other callers share the table, so filter on the
body:

```sql
SELECT jobname, schedule, active FROM cron.job WHERE jobname LIKE 'registration-%';  -- 4 rows, every one active = true
SELECT job, interval_seconds, last_ok_at FROM registration_job_heartbeats ORDER BY job;  -- each last_ok_at within 3 intervals
SELECT created, status_code, left(content, 300)
  FROM net._http_response
 WHERE content LIKE '{"data":{"checked"%' OR status_code IS DISTINCT FROM 200
 ORDER BY created DESC LIMIT 5;
```

In production all four jobs must be `active = true`. `supabase/seed.sql` deactivates every
`registration-*` job, but the seed only runs on a local or CI stack (`supabase db reset`); a
production job that reads `false` was switched off by hand and nothing expires or gets sent.

Expect `status_code = 200` with a body starting `{"data":{"checked"` (before dpay is configured
it carries `"skipped"` for the two dpay steps; that is expected). A NULL `status_code` (with
`timed_out` or `error_msg` set) is a failure too: pg_net could not reach the function or gave up. A 404 means the two
secret values differ, and a 503 means a function secret is missing (the function logs which one).

**Heartbeats and the watchdog.** Every finished run stamps `registration_job_heartbeats.last_ok_at`
(the three SQL jobs in their cron command, `registration-jobs` at the end of the function). The
scheduler container (`scheduler/src/registrationWatchdog.js`, every 15 minutes) reads the table with
`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` and e-mails `[ALERT] LeszyRun registration jobs stopped`
to `PIPELINE_ALERT_EMAIL` when one is older than 3 × `interval_seconds`: once per outage, again every
24 hours while it lasts. A table it cannot read, or an empty one, is alerted too. The scheduler runs
on the operator's machine, so the watchdog is only as awake as that machine.

**`cron.job_run_details` grows.** The four registration jobs add about 680 rows a day and Supabase
does not prune the table. Once a quarter, or when it gets large:

```sql
DELETE FROM cron.job_run_details WHERE end_time < now() - interval '7 days';
```

**4. Rotation.** Set the function secret first, then Vault. Runs between the two steps answer
404 and do nothing, and the next run after both are set catches up.

```bash
supabase secrets set REGISTRATION_JOBS_SECRET='<new>' --project-ref kojoxazlnxncrpxmnxiq
```

```sql
SELECT vault.update_secret((SELECT id FROM vault.secrets WHERE name = 'registration_jobs_secret'), '<new>');
```

## Day-to-day: making a schema change

1. Create a migration file: `supabase migration new <name>` → edit the generated
   `supabase/migrations/<ts>_<name>.sql`.
2. Commit it on your feature branch, open a PR.
3. On merge to `main`, the workflow applies it via `db push`.

**Retire MCP `apply_migration` for production DDL** — schema changes now go through
committed migrations + this pipeline. (The Fastify backend's local Postgres/Drizzle
flow is unchanged and separate.)

## Day-to-day: adding an edge function

1. Add `supabase/functions/<name>/index.js`.
2. **Add a block to `supabase/config.toml`** with `verify_jwt = false` and
   `entrypoint = "./functions/<name>/index.js"` (see the note in that file — a
   missing/incorrect block will break the function's auth on deploy).
3. Commit; merge deploys it.

## Rollback

- **Function:** redeploy the previous version (functions are versioned in Supabase),
  e.g. revert the commit and let the pipeline redeploy, or deploy the prior source.
- **Migration:** forward-only — write a new migration that undoes the change. There
  is no `db push` rollback.

## Known risks (accepted)

- **No gate, single prod project.** A bad migration reaches prod on merge. Mitigation:
  PR review, forward-only migrations, the `concurrency` guard.
- **Deploy-then-test.** A failed smoke test cannot un-ship the deploy; a red run signals
  a rollback.
- **First real run.** Because CI specifics (CLI `db push` non-interactivity, `index.js`
  entrypoint resolution, `verify_jwt` from config) can't be verified from an agent
  session, watch the FIRST release run closely and keep the manual `supabase functions
  deploy` / `db push` commands handy as a fallback.
