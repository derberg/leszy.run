#!/usr/bin/env bash
# Starts the local Supabase stack the registration tests use: only the services
# they need. The one place the excluded-service list lives (CI, README and
# CLAUDE.md all call this script). A later plan whose functions use Storage
# removes storage-api (and possibly imgproxy) here.
set -euo pipefail
EXCLUDE="studio,imgproxy,postgres-meta,logflare,vector,mailpit,storage-api,realtime"
exec supabase start -x "$EXCLUDE" "$@"
