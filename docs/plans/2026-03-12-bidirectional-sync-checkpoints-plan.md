# Bidirectional Sync, Checkpoints & Live Results — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add volunteer checkpoint observations, bidirectional Supabase sync via Realtime, a shared UI library, a volunteer app, and a public live results app.

**Architecture:** LeszyRun backend subscribes to Supabase Realtime for `participants` and `checkpoint_observations` tables — changes flow Supabase → local instantly. Volunteer app writes directly to Supabase (anon key + RLS). `liveresults/` is a static app that also subscribes to Supabase Realtime in the browser. Shared UI components live in `packages/ui`.

**Tech Stack:** Supabase Realtime (`@supabase/supabase-js`), Vite + React (all frontends), Drizzle ORM, Tailwind v4, `@leszyrun/ui` local workspace package.

---

## Pre-work: Create feature branch

```bash
git checkout -b feat/checkpoints-live-results
```

All work goes on this branch. Never commit directly to `main`.

---

## Task 1: Database migration — checkpoints + updated_at

**Files:**
- Create: `backend/src/db/migrations/0009_checkpoints.sql`
- Modify: `backend/src/db/migrations/meta/_journal.json`
- Modify: `backend/src/db/schema.js`

### Step 1: Create the SQL migration file

```sql
-- backend/src/db/migrations/0009_checkpoints.sql

--> statement-breakpoint
CREATE TABLE checkpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name text NOT NULL,
  km_marker int,
  created_at timestamptz DEFAULT now(),
  synced_at timestamptz
);

--> statement-breakpoint
CREATE TABLE checkpoint_categories (
  checkpoint_id uuid NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (checkpoint_id, category_id)
);

--> statement-breakpoint
CREATE TABLE checkpoint_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  checkpoint_id uuid NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
  bib_number int NOT NULL,
  participant_id uuid REFERENCES participants(id) ON DELETE SET NULL,
  observed_at timestamptz NOT NULL,
  synced_at timestamptz,
  UNIQUE (checkpoint_id, bib_number)
);

--> statement-breakpoint
ALTER TABLE participants ADD COLUMN updated_at timestamptz;
```

### Step 2: Register migration in journal

Add to the `entries` array in `backend/src/db/migrations/meta/_journal.json`:

```json
{
  "idx": 9,
  "version": "7",
  "when": 1741737600000,
  "tag": "0009_checkpoints",
  "breakpoints": true
}
```

### Step 3: Add Drizzle schema definitions

Add to `backend/src/db/schema.js` after the `results` table definition:

```js
export const checkpoints = pgTable('checkpoints', {
  id: uuid('id').primaryKey().defaultRandom(),
  eventId: uuid('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  kmMarker: integer('km_marker'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  syncedAt: timestamp('synced_at', { withTimezone: true }),
})

export const checkpointCategories = pgTable('checkpoint_categories', {
  checkpointId: uuid('checkpoint_id').notNull().references(() => checkpoints.id, { onDelete: 'cascade' }),
  categoryId: uuid('category_id').notNull().references(() => categories.id, { onDelete: 'cascade' }),
}, (t) => [
  { primaryKey: [t.checkpointId, t.categoryId] },
])

export const checkpointObservations = pgTable('checkpoint_observations', {
  id: uuid('id').primaryKey().defaultRandom(),
  checkpointId: uuid('checkpoint_id').notNull().references(() => checkpoints.id, { onDelete: 'cascade' }),
  bibNumber: integer('bib_number').notNull(),
  participantId: uuid('participant_id').references(() => participants.id, { onDelete: 'set null' }),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
  syncedAt: timestamp('synced_at', { withTimezone: true }),
})
```

Also add `updatedAt` to the `participants` table definition:

```js
// In the participants pgTable definition, after checkedInAt:
updatedAt: timestamp('updated_at', { withTimezone: true }),
```

Add relations at the bottom:

```js
export const checkpointsRelations = relations(checkpoints, ({ one, many }) => ({
  event: one(events, { fields: [checkpoints.eventId], references: [events.id] }),
  checkpointCategories: many(checkpointCategories),
  observations: many(checkpointObservations),
}))

export const checkpointObservationsRelations = relations(checkpointObservations, ({ one }) => ({
  checkpoint: one(checkpoints, { fields: [checkpointObservations.checkpointId], references: [checkpoints.id] }),
  participant: one(participants, { fields: [checkpointObservations.participantId], references: [participants.id] }),
}))
```

### Step 4: Restart backend and verify migration ran

```bash
docker compose restart backend
docker compose logs backend --tail=20
```

Expected: `[DB] Migrations complete` with no errors.

### Step 5: Commit

```bash
git add backend/src/db/migrations/0009_checkpoints.sql \
        backend/src/db/migrations/meta/_journal.json \
        backend/src/db/schema.js
git commit -m "feat: add checkpoints, checkpoint_observations tables + participants.updated_at"
```

---

## Task 2: Backend checkpoint routes

**Files:**
- Create: `backend/src/routes/checkpoints.js`
- Modify: `backend/src/server.js`
- Modify: `backend/src/routes/participants.js` (set `updated_at` on PATCH)

### Step 1: Create checkpoints route file

```js
// backend/src/routes/checkpoints.js
import { eq, inArray } from 'drizzle-orm'
import { checkpoints, checkpointCategories, checkpointObservations } from '../db/schema.js'

export async function checkpointsRoutes(fastify) {
  const db = fastify.db

  // List checkpoints for an event (with their category IDs)
  fastify.get('/events/:eventId/checkpoints', async (req, reply) => {
    const rows = await db.select().from(checkpoints)
      .where(eq(checkpoints.eventId, req.params.eventId))
      .orderBy(checkpoints.kmMarker, checkpoints.createdAt)

    const catLinks = rows.length
      ? await db.select().from(checkpointCategories)
          .where(inArray(checkpointCategories.checkpointId, rows.map(r => r.id)))
      : []

    const catsByCheckpoint = {}
    for (const link of catLinks) {
      if (!catsByCheckpoint[link.checkpointId]) catsByCheckpoint[link.checkpointId] = []
      catsByCheckpoint[link.checkpointId].push(link.categoryId)
    }

    return { data: rows.map(r => ({ ...r, categoryIds: catsByCheckpoint[r.id] || [] })) }
  })

  // Create checkpoint
  fastify.post('/events/:eventId/checkpoints', async (req, reply) => {
    const { name, kmMarker, categoryIds = [] } = req.body
    if (!name) return reply.code(400).send({ error: 'name required' })

    const [row] = await db.insert(checkpoints)
      .values({ eventId: req.params.eventId, name, kmMarker: kmMarker || null })
      .returning()

    if (categoryIds.length) {
      await db.insert(checkpointCategories)
        .values(categoryIds.map(cid => ({ checkpointId: row.id, categoryId: cid })))
    }

    return reply.code(201).send({ data: { ...row, categoryIds } })
  })

  // Update checkpoint
  fastify.patch('/checkpoints/:id', async (req, reply) => {
    const { name, kmMarker, categoryIds } = req.body
    const updates = {}
    if (name !== undefined) updates.name = name
    if (kmMarker !== undefined) updates.kmMarker = kmMarker

    const [row] = await db.update(checkpoints)
      .set(updates)
      .where(eq(checkpoints.id, req.params.id))
      .returning()

    if (!row) return reply.code(404).send({ error: 'not found' })

    if (categoryIds !== undefined) {
      await db.delete(checkpointCategories).where(eq(checkpointCategories.checkpointId, row.id))
      if (categoryIds.length) {
        await db.insert(checkpointCategories)
          .values(categoryIds.map(cid => ({ checkpointId: row.id, categoryId: cid })))
      }
    }

    const catLinks = await db.select().from(checkpointCategories)
      .where(eq(checkpointCategories.checkpointId, row.id))

    return { data: { ...row, categoryIds: catLinks.map(l => l.categoryId) } }
  })

  // Delete checkpoint
  fastify.delete('/checkpoints/:id', async (req, reply) => {
    await db.delete(checkpoints).where(eq(checkpoints.id, req.params.id))
    return reply.code(204).send()
  })

  // List observations for a checkpoint (for debugging/admin)
  fastify.get('/checkpoints/:id/observations', async (req, reply) => {
    const rows = await db.select().from(checkpointObservations)
      .where(eq(checkpointObservations.checkpointId, req.params.id))
      .orderBy(checkpointObservations.observedAt)
    return { data: rows }
  })
}
```

### Step 2: Register in server.js

Add import and registration in `backend/src/server.js`:

```js
// Add import alongside other route imports:
import { checkpointsRoutes } from './routes/checkpoints.js'

// Add inside the api prefix block, after resultsRoutes:
await api.register(checkpointsRoutes)
```

### Step 3: Set updated_at on participant PATCH

