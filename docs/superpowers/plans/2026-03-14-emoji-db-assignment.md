# Emoji DB Assignment Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Assign each participant a unique (per-event) animal emoji at registration time, persist it to the database, and display it consistently across all apps instead of computing it dynamically on each page load.

**Architecture:** Add an `emoji` text column to the `participants` table. A backend utility picks an emoji from a curated pool that isn't already taken in the same event. The assignment happens in the two creation paths (single POST and CSV import). All frontends (admin, liveresults) read `participant.emoji` from the API/Supabase instead of calling the client-side hash functions.

**Tech Stack:** Drizzle ORM, Fastify, React + TanStack Query, Supabase (for liveresults)

---

## Chunk 1: Backend — emoji column + assignment utility

### Task 1: DB migration + Drizzle schema

**Files:**
- Create: `backend/src/db/migrations/0011_participant_emoji.sql`
- Modify: `backend/src/db/migrations/meta/_journal.json`
- Modify: `backend/src/db/schema.js`

- [ ] **Step 1: Create the migration SQL**

```sql
ALTER TABLE participants ADD COLUMN IF NOT EXISTS emoji text;
```

Save to `backend/src/db/migrations/0011_participant_emoji.sql`.

- [ ] **Step 2: Register migration in journal**

In `backend/src/db/migrations/meta/_journal.json`, add after the last entry (idx 10):

```json
{
  "idx": 11,
  "version": "7",
  "when": 1741996800000,
  "tag": "0011_participant_emoji",
  "breakpoints": true
}
```

- [ ] **Step 3: Add emoji field to Drizzle schema**

In `backend/src/db/schema.js`, add `emoji` to the `participants` table definition (after `rfidEpc`):

```js
emoji: text('emoji'),
```

- [ ] **Step 4: Rebuild Docker image to apply migration**

```bash
docker compose build backend
docker compose up -d
```

Expected: backend logs "Migrations complete" with 0011 applied.

---

### Task 2: Emoji utility module

**Files:**
- Create: `backend/src/lib/emoji.js`

- [ ] **Step 1: Create the utility**

```js
// Curated pool of visually distinct animal emojis (50 entries)
const POOL = [
  '🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯',
  '🦁','🐮','🐷','🐸','🐵','🦄','🐝','🦋','🐢','🦎',
  '🐙','🦑','🦀','🐡','🐠','🐟','🦈','🐬','🦭','🦜',
  '🦚','🦩','🦢','🦔','🐿️','🦦','🦥','🦨','🦡','🐓',
  '🦃','🐕','🐈','🐅','🐆','🦓','🦍','🐘','🦒','🦘',
]

/**
 * Pick an emoji for a new participant in an event.
 * Prefers one not already used by other participants in the same event.
 * Falls back to a random pool entry if all are taken.
 *
 * @param {string[]} usedEmojis - emojis already assigned in this event
 * @returns {string}
 */
export function pickEmoji(usedEmojis) {
  const usedSet = new Set(usedEmojis)
  const available = POOL.filter(e => !usedSet.has(e))
  const source = available.length > 0 ? available : POOL
  return source[Math.floor(Math.random() * source.length)]
}
```

- [ ] **Step 2: Verify the file exists**

```bash
cat backend/src/lib/emoji.js
```

---

**Design decision:** `emoji` is **not added** to the PATCH `/participants/:id` allowed-fields list. It is assigned once at creation and treated as immutable via the API. If a specific participant needs a different emoji, delete and re-create them.

---

### Task 3: Assign emoji in single participant creation

**Files:**
- Modify: `backend/src/routes/participants.js`

- [ ] **Step 1: Import pickEmoji and add a helper to fetch used emojis**

At the top of `backend/src/routes/participants.js`, add:

```js
import { pickEmoji } from '../lib/emoji.js'
```

Add a helper function at the bottom of the file (alongside `nextBibNumber`):

```js
async function usedEmojis(db, eventId) {
  const rows = await db
    .select({ emoji: participants.emoji })
    .from(participants)
    .where(eq(participants.eventId, eventId))
  return rows.map(r => r.emoji).filter(Boolean)
}
```

- [ ] **Step 2: Use pickEmoji in the POST /events/:eventId/participants handler**

