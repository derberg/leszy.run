# gate_events Persistence + RFID Audit Queries Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist every raw RFID ping (that belongs to a known participant in an active race) into the `gate_events` table, and document diagnostic queries in CLAUDE.md so future Claude sessions and the user can audit missed scans.

**Architecture:** A fire-and-forget Drizzle insert is added inside the active-race loop of `CrossingDetector.processEvent`, placed after the participant guard but before the tag/no-tag branch. CLAUDE.md gets a new section with 7 ready-to-run `docker exec psql` commands covering all common audit scenarios.

**Tech Stack:** Node.js ESM, Drizzle ORM (`gateEvents` table already in schema), no test framework.

**Spec:** `docs/superpowers/specs/2026-03-15-gate-events-persistence-and-rfid-audit-design.md`

---

## Chunk 1: gate_events insert in crossingDetector.js

### Task 1: Import gateEvents and add the insert

**Files:**
- Modify: `backend/src/mqtt/crossingDetector.js:2` (import line)
- Modify: `backend/src/mqtt/crossingDetector.js:124-130` (top of active-race loop body)

- [ ] **Step 1: Add `gateEvents` to the existing import**

Current line 2:
```js
import { gateCrossings, results } from '../db/schema.js'
```

Replace with:
```js
import { gateCrossings, gateEvents, results } from '../db/schema.js'
```

- [ ] **Step 2: Add the fire-and-forget insert**

Find the block starting at line 124 — the top of the active-race `for` loop body. The current code after the loop opens looks like:

```js
    for (const [raceRunId, race] of this.activeRaces) {
      const participantId = race.epcToParticipant.get(event.epc)
      if (!participantId) continue
      if (race.finishedParticipants.has(participantId)) continue

      const key = `${event.epc}:${raceRunId}`
      const tag = this.inRange.get(key)
```

Replace with:

```js
    for (const [raceRunId, race] of this.activeRaces) {
      const participantId = race.epcToParticipant.get(event.epc)
      if (!participantId) continue
      if (race.finishedParticipants.has(participantId)) continue

      // Persist raw ping for audit — fire-and-forget, must not block sync detection loop
      this.db.insert(gateEvents).values({
        raceRunId,
        epc:         event.epc,
        antennaPort: event.antennaPort,
        rssiCdbm:    event.rssiCdbm,
        frequency:   event.frequency ?? null,
        topic:       event.topic,
        receivedAt:  new Date(event.receivedAt),
        raw:         event.raw,
      }).catch(err => console.error('[Detector] Failed to persist gate event:', err))

      const key = `${event.epc}:${raceRunId}`
      const tag = this.inRange.get(key)
```

- [ ] **Step 3: Verify the file looks correct**

Confirm:
- `gateEvents` is in the import on line 2
- The insert appears between the `finishedParticipants` guard and the `const key = ...` line
- The insert uses `.catch()` — NOT `await`
- `frequency: event.frequency ?? null` is present

- [ ] **Step 4: Verify the backend starts without errors**

```bash
docker compose up backend --no-deps
```

Watch logs for any import errors or startup crashes. Expected: backend starts normally, migrations run, `[Server]` ready log appears.

- [ ] **Step 5: Commit**

```bash
git add backend/src/mqtt/crossingDetector.js
git commit -m "feat(detector): persist raw RFID pings to gate_events table

Each RFID ping matching a known participant in an active race is now
inserted into gate_events (fire-and-forget, non-blocking). Enables
post-race audit of whether the R700 saw a tag vs. the crossing detector
failing to confirm — two very different root causes."
```

---

## Chunk 2: RFID Audit Queries in CLAUDE.md

### Task 2: Add the audit section to CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` (insert section before `## Things to never do`, which is the last section)

- [ ] **Step 1: Add the RFID Audit Queries section**

Insert the following block immediately before the `## Things to never do` section at the end of CLAUDE.md:

