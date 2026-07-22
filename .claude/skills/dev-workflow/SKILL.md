---
name: dev-workflow
description: Use when starting ANY change to LeszyRun / BeepBeep — before the first edit, when creating a branch or worktree, when finishing work (push, PR, merge), or when the branch-guard hook denies an edit. Covers the mandatory worktree-per-topic isolation, the PR/merge flow, and the single-Supabase / Vercel / docker deploy model.
---

# LeszyRun / BeepBeep Dev Workflow

## The one rule

**Never commit to `main` directly, and never leave work stranded on a branch.**
Every change goes: worktree off fresh `origin/main` → push → PR → merge back → done.
A feature branch that accumulates commits but never gets a PR or merge is the
exact failure this workflow exists to prevent.

## Step 0 — know your branch, every single time

Before reading code to answer a question OR before editing, run `git status -sb`
(shows current branch + ahead/behind). The checked-out tree is often a **stale
topic branch**: reporting "the code does X" from it is wrong if `main` already
moved. If HEAD is behind `origin/main`, say so up front and reason about
`origin/main` (`git show origin/main:<file>`, `git grep … origin/main`), not the
stale working tree.

If you find unmerged commits on the current branch (`git log --oneline origin/main..HEAD`),
surface that immediately — decide with the user whether to merge/PR them or
abandon them before piling new work on top.

## Worktree per topic — required, not optional

A single checkout has one `HEAD`, so two sessions sharing one directory fight
over the branch: one runs `git switch`, the other's files change underneath it.
Don't work around this with `git stash` juggling or extra clones. Use a **git
worktree per topic** — each is its own directory with its own checked-out
branch, all backed by this repo's single `.git` (one `fetch`, shared
branches/stash/reflog; git refuses to check out the same branch in two
worktrees, which is the guard you actually want).

Rule: **one worktree : one branch : one session.** Spin one up with the helper
(off fresh `origin/main`, inherits the `.vercel` link, runs `npm install` for
all workspaces):

```bash
scripts/worktree.sh new feature/<short-name>   # creates .worktrees/<name>, installs deps
scripts/worktree.sh list
scripts/worktree.sh rm  feature/<short-name>    # removes the dir; branch stays
```

Then open `.worktrees/<name>` as the workspace for that session and work there.
`.worktrees/` is gitignored, and the branch-guard hook is worktree-aware — it
gates each file by the branch of the worktree that owns it, so topics never gate
or clobber each other.

**A worktree is required, not optional:** the PreToolUse branch-guard hook makes
the shared main checkout read-only for edits (on any branch), so all topic work
happens in a `.worktrees/<topic>` directory. This is deliberate — the main
checkout's HEAD is shared, and a concurrent session can switch it mid-task,
landing your commit on the wrong branch. A worktree pins one branch to one
directory, which git enforces.

## The flow

```
scripts/worktree.sh new feature/<short-name>   # 1. fresh worktree off origin/main (main checkout is read-only)
# open .worktrees/feature-<short-name> and work THERE
# ... make changes ...
git push -u origin feature/<short-name>        # 2. push
# 3. open a PR:  gh pr create --fill
# 4. review, then merge:  gh pr merge --squash --delete-branch
# 5. run any post-merge steps below, then remove the worktree:
#    scripts/worktree.sh rm feature/<short-name>
```

Before opening the PR, verify isolation: `git log --oneline origin/main..HEAD`
must show **only your own commits** — anything else means you branched off the
wrong base or another topic leaked in.

## Deploy model (single environment — NOT a dev/prod split)

- **Supabase** — one project (id in CLAUDE.md). There is no dev/prod Supabase
  split. Schema + edge functions ship via the **CI release pipeline**
  (`.github/workflows/supabase-release.yml`) on merge to `main`: a committed
  `supabase/migrations/` file is applied by `supabase db push`, and functions
  deploy via `supabase functions deploy`. **NOT** MCP `apply_migration` /
  `deploy_edge_function`. A table that also lives in the local Fastify DB still
  needs its Drizzle migration (local, auto-run on backend boot) too. See CLAUDE.md
  "DDL changes MUST be applied to both" + [docs/supabase-release-runbook.md](../../../docs/supabase-release-runbook.md).
- **Vercel** — serves the `public/` app only (landing, kalendarz, event/club pages).
  Merging to `main` is what ships it; the build pre-generates static pages from
  committed manifests.
- **Backend / frontend / scheduler / enricher** — run locally via `docker compose up`.
  Not deployed to Vercel.

## Post-merge steps (don't skip)

- **Calendar / event data changed** (`calendar_events`, published events): re-run
  the manifest/page generators and commit the refreshed manifests, or the static
  public pages go stale. See CLAUDE.md "Static HTML generation" +
  `feedback_manifest_refresh`.
- **Schema changed**: confirm the Drizzle migration ran locally, and that a
  committed `supabase/migrations/` file exists so the pipeline applies it to
  Supabase on merge (watch the `Supabase Release` Actions run go green).

## Red flags — STOP

- About to describe "what the code does" without checking the branch → run
  `git status -sb` first; if HEAD is behind `origin/main`, reason about
  `origin/main`, not the stale tree.
- About to edit in the shared main checkout, or `git switch -c` there instead of
  making a worktree → STOP. A concurrent session can switch the main checkout's
  HEAD out from under you, so your commit lands on another session's branch. Use
  `scripts/worktree.sh new feature/<short-name>` and work in that worktree.
- About to add commits to a branch that already has unmerged work with no PR →
  STOP. Resolve the stranded commits (PR/merge or abandon) before piling on.
- branch-guard denied an edit → invoke this skill and follow it; don't just
  `git switch -c` in the main checkout and retry blindly.
- Finished coding but never opened a PR / merged → not done. Work stranded on a
  branch is the failure this workflow prevents.