Open `backend/src/routes/participants.js` and find the `PATCH /participants/:id` handler. Add `updatedAt: new Date()` to the set object, alongside whatever fields are already being updated.

Look for the pattern `db.update(participants).set({...}).where(...)` and add `updatedAt: new Date()` to the set.

### Step 4: Test the routes manually

```bash
# Restart backend
docker compose restart backend

# Create a checkpoint (replace EVENT_ID with a real one from your DB)
curl -X POST http://localhost:3001/api/events/EVENT_ID/checkpoints \
  -H "Content-Type: application/json" \
  -d '{"name":"Km 5","kmMarker":5,"categoryIds":[]}'

# Should return 201 with the created checkpoint

# List checkpoints
curl http://localhost:3001/api/events/EVENT_ID/checkpoints
# Should return { data: [...] }
```

### Step 5: Commit

```bash
git add backend/src/routes/checkpoints.js \
        backend/src/server.js \
        backend/src/routes/participants.js
git commit -m "feat: checkpoint CRUD routes + updated_at on participant PATCH"
```

---

## Task 3: Supabase sync — add Realtime subscriptions + new tables

**Files:**
- Modify: `backend/src/sync/supabase.js`

### Step 1: Add new tables to SYNC_TABLES

In `backend/src/sync/supabase.js`, import the new tables and add them to `SYNC_TABLES`:

```js
import { events, categories, participants, raceRuns, gateCrossings, results,
         checkpoints, checkpointCategories, checkpointObservations } from '../db/schema.js'

const SYNC_TABLES = [
  { table: events, name: 'events' },
  { table: categories, name: 'categories' },
  { table: participants, name: 'participants' },
  { table: raceRuns, name: 'race_runs' },
  { table: gateCrossings, name: 'gate_crossings' },
  { table: results, name: 'results' },
  { table: checkpoints, name: 'checkpoints' },
  { table: checkpointObservations, name: 'checkpoint_observations' },
]
```

Note: `checkpoint_categories` has a composite PK (no `id` column), so handle it separately — do NOT add to SYNC_TABLES. It will sync via a dedicated push in the sync loop (see below).

### Step 2: Add Realtime subscription logic

Add this function to `backend/src/sync/supabase.js`. It must be called from `initSupabaseSync` after the client is created:

```js
import { eq, sql } from 'drizzle-orm'
import { broadcast } from '../ws/broadcaster.js'

// Track recently pushed participant IDs to avoid re-applying our own sync writes
const recentlySyncedParticipantIds = new Set()

function subscribeRealtime(db) {
  supabase
    .channel('leszyrun-realtime')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'participants' },
      async (payload) => {
        const remote = payload.new
        if (!remote?.id) return

        // Skip if this is our own sync write coming back
        if (recentlySyncedParticipantIds.has(remote.id)) {
          recentlySyncedParticipantIds.delete(remote.id)
          return
        }

        // Skip if local record is same age or newer
        const [local] = await db.select({ updatedAt: participants.updatedAt })
          .from(participants)
          .where(eq(participants.id, remote.id))

        const remoteTs = remote.updated_at ? new Date(remote.updated_at) : null
        const localTs = local?.updatedAt ? new Date(local.updatedAt) : null

        if (localTs && remoteTs && remoteTs <= localTs) return

        console.log(`[Sync] Realtime participant ${payload.eventType}: ${remote.id}`)

        if (payload.eventType === 'INSERT') {
          await db.insert(participants).values(toCamel(remote)).onConflictDoNothing()
        } else if (payload.eventType === 'UPDATE') {
          await db.update(participants)
            .set({ ...toCamel(remote), syncedAt: new Date() })
            .where(eq(participants.id, remote.id))
        }
      }
    )
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'checkpoint_observations' },
      async (payload) => {
        const remote = payload.new
        if (!remote?.id) return

        console.log(`[Sync] Realtime checkpoint_observation: bib ${remote.bib_number}`)

        // Resolve participant_id from bib_number + event context
        // checkpoint → event → find participant by bib_number in that event
        const [cp] = await db.select({ eventId: checkpoints.eventId })
          .from(checkpoints)
          .where(eq(checkpoints.id, remote.checkpoint_id))

        let participantId = null
        if (cp) {
          const { participants: p } = await import('./db/schema.js').catch(() => ({ participants }))
          // use already-imported participants
          const [found] = await db.select({ id: participants.id })
            .from(participants)
            .where(
              sql`event_id = ${cp.eventId} AND bib_number = ${remote.bib_number}`
            )
          if (found) participantId = found.id
        }

        await db.insert(checkpointObservations)
          .values({
            id: remote.id,
            checkpointId: remote.checkpoint_id,
            bibNumber: remote.bib_number,
            participantId,
            observedAt: new Date(remote.observed_at),
            syncedAt: new Date(),
          })
          .onConflictDoNothing()

        // Broadcast to connected frontend clients
        broadcast('checkpoint:observation', {
          id: remote.id,
          checkpointId: remote.checkpoint_id,
          bibNumber: remote.bib_number,
          participantId,
          observedAt: remote.observed_at,
        })
      }
    )
    .subscribe((status) => {
      console.log(`[Sync] Realtime subscription status: ${status}`)
    })
}

// Convert snake_case DB row to camelCase for Drizzle insert/update
function toCamel(row) {
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()),
      v,
    ])
  )
}
```

### Step 3: Track synced IDs to prevent loops

In the existing `runSync` function, when pushing participants to Supabase, record their IDs in `recentlySyncedParticipantIds` before the upsert. Find the loop over `SYNC_TABLES` and add this special case:

```js
// In runSync, inside the for loop over SYNC_TABLES:
if (name === 'participants') {
  for (const row of rows) recentlySyncedParticipantIds.add(row.id)
}
const { error } = await supabase.from(name).upsert(rows.map(rowToSnake), { onConflict: 'id' })
```

### Step 4: Call subscribeRealtime from initSupabaseSync

In `initSupabaseSync`, after `supabase = createClient(url, key)`, add:

```js
subscribeRealtime(db)
```

### Step 5: Fix the checkpoint_observations import path in the Realtime handler

The handler uses `await import('./db/schema.js')` as a fallback which is wrong — `participants` is already imported at the top of the file. Remove that dynamic import and just use the already-imported `participants` reference directly. The resolved code for the participant lookup should be:

```js
const [found] = await db.select({ id: participants.id })
  .from(participants)
  .where(sql`event_id = ${cp.eventId} AND bib_number = ${remote.bib_number}`)
if (found) participantId = found.id
```

### Step 6: Verify Realtime works

Check Supabase dashboard → Database → Replication and confirm `participants` and `checkpoint_observations` are in the publication list (Supabase enables this automatically for all tables, but verify).

Also run:
```bash
docker compose restart backend
docker compose logs backend -f
```

Expected log on startup: `[Sync] Realtime subscription status: SUBSCRIBED`

### Step 7: Commit

```bash
git add backend/src/sync/supabase.js
git commit -m "feat: Supabase Realtime subscriptions for participants and checkpoint_observations"
```

---

## Task 4: Supabase RLS policies

**Files:**
- Create: `supabase/rls-policies.sql`

This file is documentation + a runnable script. Run it once in the Supabase SQL editor for project `<your-supabase-project-id>`.

### Step 1: Create the file

```sql
-- supabase/rls-policies.sql
-- Run once in Supabase SQL editor for project <your-supabase-project-id>
-- These policies allow the volunteer app and liveresults app (anon key) to read/write as needed.

-- Enable RLS on new tables (existing tables should already have RLS enabled)
ALTER TABLE checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE checkpoint_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE checkpoint_observations ENABLE ROW LEVEL SECURITY;

-- Checkpoints: anon can read
CREATE POLICY "anon read checkpoints"
  ON checkpoints FOR SELECT TO anon USING (true);

-- Checkpoint categories: anon can read
CREATE POLICY "anon read checkpoint_categories"
  ON checkpoint_categories FOR SELECT TO anon USING (true);

-- Checkpoint observations: anon can read + insert (dedup via unique constraint)
CREATE POLICY "anon read observations"
  ON checkpoint_observations FOR SELECT TO anon USING (true);
CREATE POLICY "anon insert observations"
  ON checkpoint_observations FOR INSERT TO anon WITH CHECK (true);

-- Events: anon can read (needed by volunteer app to show event name)
-- If this policy doesn't exist yet, create it:
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='events' AND policyname='anon read events'
  ) THEN
    CREATE POLICY "anon read events" ON events FOR SELECT TO anon USING (true);
  END IF;
END $$;

-- Categories: anon can read
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='categories' AND policyname='anon read categories'
  ) THEN
    CREATE POLICY "anon read categories" ON categories FOR SELECT TO anon USING (true);
  END IF;
END $$;

-- Participants: anon can read (liveresults needs bib_number, first_name, last_name, category_id)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='participants' AND policyname='anon read participants'
  ) THEN
    CREATE POLICY "anon read participants" ON participants FOR SELECT TO anon USING (true);
  END IF;
END $$;

-- Results: anon can read (liveresults shows results)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='results' AND policyname='anon read results'
  ) THEN
    CREATE POLICY "anon read results" ON results FOR SELECT TO anon USING (true);
  END IF;
END $$;

-- Gate crossings: anon can read (for liveresults)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='gate_crossings' AND policyname='anon read gate_crossings'
  ) THEN
    CREATE POLICY "anon read gate_crossings" ON gate_crossings FOR SELECT TO anon USING (true);
  END IF;
END $$;

-- Race runs: anon can read
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='race_runs' AND policyname='anon read race_runs'
  ) THEN
    CREATE POLICY "anon read race_runs" ON race_runs FOR SELECT TO anon USING (true);
  END IF;
END $$;

-- Enable Realtime for tables that need it (postgres_changes subscriptions)
-- Run these if not already enabled:
ALTER TABLE participants REPLICA IDENTITY FULL;
ALTER TABLE checkpoint_observations REPLICA IDENTITY FULL;
ALTER TABLE results REPLICA IDENTITY FULL;
ALTER TABLE race_runs REPLICA IDENTITY FULL;
```