In the `fastify.post('/events/:eventId/participants', ...)` handler, after `nextBibNumber` is called, add emoji assignment:

```js
const [nextBib, existingEmojis] = await Promise.all([
  nextBibNumber(db, req.params.eventId),
  usedEmojis(db, req.params.eventId),
])
const emoji = pickEmoji(existingEmojis)
```

Then add `emoji` to the `.values(...)` call:

```js
const [row] = await db.insert(participants).values({
  eventId: req.params.eventId,
  firstName, lastName, email, gender, birthYear, club,
  categoryId: categoryId || null,
  bibNumber: nextBib,
  emoji,
}).returning()
```

Note: the original code fetches `nextBib` alone — replace the `nextBib` fetch with the `Promise.all` above.

---

### Task 4: Assign emoji in CSV import

**Files:**
- Modify: `backend/src/routes/participants.js`

- [ ] **Step 1: Fetch used emojis once before the import loop**

In the `fastify.post('/events/:eventId/import/participants', ...)` handler, after `catMap` is built, add:

```js
const existingEmojis = await usedEmojis(db, req.params.eventId)
const assignedInThisImport = []
```

- [ ] **Step 2: Assign emoji for each new participant in the loop**

In the `else` branch (new participant insert), before `db.insert(...)`, add:

```js
const emoji = pickEmoji([...existingEmojis, ...assignedInThisImport])
assignedInThisImport.push(emoji)
```

Then add `emoji` to the `.values(...)` call:

```js
await db.insert(participants).values({
  eventId: req.params.eventId,
  firstName: row.first_name,
  lastName: row.last_name,
  email: row.email || null,
  gender: row.gender || null,
  birthYear: row.birth_year ? parseInt(row.birth_year) : null,
  club: row.club || null,
  categoryId,
  bibNumber: nextBib,
  emoji,
})
```

- [ ] **Step 3: Restart backend and smoke test**

```bash
docker compose restart backend
```

Create one participant via the admin UI. Verify the API response includes an `emoji` field:

```bash
curl -s http://localhost:3001/api/events/<eventId>/participants | jq '.data[0].emoji'
```

Expected: a single emoji character like `"🦊"`.

- [ ] **Step 4: Commit**

```bash
git add backend/src/db/migrations/0011_participant_emoji.sql \
        backend/src/db/migrations/meta/_journal.json \
        backend/src/db/schema.js \
        backend/src/lib/emoji.js \
        backend/src/routes/participants.js
git commit -m "feat(backend): persist emoji assignment to participants table at registration"
```

---

## Chunk 2: Supabase schema

### Task 5: Add emoji column to Supabase participants table

The sync worker upserts all local columns (via `rowToSnake`) to Supabase. The `emoji` column must exist in Supabase for the liveresults app to read it.

**Files:** none (Supabase DDL via MCP tool)

- [ ] **Step 1: Apply migration to Supabase**

Use the `mcp__supabase__apply_migration` tool with:
- `project_id`: `<your-supabase-project-id>`
- `name`: `participant_emoji`
- `query`: `ALTER TABLE participants ADD COLUMN IF NOT EXISTS emoji text;`

- [ ] **Step 2: Verify column exists**

Use `mcp__supabase__execute_sql` with:
- `project_id`: `<your-supabase-project-id>`
- `query`: `SELECT column_name FROM information_schema.columns WHERE table_name = 'participants' AND column_name = 'emoji';`

Expected: one row returned.

- [ ] **Step 3: Backfill emojis for existing participants**

Existing participants have `emoji = null`. Run a one-time backfill via `mcp__supabase__execute_sql` — but since emojis must be unique-per-event this is easier done locally. After the migration runs, execute:

```bash
docker compose exec backend node -e "
import { createRequire } from 'module'
// Quick backfill via API — run after backend is up
const res = await fetch('http://localhost:3001/api/events')
// ... or just accept null fallback and let them re-register
"
```

**Simplest approach:** Accept `🏃` fallback for existing participants (emoji = null). Newly registered and imported participants get emojis immediately. This is documented as intentional — a one-time manual re-import or re-registration would backfill them if needed.

- [ ] **Step 4: Trigger sync cycle**

Wait up to 30 s for the next sync cycle, or restart backend to trigger the 5-second startup sync.

---

