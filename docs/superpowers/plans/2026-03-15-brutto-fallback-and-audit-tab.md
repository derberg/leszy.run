# Brutto Fallback & Audit Tab Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an RFID start crossing is missed, automatically use gun time as the participant's start time, track the source, and expose an Audit tab in RaceControl for operator visibility and manual correction.

**Architecture:** Two new `text` columns on `results` (`start_time_source`, `start_time_trigger`) carry the audit signal. The crossing detector and a new checkpoint observation endpoint write these columns. A new `GET /api/races/:raceRunId/audit` endpoint surfaces them. The RaceControl frontend gains an Audit tab with inline manual correction.

**Tech Stack:** Node.js + Fastify backend, Drizzle ORM, PostgreSQL 16, React + Vite frontend, TanStack Query, shadcn/ui + Tailwind v4.

---

## Chunk 1: Database migration + schema

### Task 1: Migration SQL + journal entry

**Files:**
- Create: `backend/src/db/migrations/0012_start_time_source.sql`
- Modify: `backend/src/db/migrations/meta/_journal.json`

- [ ] **Step 1: Create migration SQL**

```sql
-- backend/src/db/migrations/0012_start_time_source.sql
ALTER TABLE results ADD COLUMN start_time_source text;
ALTER TABLE results ADD COLUMN start_time_trigger text;
```

- [ ] **Step 2: Add journal entry**

In `backend/src/db/migrations/meta/_journal.json`, append to the `"entries"` array:

```json
{
  "idx": 12,
  "version": "7",
  "when": 1742076000000,
  "tag": "0012_start_time_source",
  "breakpoints": true
}
```

- [ ] **Step 3: Commit**

```bash
git add backend/src/db/migrations/0012_start_time_source.sql backend/src/db/migrations/meta/_journal.json
git commit -m "feat(db): add start_time_source and start_time_trigger columns to results"
```

---

### Task 2: Drizzle schema update

**Files:**
- Modify: `backend/src/db/schema.js` (results table, around line 91)

- [ ] **Step 1: Add columns to results table**

In `backend/src/db/schema.js`, inside the `results` pgTable definition, add after `manualOverride`:

```js
startTimeSource:  text('start_time_source'),
startTimeTrigger: text('start_time_trigger'),
```

The results table block should have these two lines before `syncedAt`.

- [ ] **Step 2: Verify backend starts cleanly**

```bash
docker compose up --build -d
docker compose logs backend --tail=20
```

Expected: `Migrations complete` log line, no errors.

- [ ] **Step 3: Verify columns exist in DB**

```bash
docker exec -it leszyrun-db-1 psql -U leszyrun -d leszyrun \
  -c "\d results" | grep start_time
```

Expected output includes `start_time_source` and `start_time_trigger` as `text` columns.

- [ ] **Step 4: Commit**

```bash
git add backend/src/db/schema.js
git commit -m "feat(schema): add startTimeSource and startTimeTrigger to results Drizzle schema"
```

---

## Chunk 2: Crossing detector changes

### Task 3: Chip start path — set startTimeSource

**Files:**
- Modify: `backend/src/mqtt/crossingDetector.js` (lines 249–259, the `gate === 'start'` upsert)

- [ ] **Step 1: Update the start-crossing upsert**

The existing code at the `gate === 'start'` branch looks like:

```js
await db.insert(results).values({
  raceRunId,
  participantId,
  startTime: peakTime,
  status: 'started',
  startCrossingId: crossing.id,
}).onConflictDoUpdate({
  target: [results.raceRunId, results.participantId],
  set: { startTime: peakTime, status: 'started', startCrossingId: crossing.id },
})
```

Add `startTimeSource: 'chip'` to both `values(...)` and the `set` object:

```js
await db.insert(results).values({
  raceRunId,
  participantId,
  startTime: peakTime,
  status: 'started',
  startCrossingId: crossing.id,
  startTimeSource: 'chip',
}).onConflictDoUpdate({
  target: [results.raceRunId, results.participantId],
  set: { startTime: peakTime, status: 'started', startCrossingId: crossing.id, startTimeSource: 'chip' },
})
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/mqtt/crossingDetector.js
git commit -m "feat(detector): set startTimeSource='chip' on RFID start crossings"
```

