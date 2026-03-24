#!/bin/bash
# Runs URL resolver repeatedly until no more events need URLs.
# The resolver processes 50 events per run with 1.1s delay between Brave calls.

API="http://localhost:3001"
ROUND=1

while true; do
  echo "=== Round $ROUND ==="

  RESULT=$(curl -s "$API/api/scrapers/run" -X POST)
  ASSIGNED=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['urlResolver']['assigned'])" 2>/dev/null)
  PROCESSED=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['urlResolver']['processed'])" 2>/dev/null)

  echo "  Processed: $PROCESSED, Assigned: $ASSIGNED"

  if [ "$PROCESSED" = "0" ] || [ -z "$PROCESSED" ]; then
    echo "Done — no more events need URL resolution."
    break
  fi

  ROUND=$((ROUND + 1))
  sleep 2
done
