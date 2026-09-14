#!/usr/bin/env bash
# Adapter that lets launchd run the pre-publish review.
#
# For a run by hand, call the step directly, the same way as every other
# pipeline step:
#
#   cd backend && node --env-file=../.env scripts/run-prepublish-review.js
#   cd backend && node --env-file=../.env scripts/run-prepublish-review.js --apply
#
# This wrapper exists for the scheduled 14:00 run, which needs three things the
# node script does not provide: a fixed working directory, a log file, and an
# exit code launchd does not read as a failure. The step exits 2 when it finds
# something, which is its normal outcome.
#
#   scripts/prepublish-review.sh              diagnose and report, open nothing
#   scripts/prepublish-review.sh --apply      let the fix agents open and merge PRs
#   scripts/prepublish-review.sh --force      run even when no scrape ran today
#
# Any other flag is passed through to run-prepublish-review.js.
set -euo pipefail

# Resolve the repo from this file's own location, so the script works from a
# worktree as well as from the main checkout. launchd invokes it by absolute
# path, which resolves the same way.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

FORCE=0
ARGS=()
for arg in "$@"; do
  if [ "$arg" = "--force" ]; then FORCE=1; else ARGS+=("$arg"); fi
done

# Reviewing yesterday's data spends a full run of agents, at about a dollar
# each, on events that today's scrape may already have filled in. So the
# scheduled run needs evidence that a scrape finished today.
#
# Both ways of running the pipeline count, and each writes a different file. A
# host run writes backend/logs/scrapers-<timestamp>.json. A scheduler-container
# run writes logs/last-pipeline-ok.json and nothing else the host can read,
# because the container has no mount for backend/logs. Check both, or the gate
# never opens for whichever way is actually in use.
if [ "$FORCE" -eq 0 ]; then
  TODAY=$(date +%Y%m%d)
  SCRAPED_TODAY=0
  if compgen -G "backend/logs/scrapers-${TODAY}T*.json" > /dev/null; then SCRAPED_TODAY=1; fi

  HEARTBEAT="logs/last-pipeline-ok.json"
  if [ "$SCRAPED_TODAY" -eq 0 ] && [ -f "$HEARTBEAT" ]; then
    HEARTBEAT_DAY=$(/usr/bin/python3 -c "import json;print(json.load(open('$HEARTBEAT'))['ts'][:10].replace('-',''))" 2>/dev/null || echo "")
    [ "$HEARTBEAT_DAY" = "$TODAY" ] && SCRAPED_TODAY=1
  fi

  if [ "$SCRAPED_TODAY" -eq 0 ]; then
    echo "No scrape finished today ($(date +%Y-%m-%d)), on this host or in the scheduler."
    echo "Nothing new to review. Use --force to review the current data anyway."
    exit 0
  fi
fi

mkdir -p logs
LOG_FILE="logs/prepublish-review-$(date +%Y%m%d).log"

cd backend
set +e
node --env-file=../.env scripts/run-prepublish-review.js "${ARGS[@]+"${ARGS[@]}"}" 2>&1 | tee -a "../$LOG_FILE"
STATUS=${PIPESTATUS[0]}
set -e

echo ""
echo "Log: $LOG_FILE"
if [ "$STATUS" = "2" ]; then exit 0; fi
exit "$STATUS"
