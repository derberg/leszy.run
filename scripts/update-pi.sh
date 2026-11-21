#!/bin/sh
# Update a race Pi to the latest main and restart what it runs.
#
#   ~/leszyrun/scripts/update-pi.sh
#
# The role comes from the systemd units installed on the Pi:
#   leszyrun-backend     -> main timing host (checkpoint1): backend + admin panel
#   leszyrun-checkpoint  -> checkpoint agent (checkpoint2): agent + its UI
# The backend runs its Drizzle migrations itself on start.
set -eu

REPO="$HOME/leszyrun"
cd "$REPO"

has_unit() { systemctl list-unit-files "$1.service" --no-legend 2>/dev/null | grep -q "^$1.service"; }

if has_unit leszyrun-backend; then
  ROLE=host
elif has_unit leszyrun-checkpoint; then
  ROLE=agent
else
  echo "No leszyrun-backend or leszyrun-checkpoint unit on this machine. Nothing to update." >&2
  exit 1
fi

echo "== $(hostname): role $ROLE, was $(git log -1 --oneline)"
git pull --ff-only
echo "== now $(git log -1 --oneline)"

if [ "$ROLE" = host ]; then
  npm install --no-audit --no-fund
  (cd frontend && npm run build)
  sudo systemctl restart leszyrun-backend leszyrun-frontend
  sleep 5
  systemctl status leszyrun-backend leszyrun-frontend --no-pager --lines=5
else
  (cd checkpoint-agent && npm install --no-audit --no-fund && cd ui && npm run build)
  sudo systemctl restart leszyrun-checkpoint
  sleep 5
  systemctl status leszyrun-checkpoint --no-pager --lines=5
fi
