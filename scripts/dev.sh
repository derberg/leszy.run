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

# ── Native apps ──────────────────────────────────────────────────────────────
# backend + frontend MUST run natively (they need the Mac's LAN interfaces / the
# reader auto-heal). A leftover `docker compose --profile docker` container from
# the old all-Docker setup would squat the port and — worse — run stale code that
# can't see en8, so we stop it first rather than silently skipping (the bug that
# once left a 3-day-old Docker backend serving :3001).
start_app() { # name port dir compose_service cmd...
  local name="$1" port="$2" dir="$3" svc="$4"; shift 4
  if nc -z localhost "$port" 2>/dev/null; then
    # Is the squatter our own compose container? If so, stop it and take over.
    if [[ -n "$svc" ]] && docker compose --profile docker ps --status running --services 2>/dev/null | grep -qx "$svc"; then
      echo "[dev] $name: stale Docker '$svc' container holds :$port — stopping it to run native"
      docker compose --profile docker stop "$svc" >/dev/null 2>&1 || true
    else
      echo "[dev] $name: something (not our Docker '$svc') already listens on :$port — skipping"
      return
    fi
  fi
  echo "[dev] $name: starting on :$port"
  (cd "$dir" && "$@") 2>&1 | sed -l "s/^/[$name] /" &
}

start_app backend  3001 backend  backend  npm run dev
start_app frontend 3000 frontend frontend npm run dev
if [[ "${1:-}" == "--public" ]]; then
  start_app public 3002 public "" npx vite --port 3002
fi

echo "[dev] all up — frontend http://localhost:3000 · backend http://localhost:3001 · Ctrl+C stops everything"
wait