## Chunk 3: Frontend — admin (ParticipantsTable)

### Task 6: Display emoji in ParticipantsTable

**Files:**
- Modify: `frontend/src/components/ParticipantsTable/ParticipantsTable.jsx`

- [ ] **Step 1: Add emoji column header**

In the `<thead>` row, add `'Emoji'` to the header array:

```jsx
{['Emoji', 'Nr', 'Imię', 'Nazwisko', 'Email', 'Klub', 'Płeć', 'Rok', 'Kategoria', 'RFID', 'Z', ''].map(h => (
```

- [ ] **Step 2: Add emoji cell in each row**

In the `<tbody>` row, add before the `bibNumber` cell:

```jsx
<td className="px-2 py-1 w-10 text-center text-lg">{p.emoji || '🏃'}</td>
```

- [ ] **Step 3: Verify in browser**

Open the admin UI participants tab. Each row should show the stored emoji as the first column.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/ParticipantsTable/ParticipantsTable.jsx
git commit -m "feat(frontend): show persisted emoji in participants table"
```

---

## Chunk 4: Frontend — PodiumPage

### Task 7: Replace dynamic emoji computation with DB value

**Files:**
- Modify: `frontend/src/pages/PodiumPage.jsx`
- Modify: `frontend/src/lib/utils.js`

- [ ] **Step 1: Remove getPodiumAnimals from PodiumPage**

In `frontend/src/pages/PodiumPage.jsx`:

1. Remove `getPodiumAnimals` from the import on line 6:
   ```js
   import { formatDuration, cn } from '../lib/utils.js'
   ```

2. In `CategoryCard`, replace:
   ```js
   const podiumAnimals = getPodiumAnimals(top3.map(r => r.participant))
   ```
   with:
   ```js
   const podiumAnimals = top3.map(r => r.participant?.emoji || '🏃')
   ```

- [ ] **Step 2: Remove dead code from utils.js**

In `frontend/src/lib/utils.js`, delete:
- The `ANIMALS` array (lines 65–73)
- The `seededShuffle` function (lines 75–84)
- The `getParticipantAnimal` export (lines 86–89)
- The `getPodiumAnimals` export (lines 91–104)

- [ ] **Step 3: Verify podium still renders**

Open a race result page with finishers. Podium should show each participant's emoji from the DB.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/PodiumPage.jsx frontend/src/lib/utils.js
git commit -m "feat(frontend): read podium emojis from participant DB field, remove client-side hash"
```

---

## Chunk 5: Liveresults app

### Task 8: Replace dynamic emoji computation in CategorySection

**Files:**
- Modify: `liveresults/src/pages/CategorySection.jsx`

- [ ] **Step 1: Add emoji to the participants SELECT query**

In the `loadData` callback, find the Supabase query for participants (line 53):

```js
supabase.from('participants').select('id, bib_number, first_name, last_name, club, category_id').eq('category_id', categoryId),
```

Change to:

```js
supabase.from('participants').select('id, bib_number, first_name, last_name, club, category_id, emoji').eq('category_id', categoryId),
```

- [ ] **Step 2: Pass emoji through the participant map**

In the `pMap` construction (line 56), include `emoji`:

```js
const pMap = Object.fromEntries((participantRows.data || []).map(p => [p.id, {
  ...p, firstName: p.first_name, lastName: p.last_name, bibNumber: p.bib_number,
}]))
```

The `...p` spread already includes `emoji`, so no additional change needed here.

- [ ] **Step 3: Replace getPodiumAnimals call with direct emoji read**

Replace:

```js
const animals = getPodiumAnimals(top3.map(r => r.participant))
```

with:

```js
const animals = top3.map(r => r.participant?.emoji || '🏃')
```

- [ ] **Step 4: Remove getPodiumAnimals function and ANIMAL_POOL constant**

Delete lines 5–14 (the `ANIMAL_POOL` constant and `getPodiumAnimals` function).

- [ ] **Step 5: Verify liveresults app**

```bash
cd liveresults && npm run dev
```

Open a category page. Podium emojis should match what's shown in the admin UI.

- [ ] **Step 6: Commit**

```bash
git add liveresults/src/pages/CategorySection.jsx
git commit -m "feat(liveresults): read podium emojis from Supabase participant field"
```
