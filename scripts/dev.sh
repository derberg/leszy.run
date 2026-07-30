#!/usr/bin/env bash
# Start the whole LeszyRun dev stack with one command. Ctrl+C stops everything
# this script started (Docker services keep running — they're cheap and stateful).
#
#   ./scripts/dev.sh            # mosquitto + docker (db/scheduler/searxng) + backend + frontend
#   ./scripts/dev.sh --public   # also start the public app on :3002
#
# Each piece can still be started on its own — see README "Running locally".
set -euo pipefail
cd "$(dirname "$0")/.."

MOSQUITTO_BIN="${MOSQUITTO_BIN:-/opt/homebrew/sbin/mosquitto}"

# ── Mosquitto (skip if something already listens on 1883) ─────────────────────
if nc -z localhost 1883 2>/dev/null; then
  echo "[dev] mosquitto: already running on :1883 — leaving it alone"
else
  echo "[dev] mosquitto: starting"
  "$MOSQUITTO_BIN" -c mosquitto/config/mosquitto.conf 2>&1 | sed -l 's/^/[mosquitto] /' &
fi

# ── Docker: PostgreSQL + scheduler + SearXNG ─────────────────────────────────
echo "[dev] docker: starting db + scheduler + searxng"
docker compose up -d

# ── Native apps (skip any whose port is already taken) ───────────────────────
start_app() { # name port dir cmd...
  local name="$1" port="$2" dir="$3"; shift 3
  if nc -z localhost "$port" 2>/dev/null; then
    echo "[dev] $name: something already listens on :$port — skipping"
  else
    echo "[dev] $name: starting on :$port"
    (cd "$dir" && "$@") 2>&1 | sed -l "s/^/[$name] /" &
  fi
}

start_app backend  3001 backend  npm run dev
start_app frontend 3000 frontend npm run dev
if [[ "${1:-}" == "--public" ]]; then
  start_app public 3002 public npx vite --port 3002
fi

echo "[dev] all up — frontend http://localhost:3000 · backend http://localhost:3001 · Ctrl+C stops everything"
wait