### Step 2: Run in Supabase SQL editor

Go to https://supabase.com/dashboard/project/<your-supabase-project-id>/sql and run the script.

### Step 3: Commit

```bash
git add supabase/rls-policies.sql
git commit -m "chore: Supabase RLS policies and Realtime config script"
```

---

## Task 5: packages/ui — shared component library setup

**Files:**
- Create: `packages/ui/package.json`
- Create: `packages/ui/src/index.js`
- Modify: `frontend/package.json`

### Step 1: Create directory and package.json

```bash
mkdir -p packages/ui/src/components packages/ui/src/lib
```

```json
// packages/ui/package.json
{
  "name": "@leszyrun/ui",
  "version": "1.0.0",
  "type": "module",
  "exports": {
    ".": "./src/index.js"
  },
  "peerDependencies": {
    "react": ">=19.0.0"
  }
}
```

### Step 2: Create the index barrel

```js
// packages/ui/src/index.js
export { Podium } from './components/Podium.jsx'
export { CheckpointTrackingTable } from './components/CheckpointTrackingTable.jsx'
export { PositionBadge } from './components/PositionBadge.jsx'
export { estimatePositions } from './lib/positionEstimation.js'
```

### Step 3: Add @leszyrun/ui to frontend

In `frontend/package.json`, add to `dependencies`:

```json
"@leszyrun/ui": "file:../packages/ui"
```

Then run:
```bash
cd frontend && npm install && cd ..
```

### Step 4: Tell Tailwind to scan packages/ui

In `frontend/src/index.css`, add `@source` after the `@import "tailwindcss"` line:

```css
@import "tailwindcss";
@source "../../packages/ui/src";
```

### Step 5: Commit

```bash
git add packages/ui/package.json packages/ui/src/index.js frontend/package.json frontend/src/index.css
git commit -m "chore: packages/ui shared component library scaffold"
```

---

## Task 6: packages/ui — position estimation logic

**Files:**
- Create: `packages/ui/src/lib/positionEstimation.js`

### Step 1: Write the utility

```js
// packages/ui/src/lib/positionEstimation.js

/**
 * Estimates race positions for a list of results, enriched with checkpoint observations.
 *
 * @param {Array} results - result rows, each with { id, participantId, startTime, finishTime,
 *                          gunDurationMs, status, participant: { bibNumber, firstName, lastName, club } }
 * @param {Array} checkpoints - checkpoint rows sorted by km_marker asc: [{ id, name, kmMarker }]
 * @param {Array} observations - observation rows: [{ checkpointId, participantId, observedAt }]
 * @returns {Array} results sorted by estimated position, each with { ...result, estimatedPosition, positionType }
 *   positionType: 'final' | 'checkpoint' | 'started' | 'not-started'
 */
export function estimatePositions(results, checkpoints, observations) {
  // Build observation map: participantId → { checkpointIdx, observedAt }
  // checkpointIdx = index in the sorted checkpoints array (higher = further along)
  const cpIndexById = Object.fromEntries(checkpoints.map((cp, i) => [cp.id, i]))
  const obsMap = {}

  for (const obs of observations) {
    const pid = obs.participantId
    if (!pid) continue
    const idx = cpIndexById[obs.checkpointId]
    if (idx === undefined) continue
    const existing = obsMap[pid]
    if (!existing || idx > existing.checkpointIdx ||
        (idx === existing.checkpointIdx && new Date(obs.observedAt) < new Date(existing.observedAt))) {
      obsMap[pid] = { checkpointIdx: idx, observedAt: obs.observedAt }
    }
  }

  const enriched = results.map(r => {
    const obs = obsMap[r.participantId]
    return { ...r, _obs: obs }
  })

  // Sort: finished first (by gunDurationMs), then by furthest checkpoint, then by start time
  enriched.sort((a, b) => {
    const aFinished = !!a.finishTime
    const bFinished = !!b.finishTime

    if (aFinished && bFinished) return (a.gunDurationMs || 0) - (b.gunDurationMs || 0)
    if (aFinished) return -1
    if (bFinished) return 1

    const aObs = a._obs, bObs = b._obs
    if (aObs && bObs) {
      if (aObs.checkpointIdx !== bObs.checkpointIdx) return bObs.checkpointIdx - aObs.checkpointIdx
      return new Date(aObs.observedAt) - new Date(bObs.observedAt)
    }
    if (aObs) return -1
    if (bObs) return 1

    const aStarted = !!a.startTime
    const bStarted = !!b.startTime
    if (aStarted && bStarted) return new Date(a.startTime) - new Date(b.startTime)
    if (aStarted) return -1
    if (bStarted) return 1
    return 0
  })

  return enriched.map((r, i) => ({
    ...r,
    estimatedPosition: i + 1,
    positionType: r.finishTime ? 'final'
      : r._obs ? 'checkpoint'
      : r.startTime ? 'started'
      : 'not-started',
  }))
}
```

### Step 2: Commit

```bash
git add packages/ui/src/lib/positionEstimation.js
git commit -m "feat: position estimation algorithm in shared UI library"
```

---

## Task 7: packages/ui — PositionBadge component

**Files:**
- Create: `packages/ui/src/components/PositionBadge.jsx`

### Step 1: Write the component

```jsx
// packages/ui/src/components/PositionBadge.jsx

export function PositionBadge({ positionType }) {
  if (positionType === 'final') {
    return (
      <span className="text-xs font-bold uppercase tracking-widest px-1.5 py-0.5 border border-apex-yellow text-apex-yellow">
        FINAL
      </span>
    )
  }
  return (
    <span className="text-xs font-bold uppercase tracking-widest px-1.5 py-0.5 border border-apex-cyan text-apex-cyan flex items-center gap-1">
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-apex-cyan animate-pulse" />
      LIVE
    </span>
  )
}
```

### Step 2: Commit

```bash
git add packages/ui/src/components/PositionBadge.jsx
git commit -m "feat: PositionBadge shared component (LIVE/FINAL)"
```

---

## Task 8: packages/ui — Podium component (extracted from CategoryResults)

**Files:**
- Create: `packages/ui/src/components/Podium.jsx`

The existing `PodiumBox` lives in `frontend/src/pages/CategoryResults.jsx`. Extract and generalize it. The `formatDuration` util is app-specific — accept it as a prop to avoid coupling.

### Step 1: Write the component

