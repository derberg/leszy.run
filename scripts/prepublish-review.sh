#!/usr/bin/env bash
# Run the pre-publish review on the host.
#
# The scheduler container cannot run this step. It has no `claude` CLI, and no
# `pdftotext` or `textutil` either, and the agents need all three. The container
# also never runs run-publish, because publishing is a human decision. So the
# review runs here, on the host, after the nightly scrape and enrich finish, and
# before the operator publishes.
#
#   scripts/prepublish-review.sh              diagnose and report, open nothing
#   scripts/prepublish-review.sh --apply      let the fix agents open and merge PRs
#   scripts/prepublish-review.sh --force      run even if today's pipeline has not finished
#
# Any other flag is passed through to run-prepublish-review.js.
set -euo pipefail

REPO="/Users/derberg/Documents/GitHub/BeepBeep"
cd "$REPO"

FORCE=0
ARGS=()
for arg in "$@"; do
  if [ "$arg" = "--force" ]; then FORCE=1; else ARGS+=("$arg"); fi
done

# Reviewing yesterday's data wastes a full run of agents on events that the
# night's scrape may already have filled in. The scheduler writes this heartbeat
# only after every step succeeds.
HEARTBEAT="logs/last-pipeline-ok.json"
if [ "$FORCE" -eq 0 ]; then
  if [ ! -f "$HEARTBEAT" ]; then
    echo "No $HEARTBEAT. The nightly pipeline has never finished. Use --force to review anyway."
    exit 0
  fi
  HEARTBEAT_DAY=$(/usr/bin/python3 -c "import json,sys;print(json.load(open('$HEARTBEAT'))['ts'][:10])" 2>/dev/null || echo "")
  TODAY=$(date +%Y-%m-%d)
  if [ "$HEARTBEAT_DAY" != "$TODAY" ]; then
    echo "The last successful pipeline finished on ${HEARTBEAT_DAY:-an unknown date}, not today ($TODAY)."
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
# Exit 2 means the step found something and said so. That is the normal outcome
# and must not read as a failure to whatever scheduled this.
if [ "$STATUS" = "2" ]; then exit 0; fi
exit "$STATUS"
