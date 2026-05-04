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

ENV_FILE="$REPO/.env"

# Bash reads .env (cron's FDA propagates to bash) and exports vars into the environment.
# node then inherits the env from bash without ever reading the file directly — sidesteps
# macOS TCC, which doesn't propagate FDA from cron→bash to grandchild binaries like node.
[ -r "$ENV_FILE" ] || { echo "FATAL: $ENV_FILE not readable" >&2; exit 1; }
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

{
  echo ""
  echo "==== $(date '+%Y-%m-%d %H:%M:%S') daily pipeline starting ===="

  cd "$REPO/backend"
  echo "[1/11] run-scrapers";       node scripts/run-scrapers.js
  echo "[2/11] run-merge";          node scripts/run-merge.js --apply
  echo "[3/11] run-dedup";          node scripts/run-dedup.js --apply
  echo "[4/11] run-geocode";        node scripts/run-geocode.js --apply
  echo "[5/11] run-enrich-flags";   node scripts/run-enrich-flags.js --apply
  echo "[6/11] run-normalize";      node scripts/run-normalize.js --apply

  echo "[7/11] python enricher (LOCAL LLM — PRIMARY TOOL)"
  cd "$REPO/enricher"
  docker compose up -d
  ./.venv/bin/python -m enricher run

  cd "$REPO/backend"
  echo "[8/11] run-enrich-search";  node scripts/run-enrich-search.js --apply
  echo "[9/11] run-dedup";          node scripts/run-dedup.js --apply
  echo "[10/11] run-normalize";     node scripts/run-normalize.js --apply
  echo "[11/11] run-publish";       node scripts/run-publish.js --apply

  echo "==== $(date '+%Y-%m-%d %H:%M:%S') daily pipeline complete ===="
} >> "$LOG" 2>&1