```jsx
// packages/ui/src/components/Podium.jsx
import { PositionBadge } from './PositionBadge.jsx'

/**
 * @param {Array} top3 - up to 3 result objects with { participant, gunDurationMs, durationMs, positionType }
 * @param {Array} animals - array of 3 emoji strings from getPodiumAnimals()
 * @param {Function} formatDuration - (ms) => string
 */
export function Podium({ top3, animals, formatDuration }) {
  const [first, second, third] = top3
  return (
    <div className="flex items-end justify-center gap-4">
      {second && <PodiumBox place={2} result={second} animal={animals[1]} formatDuration={formatDuration} />}
      {first  && <PodiumBox place={1} result={first}  animal={animals[0]} formatDuration={formatDuration} />}
      {third  && <PodiumBox place={3} result={third}  animal={animals[2]} formatDuration={formatDuration} />}
    </div>
  )
}

const platformColors = {
  1: 'bg-apex-surface-2/50 border-t-4 border-yellow-500',
  2: 'bg-apex-surface-2/30 border-t-4 border-stone-400',
  3: 'bg-apex-surface-2/20 border-t-4 border-amber-600',
}
const platformHeights = { 1: 'h-28', 2: 'h-20', 3: 'h-16' }
const placeColors = {
  1: 'text-yellow-400',
  2: 'text-apex-muted',
  3: 'text-amber-600',
}

function PodiumBox({ place, result, animal, formatDuration }) {
  const p = result.participant
  return (
    <div className="flex-1 max-w-40 flex flex-col items-center">
      <div className="text-6xl leading-none mb-2">{animal}</div>
      <div className="font-display text-base tracking-wider text-center leading-tight text-apex-text-bright mb-1 px-1">
        {p?.firstName}<br />{p?.lastName}
      </div>
      <div className="mb-2">
        <PositionBadge positionType={result.positionType} />
      </div>
      <div className={`w-full flex flex-col items-center justify-center gap-1 ${platformColors[place]} ${platformHeights[place]}`}>
        <div className={`font-display text-4xl leading-none ${placeColors[place]}`}>{place}.</div>
        {result.gunDurationMs && (
          <div className="font-mono text-xs font-bold text-apex-yellow-bright">{formatDuration(result.gunDurationMs)}</div>
        )}
        {result.durationMs && result.durationMs !== result.gunDurationMs && (
          <div className="font-mono text-xs text-apex-muted">chip {formatDuration(result.durationMs)}</div>
        )}
        {!result.gunDurationMs && (
          <div className="font-mono text-xs text-apex-muted">na trasie</div>
        )}
      </div>
    </div>
  )
}
```

### Step 2: Commit

```bash
git add packages/ui/src/components/Podium.jsx
git commit -m "feat: Podium shared component with LIVE/FINAL position support"
```

---

## Task 9: packages/ui — CheckpointTrackingTable

**Files:**
- Create: `packages/ui/src/components/CheckpointTrackingTable.jsx`

### Step 1: Write the component

```jsx
// packages/ui/src/components/CheckpointTrackingTable.jsx

/**
 * @param {Array} results - enriched by estimatePositions (with estimatedPosition, positionType)
 * @param {Array} checkpoints - [{ id, name, kmMarker }] sorted by kmMarker
 * @param {Array} observations - [{ checkpointId, participantId, observedAt }]
 * @param {Function} formatTime - (isoString) => display string
 */
export function CheckpointTrackingTable({ results, checkpoints, observations, formatTime }) {
  // Build lookup: participantId + checkpointId → observedAt
  const obsLookup = {}
  for (const obs of observations) {
    if (obs.participantId) {
      obsLookup[`${obs.participantId}:${obs.checkpointId}`] = obs.observedAt
    }
  }

  return (
    <div className="border border-apex-border bg-apex-surface overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-apex-border bg-apex-surface-2">
            <th className="text-left px-3 py-2 text-xs font-bold uppercase tracking-wider text-apex-muted w-10">Poz.</th>
            <th className="text-left px-3 py-2 text-xs font-bold uppercase tracking-wider text-apex-muted w-10">Nr</th>
            <th className="text-left px-3 py-2 text-xs font-bold uppercase tracking-wider text-apex-muted">Zawodnik</th>
            <th className="text-left px-3 py-2 text-xs font-bold uppercase tracking-wider text-apex-muted font-mono">Start</th>
            {checkpoints.map(cp => (
              <th key={cp.id} className="text-left px-3 py-2 text-xs font-bold uppercase tracking-wider text-apex-cyan font-mono whitespace-nowrap">
                {cp.name}{cp.kmMarker ? ` (km ${cp.kmMarker})` : ''}
              </th>
            ))}
            <th className="text-left px-3 py-2 text-xs font-bold uppercase tracking-wider text-apex-muted font-mono">Meta</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-apex-border">
          {results.map(r => {
            const p = r.participant
            return (
              <tr key={r.id} className="hover:bg-apex-surface-2 transition-colors">
                <td className="px-3 py-1.5 font-display text-lg text-apex-yellow">{r.estimatedPosition}</td>
                <td className="px-3 py-1.5 font-mono">#{p?.bibNumber}</td>
                <td className="px-3 py-1.5">{p?.firstName} {p?.lastName}</td>
                <td className="px-3 py-1.5 font-mono text-apex-muted">
                  {r.startTime ? formatTime(r.startTime) : '—'}
                </td>
                {checkpoints.map(cp => {
                  const t = obsLookup[`${r.participantId}:${cp.id}`]
                  return (
                    <td key={cp.id} className="px-3 py-1.5 font-mono text-apex-cyan">
                      {t ? formatTime(t) : <span className="text-apex-dim">—</span>}
                    </td>
                  )
                })}
                <td className="px-3 py-1.5 font-mono font-bold text-apex-yellow-bright">
                  {r.finishTime ? formatTime(r.finishTime) : '—'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
```

### Step 2: Commit

```bash
git add packages/ui/src/components/CheckpointTrackingTable.jsx
git commit -m "feat: CheckpointTrackingTable shared component"
```

---

## Task 10: frontend — checkpoint API methods

**Files:**
- Modify: `frontend/src/lib/api.js`

### Step 1: Add checkpoints section to api object

```js
// Add to the api export in frontend/src/lib/api.js:
checkpoints: {
  list: (eventId) => request('GET', `/events/${eventId}/checkpoints`),
  create: (eventId, body) => request('POST', `/events/${eventId}/checkpoints`, body),
  update: (id, body) => request('PATCH', `/checkpoints/${id}`, body),
  delete: (id) => request('DELETE', `/checkpoints/${id}`),
},
```

### Step 2: Commit

```bash
git add frontend/src/lib/api.js
git commit -m "feat: checkpoints API methods in frontend api.js"
```

---

## Task 11: frontend — Checkpoints tab in EventDetail

**Files:**
- Modify: `frontend/src/pages/EventDetail.jsx`

### Step 1: Add 'checkpoints' to VALID_TABS

In `EventDetail.jsx`, change:
```js
const VALID_TABS = ['categories', 'participants', 'import', 'rfid']
```
to:
```js
const VALID_TABS = ['categories', 'participants', 'import', 'rfid', 'checkpoints']
```

### Step 2: Add checkpoint data fetching

After the `categories` query, add:
```js
const { data: checkpoints = [] } = useQuery({
  queryKey: ['checkpoints', id],
  queryFn: () => api.checkpoints.list(id),
})
```

Add checkpoint mutations after existing mutations:
```js
const createCheckpoint = useMutation({
  mutationFn: (body) => api.checkpoints.create(id, body),
  onSuccess: () => qc.invalidateQueries({ queryKey: ['checkpoints', id] }),
})

const updateCheckpoint = useMutation({
  mutationFn: ({ id: cpId, ...body }) => api.checkpoints.update(cpId, body),
  onSuccess: () => qc.invalidateQueries({ queryKey: ['checkpoints', id] }),
})

const deleteCheckpoint = useMutation({
  mutationFn: api.checkpoints.delete,
  onSuccess: () => qc.invalidateQueries({ queryKey: ['checkpoints', id] }),
})
```

Add state for the checkpoint dialog:
```js
const [cpDialog, setCpDialog] = useState(false)
const [cpForm, setCpForm] = useState({ name: '', kmMarker: '', categoryIds: [] })
const [editingCp, setEditingCp] = useState(null)
```

### Step 3: Add the tab trigger

In the `TabsList` block (where other tab triggers are), add:
```jsx
<TabsTrigger value="checkpoints">
  <Flag size={14} /> Punkty kontrolne
</TabsTrigger>
```

### Step 4: Add the tab content

Add a `TabsContent` block for `checkpoints` after the `rfid` tab:

