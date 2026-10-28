#!/usr/bin/env bash
# Starts the local Supabase stack the registration tests use: only the services
# they need. The one place the excluded-service list lives (CI, README and
# CLAUDE.md all call this script). Storage runs: the registration uploads
# (poster, regulamin, GPX) go through it.
set -euo pipefail
EXCLUDE="studio,imgproxy,postgres-meta,logflare,vector,mailpit,realtime"
exec supabase start -x "$EXCLUDE" "$@"