---

### Task 4: Finish crossing with no prior start — gun fallback

**Files:**
- Modify: `backend/src/mqtt/crossingDetector.js` (lines 262–283, the `gate === 'finish'` block)

- [ ] **Step 1: Understand the current finish-crossing code**

The current `gate === 'finish'` block fetches `existing` to get `startTime`, computes `durationMs` and `gunDurationMs`, then does an upsert. The gun fallback is inserted into the middle of this flow.

- [ ] **Step 2: Add gun fallback to finish-crossing upsert**

Find the finish upsert (around line 269). The existing `set` is:
```js
set: { finishTime: peakTime, durationMs, gunDurationMs, status: 'finished', finishCrossingId: crossing.id }
```

Change the finish block so that when `existing.startTime` is null, we include the gun-start fields. Replace the entire finish upsert block with:

```js
const durationMs = existing?.startTime ? peakTime - new Date(existing.startTime) : null
const gunDurationMs = race?.gunStartTime ? peakTime - race.gunStartTime : null
const noChipStart = !existing?.startTime

// Build the set fields (never include raceRunId/participantId — those are the conflict target)
const setFields = {
  finishTime: peakTime,
  durationMs: noChipStart ? gunDurationMs : durationMs,
  gunDurationMs,
  status: 'finished',
  finishCrossingId: crossing.id,
  ...(noChipStart && {
    startTime: race.gunStartTime,
    startTimeSource: 'gun',
    startTimeTrigger: 'finish_crossing',
  }),
}

await db.insert(results).values({
  raceRunId,
  participantId,
  ...setFields,
}).onConflictDoUpdate({
  target: [results.raceRunId, results.participantId],
  set: setFields,
})

await this.#recalcPositions(raceRunId)

if (noChipStart && race) {
  race.startedParticipants.add(participantId)
}
// Remove the original race.finishedParticipants.add(participantId) line that was previously
// at the end of this block (around original line 283) — this is the only add now:
if (race) race.finishedParticipants.add(participantId)
```

Note: The existing `race.finishedParticipants.add(participantId)` call (currently at line 283) is now inside this block. Make sure it is not duplicated outside.

- [ ] **Step 3: Verify no duplicate finishedParticipants.add**

After editing, read the `gate === 'finish'` block to confirm `race.finishedParticipants.add(participantId)` appears exactly once (in the new block above), not twice.

- [ ] **Step 4: Restart backend and do a manual smoke test**

```bash
docker compose restart backend
docker compose logs backend --tail=10
```

Expected: clean start, no JS errors.

- [ ] **Step 5: Commit**

```bash
git add backend/src/mqtt/crossingDetector.js
git commit -m "feat(detector): apply gun-time fallback when finish crossing has no prior start"
```

---

## Chunk 3: New checkpoint observation endpoint + gun fallback

> **Prerequisite:** Tasks 1 and 2 (migration `0012_start_time_source` and Drizzle schema changes) must already be applied before running any task in this chunk. Verify with `docker compose logs backend --tail=5` — should show `Migrations complete`.

### Task 5: POST /api/checkpoints/:id/observations

**Files:**
- Modify: `backend/src/routes/checkpoints.js`

- [ ] **Step 1: Add broadcast import**

At the top of `backend/src/routes/checkpoints.js`, after the existing imports, add:

```js
import { broadcast } from '../ws/broadcaster.js'
```

Also add to the existing schema imports: `participants, results, raceRuns` (check which are already imported — currently only `checkpoints, checkpointCategories, checkpointObservations, raceRuns, categories` are imported).

Add `participants, results` to the import line:

```js
import { checkpoints, checkpointCategories, checkpointObservations, raceRuns, categories, participants, results } from '../db/schema.js'
```

- [ ] **Step 2: Add the new POST endpoint**

In `checkpointsRoutes`, after the existing `GET /checkpoints/:id/observations` handler (around line 86), add:

