#!/usr/bin/env bash
# SessionStart hook: front-loads the dev-workflow skill requirement so the
# assistant invokes it BEFORE the first edit, instead of being caught by
# branch-guard.sh mid-task. The branch guard is the safety net; this is
# the actual instruction.

set -u

jq -n '{
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: (
      "DEV-WORKFLOW REQUIREMENT (LeszyRun / BeepBeep):\n" +
      "Before ANY tool call that mutates this repo (Edit, Write, MultiEdit, NotebookEdit, " +
      "or Bash commands that change files / git state / installed deps), you MUST invoke the " +
      "`dev-workflow` skill via the Skill tool and follow it.\n\n" +
      "The shared main checkout is read-only for edits — ALL topic work happens in an isolated " +
      "git worktree: scripts/worktree.sh new feature/<short-name>, then work in .worktrees/<name>. " +
      "The skill covers worktrees, branching off main, the PR + merge flow, and the post-merge " +
      "manifest/deploy steps. Creating the worktree is only the first step — invoking the skill " +
      "is non-negotiable, even if you already know the flow.\n\n" +
      "If the PreToolUse branch guard denies an edit, the correct response is to invoke the " +
      "`dev-workflow` skill FIRST and then follow it end to end. Do not just `git switch -c` in " +
      "the main checkout and retry — that bypasses the worktree isolation (a feature branch that " +
      "never gets a PR or merge is the exact failure this guards against)."
    )
  }
}'
