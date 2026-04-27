#!/usr/bin/env bash
# Daily scrape + enrich + publish pipeline.
# Triggered by user crontab at 08:00 Europe/Warsaw.
set -euo pipefail

REPO="/Users/derberg/Documents/GitHub/BeepBeep"
LOG_DIR="$REPO/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/daily-pipeline-$(date +%Y%m%d).log"

# cron has a minimal PATH — extend it so docker, node, brew tools resolve
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

{
  echo ""
  echo "==== $(date '+%Y-%m-%d %H:%M:%S') daily pipeline starting ===="

  cd "$REPO/backend"
  echo "[1/11] run-scrapers";       node --env-file=../.env scripts/run-scrapers.js
  echo "[2/11] run-merge";          node --env-file=../.env scripts/run-merge.js --apply
  echo "[3/11] run-dedup";          node --env-file=../.env scripts/run-dedup.js --apply
  echo "[4/11] run-geocode";        node --env-file=../.env scripts/run-geocode.js --apply
  echo "[5/11] run-enrich-flags";   node --env-file=../.env scripts/run-enrich-flags.js --apply
  echo "[6/11] run-normalize";      node --env-file=../.env scripts/run-normalize.js --apply

  echo "[7/11] python enricher (LOCAL LLM — PRIMARY TOOL)"
  cd "$REPO/enricher"
  docker compose up -d
  ./.venv/bin/python -m enricher run

  cd "$REPO/backend"
  echo "[8/11] run-enrich-search";  node --env-file=../.env scripts/run-enrich-search.js --apply
  echo "[9/11] run-dedup";          node --env-file=../.env scripts/run-dedup.js --apply
  echo "[10/11] run-normalize";     node --env-file=../.env scripts/run-normalize.js --apply
  echo "[11/11] run-publish";       node --env-file=../.env scripts/run-publish.js --apply

  echo "==== $(date '+%Y-%m-%d %H:%M:%S') daily pipeline complete ===="
} >> "$LOG" 2>&1
