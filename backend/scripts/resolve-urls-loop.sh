#!/bin/bash
# Runs URL resolver repeatedly until no more events need URLs.

API="http://localhost:3001"
ROUND=1

while true; do
  echo "=== Round $ROUND ==="

  RESULT=$(curl -s "$API/api/scrapers/resolve-urls" -X POST)
  echo "  Raw: $RESULT"

  PROCESSED=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['data']['processed'])" 2>/dev/null)

  if [ -z "$PROCESSED" ] || [ "$PROCESSED" = "0" ]; then
    echo "Done — no more events need URL resolution."
    break
  fi

  echo "  Processed: $PROCESSED"
  ROUND=$((ROUND + 1))
  sleep 2
done
