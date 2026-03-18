# Design: gate_events Persistence + RFID Audit Queries in CLAUDE.md

**Date:** 2026-03-15
**Status:** Approved

## Problem

The `gate_events` table exists in the schema but is never written to. When a participant
is not detected at a gate, there is no way to tell whether:
- The R700 saw the tag but the crossing detector didn't confirm it (software issue)
- The R700 never received a ping from that tag at all (hardware/RF issue)

These are very different root causes requiring different responses.

## Solution

Two independent changes:

### 1. Persist raw RFID pings to gate_events

In `CrossingDetector.processEvent`, after the dedup check and inside the active-race
loop (once we know which `raceRunId` the ping belongs to), insert a `gate_events` row.

**Insert fields** (all available from the event object and race context):
- `raceRunId` — from the current active race
- `epc` — from the event
- `antennaPort` — from the event
- `rssiCdbm` — from the event (`rssiCdbm` field)
- `frequency` — from the event (nullable, may be undefined)
- `topic` — from the event
- `receivedAt` — from the event (`new Date(event.receivedAt)`)
- `raw` — full event payload (`event.raw`)
- `crossingId` — null (not linked at insert time)

**Placement:** The insert goes at the top of the active-race loop body, after the
`participantId` lookup and the `finishedParticipants` guard, but **before** the
`tag` / `!tag` branch split. This ensures every qualifying ping is recorded regardless
of whether it is the first sighting or a subsequent one.

**Fire-and-forget:** `processEvent` is a synchronous method and cannot `await` anything.
The insert must be a detached promise with an explicit `.catch()` for error handling:
```js
this.db.insert(gateEvents).values({ ... }).catch(err =>
  console.error('[Detector] Failed to persist gate event:', err)
)
```

**frequency coercion:** `event.frequency` may be `undefined` if the R700 doesn't include
it. Coerce explicitly: `frequency: event.frequency ?? null`.

**Scope:** Only insert for EPCs that match a known participant in an active race. Unknown
tags (not in `epcToParticipant`) are skipped — this keeps the table focused and avoids
recording noise from stray tags.

### 2. RFID Audit section in CLAUDE.md

Add a new "## RFID Audit Queries" section to CLAUDE.md with exact `docker exec` commands
that both Claude and the user can run directly. The DB credentials are:
- Container: `leszyrun-db-1`
- User: `leszyrun`
- DB: `leszyrun`

#### Queries to include

**1. Did the R700 see this EPC at all?**
```bash
docker exec -it leszyrun-db-1 psql -U leszyrun -d leszyrun \
  -c "SELECT received_at, antenna_port, rssi_cdbm, topic FROM gate_events WHERE epc = '<EPC>' ORDER BY received_at;"
```

**2. What did each antenna see for a specific participant?**
```bash
docker exec -it leszyrun-db-1 psql -U leszyrun -d leszyrun \
  -c "SELECT antenna_port, COUNT(*) as pings, MIN(rssi_cdbm) as worst_rssi, MAX(rssi_cdbm) as best_rssi FROM gate_events WHERE epc = '<EPC>' GROUP BY antenna_port ORDER BY antenna_port;"
```

**3. All pings for a race (timeline — useful for spotting RF gaps)**
```bash
docker exec -it leszyrun-db-1 psql -U leszyrun -d leszyrun \
  -c "SELECT ge.received_at, ge.epc, ge.antenna_port, ge.rssi_cdbm, p.first_name, p.last_name FROM gate_events ge LEFT JOIN participants p ON p.rfid_epc = ge.epc WHERE ge.race_run_id = '<RACE_RUN_ID>' ORDER BY ge.received_at;"
```

**4. Which participants have no finish crossing for a race?**
```bash
docker exec -it leszyrun-db-1 psql -U leszyrun -d leszyrun \
  -c "SELECT p.first_name, p.last_name, p.rfid_epc, r.status, r.start_time, r.finish_time FROM results r JOIN participants p ON p.id = r.participant_id WHERE r.race_run_id = '<RACE_RUN_ID>' AND r.finish_time IS NULL ORDER BY r.start_time;"
```

**5. EPC for a participant by name (to get the EPC when you know the runner)**
```bash
docker exec -it leszyrun-db-1 psql -U leszyrun -d leszyrun \
  -c "SELECT first_name, last_name, rfid_epc FROM participants WHERE last_name ILIKE '%<NAME>%';"
```

**6. Find race_run_id for a recent race**
```bash
docker exec -it leszyrun-db-1 psql -U leszyrun -d leszyrun \
  -c "SELECT rr.id, rr.started_at, rr.status, c.name as category FROM race_runs rr JOIN categories c ON c.id = rr.category_id ORDER BY rr.created_at DESC LIMIT 10;"
```

**7. Ping density per minute for a race (spot RF blackout windows)**
```bash
docker exec -it leszyrun-db-1 psql -U leszyrun -d leszyrun \
  -c "SELECT date_trunc('minute', received_at) as minute, COUNT(*) as pings FROM gate_events WHERE race_run_id = '<RACE_RUN_ID>' GROUP BY 1 ORDER BY 1;"
```

## Files Changed

| File | Change |
|------|--------|
| `backend/src/mqtt/crossingDetector.js` | Import `gateEvents` from schema; add fire-and-forget insert inside the active-race loop in `processEvent` |
| `CLAUDE.md` | Add `## RFID Audit Queries` section with all 7 docker commands above |

## Out of Scope

- Linking `crossingId` to gate_events rows (requires storing row IDs in `inRange` map + UPDATE on confirm — future work)
- Syncing `gate_events` to Supabase (table is local-only, high write volume)
- Recording pings for unknown EPCs (noise reduction)
