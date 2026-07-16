# Supabase CI Release Pipeline — Design

**Date:** 2026-07-16
**Status:** Approved (brainstorming) — ready for implementation planning
**Motivation:** Today nothing about Supabase is automated — schema is applied ad-hoc via MCP `apply_migration`, edge functions via manual MCP/CLI deploy. Only the Vercel frontend auto-deploys on push to `main`. This pipeline makes Supabase releases repeatable, versioned, and coupled to `main`, and it removes the need for an authenticated MCP session to ship backend changes. The teams/clubs feature will be the first change to ride it.

## Summary

A GitHub Actions workflow that, on every push to `main`, applies committed migrations (`supabase db push`), deploys all edge functions (`supabase functions deploy`), then runs the edge-function integration tests as a post-deploy smoke check. No approval gate — PR review before merge is the control. All actions and the Supabase CLI are version-pinned.

## Current state (verified)

- **No `.github/workflows/`** — the repo has zero GitHub Actions.
- **No `supabase/migrations/`** — schema changes were applied imperatively via MCP `apply_migration` (each call recorded a row in the remote `supabase_migrations.schema_migrations` table with its own version string).
- **No `supabase/config.toml`** — the repo is not linked as a Supabase CLI project.
- `supabase/` currently holds `functions/`, `rls-policies.sql`, `tests/`.
- One shared **production** Supabase project (`kojoxazlnxncrpxmnxiq`) — no dev/prod/staging split.
- Vercel auto-deploys `public/` on push to `main` (configured in the Vercel dashboard, not in-repo).
- Edge-function tests are Node integration tests (`node --test`) that POST to the **live** functions and create/clean up test rows (`%@test.leszy.run`) in the single prod project; run today via `public/package.json` → `test:functions` (`node ../supabase/functions/tests/sweep.js && node --test ../supabase/functions/tests/*.test.js`).

## Decisions (resolved during brainstorming)