```jsx
<TabsContent value="checkpoints">
  <div className="space-y-4">
    <div className="flex items-center justify-between">
      <h2 className="font-display text-2xl uppercase tracking-wider text-apex-text-bright">
        Punkty kontrolne
      </h2>
      <Button size="sm" onClick={() => { setEditingCp(null); setCpForm({ name: '', kmMarker: '', categoryIds: [] }); setCpDialog(true) }}>
        <Plus size={14} /> Dodaj punkt
      </Button>
    </div>

    {checkpoints.length === 0 && (
      <p className="text-sm text-apex-muted py-4">Brak punktów kontrolnych. Dodaj punkt, aby wolontariusze mogli rejestrować przejścia.</p>
    )}

    <div className="space-y-2">
      {checkpoints.map(cp => {
        const volunteerUrl = `${import.meta.env.VITE_VOLUNTEER_URL || 'http://localhost:5174'}?checkpoint=${cp.id}`
        return (
          <div key={cp.id} className="border border-apex-border bg-apex-surface px-4 py-3 flex items-center justify-between gap-4">
            <div>
              <div className="font-semibold text-apex-text-bright">{cp.name}</div>
              <div className="text-xs text-apex-muted mt-0.5">
                {cp.kmMarker ? `Km ${cp.kmMarker} · ` : ''}
                {cp.categoryIds?.length
                  ? `Kategorie: ${cp.categoryIds.map(cid => categories.find(c => c.id === cid)?.name || cid).join(', ')}`
                  : 'Wszystkie kategorie'
                }
              </div>
              <div className="text-xs text-apex-cyan font-mono mt-1 break-all">{volunteerUrl}</div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Button size="sm" variant="outline" onClick={() => navigator.clipboard.writeText(volunteerUrl)} title="Kopiuj link">
                <ExternalLink size={12} />
              </Button>
              <Button size="sm" variant="outline" onClick={() => {
                setEditingCp(cp)
                setCpForm({ name: cp.name, kmMarker: cp.kmMarker ?? '', categoryIds: cp.categoryIds || [] })
                setCpDialog(true)
              }}>
                Edytuj
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button size="sm" variant="destructive"><Trash2 size={12} /></Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogTitle>Usuń punkt?</AlertDialogTitle>
                  <AlertDialogDescription>Usunięcie punktu usunie też wszystkie zarejestrowane przejścia wolontariuszy.</AlertDialogDescription>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Anuluj</AlertDialogCancel>
                    <AlertDialogAction onClick={() => deleteCheckpoint.mutate(cp.id)}>Usuń</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
        )
      })}
    </div>
  </div>

  {/* Add/Edit checkpoint dialog */}
  <Dialog open={cpDialog} onOpenChange={setCpDialog}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{editingCp ? 'Edytuj punkt' : 'Nowy punkt kontrolny'}</DialogTitle>
      </DialogHeader>
      <DialogBody className="space-y-3">
        <label className="block">
          <span className="text-xs font-bold uppercase tracking-widest text-apex-muted mb-1 block">Nazwa *</span>
          <Input value={cpForm.name} onChange={e => setCpForm(f => ({ ...f, name: e.target.value }))} placeholder="np. Km 5 – Górka" />
        </label>
        <label className="block">
          <span className="text-xs font-bold uppercase tracking-widest text-apex-muted mb-1 block">Km marker</span>
          <Input type="number" value={cpForm.kmMarker} onChange={e => setCpForm(f => ({ ...f, kmMarker: e.target.value }))} placeholder="5" />
        </label>
        <div>
          <span className="text-xs font-bold uppercase tracking-widest text-apex-muted mb-2 block">Kategorie (puste = wszystkie)</span>
          <div className="space-y-1">
            {categories.map(cat => (
              <label key={cat.id} className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={cpForm.categoryIds.includes(cat.id)}
                  onChange={e => setCpForm(f => ({
                    ...f,
                    categoryIds: e.target.checked
                      ? [...f.categoryIds, cat.id]
                      : f.categoryIds.filter(x => x !== cat.id),
                  }))}
                />
                {cat.name}
              </label>
            ))}
          </div>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={() => setCpDialog(false)}>Anuluj</Button>
        <Button
          disabled={!cpForm.name}
          onClick={() => {
            const body = {
              name: cpForm.name,
              kmMarker: cpForm.kmMarker ? parseInt(cpForm.kmMarker) : null,
              categoryIds: cpForm.categoryIds,
            }
            if (editingCp) {
              updateCheckpoint.mutate({ id: editingCp.id, ...body }, { onSuccess: () => setCpDialog(false) })
            } else {
              createCheckpoint.mutate(body, { onSuccess: () => setCpDialog(false) })
            }
          }}
        >
          {editingCp ? 'Zapisz' : 'Utwórz'}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</TabsContent>
```

### Step 5: Commit

```bash
git add frontend/src/pages/EventDetail.jsx
git commit -m "feat: Checkpoints tab in EventDetail with add/edit/delete + volunteer URL"
```

---

## Task 12: frontend — update CategoryResults to use shared Podium + live checkpoint tracking

**Files:**
- Modify: `frontend/src/pages/CategoryResults.jsx`

### Step 1: Add imports and query

At the top, import from `@leszyrun/ui`:

```js
import { Podium, CheckpointTrackingTable, estimatePositions } from '@leszyrun/ui'
import { api } from '../lib/api.js'
```

Add a query for checkpoints + observations. After the existing `categories` query, add:

```js
const eventId = /* extract from category once loaded */
// Since categories query already runs for eventId, use it:
const { data: checkpointsData = [] } = useQuery({
  queryKey: ['checkpoints', eventId],
  queryFn: () => api.checkpoints.list(eventId),
  enabled: !!eventId,
})

const { data: observationsData = [] } = useQuery({
  queryKey: ['checkpoint-observations', run?.id],
  queryFn: () => api.checkpoints.observations(run?.id),
  enabled: !!run?.id,
  refetchInterval: 5000,
})
```

Note: Add a `observations` method to `api.checkpoints` that lists observations for a race run — add this to `frontend/src/lib/api.js`:
```js
// Inside checkpoints:
observationsForRace: (raceRunId) => request('GET', `/races/${raceRunId}/checkpoint-observations`),
```

And add the corresponding backend route in `backend/src/routes/checkpoints.js`:
```js
fastify.get('/races/:raceRunId/checkpoint-observations', async (req, reply) => {
  const { eq } = await import('drizzle-orm')
  const { checkpoints: cpTable } = await import('../db/schema.js')

  // Get all observations for checkpoints in this race run's event
  // checkpointObservations JOIN checkpoints where checkpoints.event_id = race's event
  const rows = await db
    .select({
      id: checkpointObservations.id,
      checkpointId: checkpointObservations.checkpointId,
      bibNumber: checkpointObservations.bibNumber,
      participantId: checkpointObservations.participantId,
      observedAt: checkpointObservations.observedAt,
    })
    .from(checkpointObservations)
    .innerJoin(checkpoints, eq(checkpoints.id, checkpointObservations.checkpointId))
    .innerJoin(raceRuns, eq(raceRuns.id, req.params.raceRunId))
    .where(eq(checkpoints.eventId, raceRuns.categoryId)) // TODO: fix join logic - see note
  return { data: rows }
})
```

**Note:** The join above needs refinement. The cleanest approach: get the event_id from the race run via category, then query observations for all checkpoints in that event. Update this route to do two queries:

```js
fastify.get('/races/:raceRunId/checkpoint-observations', async (req, reply) => {
  const { eq, inArray } = await import('drizzle-orm')

  // Get event_id via raceRun → category
  const [run] = await db.select({ categoryId: raceRuns.categoryId })
    .from(raceRuns).where(eq(raceRuns.id, req.params.raceRunId))
  if (!run) return reply.code(404).send({ error: 'race run not found' })

  const [cat] = await db.select({ eventId: categories.eventId })
    .from(categories).where(eq(categories.id, run.categoryId))
  if (!cat) return reply.code(404).send({ error: 'category not found' })

  const cps = await db.select({ id: checkpoints.id })
    .from(checkpoints).where(eq(checkpoints.eventId, cat.eventId))

  if (!cps.length) return { data: [] }

  const rows = await db.select()
    .from(checkpointObservations)
    .where(inArray(checkpointObservations.checkpointId, cps.map(c => c.id)))
    .orderBy(checkpointObservations.observedAt)

  return { data: rows }
})
```

This route needs `raceRuns` and `categories` imported in `checkpoints.js` — add those imports.

### Step 2: Subscribe to checkpoint:observation WebSocket event

In `CategoryResults.jsx`, add:

```js
useWsEvent('checkpoint:observation', () => {
  qc.invalidateQueries({ queryKey: ['checkpoint-observations', run?.id] })
})
```

### Step 3: Replace the podium rendering

Replace the existing podium section and `PodiumBox` function with the shared component.

The `finished` and `podium` computation changes to use `estimatePositions`:

```js
const enrichedResults = estimatePositions(results, checkpointsData, observationsData)
const top3 = enrichedResults.slice(0, 3)
const podiumAnimals = getPodiumAnimals(top3.map(r => r.participant))
```

Replace the podium JSX:
```jsx
{top3.length > 0 && (
  <div className="mb-10">
    <div className="font-display text-2xl tracking-widest uppercase text-apex-muted text-center mb-6">Podium</div>
    <Podium top3={top3} animals={podiumAnimals} formatDuration={formatDuration} />
  </div>
)}
```

### Step 4: Add checkpoint tracking table below the leaderboard

After the existing leaderboard section, add:

```jsx
{checkpointsData.length > 0 && (
  <div className="mt-8">
    <div className="font-display text-xl tracking-widest uppercase text-apex-muted mb-3">Tracking na żywo</div>
    <CheckpointTrackingTable
      results={enrichedResults}
      checkpoints={checkpointsData}
      observations={observationsData}
      formatTime={(iso) => new Date(iso).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
    />
  </div>
)}
```

### Step 5: Delete the old PodiumBox function from CategoryResults.jsx

Remove the `function PodiumBox(...)` at the bottom — it's replaced by the shared component.

### Step 6: Commit

