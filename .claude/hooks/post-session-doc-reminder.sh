#!/usr/bin/env bash
# Stop hook: a docs + skills + automation gate.
#
# When this branch changed code where docs usually drift (backend routes/schema,
# pipeline scripts, scrapers, sync, crossing detector, public/frontend, enricher,
# scheduler, shared UI) OR automation itself (.claude/, .github/), BLOCK the stop
# once and make the assistant run an HONEST self-check before finishing.
#
# Three things get reviewed:
#   1. Docs — did any documented contract drift (CLAUDE.md API/pipeline rules,
#      ARCHITECTURE.md, docs/, enricher/README, scrapers.md)?
#   2. Skills — did the diff make a .claude/skills/ skill wrong, OR did THIS
#      SESSION reveal a reusable workflow/gotcha worth codifying as a NEW skill
#      (or an addition to one)? The summary must ALWAYS state a skills verdict.
#   3. Automation + learning — did the diff, or anything learned this session,
#      make a hook, settings entry, CI workflow, or CLAUDE.md rule wrong or
#      incomplete? A session learning is reason enough to update one — so a pure
#      automation/learning session no longer slips through silently.
#
# Design intent: this is NOT a checklist-grinder. The bar is "genuinely needed",
# not "produce output". The prompt tells the model to challenge itself and exit
# fast with "nothing needed" when nothing actually drifted or surfaced — no
# busywork, no invented skills. It only fires when watched paths changed, so quiet
# chat/read-only sessions are never gated.
#
# - Fires whenever watched code changed — it does NOT go quiet just because some
#   doc was touched. Touching one doc is not evidence that every affected doc is
#   current; only the model can judge semantic coverage. Docs already changed on
#   the branch are listed in the prompt so the review focuses on what's still stale.
# - Allows the stop silently on branches that didn't change watched paths.
# - Skips on the main checkout: real topic work happens in a per-topic worktree
#   on a feature branch (branch-guard makes main read-only for edits), and the
#   diff base below is origin/main — a remote-tracking ref that only moves on
#   `git fetch`. Right after a PR merges, sitting on main with a stale origin/main
#   makes the just-merged commit show up in origin/main...HEAD, re-firing the
#   whole review for work that's already merged. Skipping on main removes that
#   false alarm.
# - Reads stop_hook_active from the payload to avoid an infinite stop loop:
#   once we've blocked once in a stop-continuation chain, we let the next stop
#   through regardless (so the gate costs exactly one deliberate review pass).

set -u

# Read the Stop-hook payload on stdin. If we're already in a continuation
# triggered by a previous block, allow the stop (loop guard).
input=$(cat 2>/dev/null || true)
stop_active=$(printf '%s' "$input" | jq -r '.stop_hook_active // false' 2>/dev/null || echo false)
[ "$stop_active" = "true" ] && exit 0

project=$(cd "$(dirname "$0")/../.." 2>/dev/null && pwd)
[ -z "$project" ] && exit 0

# Skip on main (see header) — topic work lives in worktrees on feature branches.
branch=$(git -C "$project" symbolic-ref --short -q HEAD 2>/dev/null || true)
[ "$branch" = "main" ] && exit 0

# Code paths whose changes usually require a docs and/or skills update.
CODE='^(backend/src/|backend/scripts/|public/scripts/|public/src/|frontend/src/|packages/ui/|enricher/|scheduler/)'
# Automation paths: CI + the harness's own skills/hooks/settings.
AUTOMATION='^(\.github/|\.claude/)'
# Doc/skill paths — surfaced in the prompt as "already touched" so the review
# focuses on what's still likely stale. NOT used to silence the gate.
DOCS='^(docs/|CLAUDE\.md|ARCHITECTURE\.md|.*README\.md|\.claude/skills/)'

# Files in this branch's diff vs origin/main + anything uncommitted. Use origin/main
# (not local main, which goes stale and inflates the diff with already-merged commits).
changed=$(
  {
    git -C "$project" diff --name-only origin/main...HEAD 2>/dev/null || true
    git -C "$project" status --porcelain 2>/dev/null | awk '{print $NF}'
  } | sort -u
)

