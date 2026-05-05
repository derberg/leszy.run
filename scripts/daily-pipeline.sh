#!/usr/bin/env bash
# Manual trigger for the daily pipeline.
#
# The 08:00 cron lives inside the scheduler container — this script is for
# ad-hoc runs. We launch it DETACHED (`exec -d`) so closing your terminal,
# losing your network, or laptop sleep can't kill the orchestrator. Without
# this, the npm process gets SIGHUP'd when the docker-compose-exec channel
# breaks; meanwhile sibling containers (enricher) keep running daemon-owned,
# leaving the pipeline half-done with no heartbeat and no continuation.
set -euo pipefail

REPO="/Users/derberg/Documents/GitHub/BeepBeep"
cd "$REPO"

LOG_FILE="logs/daily-pipeline-$(date +%Y%m%d).log"

docker compose exec -d scheduler npm run pipeline

echo "Pipeline triggered (detached). It will write to:"
echo "  $LOG_FILE"
echo ""
echo "Watch progress:"
echo "  tail -F $LOG_FILE"
echo ""
echo "When it completes successfully, logs/last-pipeline-ok.json will be updated."
echo "On any failure you'll get an email at PIPELINE_ALERT_EMAIL."