```bash
git add frontend/src/pages/CategoryResults.jsx frontend/src/lib/api.js backend/src/routes/checkpoints.js
git commit -m "feat: live checkpoint tracking + enhanced podium in CategoryResults"
```

---

## Task 13: volunteer app — project setup

**Files:**
- Create: `volunteer/` (new Vite project)

### Step 1: Scaffold the project

```bash
cd volunteer
# Create manually — do not use npm create as it runs interactively
```

Create `volunteer/package.json`:

```json
{
  "name": "leszyrun-volunteer",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite --port 5174",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@supabase/supabase-js": "^2.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.0.0",
    "vite": "^6.0.0"
  }
}
```

Create `volunteer/vite.config.js`:

```js
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
})
```

Create `volunteer/index.html`:

```html
<!DOCTYPE html>
<html lang="pl">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no" />
    <title>LeszyRun — Wolontariusz</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
```

Create `volunteer/.env.example`:

```
VITE_SUPABASE_URL=https://<your-supabase-project-id>.supabase.co
VITE_SUPABASE_ANON_KEY=your_anon_key_here
```

Create `volunteer/.env.local` (gitignored — add to .gitignore):

```
VITE_SUPABASE_URL=https://<your-supabase-project-id>.supabase.co
VITE_SUPABASE_ANON_KEY=<actual anon key from Supabase dashboard>
```

Run in `volunteer/`:
```bash
npm install
```

### Step 2: Commit scaffold

```bash
git add volunteer/
git commit -m "chore: volunteer app scaffold (Vite + React + Supabase)"
```

---

## Task 14: volunteer app — main application

**Files:**
- Create: `volunteer/src/main.jsx`
- Create: `volunteer/src/App.jsx`
- Create: `volunteer/src/index.css`
- Create: `volunteer/src/lib/supabase.js`

### Step 1: Supabase client

```js
// volunteer/src/lib/supabase.js
import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
)
```

### Step 2: main.jsx

```jsx
// volunteer/src/main.jsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode><App /></StrictMode>
)
```

### Step 3: CSS — mobile-first full-screen dark

```css
/* volunteer/src/index.css */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: system-ui, -apple-system, sans-serif;
  background: #0A0A10;
  color: #C4C2D8;
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
}

#root { display: flex; flex-direction: column; min-height: 100dvh; }

input[type="number"] {
  -moz-appearance: textfield;
  appearance: textfield;
}
input[type="number"]::-webkit-outer-spin-button,
input[type="number"]::-webkit-inner-spin-button { -webkit-appearance: none; }
```

### Step 4: App.jsx — full application

```jsx
// volunteer/src/App.jsx
import { useState, useEffect, useRef } from 'react'
import { supabase } from './lib/supabase.js'

export default function App() {
  const checkpointId = new URLSearchParams(window.location.search).get('checkpoint')

  const [checkpoint, setCheckpoint] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [screen, setScreen] = useState('input') // 'input' | 'confirm'
  const [bib, setBib] = useState('')
  const [pendingBib, setPendingBib] = useState(null)
  const [flash, setFlash] = useState(null) // 'sent' | null
  const inputRef = useRef(null)

  // Load checkpoint info on mount
  useEffect(() => {
    if (!checkpointId) { setLoadError('Brak ID punktu kontrolnego w URL.'); return }

    supabase.from('checkpoints').select('id, name, km_marker').eq('id', checkpointId).single()
      .then(({ data, error }) => {
        if (error || !data) { setLoadError('Nie znaleziono punktu kontrolnego.'); return }
        setCheckpoint(data)
      })
  }, [checkpointId])

  // Focus input whenever we're on input screen
  useEffect(() => {
    if (screen === 'input') inputRef.current?.focus()
  }, [screen])

  const handleSubmit = (e) => {
    e?.preventDefault()
    const n = parseInt(bib, 10)
    if (!n || n < 1) return
    setPendingBib(n)
    setBib('')
    setScreen('confirm')
  }

  const handleConfirm = () => {
    // Fire-and-forget — do NOT await, do NOT block UI
    supabase.from('checkpoint_observations').upsert({
      checkpoint_id: checkpointId,
      bib_number: pendingBib,
      observed_at: new Date().toISOString(),
    }, { onConflict: 'checkpoint_id,bib_number', ignoreDuplicates: true })
    // ignore result entirely — network errors are silent

    setPendingBib(null)
    setScreen('input')
    setFlash('sent')
    setTimeout(() => setFlash(null), 1200)
  }

  const handleBack = () => {
    setBib(String(pendingBib))
    setPendingBib(null)
    setScreen('input')
  }

  if (loadError) return <ErrorScreen message={loadError} />
  if (!checkpoint) return <LoadingScreen />

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100dvh', padding: '24px 20px' }}>
      {/* Header */}
      <div style={{ marginBottom: 32, textAlign: 'center' }}>
        <div style={{ fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.15em', color: '#545268', marginBottom: 6 }}>
          Punkt kontrolny
        </div>
        <div style={{ fontSize: 26, fontWeight: 700, color: '#C4C2D8', lineHeight: 1.2 }}>
          {checkpoint.name}
          {checkpoint.km_marker && <span style={{ color: '#545268', fontSize: 18 }}> · km {checkpoint.km_marker}</span>}
        </div>
      </div>

      {/* Flash */}
      {flash === 'sent' && (
        <div style={{ background: '#1a2e0a', border: '1px solid #4a7c10', color: '#a0d040',
          padding: '10px 16px', textAlign: 'center', fontSize: 14, marginBottom: 20, letterSpacing: '0.1em' }}>
          ✓ Wysłano
        </div>
      )}

      {/* Input screen */}
      {screen === 'input' && (
        <form onSubmit={handleSubmit} style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <label style={{ display: 'block' }}>
            <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.15em', color: '#545268', marginBottom: 10 }}>
              Numer startowy
            </div>
            <input
              ref={inputRef}
              type="number"
              inputMode="numeric"
              pattern="[0-9]*"
              value={bib}
              onChange={e => setBib(e.target.value)}
              placeholder="0"
              style={{
                width: '100%', fontSize: 72, fontWeight: 700, fontVariantNumeric: 'tabular-nums',
                background: 'transparent', border: 'none', borderBottom: '3px solid #BBDD00',
                color: '#C4C2D8', padding: '8px 0', textAlign: 'center', outline: 'none',
                lineHeight: 1,
              }}
            />
          </label>
          <button
            type="submit"
            disabled={!bib || parseInt(bib) < 1}
            style={{
              marginTop: 'auto', width: '100%', padding: '18px', fontSize: 18, fontWeight: 700,
              textTransform: 'uppercase', letterSpacing: '0.1em',
              background: bib && parseInt(bib) >= 1 ? '#BBDD00' : '#1C1C2A',
              color: bib && parseInt(bib) >= 1 ? '#0A0A10' : '#545268',
              border: 'none', cursor: bib ? 'pointer' : 'default',
              transition: 'all 0.15s',
            }}
          >
            Dalej →
          </button>
        </form>
      )}

      {/* Confirm screen */}
      {screen === 'confirm' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 24 }}>
          <div style={{ fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.15em', color: '#545268', marginTop: 16 }}>
            Potwierdź numer
          </div>
          <div style={{ fontSize: 120, fontWeight: 700, color: '#BBDD00', lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
            #{pendingBib}
          </div>
          <div style={{ display: 'flex', gap: 12, width: '100%', marginTop: 'auto' }}>
            <button
              onClick={handleBack}
              style={{
                flex: 1, padding: '18px', fontSize: 16, fontWeight: 700,
                background: 'transparent', border: '2px solid #1C1C2A', color: '#545268',
                cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.1em',
              }}
            >
              ← Popraw
            </button>
            <button
              onClick={handleConfirm}
              style={{
                flex: 2, padding: '18px', fontSize: 18, fontWeight: 700,
                background: '#BBDD00', color: '#0A0A10', border: 'none',
                cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.1em',
              }}
            >
              ✓ Wyślij
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function LoadingScreen() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100dvh', color: '#545268' }}>
      Ładowanie...
    </div>
  )
}

function ErrorScreen({ message }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100dvh',
      flexDirection: 'column', gap: 12, padding: 24, textAlign: 'center' }}>
      <div style={{ fontSize: 32 }}>⚠️</div>
      <div style={{ color: '#E53030', fontSize: 16 }}>{message}</div>
    </div>
  )
}
```

### Step 5: Test the volunteer app

```bash
cd volunteer && npm run dev
```

Open `http://localhost:5174?checkpoint=<valid-checkpoint-uuid>` (get a real UUID from your DB).

Verify:
- Checkpoint name loads
- Input screen shows with number field
- Submitting a number shows confirm screen with the number large
- Confirming clears the screen immediately (fire-and-forget)
- "Sent ✓" flash appears for ~1 second
- Second submit of the same bib_number silently does nothing (dedup)

