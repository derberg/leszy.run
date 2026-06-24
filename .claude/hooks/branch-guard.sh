#!/usr/bin/env bash
# PreToolUse guard: blocks edits to this repo's files while the OWNING worktree is on main/master.
# Worktree-aware: each worktree is gated by its own branch, so parallel topics in
# separate worktrees don't gate each other. Enforces .claude/skills/dev-workflow/SKILL.md
# ("no changes on main without a branch + PR").

set -u

payload=$(cat)
file=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // .tool_input.notebook_path // ""')
[ -z "$file" ] && exit 0

# The file may not exist yet (new file). Walk up to its nearest existing ancestor dir.
dir=$(dirname "$file")
while [ ! -d "$dir" ] && [ "$dir" != "/" ] && [ "$dir" != "." ]; do
  dir=$(dirname "$dir")
done
[ -d "$dir" ] || exit 0

# Identify the repo (shared object store) that owns the file, via its git-common-dir.
# All worktrees of one repo share a common-dir, so this is stable across worktrees.
file_common=$(git -C "$dir" rev-parse --git-common-dir 2>/dev/null) || exit 0
[ -z "$file_common" ] && exit 0
file_common=$(cd "$dir" && cd "$file_common" 2>/dev/null && pwd -P) || exit 0

# Same lookup for THIS hook (script lives in <some-worktree>/.claude/hooks/).
hook_dir=$(cd "$(dirname "$0")" 2>/dev/null && pwd) || exit 0
self_common=$(git -C "$hook_dir" rev-parse --git-common-dir 2>/dev/null)
self_common=$(cd "$hook_dir" && cd "$self_common" 2>/dev/null && pwd -P)

# Only gate files belonging to THIS repo (any of its worktrees). Anything else passes.
[ "$file_common" != "$self_common" ] && exit 0

# Branch of the specific worktree that owns the file.
branch=$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null)
case "$branch" in
  main|master) ;;
  *) exit 0 ;;
esac

jq -n --arg b "$branch" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: ("dev-workflow violation: the worktree owning this file is on branch \"" + $b + "\". No changes on main — every change goes through a branch + PR, then merges back. Spin up an isolated topic worktree: scripts/worktree.sh new feature/<short-name>  (or, in place: git switch -c feature/<short-name>). See .claude/skills/dev-workflow/SKILL.md.")
  }
}'