code_changed=$(printf '%s\n' "$changed" | grep -E "$CODE" | head -20)
automation_changed=$(printf '%s\n' "$changed" | grep -E "$AUTOMATION" | head -20)
docs_changed=$(printf '%s\n' "$changed" | grep -E "$DOCS")
[ -z "$docs_changed" ] && docs_changed="(none yet)"

# Nothing relevant changed -> nothing to gate.
[ -z "$code_changed" ] && [ -z "$automation_changed" ] && exit 0

reason=$(printf 'DOCS + SKILLS + AUTOMATION GATE — run an HONEST self-check before finishing. The bar is "genuinely needed", not "produce output". If nothing drifted and no skill gap surfaced, emit EXACTLY the line `Docs, skills, automation: unaffected.` and finish — no headings, no per-category breakdown, no recap of what you checked. Do NOT invent docs work or invent skills to look busy. This gate fires once; spend it on real judgement, not on writing about the judgement.

Code changed on this branch (where docs/skills commonly drift):
%s

Automation changed on this branch (.claude/ or .github/):
%s

Docs/skills already updated on this branch (may be incomplete):
%s

DOCS — challenge yourself, do not skim:
- For each changed area, did any *documented contract* actually change? Read the real diff (`git diff origin/main...HEAD`), then open the candidate doc and compare — do not infer from memory. Update only what truly drifted.
- Candidate doc homes (most changes touch the first two):
  - CLAUDE.md — API routes & response shapes, pipeline steps + scraper table, sync rules, crossing-detector config, status vocabularies, env vars, SEO/static-gen rules, dev-workflow rules. Keep it rules-not-narrative.
  - ARCHITECTURE.md — system design, flows, RSSI/position-estimation rules, diagrams.
  - docs/scrapers.md / docs/impinj-r700-api/ / enricher/README.md — only if that subsystem changed.

SKILLS — ask, and answer honestly:
1. Did this diff make any existing skill in .claude/skills/ wrong, incomplete, or misleading (e.g. adding-a-new-scraper if the scraper-add workflow changed, dev-workflow if branching/worktree/deploy rules changed)? If so, fix it via the writing-skills skill.
2. Did THIS SESSION reveal a repeatable workflow, gotcha, or correction you had to work out the hard way and would want codified — a genuinely reusable pattern, not a one-off? If it clears that bar, PROPOSE a new skill (name + one-line description + why it is reusable) and offer to create it via the writing-skills skill. Do not create it silently, and do not propose marginal/one-off skills.
3. If neither applies, skills are simply unaffected — say so explicitly.

AUTOMATION + LEARNING review (ALWAYS do this, even if only code changed):
Did the diff above, OR anything you learned THIS session (a recurring failure, a guard gap, a confusing or missing step), make any of these wrong, incomplete, or worth clarifying? A session learning is reason enough to update one now:
- .claude/hooks/ + .claude/settings.json — session guards and automation
- .github/workflows/ — CI/CD (Supabase release pipeline, action SHA pinning)
- CLAUDE.md — rules + pointers

Report the result:
- NOTHING needed anywhere → emit exactly `Docs, skills, automation: unaffected.` and finish. Nothing else — no listing of what you reviewed or why it was fine.
- Something WAS updated or proposed → ONE sentence, no heading, no bullet list: name only what changed, plus a terse verdict for the silent categories (e.g. `Docs: CLAUDE.md updated; skills + automation: unaffected.`).
The analysis must be real; only the written summary is compressed. Never pad the summary to prove the review happened. You may finish once you have emitted it.' "$code_changed" "${automation_changed:-"(none)"}" "$docs_changed")

# Stop hooks use {decision:"block", reason} to keep the assistant going; the
# reason is fed back as context. systemMessage surfaces the gate to the user.
jq -n --arg r "$reason" '{ decision: "block", reason: $r, systemMessage: "Docs + skills + automation gate: watched paths changed — running an honest self-check before finishing." }'