### Step 6: Commit

```bash
git add volunteer/
git commit -m "feat: volunteer app — mobile bib entry with fire-and-forget Supabase submit"
```

---

## Task 15: liveresults app — project setup

**Files:**
- Create: `liveresults/` (new Vite project)

### Step 1: Create package.json

```json
{
  "name": "leszyrun-liveresults",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite --port 5175",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@leszyrun/ui": "file:../packages/ui",
    "@supabase/supabase-js": "^2.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-router-dom": "^7.0.0"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.0.0",
    "tailwindcss": "^4.0.0",
    "@tailwindcss/vite": "^4.0.0",
    "vite": "^6.0.0"
  }
}
```

Create `liveresults/vite.config.js`:

```js
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
})
```

Create `liveresults/index.html`:

```html
<!DOCTYPE html>
<html lang="pl">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>LeszyRun — Live Results</title>
    <link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;800&family=Rajdhani:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet">
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
```

Create `liveresults/.env.example`:

```
VITE_SUPABASE_URL=https://<your-supabase-project-id>.supabase.co
VITE_SUPABASE_ANON_KEY=your_anon_key_here
```

Create `liveresults/.env.local` (gitignored):

```
VITE_SUPABASE_URL=https://<your-supabase-project-id>.supabase.co
VITE_SUPABASE_ANON_KEY=<actual anon key>
```

Add `liveresults/.env.local` to root `.gitignore` (or `liveresults/.gitignore`).

Run:
```bash
cd liveresults && npm install
```

### Step 2: Commit scaffold

```bash
git add liveresults/
git commit -m "chore: liveresults app scaffold"
```

---

## Task 16: liveresults app — CSS and shared tokens

**Files:**
- Create: `liveresults/src/index.css`

The CSS must define the same apex-* tokens as `frontend/src/index.css` so the shared `@leszyrun/ui` components render correctly.

### Step 1: Create index.css

Copy the `@theme` block and body styles from `frontend/src/index.css` verbatim. Then add the `@source` directive for the UI library:

```css
@import "tailwindcss";
@source "../../packages/ui/src";

@theme {
  /* --- paste entire @theme block from frontend/src/index.css --- */
  --font-sans: 'Rajdhani', sans-serif;
  --font-display: 'Barlow Condensed', sans-serif;
  --font-mono: 'IBM Plex Mono', monospace;

  --color-terrain-green: #BBDD00;
  --color-terrain-slate: #9896B4;
  --color-apex-bg: #0A0A10;
  --color-apex-surface: #10101A;
  --color-apex-surface-2: #161622;
  --color-apex-surface-3: #1C1C2A;
  --color-apex-border: #1C1C2A;
  --color-apex-border-mid: #262638;
  --color-apex-border-bright: #343450;
  --color-apex-yellow: #BBDD00;
  --color-apex-yellow-bright: #D4FF00;
  --color-apex-yellow-dim: #778800;
  --color-apex-red: #E53030;
  --color-apex-red-dim: #5C0A0A;
  --color-apex-cyan: #00BFEF;
  --color-apex-cyan-dim: #004458;
  --color-apex-text: #9896B4;
  --color-apex-text-bright: #C4C2D8;
  --color-apex-muted: #545268;
  --color-apex-dim: #2C2A38;
  /* add remaining tokens from frontend/src/index.css */
}

*, *::before, *::after { box-sizing: border-box; }

body {
  font-family: 'Rajdhani', sans-serif;
  font-weight: 500;
  background-color: #0A0A10;
  color: #9896B4;
  margin: 0;
  min-height: 100vh;
}
```

### Step 2: Commit

```bash
git add liveresults/src/index.css
git commit -m "chore: liveresults CSS with apex tokens + packages/ui source scan"
```

---

## Task 17: liveresults app — Supabase client + routing

**Files:**
- Create: `liveresults/src/main.jsx`
- Create: `liveresults/src/lib/supabase.js`
- Create: `liveresults/src/App.jsx`

### Step 1: Supabase client

```js
// liveresults/src/lib/supabase.js
import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
)
```

### Step 2: main.jsx

```jsx
// liveresults/src/main.jsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>
)
```

### Step 3: App.jsx with routes

```jsx
// liveresults/src/App.jsx
import { Routes, Route, Navigate } from 'react-router-dom'
import EventsPage from './pages/Events.jsx'
import EventPage from './pages/Event.jsx'
import CategoryPage from './pages/Category.jsx'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<EventsPage />} />
      <Route path="/events/:eventId" element={<EventPage />} />
      <Route path="/events/:eventId/:categoryId" element={<CategoryPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
```

### Step 4: Commit

```bash
git add liveresults/src/
git commit -m "chore: liveresults routing + Supabase client"
```

---

## Task 18: liveresults app — pages

**Files:**
- Create: `liveresults/src/pages/Events.jsx`
- Create: `liveresults/src/pages/Event.jsx`
- Create: `liveresults/src/pages/Category.jsx`

### Step 1: Events.jsx — list all events

```jsx
// liveresults/src/pages/Events.jsx
import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase.js'

export default function EventsPage() {
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.from('events').select('id, name, date, location').order('date', { ascending: false })
      .then(({ data }) => { setEvents(data || []); setLoading(false) })
  }, [])

  return (
    <div className="max-w-2xl mx-auto px-6 py-10">
      <h1 className="font-display text-5xl uppercase tracking-widest text-apex-text-bright mb-8">Wyniki</h1>
      {loading && <div className="text-apex-muted">Ładowanie...</div>}
      <div className="space-y-2">
        {events.map(ev => (
          <Link key={ev.id} to={`/events/${ev.id}`}
            className="block border border-apex-border bg-apex-surface px-5 py-4 hover:bg-apex-surface-2 transition-colors">
            <div className="font-semibold text-apex-text-bright">{ev.name}</div>
            <div className="text-xs text-apex-muted mt-1">{ev.date} {ev.location && `· ${ev.location}`}</div>
          </Link>
        ))}
      </div>
    </div>
  )
}
```

### Step 2: Event.jsx — list categories

```jsx
// liveresults/src/pages/Event.jsx
import { useState, useEffect } from 'react'
import { Link, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase.js'

export default function EventPage() {
  const { eventId } = useParams()
  const [event, setEvent] = useState(null)
  const [categories, setCategories] = useState([])

  useEffect(() => {
    supabase.from('events').select('id, name, date, location').eq('id', eventId).single()
      .then(({ data }) => setEvent(data))

    supabase.from('categories').select('id, name, distance_meters').eq('event_id', eventId)
      .then(({ data }) => setCategories(data || []))
  }, [eventId])

  return (
    <div className="max-w-2xl mx-auto px-6 py-10">
      <Link to="/" className="text-xs text-apex-muted uppercase tracking-wider hover:text-apex-text mb-6 inline-block">← Wszystkie eventy</Link>
      <h1 className="font-display text-4xl uppercase tracking-widest text-apex-text-bright mb-2">{event?.name}</h1>
      {event?.date && <div className="text-apex-muted text-sm mb-8">{event.date} {event.location && `· ${event.location}`}</div>}
      <div className="space-y-2">
        {categories.map(cat => (
          <Link key={cat.id} to={`/events/${eventId}/${cat.id}`}
            className="block border border-apex-border bg-apex-surface px-5 py-4 hover:bg-apex-surface-2 transition-colors">
            <div className="font-semibold text-apex-text-bright">{cat.name}</div>
            {cat.distance_meters && <div className="text-xs text-apex-muted mt-0.5">{(cat.distance_meters / 1000).toFixed(1)} km</div>}
          </Link>
        ))}
      </div>
    </div>
  )
}
```

### Step 3: Category.jsx — live podium + tracking (the main page)