```js
// POST observation for a checkpoint — records a volunteer scan and applies gun-start fallback
fastify.post('/checkpoints/:id/observations', async (req, reply) => {
  const { observedAt } = req.body
  const bib = parseInt(req.body.bibNumber, 10)
  if (!bib) return reply.code(400).send({ error: 'bibNumber required' })
  const bibNumber = bib

  const checkpointId = req.params.id

  // Fetch checkpoint to get its eventId (needed to resolve participant by bib)
  const [checkpoint] = await db.select({ id: checkpoints.id, eventId: checkpoints.eventId })
    .from(checkpoints)
    .where(eq(checkpoints.id, checkpointId))

  if (!checkpoint) return reply.code(404).send({ error: 'Checkpoint not found' })

  // Resolve participantId from bibNumber + eventId
  const [p] = await db.select({ id: participants.id, categoryId: participants.categoryId })
    .from(participants)
    .where(and(eq(participants.eventId, checkpoint.eventId), eq(participants.bibNumber, bibNumber)))

  // Insert observation (participantId may be null if bib not found — record it anyway)
  const [obs] = await db.insert(checkpointObservations).values({
    checkpointId,
    bibNumber,
    participantId: p?.id || null,
    observedAt: observedAt ? new Date(observedAt) : new Date(),
  }).returning()

  // Gun-start fallback: only possible if participant was resolved
  if (p?.id && p?.categoryId) {
    // 1. Verify checkpoint is linked to this participant's category
    const [catLink] = await db.select({ checkpointId: checkpointCategories.checkpointId })
      .from(checkpointCategories)
      .where(and(
        eq(checkpointCategories.checkpointId, checkpointId),
        eq(checkpointCategories.categoryId, p.categoryId),
      ))

    if (catLink) {
      // 2. Find active race run for this category (most recent started_at)
      const [activeRun] = await db.select()
        .from(raceRuns)
        .where(and(eq(raceRuns.categoryId, p.categoryId), eq(raceRuns.status, 'active')))
        .orderBy(desc(raceRuns.startedAt))
        .limit(1)

      if (activeRun) {
        // 3. Apply gun-start fallback if no startTime yet
        const [result] = await db.select({ id: results.id, startTime: results.startTime })
          .from(results)
          .where(and(eq(results.raceRunId, activeRun.id), eq(results.participantId, p.id)))

        if (result && !result.startTime) {
          const [updated] = await db.update(results)
            .set({
              startTime: activeRun.startedAt,
              startTimeSource: 'gun',
              startTimeTrigger: `checkpoint:${checkpointId}`,
              status: 'started',
            })
            .where(and(eq(results.raceRunId, activeRun.id), eq(results.participantId, p.id)))
            .returning()

          const full = await db.query.results.findFirst({ where: eq(results.id, updated.id) })
          broadcast('result:update', full)
        }
      }
    }
  }

  return reply.code(201).send({ data: obs })
})
```

- [ ] **Step 3: Add missing imports at the top of the route**

`and` and `desc` are needed. The current import has only `eq, inArray` — add both:

```js
import { eq, inArray, and, desc } from 'drizzle-orm'
```

- [ ] **Step 4: Add the route to api.js (frontend)**

In `frontend/src/lib/api.js`, inside `checkpoints:`, add:

```js
postObservation: (checkpointId, body) => request('POST', `/checkpoints/${checkpointId}/observations`, body),
```

- [ ] **Step 5: Restart + verify endpoint exists**

```bash
docker compose restart backend
curl -s -X POST http://localhost:3001/api/checkpoints/nonexistent-id/observations \
  -H "Content-Type: application/json" \
  -d '{"bibNumber": 1}' | cat
```