1. **Trigger:** `on: push` to `main`, **no approval gate.** Backend ships in lockstep with the Vercel frontend. Control = branch → PR → review → merge.
2. **Steps, in order:** `db push` → `functions deploy` (all functions) → `node --test` smoke tests → sweep. A failure at any step fails the workflow (visible red run).
3. **Smoke tests run after deploy** against the just-deployed functions. Accepts per-release test-row churn in prod (same as running them locally today; `sweep.js` cleans up).
4. **Migrations become committed SQL** in `supabase/migrations/`, applied by `db push`. Ad-hoc MCP `apply_migration` is retired for future changes.
5. **Baseline via `supabase db pull`**, run **once by the operator** (not in this session — needs credentials the session doesn't have). This snapshots current prod schema into a baseline migration and syncs local migration history to the remote, so future `db push` applies only new migrations.
6. **All GitHub Actions pinned to commit SHA; Supabase CLI pinned to an exact version** (mandatory supply-chain rule; the `github-actions-supply-chain-pinning` skill governs the workflow file).

## Components

### 1. `supabase/config.toml` (new)

Minimal CLI project config linking the repo to the project:

```toml
project_id = "kojoxazlnxncrpxmnxiq"
```

(Plus any CLI-default sections the `supabase init`/`db pull` bootstrap generates. Keep it minimal — this repo does not run a local Supabase stack.)

### 2. `supabase/migrations/` (new convention)

- Timestamped `.sql` files, ordered by filename (Supabase convention `<YYYYMMDDHHMMSS>_<name>.sql`).
- First file is the **baseline** produced by `db pull` (`<ts>_remote_schema.sql`), reflecting current prod exactly.
- Every subsequent schema change is a new file. **No more ad-hoc `apply_migration`.**
- CLAUDE.md's existing rule ("DDL changes MUST be applied to both local DB and Supabase") is updated: Supabase DDL now goes through a committed migration + the pipeline, not a manual MCP call. (The local Drizzle backend migration path is unaffected — that's a separate concern for the Fastify backend's own Postgres.)

### 3. `.github/workflows/supabase-release.yml` (new)

```yaml
name: Supabase Release
on:
  push:
    branches: [main]
```

Job outline (exact SHAs + CLI version fixed when written, per the pinning skill):
1. `actions/checkout` (SHA-pinned).
2. `supabase/setup-cli` (SHA-pinned) with an explicit `version:` (exact, not `latest`).
3. `supabase link --project-ref "$SUPABASE_PROJECT_REF"` using `SUPABASE_ACCESS_TOKEN`.
4. `supabase db push` (applies pending migrations; uses `SUPABASE_DB_PASSWORD`).
5. `supabase functions deploy` (deploys all functions; `_shared/` bundled automatically).
6. Smoke tests: set up Node (SHA-pinned `actions/setup-node`), `npm ci`, then
   `node supabase/functions/tests/sweep.js && node --test supabase/functions/tests/*.test.js`
   with env `VITE_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` from secrets.
7. On any failure the run goes red; functions are individually versioned in Supabase (roll back by redeploying the prior version), migrations are fixed forward.

Concurrency guard (`concurrency: { group: supabase-release, cancel-in-progress: false }`) so two quick merges don't race `db push`.

### 4. One-time bootstrap (operator runs; not in this session)

Reason it's out-of-session: `link`/`db pull` need `SUPABASE_ACCESS_TOKEN` + DB password, which this session does not hold, and the remote migration history can't be inspected via MCP here.

Commands the operator runs once, locally, then commits the result:

```bash
# from repo root, already authenticated (supabase login) or SUPABASE_ACCESS_TOKEN exported
supabase link --project-ref kojoxazlnxncrpxmnxiq
supabase db pull                       # writes supabase/migrations/<ts>_remote_schema.sql + config.toml
supabase migration list                # VERIFY: local (files) vs remote (history) columns should align
git add supabase/config.toml supabase/migrations
git commit -m "chore(supabase): baseline migration from current prod schema"
```

If `migration list` shows remote entries with no local file (from the old ad-hoc `apply_migration` calls), reconcile with `supabase migration repair --status applied <version>` for each, until local and remote match, before the first `db push` runs. The design's success criterion for the bootstrap is: **`supabase db push` on the baseline is a no-op** (nothing to apply — remote already matches).

### 5. Secrets (operator adds in GitHub → Settings → Secrets and variables → Actions)

- `SUPABASE_ACCESS_TOKEN` — personal/CI access token.
- `SUPABASE_DB_PASSWORD` — database password (for `db push`).
- `SUPABASE_PROJECT_REF` — `kojoxazlnxncrpxmnxiq`.
- `VITE_SUPABASE_URL` — project URL (smoke tests).
- `SUPABASE_SERVICE_ROLE_KEY` — service-role key (smoke tests).

## How the teams/clubs feature rides this pipeline

- The Phase-A migration (currently written as an MCP `apply_migration` in `docs/superpowers/plans/2026-07-16-teams-clubs-phase-a-backend.md` Task 1) is re-expressed as a committed `supabase/migrations/<ts>_teams_clubs_phase_a.sql` (same SQL, including the destructive wipe of the single existing club — still stated + confirmed before the migration is committed/merged).
- The club edge functions live under `supabase/functions/<name>/` as the plan already specifies.
- The `club-logos` storage bucket: created either by a `storage.buckets` INSERT inside the migration, or a one-off via the Storage REST API — decided in the clubs plan revision; either way it stops being an MCP `execute_sql` step.
- Merging the clubs PR to `main` triggers the pipeline: migration applied, functions deployed, smoke tests run. **The clubs backend plan will be revised** to drop its per-function MCP deploy steps and its MCP migration step in favor of "commit migration file + commit function; pipeline deploys on merge; tests run post-merge (or locally against the deployed functions)."

## Risks (accepted)

- **No gate, single prod project:** a bad migration reaches prod on merge. Mitigations: PR review, forward-only migrations, `concurrency` guard. Revisit a staging project / approval gate later if churn warrants.
- **Deploy-then-test:** a failed smoke test cannot un-ship the deploy; it signals a roll-back (function version rollback / forward migration fix).
- **Bootstrap fragility:** if `db pull` + `migration repair` don't converge to a clean no-op `db push`, the first real release could try to re-apply existing DDL. The bootstrap's `migration list` verification + no-op `db push` check is the guard; do not merge feature migrations until the baseline pushes cleanly.

## Out of scope (future)

- Staging/preview Supabase project and an approval gate.
- Automated function-version rollback.
- Migrating the Fastify backend's local Postgres/Drizzle flow into this pipeline (separate concern).
- Deploying only *changed* functions (deploy-all is fine at this scale).