```markdown
## RFID Audit Queries

DB credentials: container `leszyrun-db-1`, user `leszyrun`, db `leszyrun`.

**Investigation flow:** start with query 5 to get EPC → query 1 to check R700 saw the tag → if rows exist, use query 2 to check antenna coverage.

**1. Did the R700 see this EPC at all?**
```bash
docker exec -it leszyrun-db-1 psql -U leszyrun -d leszyrun \
  -c "SELECT received_at, antenna_port, rssi_cdbm, topic FROM gate_events WHERE epc = '<EPC>' ORDER BY received_at;"
```
Zero rows = hardware/RF issue. Rows present = detector logic issue.

**2. What did each antenna see for a participant?**
```bash
docker exec -it leszyrun-db-1 psql -U leszyrun -d leszyrun \
  -c "SELECT antenna_port, COUNT(*) as pings, MIN(rssi_cdbm) as worst_rssi, MAX(rssi_cdbm) as best_rssi FROM gate_events WHERE epc = '<EPC>' GROUP BY antenna_port ORDER BY antenna_port;"
```

**3. All pings for a race — full timeline**
```bash
docker exec -it leszyrun-db-1 psql -U leszyrun -d leszyrun \
  -c "SELECT ge.received_at, ge.epc, ge.antenna_port, ge.rssi_cdbm, p.first_name, p.last_name FROM gate_events ge LEFT JOIN participants p ON p.rfid_epc = ge.epc WHERE ge.race_run_id = '<RACE_RUN_ID>' ORDER BY ge.received_at;"
```

**4. Participants with no finish crossing**
```bash
docker exec -it leszyrun-db-1 psql -U leszyrun -d leszyrun \
  -c "SELECT p.first_name, p.last_name, p.rfid_epc, r.status, r.start_time, r.finish_time FROM results r JOIN participants p ON p.id = r.participant_id WHERE r.race_run_id = '<RACE_RUN_ID>' AND r.finish_time IS NULL ORDER BY r.start_time;"
```

**5. Find EPC by participant name**
```bash
docker exec -it leszyrun-db-1 psql -U leszyrun -d leszyrun \
  -c "SELECT first_name, last_name, rfid_epc FROM participants WHERE last_name ILIKE '%<NAME>%';"
```

**6. Find race_run_id for a recent race**
```bash
docker exec -it leszyrun-db-1 psql -U leszyrun -d leszyrun \
  -c "SELECT rr.id, rr.started_at, rr.status, c.name as category FROM race_runs rr JOIN categories c ON c.id = rr.category_id ORDER BY rr.created_at DESC LIMIT 10;"
```

**7. Ping density per minute — spot RF blackout windows**
```bash
docker exec -it leszyrun-db-1 psql -U leszyrun -d leszyrun \
  -c "SELECT date_trunc('minute', received_at) as minute, COUNT(*) as pings FROM gate_events WHERE race_run_id = '<RACE_RUN_ID>' GROUP BY 1 ORDER BY 1;"
```
```

- [ ] **Step 2: Verify CLAUDE.md looks correct**

Confirm:
- The new section appears before `## Things to never do`
- All 7 queries are present
- The investigation flow note is at the top of the section

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add RFID audit queries to CLAUDE.md

Seven ready-to-run docker psql commands for investigating missed scans:
EPC lookup, per-antenna coverage, race timeline, unfinished participants,
participant-by-name lookup, race_run_id lookup, and per-minute ping density."
```

---

## Chunk 3: Manual verification

### Task 3: Verify gate_events are being written during a race

- [ ] **Step 1: Start a race and let a participant cross the gate**

Scan any registered participant with an RFID tag. Their EPC should now appear in `gate_events`.

- [ ] **Step 2: Run audit query 1 with their EPC**

```bash
docker exec -it leszyrun-db-1 psql -U leszyrun -d leszyrun \
  -c "SELECT received_at, antenna_port, rssi_cdbm FROM gate_events ORDER BY received_at DESC LIMIT 20;"
```

Expected: rows appear with timestamps matching when the scan happened.

- [ ] **Step 3: Confirm no backend errors in logs**

```bash
docker compose logs backend --tail=30
```

Expected: no `[Detector] Failed to persist gate event:` errors.
