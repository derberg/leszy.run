---
name: dev-workflow
description: Use when starting ANY change to LeszyRun / BeepBeep — before the first edit, when creating a branch or worktree, when finishing work (push, PR, merge), or when the branch-guard hook denies an edit on main. Covers worktrees, branching, PR/merge, and the single-Supabase / Vercel / docker deploy model.
---

# LeszyRun / BeepBeep Dev Workflow

## The one rule

**Never commit to `main` directly, and never leave work stranded on a branch.**
Every change goes: branch off fresh `main` → push → PR → merge back → done.
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

## Parallel topics — one worktree per topic

A single checkout has one `HEAD`, so two sessions sharing one directory fight
over the branch: one runs `git switch`, the other's files change underneath it.
Use a **git worktree per topic** — each is its own directory with its own
checked-out branch, all backed by this repo's single `.git`.

Rule: **one worktree : one branch : one session.** Spin one up with the helper
(off fresh `origin/main`, runs `npm install` for all workspaces):

```bash
scripts/worktree.sh new feature/<short-name>   # creates .worktrees/<name>, installs deps
scripts/worktree.sh list
scripts/worktree.sh rm  feature/<short-name>    # removes the dir; branch stays
```

Then open `.worktrees/<name>` as the workspace for that session and work there.
`.worktrees/` is gitignored, and the branch-guard hook is worktree-aware — it
gates each file by the branch of the worktree that owns it, so topics never gate
or clobber each other. You don't *have* to use a worktree for a one-off change
on a clean checkout — but the moment you run more than one session, use them.

## The flow

```
git switch main && git pull             # 1a. ALWAYS land on clean, up-to-date main FIRST
git switch -c feature/<short-name>      # 1b. branch from there — never from whatever was checked out
# ... make changes ...
git push -u origin feature/<short-name> # 2. push
# 3. open a PR:  gh pr create --fill
# 4. review, then merge:  gh pr merge --squash --delete-branch
#    (or fast-forward locally:  git switch main && git merge --ff-only feature/<short-name> && git push)
# 5. run any post-merge steps below
```

**Branching from `main`, not from whatever is checked out, is load-bearing.** A
session can start on *another* topic's branch; branching off it silently inherits
that branch's unmerged commits. Always `git switch main && git pull` first.

## Deploy model (single environment — NOT a dev/prod split)

- **Supabase** — one project (id in CLAUDE.md). There is no dev/prod Supabase
  split. Schema changes are Drizzle migrations (local, auto-run on backend boot)
  AND a matching `mcp__supabase__apply_migration` (Supabase). Apply to BOTH —
  see CLAUDE.md "DDL changes MUST be applied to both".
- **Vercel** — serves the `public/` app only (landing, kalendarz, event pages).
  Merging to `main` is what ships it; the build pre-generates static pages from
  committed manifests.
- **Backend / frontend / scheduler / enricher** — run locally via `docker compose up`.
  Not deployed to Vercel.

## Post-merge steps (don't skip)

- **Calendar / event data changed** (`calendar_events`, published events): re-run
  the manifest/page generators and commit the refreshed manifests, or the static
  public pages go stale. See CLAUDE.md "Static HTML generation" +
  `feedback_manifest_refresh`.
- **Schema changed**: confirm the migration ran locally AND was applied to Supabase.

## Red flags — STOP

- About to describe "what the code does" without checking the branch → run
  `git status -sb` first; if HEAD is behind `origin/main`, reason about
  `origin/main`, not the stale tree.
- About to `git switch -c` without first checking out `main` → STOP. Branch off
  fresh `main`, not the currently-checked-out (possibly unrelated) branch.
- About to add commits to a branch that already has unmerged work with no PR →
  STOP. Resolve the stranded commits (PR/merge or abandon) before piling on.
- branch-guard denied an edit because you're on `main` → invoke this skill and
  follow it; don't just `git switch -c` and retry blindly.
- Finished coding but never opened a PR / merged → not done. Work stranded on a
  branch is the failure this workflow prevents.