Expected: `{"error":"Checkpoint not found"}` with HTTP 404.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/checkpoints.js frontend/src/lib/api.js
git commit -m "feat(checkpoints): add POST observations endpoint with gun-start fallback"
```

---

## Chunk 4: Audit endpoint + PATCH results extension

### Task 6: GET /api/races/:raceRunId/audit

**Files:**
- Modify: `backend/src/routes/races.js`

- [ ] **Step 1: Add required imports**

In `backend/src/routes/races.js`, add to the existing schema import:
- `checkpoints` and `participants` (check which are already present — currently `raceRuns, results, participants, categories, events, settings` are imported)
- Add `checkpoints` to the import

```js
import { raceRuns, results, participants, categories, events, settings, checkpoints } from '../db/schema.js'
```

Check the current drizzle import — `inArray` may not yet be present. Ensure it includes:

```js
import { eq, and, inArray } from 'drizzle-orm'
```

- [ ] **Step 2: Add the audit endpoint**

Append before the closing `}` of `racesRoutes`:

```js
// Audit data for a race run
fastify.get('/races/:raceRunId/audit', async (req, reply) => {
  const raceRunId = req.params.raceRunId

  // Fetch results where start_time_source is 'gun' or 'manual'
  const rows = await db.select({
    resultId:        results.id,
    participantId:   results.participantId,
    startTime:       results.startTime,
    finishTime:      results.finishTime,
    durationMs:      results.durationMs,
    gunDurationMs:   results.gunDurationMs,
    startTimeSource: results.startTimeSource,
    startTimeTrigger: results.startTimeTrigger,
    firstName:       participants.firstName,
    lastName:        participants.lastName,
    bibNumber:       participants.bibNumber,
    emoji:           participants.emoji,
  })
    .from(results)
    .innerJoin(participants, eq(results.participantId, participants.id))
    .where(
      and(
        eq(results.raceRunId, raceRunId),
        inArray(results.startTimeSource, ['gun', 'manual']),
      )
    )
    .orderBy(results.startTime)

  // Resolve checkpoint names for checkpoint:uuid triggers
  const checkpointIds = [...new Set(
    rows
      .filter(r => r.startTimeTrigger?.startsWith('checkpoint:'))
      .map(r => r.startTimeTrigger.replace('checkpoint:', ''))
  )]

  const cpMap = {}
  if (checkpointIds.length) {
    const cps = await db.select({ id: checkpoints.id, name: checkpoints.name })
      .from(checkpoints)
      .where(inArray(checkpoints.id, checkpointIds))
    for (const cp of cps) cpMap[cp.id] = cp.name
  }

  const gunStartFallback = rows.map(r => {
    let checkpointName = null
    if (r.startTimeTrigger?.startsWith('checkpoint:')) {
      const cpId = r.startTimeTrigger.replace('checkpoint:', '')
      checkpointName = cpMap[cpId] ?? null  // null = deleted checkpoint; frontend shows fallback label
    }
    return { ...r, checkpointName }
  })

  return { data: { gunStartFallback } }
})
```

- [ ] **Step 3: Add audit method to frontend api.js**

In `frontend/src/lib/api.js`, inside `races:`, add:

```js
audit: (raceRunId) => request('GET', `/races/${raceRunId}/audit`),
```

The full `races` object becomes:

```js
races: {
  list: (eventId) => request('GET', `/events/${eventId}/races`),
  listForCategory: (categoryId) => request('GET', `/categories/${categoryId}/races`),
  start: (categoryId) => request('POST', `/categories/${categoryId}/races`, {}),
  update: (id, body) => request('PATCH', `/races/${id}`, body),
  audit: (raceRunId) => request('GET', `/races/${raceRunId}/audit`),
},
```

Note: the audit endpoint returns `{ data: { gunStartFallback: [...] } }`. The `request` helper returns `json.data`, so the call returns `{ gunStartFallback: [...] }`. Account for this in the frontend query.

- [ ] **Step 4: Verify endpoint**

```bash
docker compose restart backend
# Get a real raceRunId first:
docker exec -it leszyrun-db-1 psql -U leszyrun -d leszyrun \
  -c "SELECT id FROM race_runs ORDER BY created_at DESC LIMIT 1;"
# Then test:
curl -s http://localhost:3001/api/races/<raceRunId>/audit | python3 -m json.tool
```

Expected: `{"data": {"gunStartFallback": [...]}}` — empty array if no gun fallbacks exist yet.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/races.js frontend/src/lib/api.js
git commit -m "feat(races): add GET /races/:raceRunId/audit endpoint"
```

---

### Task 7: Extend PATCH /api/results/:id for startTime manual correction

