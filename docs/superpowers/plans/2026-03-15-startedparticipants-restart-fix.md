# startedParticipants Restart Fix Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pre-populate `startedParticipants` and `finishedParticipants` Sets from the DB when restoring active races on backend restart, so `maxTimer` arms correctly for finish crossings and finished participants are not double-processed.

**Architecture:** `CrossingDetector.startRace` becomes async and queries the `results` table for the given `raceRunId` at startup. The server startup sequence is reordered so active races are loaded before MQTT connects, eliminating a race window. All three call sites are updated to `await` the now-async method.

**Tech Stack:** Node.js ESM, Drizzle ORM, `drizzle-orm` (`eq`, `isNotNull`, `and`), no test framework present.

**Spec:** `docs/superpowers/specs/2026-03-15-startedparticipants-restart-fix-design.md`

---

## Chunk 1: crossingDetector.js — pre-populate Sets in startRace

### Task 1: Make `startRace` async and query DB for existing results

**Files:**
- Modify: `backend/src/mqtt/crossingDetector.js:64-77` (`startRace` method)

No import changes needed — `results`, `eq`, and `and` are all already imported at the top of the file.

- [ ] **Step 1: Replace `startRace` with async version**

Replace the entire `startRace` method (lines 64–77):

```js
  async startRace(raceRun, eventConfig, participantList) {
    const epcMap = new Map()
    for (const p of participantList) {
      if (p.rfidEpc) epcMap.set(p.rfidEpc, p.id)
    }

    // Pre-populate from DB so maxTimer arms correctly after a backend restart
    const existingResults = await this.db
      .select({ participantId: results.participantId, startTime: results.startTime, finishTime: results.finishTime })
      .from(results)
      .where(eq(results.raceRunId, raceRun.id))

    const startedParticipants = new Set()
    const finishedParticipants = new Set()
    for (const r of existingResults) {
      if (r.startTime)  startedParticipants.add(r.participantId)
      if (r.finishTime) finishedParticipants.add(r.participantId)
    }

    this.activeRaces.set(raceRun.id, {
      config: eventConfig,
      gunStartTime: raceRun.startedAt ? new Date(raceRun.startedAt) : new Date(),
      epcToParticipant: epcMap,
      startedParticipants,
      finishedParticipants,
    })
    console.log(`[Detector] Started race ${raceRun.id} with ${epcMap.size} tagged participants (${startedParticipants.size} already started, ${finishedParticipants.size} already finished)`)
  }
```

- [ ] **Step 2: Verify the file looks correct**

Open `backend/src/mqtt/crossingDetector.js` and confirm:
- `startRace` is now `async`
- Sets are pre-populated before `this.activeRaces.set()`
- The log line shows restoration counts

---

## Chunk 2: Update call sites to await startRace

### Task 2: Update races.js

**Files:**
- Modify: `backend/src/routes/races.js:77`

- [ ] **Step 1: Add `await` to the `detector.startRace` call**

Find line 77 in `backend/src/routes/races.js`:
```js
detector.startRace(run, { ...category.event, rfidTopicMain: rowMain, rfidTopicFinish: rowFinish }, allParticipants)
```

Replace with:
```js
await detector.startRace(run, { ...category.event, rfidTopicMain: rowMain, rfidTopicFinish: rowFinish }, allParticipants)
```

Note: the surrounding code is already inside an `async` handler, so `await` is valid here.

- [ ] **Step 2: Verify the surrounding async context**

Confirm the function containing this call has `async` in its signature (it should already be an async Fastify route handler).

---

### Task 3: Update server.js — fix call site and startup ordering

**Files:**
- Modify: `backend/src/server.js:66-74` (startup sequence)
- Modify: `backend/src/server.js:102` (`reloadActiveRaces` body)

- [ ] **Step 1: Add `await` to `detector.startRace` in `reloadActiveRaces`**

Find line 102 in `backend/src/server.js`:
```js
    detector.startRace(run, run.category.event, run.category.participants)
```

Replace with:
```js
    await detector.startRace(run, run.category.event, run.category.participants)
```

- [ ] **Step 2: Move `reloadActiveRaces` before `initMqtt` in startup sequence**

Find the startup block (around lines 65–74):
```js
    // Connect MQTT
    initMqtt(db)

    // Start Supabase sync
    initSupabaseSync(db)

    console.log(`[Server] LeszyRun backend running at ${address}`)

    // On startup, reload any active races into the crossing detector
    await reloadActiveRaces()
```

Replace with:
```js
    // On startup, reload any active races into the crossing detector
    // MUST happen before initMqtt so Sets are populated before RFID events arrive
    await reloadActiveRaces()

    // Connect MQTT
    initMqtt(db)

    // Start Supabase sync
    initSupabaseSync(db)

    console.log(`[Server] LeszyRun backend running at ${address}`)
```

- [ ] **Step 3: Verify the startup block looks correct**

Confirm the order is: migrations → listen → WebSocket → `reloadActiveRaces` → MQTT → Supabase sync → log.

`initWebSocket` MUST remain before `reloadActiveRaces` — the WebSocket broadcaster needs to be ready in case any crossings fire during race restore.

---

## Chunk 3: Manual verification

### Task 4: Start a race, restart backend, verify Sets restore

- [ ] **Step 1: Start the stack**

```bash
docker compose up
```

- [ ] **Step 2: Create an event, category, and participants with EPC tags via the UI or API. Start a race.**

Confirm a few participants cross the start gate and appear as `started` in the results table:
```bash
docker exec -it leszyrun-db-1 psql -U postgres -d leszyrun \
  -c "SELECT participant_id, start_time, finish_time, status FROM results WHERE race_run_id = '<your_run_id>';"
```

- [ ] **Step 3: Restart the backend only**

```bash
docker compose restart backend
```

- [ ] **Step 4: Check backend logs for restoration counts**

```bash
docker compose logs backend --tail=20
```

Expected output should include something like:
```
[Detector] Started race <id> with N tagged participants (M already started, 0 already finished)
```

`M` should match the number of participants who crossed the start before the restart.

- [ ] **Step 5: Simulate a finish crossing for an already-started participant** (single RFID mode only)

Scan an EPC that was already started. Verify:
- The crossing is detected as `gate = finish` (not start again)
- `maxTimer` would arm (you can verify indirectly: if the participant lingers near the antenna for 10s and a finish crossing is recorded, maxTimer fired correctly)

Note: in `separate` RFID mode, gate is determined by MQTT topic — `startedParticipants` only affects `maxTimer` arming, not gate detection.

- [ ] **Step 6: Commit**

```bash
git add backend/src/mqtt/crossingDetector.js backend/src/routes/races.js backend/src/server.js
git commit -m "fix(detector): pre-populate startedParticipants from DB on race restore

After a backend restart, startedParticipants and finishedParticipants
Sets were always empty. This caused maxTimer to never arm for finish
crossings (runner lingering at finish gate never force-confirmed after
10s) and allowed finished participants to be re-processed as new crossings.

Fix: startRace now queries the results table on startup to pre-populate
both Sets. Server startup order changed so reloadActiveRaces runs before
initMqtt, ensuring Sets are ready before any RFID events arrive."
```
