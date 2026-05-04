#!/usr/bin/env bash
# Manual trigger for the daily pipeline.
# Real scheduling lives inside the `scheduler` container (node-cron @ 08:00 Europe/Warsaw).
# This wrapper just hands off to the scheduler so ad-hoc runs use the exact same code path.
set -euo pipefail

REPO="/Users/derberg/Documents/GitHub/BeepBeep"
cd "$REPO"

exec docker compose exec scheduler npm run pipeline
