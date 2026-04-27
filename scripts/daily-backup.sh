#!/usr/bin/env bash
# Daily backup of local Postgres + Supabase.
# Triggered by user crontab at 11:00 Europe/Warsaw.
# Coexists with the existing 6-hourly local backup (different dir).
set -euo pipefail

REPO="/Users/derberg/Documents/GitHub/BeepBeep"
LOG_DIR="$REPO/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/daily-backup-$(date +%Y%m%d).log"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

LOCAL_DIR="$HOME/backups/leszyrun-daily"
REMOTE_DIR="$HOME/backups/leszyrun-supabase"
mkdir -p "$LOCAL_DIR" "$REMOTE_DIR"
TS=$(date +%Y%m%d_%H%M)

{
  echo "==== $(date '+%Y-%m-%d %H:%M:%S') daily backup starting ===="

  echo "[local] dumping leszyrun-db-1"
  docker exec leszyrun-db-1 pg_dump -U leszyrun -d leszyrun --format=custom \
    > "$LOCAL_DIR/leszyrun_local_${TS}.dump"
  find "$LOCAL_DIR" -name 'leszyrun_local_*.dump' -mtime +14 -delete

  echo "[remote] dumping Supabase"
  SUPABASE_DB_URL=$(grep '^SUPABASE_DB_URL=' "$REPO/.env" | cut -d= -f2-)
  if [ -z "$SUPABASE_DB_URL" ]; then
    echo "SUPABASE_DB_URL not set in $REPO/.env — skipping remote backup"
  else
    # Local pg_dump is v16, Supabase is v17 — use pg_dump from postgres:17 image
    docker run --rm postgres:17 pg_dump --format=custom "$SUPABASE_DB_URL" \
      > "$REMOTE_DIR/supabase_${TS}.dump"
    find "$REMOTE_DIR" -name 'supabase_*.dump' -mtime +14 -delete
  fi

  echo "==== $(date '+%Y-%m-%d %H:%M:%S') daily backup complete ===="
} >> "$LOG" 2>&1
