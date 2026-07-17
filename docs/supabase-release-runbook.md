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