```jsx
// liveresults/src/pages/Category.jsx
import { useState, useEffect, useCallback } from 'react'
import { Link, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase.js'
import { Podium, CheckpointTrackingTable, estimatePositions } from '@leszyrun/ui'

const ANIMAL_POOL = ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🦄','🐝','🦋','🐢','🦎','🦖','🐙','🦑','🦐','🦞','🦀','🐡','🐠','🐟','🦈','🐬','🐳','🦭','🦜','🦚','🦩','🦢','🦔','🐿️','🦦','🦥','🦨','🦡','🐓','🦃']

function getPodiumAnimals(participants) {
  return participants.map(p => {
    if (!p?.id) return '🏃'
    let hash = 0
    for (let i = 0; i < p.id.length; i++) hash = ((hash << 5) - hash) + p.id.charCodeAt(i)
    const shuffled = [...ANIMAL_POOL].sort((a, b) => {
      const seed = Math.abs(hash)
      return (seed * ANIMAL_POOL.indexOf(a)) % ANIMAL_POOL.length - (seed * ANIMAL_POOL.indexOf(b)) % ANIMAL_POOL.length
    })
    return shuffled[0]
  })
}

function formatDuration(ms) {
  if (!ms) return '—'
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
  return `${m}:${String(sec).padStart(2,'0')}`
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export default function CategoryPage() {
  const { eventId, categoryId } = useParams()
  const [category, setCategory] = useState(null)
  const [raceRun, setRaceRun] = useState(null)
  const [results, setResults] = useState([])
  const [participants, setParticipants] = useState([])
  const [checkpoints, setCheckpoints] = useState([])
  const [observations, setObservations] = useState([])

  const loadData = useCallback(async () => {
    const [catRes, runRes, cpRes] = await Promise.all([
      supabase.from('categories').select('id, name, distance_meters').eq('id', categoryId).single(),
      supabase.from('race_runs').select('id, started_at, status').eq('category_id', categoryId)
        .in('status', ['active', 'finished']).order('created_at', { ascending: false }).limit(1).single(),
      supabase.from('checkpoints').select('id, name, km_marker')
        .eq('event_id', eventId).order('km_marker'),
    ])

    if (catRes.data) setCategory(catRes.data)
    if (cpRes.data) setCheckpoints(cpRes.data)

    const run = runRes.data
    if (!run) return
    setRaceRun(run)

    const [resultRows, participantRows] = await Promise.all([
      supabase.from('results').select('id, race_run_id, participant_id, start_time, finish_time, duration_ms, gun_duration_ms, status').eq('race_run_id', run.id),
      supabase.from('participants').select('id, bib_number, first_name, last_name, club, category_id').eq('category_id', categoryId),
    ])

    const pMap = Object.fromEntries((participantRows.data || []).map(p => [p.id, {
      ...p, firstName: p.first_name, lastName: p.last_name, bibNumber: p.bib_number,
    }]))

    const enrichedResults = (resultRows.data || []).map(r => ({
      ...r,
      participantId: r.participant_id,
      startTime: r.start_time,
      finishTime: r.finish_time,
      durationMs: r.duration_ms,
      gunDurationMs: r.gun_duration_ms,
      participant: pMap[r.participant_id],
    }))

    setResults(enrichedResults)
    setParticipants(participantRows.data || [])

    if (cpRes.data?.length) {
      const cpIds = cpRes.data.map(c => c.id)
      const { data: obsData } = await supabase.from('checkpoint_observations')
        .select('id, checkpoint_id, participant_id, bib_number, observed_at')
        .in('checkpoint_id', cpIds)
      setObservations((obsData || []).map(o => ({ ...o, checkpointId: o.checkpoint_id, participantId: o.participant_id, observedAt: o.observed_at })))
    }
  }, [eventId, categoryId])

  useEffect(() => { loadData() }, [loadData])

  // Supabase Realtime subscriptions
  useEffect(() => {
    if (!raceRun?.id) return

    const channel = supabase.channel(`liveresults-${categoryId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'results',
        filter: `race_run_id=eq.${raceRun.id}` }, () => loadData())
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'checkpoint_observations' },
        (payload) => {
          const obs = payload.new
          setObservations(prev => {
            const exists = prev.some(o => o.id === obs.id)
            if (exists) return prev
            return [...prev, {
              id: obs.id,
              checkpointId: obs.checkpoint_id,
              participantId: obs.participant_id,
              bibNumber: obs.bib_number,
              observedAt: obs.observed_at,
            }]
          })
        })
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [raceRun?.id, categoryId, loadData])

  const enrichedResults = estimatePositions(results, checkpoints, observations)
  const top3 = enrichedResults.slice(0, 3)
  const animals = getPodiumAnimals(top3.map(r => r.participant))

  return (
    <div className="min-h-screen bg-terrain-slate text-white relative overflow-hidden">
      <div className="absolute inset-0 opacity-5 pointer-events-none" style={{
        backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E")`
      }} />
      <div className="relative z-10 max-w-3xl mx-auto px-6 py-10">
        <Link to={`/events/${eventId}`} className="text-xs text-apex-muted uppercase tracking-wider hover:text-apex-text mb-6 inline-block">← Kategorie</Link>

        <div className="text-center mb-10">
          <div className="font-display text-5xl tracking-widest uppercase text-white mb-1">{category?.name || '—'}</div>
          {raceRun?.started_at && (
            <div className="text-apex-muted text-sm">Start {formatTime(raceRun.started_at)}</div>
          )}
        </div>

        {top3.length > 0 && (
          <div className="mb-10">
            <div className="font-display text-2xl tracking-widest uppercase text-apex-muted text-center mb-6">Podium</div>
            <Podium top3={top3} animals={animals} formatDuration={formatDuration} />
          </div>
        )}

        {enrichedResults.length > 0 && checkpoints.length > 0 && (
          <div className="mb-8">
            <div className="font-display text-xl tracking-widest uppercase text-apex-muted mb-3">Tracking na żywo</div>
            <CheckpointTrackingTable
              results={enrichedResults}
              checkpoints={checkpoints}
              observations={observations}
              formatTime={formatTime}
            />
          </div>
        )}

        {!raceRun && (
          <div className="text-center py-12 text-apex-muted">
            <div className="font-display text-4xl uppercase tracking-widest mb-2">Oczekiwanie</div>
            <div className="text-sm">Wyścig jeszcze nie wystartował. Ta strona aktualizuje się automatycznie.</div>
          </div>
        )}
      </div>
    </div>
  )
}
```

### Step 4: Test liveresults app

```bash
cd liveresults && npm run dev
```

Open `http://localhost:5175`. Navigate to an event → category. Verify:
- Event and category list loads from Supabase
- Podium renders using shared `@leszyrun/ui` Podium component
- Checkpoint tracking table appears when checkpoints are configured
- Realtime: submit an observation via volunteer app → liveresults updates within ~1s

### Step 5: Commit

```bash
git add liveresults/
git commit -m "feat: liveresults app with live Supabase Realtime podium + checkpoint tracking"
```

---

## Task 19: Update root .gitignore and VITE_VOLUNTEER_URL env var

**Files:**
- Modify: `.gitignore` (root)
- Modify: `frontend/.env` or `docker-compose.yml`

### Step 1: Add .env.local files to .gitignore

```bash
# Add to root .gitignore:
volunteer/.env.local
liveresults/.env.local
```

### Step 2: Add VITE_VOLUNTEER_URL to frontend env

In `docker-compose.yml`, under the frontend service environment, add:
```
VITE_VOLUNTEER_URL=http://localhost:5174
```

Or in `frontend/.env.local`:
```
VITE_VOLUNTEER_URL=http://localhost:5174
```

This is the URL shown in the EventDetail Checkpoints tab for the volunteer links.

### Step 3: Commit

```bash
git add .gitignore docker-compose.yml
git commit -m "chore: gitignore .env.local files, add VITE_VOLUNTEER_URL"
```

---

## Task 20: End-to-end smoke test

### Full flow to verify

1. Start everything: `docker compose up` + Mosquitto
2. Open LeszyRun at http://localhost:3000
3. Create an event, add a category, add participants
4. Go to EventDetail → Checkpoints tab → create a checkpoint at "Km 5", assign the category
5. Copy the volunteer URL
6. Open `http://localhost:5174?checkpoint=<uuid>` — confirm checkpoint name loads
7. Enter bib number `1`, confirm → "Sent ✓" flash
8. In LeszyRun backend logs: `[Sync] Realtime checkpoint_observation: bib 1`
9. Open liveresults at http://localhost:5175 → navigate to the category
10. Confirm the checkpoint tracking table shows the observation
11. Start a race in LeszyRun → simulate RFID crossings
12. Verify liveresults podium updates live as results arrive via Realtime

---

## Task 21: Update docs and memory

**Files:**
- Modify: `ARCHITECTURE.md` (add new apps + tables to the overview)
- Modify: `docs/plans/2026-03-12-bidirectional-sync-checkpoints-design.md` (mark as implemented)

### Step 1: Update ARCHITECTURE.md

Add to the System Architecture section:
- `volunteer/` — mobile bib entry app (Vite + React, writes to Supabase anon)
- `liveresults/` — public live results (Vite + React, Supabase Realtime)
- `packages/ui` — shared component library

Add new tables to the schema section (checkpoints, checkpoint_categories, checkpoint_observations).

Add Realtime subscription description to the Supabase Sync section.

### Step 2: Commit

```bash
git add ARCHITECTURE.md
git commit -m "docs: update ARCHITECTURE.md with new apps, tables, Realtime subscriptions"
```

---

## Final: push branch and open PR

```bash
git push -u origin feat/checkpoints-live-results
gh pr create --title "feat: checkpoints, volunteer app, liveresults, bidirectional sync" \
  --body "Implements design from docs/plans/2026-03-12-bidirectional-sync-checkpoints-design.md"
```
