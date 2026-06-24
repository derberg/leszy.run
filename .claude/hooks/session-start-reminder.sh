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
      "The skill covers branching off fresh main, pushing, opening a PR, merging back, and the " +
      "post-merge manifest/deploy steps. Branching is only the first step — invoking the skill is " +
      "non-negotiable, even if you already know to branch.\n\n" +
      "If the PreToolUse branch guard denies an edit, the correct response is to invoke the " +
      "`dev-workflow` skill FIRST and then follow it end to end. Do not just `git switch -c` and " +
      "retry — that bypasses the workflow (a feature branch that never gets a PR or merge is the " +
      "exact failure this guards against)."
    )
  }
}'
