# Design: Pre-populate startedParticipants on Race Restore

**Date:** 2026-03-15
**Status:** Approved

## Problem

`startedParticipants` and `finishedParticipants` are in-memory Sets on `CrossingDetector`.
They are always initialised empty in `startRace()`. If the backend restarts while a race
is active, both Sets are empty for the restored race. This causes two bugs:

1. **`maxTimer` never arms for finish crossings** — the `maxTimer` arm check uses
   `race.startedParticipants.has(participantId)`. Empty set → no maxTimer → a runner who
   lingers at the finish never gets a force-confirmed crossing after fallbackSeconds (10s).
   This affects both `single` and `separate` RFID modes.

2. **Finished participants can get a false crossing** — the skip-check uses
   `race.finishedParticipants.has(participantId)`. Empty set → a finished runner walking
   near the gate again is processed as a new crossing.

Gate determination itself already survives restarts correctly via a DB fallback in
`#confirmCrossing`. Only the Sets are broken.

## Solution

### 1. Make `startRace` async — pre-populate Sets from DB

Query `results` for the given `raceRunId` at the start of `startRace` and populate both
Sets using Drizzle field names (`results.startTime`, `results.finishTime`):

```
results WHERE raceRunId = X AND startTime IS NOT NULL  → startedParticipants (participantId)
results WHERE raceRunId = X AND finishTime IS NOT NULL → finishedParticipants (participantId)
```

### 2. Fix startup ordering in server.js

Currently `initMqtt` fires before `reloadActiveRaces`, creating a window where RFID events
arrive before the Sets are populated. Fix: move `await reloadActiveRaces()` before
`initMqtt(db)` in the startup sequence.

## Files Changed

| File | Change |
|------|--------|
| `backend/src/mqtt/crossingDetector.js` | `startRace` becomes `async`; queries `results` table; pre-populates both Sets |
| `backend/src/routes/races.js` | `await detector.startRace(...)` |
| `backend/src/server.js` | `await reloadActiveRaces()` moved before `initMqtt(db)`; `await detector.startRace(...)` in `reloadActiveRaces` |

## Out of Scope

- No schema changes
- No new migrations
- No changes to the crossing detection algorithm
- No changes to gate determination logic
- Existing divergence in topic config source (settings table in races.js vs events table in
  server.js reloadActiveRaces) is not addressed here