**Files:**
- Modify: `backend/src/routes/results.js` (lines 43–84)

- [ ] **Step 1: Extend the PATCH handler**

The current handler has an `allowed` array and recalculates `durationMs` when times change. We need to:
1. Keep `startTime` in the `allowed` list (it's already there)
2. When `startTime` is patched, force server-side `startTimeSource = 'manual'` and `startTimeTrigger = null`
3. Do NOT recalculate `gunDurationMs` when only `startTime` changes (it's already handled correctly: `gunDurationMs` is only updated when `finishTime` is in the update)

Replace the `PATCH /results/:id` handler with:

```js
fastify.patch('/results/:id', async (req, reply) => {
  const allowed = ['startTime', 'finishTime', 'status', 'statusNote']
  const updates = {}
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key]
  }

  if (updates.status === 'dsq' && !req.body.statusNote) {
    return reply.code(400).send({ error: 'statusNote is required when setting status to dsq' })
  }

  if (updates.startTime || updates.finishTime) {
    updates.manualOverride = true
  }

  // If startTime is being patched manually, force source tracking
  if (updates.startTime) {
    updates.startTimeSource = 'manual'
    updates.startTimeTrigger = null
  }

  const current = await db.query.results.findFirst({ where: eq(results.id, req.params.id) })
  if (!current) return reply.code(404).send({ error: 'Result not found' })

  const startTime = updates.startTime ? new Date(updates.startTime) : current.startTime
  const finishTime = updates.finishTime ? new Date(updates.finishTime) : current.finishTime
  if (startTime && finishTime) {
    updates.durationMs = finishTime - startTime
  }
  // Only recalculate gunDurationMs when finishTime changes — startTime correction does not affect it
  if (updates.finishTime) {
    const run = await db.query.raceRuns.findFirst({ where: eq(raceRuns.id, current.raceRunId) })
    if (run?.startedAt) updates.gunDurationMs = finishTime - new Date(run.startedAt)
  }
  if (updates.finishTime && !current.startTime && !updates.startTime) {
    updates.status = updates.status || 'finished'
  }

  const [row] = await db.update(results).set(updates).where(eq(results.id, req.params.id)).returning()

  await recalcPositions(db, current.raceRunId)

  const updated = await db.query.results.findFirst({ where: eq(results.id, req.params.id) })
  broadcast('result:update', updated)

  return { data: row }
})
```

- [ ] **Step 2: Restart and verify the PATCH endpoint still works for normal updates**

```bash
docker compose restart backend
docker compose logs backend --tail=5
```

Expected: clean start.

- [ ] **Step 3: Commit**

```bash
git add backend/src/routes/results.js
git commit -m "feat(results): force startTimeSource='manual' when startTime is patched manually"
```

---

## Chunk 5: Frontend — Audit tab in RaceControl

### Task 8: Add Audit tab to RaceControl.jsx

**Files:**
- Modify: `frontend/src/pages/RaceControl.jsx`

The current `RaceControl.jsx` renders a two-column layout: left = category race cards, right = live crossing feed + raw RFID feed. There are no tabs. We need to restructure the right column (or add a tab structure to the whole page) to accommodate the Audit tab.

Looking at the existing layout, the cleanest approach is to convert the right-column sidebar into a tabbed panel: "Feed" tab (existing crossing feed + raw feed) and "Audit" tab (new).

- [ ] **Step 1: Ensure shadcn Tabs component exists**

Check if `frontend/src/components/ui/tabs.jsx` already exists:

```bash
ls frontend/src/components/ui/tabs.jsx 2>/dev/null && echo "exists" || echo "missing"
```

If missing, add it (from the frontend container or locally via shadcn-ui CLI):

```bash
cd frontend && npx shadcn-ui@latest add tabs
```

Then verify the file is at `frontend/src/components/ui/tabs.jsx`.

- [ ] **Step 2: Add required imports**

At the top of `RaceControl.jsx`, add to existing imports:

```js
import { useState } from 'react'  // already imported
import { useMutation } from '@tanstack/react-query'  // already imported
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/tabs.jsx'
import { AlertTriangle } from 'lucide-react'  // may already be imported
```

Also verify `useQuery`, `useMutation`, `useQueryClient` are already imported (they are).

- [ ] **Step 3: Add audit query and WS invalidation**

Inside the `RaceControl` component, after the existing `useWsEvent('race:update', ...)` call, find the currently selected/active raceRunId. The page has multiple categories, each with their own race. For the audit, we need to pick the active race run across all categories. Add:

```js
// Determine the active raceRunId for audit (most recently started active race across all categories)
const activeRaceRunId = useMemo(() => {
  const active = races.filter(r => r.status === 'active')
  if (!active.length) {
    // Fall back to most recent finished race
    const all = [...races].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    return all[0]?.id || null
  }
  return active.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))[0]?.id || null
}, [races])

const { data: auditData } = useQuery({
  queryKey: ['audit', activeRaceRunId],
  queryFn: () => api.races.audit(activeRaceRunId),
  enabled: !!activeRaceRunId,
  refetchInterval: 30000,
  select: (d) => d,
})

const gunStartFallback = auditData?.gunStartFallback ?? []
const unresolvedCount = gunStartFallback.filter(r => r.startTimeSource === 'gun').length
```

Add `useMemo` to the React import:

```js
import { useState, useRef, useMemo } from 'react'
```

Also add WS invalidation for audit. Use `{ queryKey: ['audit'] }` (prefix match, no specific raceRunId) to avoid stale-closure issues — TanStack Query will invalidate all `['audit', *]` entries:

```js
useWsEvent('rfid:crossing', (payload) => {
  // ... existing code ...
  qc.invalidateQueries({ queryKey: ['audit'] })
})

useWsEvent('result:update', () => {
  qc.invalidateQueries({ queryKey: ['audit'] })
})

useWsEvent('race:update', () => {
  qc.invalidateQueries({ queryKey: ['races', id] })
  qc.invalidateQueries({ queryKey: ['audit'] })
})
```

Note: the existing `useWsEvent` handlers already invalidate some queries — extend them rather than replacing.

- [ ] **Step 4: Convert the right-column sidebar to a tabbed panel**

Replace the right-column `<div className="space-y-3">` and its contents with:

```jsx
<div>
  <Tabs defaultValue="feed">
    <TabsList className="w-full mb-3">
      <TabsTrigger value="feed" className="flex-1">Feed</TabsTrigger>
      <TabsTrigger value="audit" className="flex-1 relative">
        Audit
        {unresolvedCount > 0 && (
          <span className="ml-1.5 bg-amber-500 text-black text-xs font-bold px-1.5 py-0.5 leading-none">
            {unresolvedCount}
          </span>
        )}
      </TabsTrigger>
    </TabsList>

    <TabsContent value="feed" className="space-y-3">
      {/* existing Card: Przejścia na żywo */}
      <Card>
        <CardHeader className="py-2.5"><CardTitle className="text-base">Przejścia na żywo</CardTitle></CardHeader>
        <CardContent className="p-0 max-h-80 overflow-y-auto">
          {/* ... existing crossing feed ... */}
        </CardContent>
      </Card>

      {/* existing Card: Surowe odczyty RFID */}
      <Card>
        <CardHeader className="py-2.5"><CardTitle className="text-base">Surowe odczyty RFID</CardTitle></CardHeader>
        <CardContent className="p-0 max-h-48 overflow-y-auto font-mono text-xs">
          {/* ... existing raw feed ... */}
        </CardContent>
      </Card>
    </TabsContent>

    <TabsContent value="audit">
      <AuditPanel gunStartFallback={gunStartFallback} raceRun={races.find(r => r.id === activeRaceRunId)} onCorrect={() => qc.invalidateQueries({ queryKey: ['audit'] })} />
    </TabsContent>
  </Tabs>
</div>
```

- [ ] **Step 5: Implement the AuditPanel component**

Add at the bottom of `RaceControl.jsx` (before the final export, after `RaceCard`):

```jsx
function AuditPanel({ gunStartFallback, raceRun, onCorrect }) {
  const [editingId, setEditingId] = useState(null)
  const [timeInput, setTimeInput] = useState('')

  const correctMutation = useMutation({
    mutationFn: ({ resultId, startTime }) => api.results.update(resultId, { startTime }),
    onSuccess: () => {
      setEditingId(null)
      setTimeInput('')
      onCorrect()
    },
  })

  function parseTime(hhmmss, gunStartTime) {
    // Parse HH:MM:SS relative to the race start date
    const [h, m, s] = hhmmss.split(':').map(Number)
    if ([h, m, s].some(isNaN)) return null
    const base = new Date(gunStartTime)
    base.setHours(h, m, s, 0)
    return base.toISOString()
  }

  if (!gunStartFallback.length) {
    return (
      <div className="py-8 text-center text-xs text-apex-muted">
        Brak wpisów auditu.
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Section: gun start fallback */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <span className="bg-amber-900 text-amber-400 text-xs font-bold px-2 py-0.5 uppercase tracking-widest">
            <AlertTriangle size={10} className="inline mr-1" />
            Brutto użyte zamiast netto
          </span>
          {gunStartFallback.filter(r => r.startTimeSource === 'gun').length > 0 && (
            <span className="text-xs text-apex-muted">
              {gunStartFallback.filter(r => r.startTimeSource === 'gun').length} do poprawy
            </span>
          )}
        </div>

        <div className="border border-apex-border">
          {/* Header row */}
          <div className="grid grid-cols-[2fr_1fr_1fr_1fr_1.5fr] gap-2 px-3 py-1.5 bg-apex-surface text-xs text-apex-muted uppercase tracking-widest border-b border-apex-border">
            <span>Zawodnik</span>
            <span>Netto*</span>
            <span>Brutto</span>
            <span>Powód</span>
            <span>Akcja</span>
          </div>

          {gunStartFallback.map(r => {
            const reason = r.startTimeSource === 'manual'
              ? 'poprawiono ręcznie'
              : r.startTimeTrigger === 'finish_crossing'
                ? 'brak startu RFID (meta)'
                : r.startTimeTrigger?.startsWith('checkpoint:')
                  ? r.checkpointName
                    ? `brak startu RFID (pkt ${r.checkpointName})`
                    : 'brak startu RFID (usunięty punkt)'  // checkpoint deleted
                  : 'brak startu RFID'

            const nettoLabel = r.durationMs ? formatDuration(r.durationMs) : '—'
            const bruttoLabel = r.gunDurationMs ? formatDuration(r.gunDurationMs) : '—'
            const isResolved = r.startTimeSource === 'manual'

            return (
              <div
                key={r.resultId}
                className={`grid grid-cols-[2fr_1fr_1fr_1fr_1.5fr] gap-2 px-3 py-2 border-b border-apex-border last:border-0 text-xs items-center ${isResolved ? 'opacity-50' : ''}`}
              >
                <span className="text-apex-text truncate">
                  {r.emoji && <span className="mr-1">{r.emoji}</span>}
                  {r.firstName} {r.lastName}
                  {r.bibNumber && <span className="ml-1 text-apex-muted">#{r.bibNumber}</span>}
                </span>

                <span className={isResolved ? 'text-green-400' : 'text-amber-400'}>
                  {nettoLabel}
                  <span className={`ml-1 text-xs font-bold px-1 ${isResolved ? 'bg-green-900 text-green-400' : 'bg-amber-900 text-amber-400'}`}>
                    {r.startTimeSource === 'manual' ? 'MANUAL' : 'GUN'}
                  </span>
                </span>

                <span className="text-apex-muted">{bruttoLabel}</span>

                <span className="text-apex-muted truncate" title={reason}>{reason}</span>

                <div>
                  {isResolved ? (
                    <span className="text-apex-muted italic">poprawiono ✓</span>
                  ) : editingId === r.resultId ? (
                    <div className="flex gap-1 items-center">
                      <input
                        type="text"
                        placeholder="HH:MM:SS"
                        value={timeInput}
                        onChange={e => setTimeInput(e.target.value)}
                        className="bg-apex-surface border border-apex-border text-apex-text px-1.5 py-0.5 w-20 text-xs font-mono focus:outline-none focus:border-apex-yellow"
                      />
                      <button
                        className="border border-apex-border px-2 py-0.5 text-xs text-apex-text hover:border-apex-yellow hover:text-apex-yellow"
                        onClick={() => {
                          if (!raceRun?.startedAt) return
                          const iso = parseTime(timeInput, raceRun.startedAt)
                          if (!iso) return
                          correctMutation.mutate({ resultId: r.resultId, startTime: iso })
                        }}
                        disabled={correctMutation.isPending}
                      >
                        OK
                      </button>
                      <button
                        className="text-apex-muted text-xs hover:text-apex-text"
                        onClick={() => { setEditingId(null); setTimeInput('') }}
                      >✕</button>
                    </div>
                  ) : (
                    <button
                      className="border border-apex-border px-2 py-0.5 text-xs text-apex-text hover:border-apex-yellow hover:text-apex-yellow"
                      onClick={() => { setEditingId(r.resultId); setTimeInput('') }}
                    >
                      Podaj czas startu
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        <p className="text-xs text-apex-muted mt-2">
          * GUN = użyto czasu brutto jako zastępstwo. MANUAL = ręcznie poprawiony przez operatora.
        </p>
      </div>

      {/* Placeholder for future audit sections */}
      <div className="border border-dashed border-apex-border px-3 py-2 text-xs text-apex-muted italic">
        Kolejne sekcje auditu pojawią się tutaj (np. check-in bez startu)
      </div>
    </div>
  )
}
```

The `formatDuration` helper is already defined in `utils.js` and imported. Use `formatDuration` from `../lib/utils.js`.

Check the import line for `utils.js` — the current import is:
```js
import { formatDateTime, formatDuration, statusLabel, statusColor, cn } from '../lib/utils.js'
```

`formatDuration` is already available. Good.

- [ ] **Step 6: Rebuild frontend and verify**

```bash
docker compose restart frontend
```

Open http://localhost:3000, navigate to an event → Sterowanie. Verify:
- Right column now has "Feed" and "Audit" tabs
- Feed tab shows existing crossing feed and raw RFID feed
- Audit tab shows "Brak wpisów auditu." when no gun fallbacks exist
- Amber badge appears on Audit tab when there are unresolved gun fallbacks

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/RaceControl.jsx
git commit -m "feat(frontend): add Audit tab to RaceControl with gun-start fallback section"
```

---

## Chunk 6: Supabase schema update

### Task 9: Add columns to Supabase remote results table

**Files:**
- No local files — this is a Supabase console/migration step

- [ ] **Step 1: Apply migration to Supabase**

The Supabase sync worker will attempt to upsert rows with `start_time_source` and `start_time_trigger` columns once they exist locally. The remote `results` table must have these columns before the first sync after deployment.

Run via Supabase MCP or console:

```sql
ALTER TABLE results ADD COLUMN IF NOT EXISTS start_time_source text;
ALTER TABLE results ADD COLUMN IF NOT EXISTS start_time_trigger text;
```

If using Supabase MCP: `mcp__supabase__execute_sql` with the above SQL.

- [ ] **Step 2: Verify sync still works**

```bash
docker compose logs backend --tail=30 | grep -i sync
```

Expected: `[Sync] Synced N rows from results` without errors about unknown columns.

---

## Post-implementation verification

- [ ] Start a race, trigger a finish crossing for a participant with no RFID start tag assigned
- [ ] Verify in DB: `SELECT start_time_source, start_time_trigger, start_time, duration_ms, gun_duration_ms FROM results WHERE ...`
  - `start_time_source = 'gun'`
  - `start_time_trigger = 'finish_crossing'`
  - `start_time` = race gun start time
  - `duration_ms = gun_duration_ms`
- [ ] Verify Audit tab shows this participant with GUN badge
- [ ] Use "Podaj czas startu" to enter a corrected time, confirm row becomes "poprawiono ✓" with MANUAL badge
- [ ] Verify `start_time_source = 'manual'` in DB
- [ ] Verify amber badge disappears from Audit tab trigger after all entries are resolved
