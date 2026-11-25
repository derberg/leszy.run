#!/usr/bin/env bash
# Isolated stack for the admin panel's agentic e2e tests (frontend/e2e/).
#
# Everything runs on its own ports so it never touches the Mac's real stack:
#   Postgres  127.0.0.1:55471  (docker container e2e-admin-pg, throwaway, no volume)
#   Mosquitto 127.0.0.1:18871  (its own broker: the backend's MQTT clientId is fixed,
#                                so sharing :1883 would kick the real backend off)
#   Backend   :3071            (no SUPABASE_URL: every sync worker stays off)
#   Admin UI  :3072
#
# The backend is started WITHOUT --env-file, so the repo-root .env (real DB,
# production Supabase) is never read.
#
#   frontend/e2e/stack.sh up     start everything, wait until it answers
#   frontend/e2e/stack.sh down   stop everything this script started
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUN_DIR="${E2E_ADMIN_RUN_DIR:-/tmp/e2e-admin-stack}"
PG_PORT=55471
MQTT_PORT=18871
API_PORT=3071
UI_PORT=3072
PG_NAME=e2e-admin-pg

port_pid() { lsof -ti "tcp:$1" -sTCP:LISTEN 2>/dev/null | head -1; }

wait_for() { # url, label
  for _ in $(seq 1 90); do
    if curl -fsS -o /dev/null "$1"; then echo "  $2 ready"; return 0; fi
    sleep 1
  done
  echo "  $2 did not answer at $1 (logs in $RUN_DIR)" >&2; return 1
}

up() {
  mkdir -p "$RUN_DIR"

  if ! docker ps --format '{{.Names}}' | grep -qx "$PG_NAME"; then
    docker run -d --rm --name "$PG_NAME" \
      -e POSTGRES_USER=leszyrun -e POSTGRES_PASSWORD=leszyrun -e POSTGRES_DB=leszyrun \
      -p "127.0.0.1:$PG_PORT:5432" postgres:16 >/dev/null
  fi
  for _ in $(seq 1 30); do
    docker exec "$PG_NAME" pg_isready -U leszyrun >/dev/null 2>&1 && break; sleep 1
  done
  echo "  postgres ready"

  if [ -z "$(port_pid $MQTT_PORT)" ]; then
    printf 'listener %s 127.0.0.1\nallow_anonymous true\n' "$MQTT_PORT" > "$RUN_DIR/mosquitto.conf"
    nohup /opt/homebrew/sbin/mosquitto -c "$RUN_DIR/mosquitto.conf" > "$RUN_DIR/mosquitto.log" 2>&1 < /dev/null &
  fi

  if [ -z "$(port_pid $API_PORT)" ]; then
    (cd "$ROOT/backend" && env -i PATH="$PATH" HOME="$HOME" \
      DATABASE_URL="postgres://leszyrun:leszyrun@127.0.0.1:$PG_PORT/leszyrun" \
      MQTT_URL="mqtt://127.0.0.1:$MQTT_PORT" PORT="$API_PORT" \
      nohup node src/server.js > "$RUN_DIR/backend.log" 2>&1 < /dev/null &)
  fi
  wait_for "http://127.0.0.1:$API_PORT/health" backend

  if [ -z "$(port_pid $UI_PORT)" ]; then
    (cd "$ROOT/frontend" && \
      VITE_API_URL="http://localhost:$API_PORT" VITE_WS_URL="ws://localhost:$API_PORT" \
      nohup npx vite --port "$UI_PORT" --strictPort > "$RUN_DIR/frontend.log" 2>&1 < /dev/null &)
  fi
  wait_for "http://localhost:$UI_PORT/" "admin UI"
}

down() {
  for p in $UI_PORT $API_PORT $MQTT_PORT; do
    pid="$(port_pid $p)"; [ -n "$pid" ] && kill "$pid" && echo "  stopped :$p"
  done
  docker rm -f "$PG_NAME" >/dev/null 2>&1 && echo "  removed $PG_NAME" || true
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  *) echo "usage: $0 up|down" >&2; exit 2 ;;
esac
