# SMS Check-in & Unified Public App — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add SMS-based pre-event check-in with QR codes and merge liveresults/volunteer into a unified `public/` app with slug-based event routing.

**Architecture:** Supabase-first for public check-in flows (self-service + admin QR scan). Backend handles SMS sending via SMSAPI. New `checkins` + `checkin_documents` tables in Supabase as source of truth, reverse-synced to local DB. New `event_documents` table for flexible N-document system. New `public/` app on Vercel replaces `liveresults/` and `volunteer/`.

**Tech Stack:** JavaScript (no TS), Fastify, Drizzle ORM, React + Vite, Supabase, SMSAPI.pl, Tailwind v4, qrcode.react, html5-qrcode

**Spec:** `docs/superpowers/specs/2026-03-17-sms-checkin-and-public-app-design.md`

---

## Chunk 1: Database Schema & Migration

### Task 1: Add new columns and tables to Drizzle schema

**Files:**
- Modify: `backend/src/db/schema.js`

- [ ] **Step 1: Add `slug` column to events table**

In `backend/src/db/schema.js`, add after `fallbackSeconds` (line 16):

```javascript
slug: text('slug').unique(),
```

Note: NOT `notNull()` yet — existing events don't have slugs. Migration will generate slugs for existing rows, then a follow-up migration adds the NOT NULL constraint.

- [ ] **Step 2: Add `phone` and `smsSentAt` columns to participants table**

In `backend/src/db/schema.js`, add after `emoji` (line 45):

```javascript
phone: text('phone'),
smsSentAt: timestamp('sms_sent_at', { withTimezone: true }),
```

- [ ] **Step 3: Add `eventDocuments` table definition**

After `checkpointObservations` table (line 158), add:

```javascript
export const eventDocuments = pgTable('event_documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  eventId: uuid('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  type: text('type').notNull(),           // 'acknowledge' | 'provide'
  url: text('url'),
  requiredFor: text('required_for').notNull().default('all'),  // 'all' | 'minors'
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
  syncedAt: timestamp('synced_at', { withTimezone: true }),
})
```

- [ ] **Step 4: Add `checkins` table definition**

```javascript
export const checkins = pgTable('checkins', {
  id: uuid('id').primaryKey().defaultRandom(),
  participantId: uuid('participant_id').notNull().unique().references(() => participants.id, { onDelete: 'cascade' }),
  eventId: uuid('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  checkedInAt: timestamp('checked_in_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
  syncedAt: timestamp('synced_at', { withTimezone: true }),
})
```

- [ ] **Step 5: Add `checkinDocuments` table definition**

```javascript
export const checkinDocuments = pgTable('checkin_documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  checkinId: uuid('checkin_id').notNull().references(() => checkins.id, { onDelete: 'cascade' }),
  documentId: uuid('document_id').notNull().references(() => eventDocuments.id, { onDelete: 'cascade' }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  completedBy: text('completed_by'),    // 'participant' | 'admin'
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
  syncedAt: timestamp('synced_at', { withTimezone: true }),
})
```

- [ ] **Step 6: Add relations for new tables**

After `checkpointObservationsRelations` (line 217), add:

```javascript
export const eventDocumentsRelations = relations(eventDocuments, ({ one }) => ({
  event: one(events, { fields: [eventDocuments.eventId], references: [events.id] }),
}))

export const checkinsRelations = relations(checkins, ({ one, many }) => ({
  participant: one(participants, { fields: [checkins.participantId], references: [participants.id] }),
  event: one(events, { fields: [checkins.eventId], references: [events.id] }),
  documents: many(checkinDocuments),
}))

export const checkinDocumentsRelations = relations(checkinDocuments, ({ one }) => ({
  checkin: one(checkins, { fields: [checkinDocuments.checkinId], references: [checkins.id] }),
  document: one(eventDocuments, { fields: [checkinDocuments.documentId], references: [eventDocuments.id] }),
}))
```

- [ ] **Step 7: Update `eventsRelations` to include new relations**

Update existing `eventsRelations` (line 162) to add `eventDocuments` and `checkins`:

```javascript
export const eventsRelations = relations(events, ({ many }) => ({
  categories: many(categories),
  eventDocuments: many(eventDocuments),
  checkins: many(checkins),
}))
```

- [ ] **Step 8: Update `participantsRelations` to include checkin**

Update existing `participantsRelations` (line 172):

```javascript
export const participantsRelations = relations(participants, ({ one }) => ({
  category: one(categories, { fields: [participants.categoryId], references: [categories.id] }),
  event: one(events, { fields: [participants.eventId], references: [events.id] }),
  checkin: one(checkins, { fields: [participants.id], references: [checkins.participantId] }),
}))
```

- [ ] **Step 9: Add new tables to import in schema.js top-level exports**

Verify all new tables are exported (they are via `export const`). No additional action needed — just confirm.

- [ ] **Step 10: Commit schema changes**

```bash
git add backend/src/db/schema.js
git commit -m "feat(schema): add event_documents, checkins, checkin_documents tables and event slug"
```

### Task 2: Write the SQL migration

**Files:**
- Create: `backend/src/db/migrations/0014_sms_checkin.sql`
- Modify: `backend/src/db/migrations/meta/_journal.json`

- [ ] **Step 1: Create migration SQL file**

Create `backend/src/db/migrations/0014_sms_checkin.sql`:

```sql
-- Add slug to events
ALTER TABLE events ADD COLUMN slug TEXT UNIQUE;

-- Generate slugs for existing events (lowercase name, replace spaces with hyphens, strip non-alphanumeric)
UPDATE events SET slug = lower(regexp_replace(regexp_replace(name, '[^a-zA-Z0-9\s-]', '', 'g'), '\s+', '-', 'g'))
WHERE slug IS NULL;

-- Handle any duplicate slugs by appending id prefix
UPDATE events e SET slug = slug || '-' || left(id::text, 8)
WHERE (SELECT count(*) FROM events e2 WHERE e2.slug = e.slug) > 1;

-- Now make slug NOT NULL (add constraint after backfill)
ALTER TABLE events ALTER COLUMN slug SET NOT NULL;

-- Add phone and sms_sent_at to participants
ALTER TABLE participants ADD COLUMN phone TEXT;
ALTER TABLE participants ADD COLUMN sms_sent_at TIMESTAMPTZ;

-- Create event_documents table
CREATE TABLE event_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  url TEXT,
  required_for TEXT NOT NULL DEFAULT 'all',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ,
  synced_at TIMESTAMPTZ
);

-- Forward sync trigger for event_documents (same pattern as other synced tables)
CREATE OR REPLACE FUNCTION trg_fn_reset_synced_at_event_documents()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.synced_at IS DISTINCT FROM NEW.synced_at THEN
    RETURN NEW;
  END IF;
  NEW.synced_at := NULL;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reset_synced_at_event_documents
BEFORE UPDATE ON event_documents
FOR EACH ROW EXECUTE FUNCTION trg_fn_reset_synced_at_event_documents();

-- Create checkins table (reverse sync: Supabase → local, NO trg_reset_synced_at)
CREATE TABLE checkins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_id UUID NOT NULL UNIQUE REFERENCES participants(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  checked_in_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ,
  synced_at TIMESTAMPTZ
);

-- Create checkin_documents table (reverse sync: Supabase → local, NO trg_reset_synced_at)
CREATE TABLE checkin_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  checkin_id UUID NOT NULL REFERENCES checkins(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES event_documents(id) ON DELETE CASCADE,
  completed_at TIMESTAMPTZ,
  completed_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ,
  synced_at TIMESTAMPTZ,
  UNIQUE (checkin_id, document_id)
);
```

- [ ] **Step 2: Add journal entry**

In `backend/src/db/migrations/meta/_journal.json`, add to the `entries` array after the last entry (idx 13):

```json
{
  "idx": 14,
  "version": "7",
  "when": 1742248800000,
  "tag": "0014_sms_checkin",
  "breakpoints": true
}
```

- [ ] **Step 3: Verify migration runs cleanly**

```bash
docker compose up -d db backend
docker compose logs -f backend
```

Expected: `[DB] Migrations complete` with no errors.

- [ ] **Step 4: Commit migration**

```bash
git add backend/src/db/migrations/0014_sms_checkin.sql backend/src/db/migrations/meta/_journal.json
git commit -m "feat(db): add migration 0014 for sms checkin tables"
```

### Task 3: Update forward sync to include event_documents

**Files:**
- Modify: `backend/src/sync/supabase.js`

- [ ] **Step 1: Import new table**

At top of `backend/src/sync/supabase.js` (line 3), add `eventDocuments` to the import:

```javascript
import { events, categories, participants, raceRuns, gateCrossings, results,
         checkpoints, checkpointObservations, eventDocuments } from '../db/schema.js'
```

- [ ] **Step 2: Add to SYNC_TABLES array**

In `SYNC_TABLES` (line 12-21), add after `checkpointObservations` entry:

```javascript
{ table: eventDocuments, name: 'event_documents' },
```

**CRITICAL:** Do NOT add `checkins` or `checkinDocuments` here — they are reverse-sync only.

- [ ] **Step 3: Update syncDeleteEvent to clean up new tables**

In `syncDeleteEvent` function (line 48-78), add before deleting participants (line 72):

```javascript
// Delete checkin-related data
await supabase.from('checkin_documents').delete().eq('checkin_id',
  supabase.from('checkins').select('id').eq('event_id', eventId)
)
// Simpler approach: delete checkins (cascade handles checkin_documents)
await supabase.from('checkins').delete().eq('event_id', eventId)
await supabase.from('event_documents').delete().eq('event_id', eventId)
```

Since `syncDeleteEvent` does manual cascade (not SQL CASCADE), explicitly delete all related rows in dependency order. Add these lines before `await supabase.from('participants').delete()` (line 72):

```javascript
// Delete checkin-related data (manual cascade order: documents → checkins → event_documents)
const { data: cks } = await supabase.from('checkins').select('id').eq('event_id', eventId)
const ckIds = (cks || []).map(c => c.id)
if (ckIds.length) {
  await supabase.from('checkin_documents').delete().in('checkin_id', ckIds)
  await supabase.from('checkins').delete().in('id', ckIds)
}
await supabase.from('event_documents').delete().eq('event_id', eventId)
```

- [ ] **Step 4: Commit**

```bash
git add backend/src/sync/supabase.js
git commit -m "feat(sync): add event_documents to forward sync, clean up checkin data on event delete"
```

### Task 4: Create Supabase tables and RLS policies

**Files:**
- Supabase migration via MCP tool

- [ ] **Step 1: Create event_documents table in Supabase**

Apply Supabase migration to create the `event_documents` table (same schema as local, will be populated via forward sync).

- [ ] **Step 2: Create event_secrets table in Supabase (PIN storage)**

```sql
CREATE TABLE event_secrets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID UNIQUE NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  checkin_pin TEXT NOT NULL
);

-- No public SELECT — only accessible via DB functions
ALTER TABLE event_secrets ENABLE ROW LEVEL SECURITY;
-- No RLS policies = no access via anon/authenticated roles
```

- [ ] **Step 3: Create checkins table in Supabase**

```sql
CREATE TABLE checkins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_id UUID NOT NULL UNIQUE REFERENCES participants(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  checked_in_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Auto-update updated_at on any modification
CREATE OR REPLACE FUNCTION update_checkins_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_checkins_updated_at
BEFORE UPDATE ON checkins
FOR EACH ROW EXECUTE FUNCTION update_checkins_updated_at();

-- RLS
ALTER TABLE checkins ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read" ON checkins FOR SELECT USING (true);
CREATE POLICY "Anon insert once" ON checkins FOR INSERT WITH CHECK (
  NOT EXISTS (SELECT 1 FROM checkins existing WHERE existing.participant_id = checkins.participant_id)
);
-- UPDATE only via DB function (no direct UPDATE policy)
```

- [ ] **Step 4: Create checkin_documents table in Supabase**

```sql
CREATE TABLE checkin_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  checkin_id UUID NOT NULL REFERENCES checkins(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES event_documents(id) ON DELETE CASCADE,
  completed_at TIMESTAMPTZ,
  completed_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (checkin_id, document_id)
);

CREATE OR REPLACE FUNCTION update_checkin_documents_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_checkin_documents_updated_at
BEFORE UPDATE ON checkin_documents
FOR EACH ROW EXECUTE FUNCTION update_checkin_documents_updated_at();

-- RLS
ALTER TABLE checkin_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read" ON checkin_documents FOR SELECT USING (true);
CREATE POLICY "Anon insert" ON checkin_documents FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM checkins c WHERE c.id = checkin_id)
);
```

- [ ] **Step 5: Create verify_checkin_pin DB function**

```sql
CREATE OR REPLACE FUNCTION verify_checkin_pin(p_event_id UUID, p_pin TEXT)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM event_secrets
    WHERE event_id = p_event_id AND checkin_pin = p_pin
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

- [ ] **Step 6: Create checkin_confirm DB function**

```sql
CREATE OR REPLACE FUNCTION checkin_confirm(
  p_participant_id UUID,
  p_pin TEXT,
  p_documents JSONB DEFAULT '[]'::JSONB
)
RETURNS JSONB AS $$
DECLARE
  v_event_id UUID;
  v_checkin_id UUID;
  v_doc JSONB;
BEGIN
  -- Get event_id from participant
  SELECT event_id INTO v_event_id FROM participants WHERE id = p_participant_id;
  IF v_event_id IS NULL THEN
    RETURN jsonb_build_object('error', 'Participant not found');
  END IF;

  -- Validate PIN
  IF NOT EXISTS (SELECT 1 FROM event_secrets WHERE event_id = v_event_id AND checkin_pin = p_pin) THEN
    RETURN jsonb_build_object('error', 'Invalid PIN');
  END IF;

  -- Upsert checkins row
  INSERT INTO checkins (participant_id, event_id, checked_in_at)
  VALUES (p_participant_id, v_event_id, NOW())
  ON CONFLICT (participant_id) DO UPDATE SET checked_in_at = NOW(), updated_at = NOW()
  RETURNING id INTO v_checkin_id;

  -- Insert document completions
  FOR v_doc IN SELECT * FROM jsonb_array_elements(p_documents)
  LOOP
    INSERT INTO checkin_documents (checkin_id, document_id, completed_at, completed_by)
    VALUES (
      v_checkin_id,
      (v_doc->>'document_id')::UUID,
      NOW(),
      COALESCE(v_doc->>'completed_by', 'admin')
    )
    ON CONFLICT DO NOTHING;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'checkin_id', v_checkin_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

- [ ] **Step 7: Add public SELECT policy for event_documents**

```sql
ALTER TABLE event_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read" ON event_documents FOR SELECT USING (true);
```

- [ ] **Step 8: Commit any local files tracking Supabase migrations**

---

## Chunk 2: Backend — Reverse Sync, SMS, and Route Updates

### Task 5: Create reverse sync worker

**Files:**
- Create: `backend/src/sync/checkinSync.js`

- [ ] **Step 1: Create checkinSync.js**

Create `backend/src/sync/checkinSync.js`:

```javascript
import { createClient } from '@supabase/supabase-js'
import { sql } from 'drizzle-orm'
import { checkins, checkinDocuments } from '../db/schema.js'

let supabase = null
let lastSyncTime = null

export function initCheckinSync(db) {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !key) {
    console.log('[CheckinSync] Supabase credentials not set — reverse sync disabled')
    return
  }

  supabase = createClient(url, key)
  console.log('[CheckinSync] Reverse sync enabled, polling every 30s')

  setInterval(() => pullCheckins(db), 30_000)
  setTimeout(() => pullCheckins(db), 6_000)  // First run slightly after forward sync
}

export async function pullCheckins(db) {
  if (!supabase) return

  try {
    // Fetch checkins updated since last sync (or all if first run)
    let query = supabase.from('checkins').select('*')
    if (lastSyncTime) {
      query = query.gt('updated_at', lastSyncTime)
    }
    const { data: remoteCheckins, error: checkinsError } = await query

    if (checkinsError) {
      console.error('[CheckinSync] Error fetching checkins:', checkinsError.message)
      return
    }

    if (!remoteCheckins?.length) return

    const now = new Date()

    // Upsert checkins into local DB
    for (const row of remoteCheckins) {
      await db.insert(checkins).values({
        id: row.id,
        participantId: row.participant_id,
        eventId: row.event_id,
        checkedInAt: row.checked_in_at ? new Date(row.checked_in_at) : null,
        createdAt: row.created_at ? new Date(row.created_at) : null,
        updatedAt: row.updated_at ? new Date(row.updated_at) : null,
        syncedAt: now,
      }).onConflictDoUpdate({
        target: checkins.id,
        set: {
          checkedInAt: row.checked_in_at ? new Date(row.checked_in_at) : null,
          updatedAt: row.updated_at ? new Date(row.updated_at) : null,
          syncedAt: now,
        },
      })
    }

    // Fetch checkin_documents for affected checkins
    const checkinIds = remoteCheckins.map(c => c.id)
    const { data: remoteDocs, error: docsError } = await supabase
      .from('checkin_documents')
      .select('*')
      .in('checkin_id', checkinIds)

    if (docsError) {
      console.error('[CheckinSync] Error fetching checkin_documents:', docsError.message)
    } else if (remoteDocs?.length) {
      for (const row of remoteDocs) {
        await db.insert(checkinDocuments).values({
          id: row.id,
          checkinId: row.checkin_id,
          documentId: row.document_id,
          completedAt: row.completed_at ? new Date(row.completed_at) : null,
          completedBy: row.completed_by,
          createdAt: row.created_at ? new Date(row.created_at) : null,
          updatedAt: row.updated_at ? new Date(row.updated_at) : null,
          syncedAt: now,
        }).onConflictDoUpdate({
          target: checkinDocuments.id,
          set: {
            completedAt: row.completed_at ? new Date(row.completed_at) : null,
            completedBy: row.completed_by,
            updatedAt: row.updated_at ? new Date(row.updated_at) : null,
            syncedAt: now,
          },
        })
      }
    }

    lastSyncTime = now.toISOString()
    console.log(`[CheckinSync] Pulled ${remoteCheckins.length} checkins, ${remoteDocs?.length || 0} documents`)
  } catch (err) {
    console.error('[CheckinSync] Unexpected error:', err.message)
  }
}
```

- [ ] **Step 2: Register in server.js**

In `backend/src/server.js`, add import (after line 12):

```javascript
import { initCheckinSync } from './sync/checkinSync.js'
```

Add initialization after `initSupabaseSync(db)` (line 73):

```javascript
initCheckinSync(db)
```

- [ ] **Step 3: Commit**

```bash
git add backend/src/sync/checkinSync.js backend/src/server.js
git commit -m "feat(sync): add reverse sync worker for checkins from Supabase"
```

### Task 6: Create SMSAPI client wrapper

**Files:**
- Create: `backend/src/sms/smsapi.js`

- [ ] **Step 1: Create smsapi.js**

Create `backend/src/sms/smsapi.js`:

```javascript
const SMSAPI_URL = 'https://api.smsapi.pl/sms.do'

export async function sendSms(phone, message) {
  const token = process.env.SMSAPI_TOKEN
  const sender = process.env.SMSAPI_SENDER || 'LeszyRun'

  if (!token) {
    throw new Error('SMSAPI_TOKEN not configured')
  }

  const params = new URLSearchParams({
    to: phone.replace(/\s+/g, ''),  // strip whitespace
    message,
    from: sender,
    format: 'json',
    encoding: 'utf-8',
  })

  const res = await fetch(SMSAPI_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  })

  const data = await res.json()

  if (data.error) {
    return { success: false, error: `${data.error}: ${data.message || ''}` }
  }

  return { success: true, messageId: data.list?.[0]?.id }
}
```

- [ ] **Step 2: Add env vars to docker-compose.yml**

In `docker-compose.yml`, in the backend service `environment` section, add:

```yaml
SMSAPI_TOKEN: ${SMSAPI_TOKEN:-}
SMSAPI_SENDER: ${SMSAPI_SENDER:-LeszyRun}
```

- [ ] **Step 3: Commit**

```bash
git add backend/src/sms/smsapi.js docker-compose.yml
git commit -m "feat(sms): add SMSAPI client wrapper"
```

### Task 7: Create SMS routes

**Files:**
- Create: `backend/src/routes/sms.js`
- Modify: `backend/src/server.js`

- [ ] **Step 1: Create sms.js route file**

Create `backend/src/routes/sms.js`:

```javascript
import { eq, and, isNull, inArray } from 'drizzle-orm'
import { participants, events } from '../db/schema.js'
import { sendSms } from '../sms/smsapi.js'

export async function smsRoutes(fastify) {
  const { db } = fastify

  // Send check-in SMS to specific participants
  fastify.post('/events/:eventId/sms/checkin', async (req, reply) => {
    const { participantIds } = req.body
    if (!participantIds?.length) return reply.code(400).send({ error: 'participantIds required' })

    const event = await db.query.events.findFirst({ where: eq(events.id, req.params.eventId) })
    if (!event) return reply.code(404).send({ error: 'Event not found' })
    if (!event.slug) return reply.code(400).send({ error: 'Event has no slug — set one in event settings first' })

    const rows = await db.query.participants.findMany({
      where: and(
        eq(participants.eventId, req.params.eventId),
        inArray(participants.id, participantIds),
      ),
    })

    return await sendCheckinSms(db, event, rows)
  })

  // Send check-in SMS to all eligible participants
  fastify.post('/events/:eventId/sms/checkin-all', async (req, reply) => {
    const event = await db.query.events.findFirst({ where: eq(events.id, req.params.eventId) })
    if (!event) return reply.code(404).send({ error: 'Event not found' })
    if (!event.slug) return reply.code(400).send({ error: 'Event has no slug — set one in event settings first' })

    const rows = await db.query.participants.findMany({
      where: and(
        eq(participants.eventId, req.params.eventId),
        isNull(participants.smsSentAt),
      ),
    })

    return await sendCheckinSms(db, event, rows)
  })
}

async function sendCheckinSms(db, event, participantRows) {
  let sent = 0, skipped = 0
  const errors = []

  for (const p of participantRows) {
    if (!p.phone) {
      skipped++
      continue
    }

    const message = `Cześć ${p.firstName}! Zamelduj się na ${event.name}: leszy.run/${event.slug}/checkin?p=${p.id}`

    try {
      const result = await sendSms(p.phone, message)
      if (result.success) {
        await db.update(participants).set({ smsSentAt: new Date() }).where(eq(participants.id, p.id))
        sent++
      } else {
        errors.push({ participantId: p.id, message: result.error })
      }
    } catch (err) {
      errors.push({ participantId: p.id, message: err.message })
    }
  }

  return { data: { sent, skipped, errors } }
}
```

- [ ] **Step 2: Register SMS routes in server.js**

In `backend/src/server.js`, add import (after line 21):

```javascript
import { smsRoutes } from './routes/sms.js'
```

Add registration inside the API prefix block (after line 43):

```javascript
await api.register(smsRoutes)
```

- [ ] **Step 3: Commit**

```bash
git add backend/src/routes/sms.js backend/src/server.js
git commit -m "feat(sms): add SMS check-in endpoints"
```

### Task 8: Create event documents routes

**Files:**
- Create: `backend/src/routes/eventDocuments.js`
- Modify: `backend/src/server.js`

- [ ] **Step 1: Create eventDocuments.js route file**

Create `backend/src/routes/eventDocuments.js`:

```javascript
import { eq } from 'drizzle-orm'
import { eventDocuments } from '../db/schema.js'

export async function eventDocumentsRoutes(fastify) {
  const { db } = fastify

  // List documents for event
  fastify.get('/events/:eventId/documents', async (req) => {
    const rows = await db.query.eventDocuments.findMany({
      where: eq(eventDocuments.eventId, req.params.eventId),
      orderBy: eventDocuments.sortOrder,
    })
    return { data: rows }
  })

  // Create document
  fastify.post('/events/:eventId/documents', async (req, reply) => {
    const { name, type, url, requiredFor, sortOrder } = req.body
    if (!name || !type) return reply.code(400).send({ error: 'name and type are required' })
    if (!['acknowledge', 'provide'].includes(type)) return reply.code(400).send({ error: 'type must be acknowledge or provide' })

    const [row] = await db.insert(eventDocuments).values({
      eventId: req.params.eventId,
      name,
      type,
      url: url || null,
      requiredFor: requiredFor || 'all',
      sortOrder: sortOrder || 0,
    }).returning()

    return reply.code(201).send({ data: row })
  })

  // Update document
  fastify.patch('/documents/:id', async (req, reply) => {
    const allowed = ['name', 'type', 'url', 'requiredFor', 'sortOrder']
    const updates = {}
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key]
    }
    updates.updatedAt = new Date()
    if (Object.keys(updates).length <= 1) return reply.code(400).send({ error: 'No fields to update' })

    const [row] = await db.update(eventDocuments).set(updates).where(eq(eventDocuments.id, req.params.id)).returning()
    if (!row) return reply.code(404).send({ error: 'Document not found' })
    return { data: row }
  })

  // Delete document
  fastify.delete('/documents/:id', async (req, reply) => {
    const [row] = await db.delete(eventDocuments).where(eq(eventDocuments.id, req.params.id)).returning()
    if (!row) return reply.code(404).send({ error: 'Document not found' })
    return { data: row }
  })
}
```

- [ ] **Step 2: Register in server.js**

Add import and registration following the same pattern as smsRoutes.

- [ ] **Step 3: Commit**

```bash
git add backend/src/routes/eventDocuments.js backend/src/server.js
git commit -m "feat(api): add event documents CRUD endpoints"
```

### Task 9: Create event secrets management route + reverse sync trigger endpoint

**Files:**
- Create: `backend/src/routes/eventSecrets.js`
- Modify: `backend/src/server.js`

- [ ] **Step 1: Create eventSecrets.js**

Create `backend/src/routes/eventSecrets.js`:

```javascript
import { createClient } from '@supabase/supabase-js'
import { eq } from 'drizzle-orm'
import { events } from '../db/schema.js'
import { pullCheckins } from '../sync/checkinSync.js'

function getSupabase() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createClient(url, key)
}

function generatePin() {
  return String(Math.floor(100000 + Math.random() * 900000))  // 6-digit PIN
}

export async function eventSecretsRoutes(fastify) {
  const { db } = fastify

  // Get check-in PIN for event
  fastify.get('/events/:eventId/secrets/checkin-pin', async (req, reply) => {
    const supabase = getSupabase()
    if (!supabase) return reply.code(503).send({ error: 'Supabase not configured' })

    const { data, error } = await supabase
      .from('event_secrets')
      .select('checkin_pin')
      .eq('event_id', req.params.eventId)
      .single()

    if (error && error.code !== 'PGRST116') return reply.code(500).send({ error: error.message })
    return { data: { checkinPin: data?.checkin_pin || null } }
  })

  // Generate or regenerate check-in PIN
  fastify.post('/events/:eventId/secrets/checkin-pin', async (req, reply) => {
    const supabase = getSupabase()
    if (!supabase) return reply.code(503).send({ error: 'Supabase not configured' })

    const event = await db.query.events.findFirst({ where: eq(events.id, req.params.eventId) })
    if (!event) return reply.code(404).send({ error: 'Event not found' })

    const pin = generatePin()
    const { error } = await supabase
      .from('event_secrets')
      .upsert({ event_id: req.params.eventId, checkin_pin: pin }, { onConflict: 'event_id' })

    if (error) return reply.code(500).send({ error: error.message })
    return { data: { checkinPin: pin } }
  })

  // Manual trigger: pull checkins from Supabase now
  fastify.post('/events/:eventId/sync/checkins', async (req, reply) => {
    await pullCheckins(db)
    return { data: { synced: true } }
  })
}
```

- [ ] **Step 2: Register in server.js and export pullCheckins from checkinSync.js**

Ensure `pullCheckins` is exported (it already is in our Task 5 code). Register the route in server.js.

- [ ] **Step 3: Commit**

```bash
git add backend/src/routes/eventSecrets.js backend/src/server.js
git commit -m "feat(api): add event secrets (PIN) management and manual checkin sync trigger"
```

### Task 10: Update events route — add slug to allowed fields

**Files:**
- Modify: `backend/src/routes/events.js`

- [ ] **Step 1: Add slug to PATCH allowed fields**

In `backend/src/routes/events.js` line 40, add `'slug'` to the allowed array:

```javascript
const allowed = ['name', 'description', 'date', 'location', 'slug', 'rfidMode', 'rfidTopicMain', 'rfidTopicFinish', 'rssiThreshold', 'declineThresholdCdbm', 'fallbackSeconds']
```

- [ ] **Step 2: Add slug validation**

After the `updates` object is built (line 44), add validation:

```javascript
if (updates.slug !== undefined) {
  updates.slug = updates.slug.toLowerCase().replace(/[^a-z0-9-]/g, '')
  if (!updates.slug) return reply.code(400).send({ error: 'Invalid slug' })
}
```

- [ ] **Step 3: Auto-generate slug on event creation**

In the POST handler (line 30-36), generate a slug from the name:

```javascript
const slug = name.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-')
const [row] = await db.insert(events).values({ name, description, date, location, slug }).returning()
```

- [ ] **Step 4: Commit**

```bash
git add backend/src/routes/events.js
git commit -m "feat(events): add slug field with auto-generation and validation"
```

### Task 11: Update participants route — add phone to allowed fields and CSV import

**Files:**
- Modify: `backend/src/routes/participants.js`

- [ ] **Step 1: Add phone to PATCH allowed fields**

In `backend/src/routes/participants.js` line 45, add `'phone'` to the allowed array:

```javascript
const allowed = ['firstName', 'lastName', 'email', 'gender', 'birthDate', 'club', 'bibNumber', 'categoryId', 'rfidEpc', 'checkedIn', 'phone']
```

- [ ] **Step 2: Add phone to CSV import**

In the import handler (line 93-143), add phone extraction. After the category lookup (line 108), add:

```javascript
const rawPhone = row.phone || row.telefon || row.tel || null
// Normalize to E.164: strip spaces, ensure + prefix for international
const phone = rawPhone ? rawPhone.replace(/[\s()-]/g, '').replace(/^(?!\+)48/, '+48').replace(/^(?!\+)/, '+48') : null
```

Validation: if `phone` is provided, check it matches `/^\+\d{9,15}$/` — if not, log an import warning but don't reject the row.

Add `phone` to the insert values (line 140) and update set (line 123):

In the `else` (insert) block, add `phone,` to the values object.
In the `if (existing)` (update) block, add `phone: phone || existing.phone,` to the set object.

- [ ] **Step 3: Commit**

```bash
git add backend/src/routes/participants.js
git commit -m "feat(participants): add phone field to PATCH and CSV import"
```

### Task 12: Update race seeding to use checkins table

**Files:**
- Modify: `backend/src/routes/races.js`

- [ ] **Step 1: Import checkins table**

Add to imports at top of `backend/src/routes/races.js`:

```javascript
import { checkins } from '../db/schema.js'
```

- [ ] **Step 2: Update race seeding query**

In the race start handler (around line 55-68), replace the simple `findMany` with a query that joins checkins:

```javascript
const allParticipants = await db.query.participants.findMany({
  where: eq(participants.categoryId, req.params.categoryId),
  with: { checkin: true },
})
```

Then update the status assignment (line 65):

```javascript
status: p.checkin?.checkedInAt ? 'checked_in' : 'registered',
```

- [ ] **Step 3: Commit**

```bash
git add backend/src/routes/races.js
git commit -m "feat(races): use checkins table join for race seeding status"
```

---

## Chunk 3: Frontend Admin Updates

### Task 13: Add API client methods for new endpoints

**Files:**
- Modify: `frontend/src/lib/api.js`

- [ ] **Step 1: Add SMS, documents, and secrets API methods**

In `frontend/src/lib/api.js`, add after the `results` section (line 95):

```javascript
// Event Documents
documents: {
  list: (eventId) => request('GET', `/events/${eventId}/documents`),
  create: (eventId, body) => request('POST', `/events/${eventId}/documents`, body),
  update: (id, body) => request('PATCH', `/documents/${id}`, body),
  delete: (id) => request('DELETE', `/documents/${id}`),
},

// SMS
sms: {
  sendToParticipants: (eventId, participantIds) =>
    request('POST', `/events/${eventId}/sms/checkin`, { participantIds }),
  sendToAll: (eventId) =>
    request('POST', `/events/${eventId}/sms/checkin-all`),
},

// Event Secrets
secrets: {
  getCheckinPin: (eventId) => request('GET', `/events/${eventId}/secrets/checkin-pin`),
  generateCheckinPin: (eventId) => request('POST', `/events/${eventId}/secrets/checkin-pin`),
},

// Checkin Sync
checkinSync: {
  pullNow: (eventId) => request('POST', `/events/${eventId}/sync/checkins`),
},
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/lib/api.js
git commit -m "feat(frontend): add API client methods for documents, SMS, secrets, and checkin sync"
```

### Task 14: Add event slug and PIN to event settings UI

**Files:**
- Modify: `frontend/src/pages/EventDetail.jsx`

This task adds the slug field and check-in PIN management to the existing event settings section. The exact UI changes depend on the current EventDetail layout. Key additions:

- [ ] **Step 1: Add slug input field to event settings**

Find the event settings section in EventDetail.jsx. Add a text input for `slug` with inline edit (same pattern as other event fields). Show the public URL preview: `leszy.run/{slug}`.

- [ ] **Step 2: Add check-in PIN section**

Add a section showing the current PIN (fetched via `api.secrets.getCheckinPin`), a copy button, and a "Regenerate" button that calls `api.secrets.generateCheckinPin`.

- [ ] **Step 3: Add "Pull check-ins" button**

Add a button that calls `api.checkinSync.pullNow(eventId)` with a loading state. Show it near the race control area or in the event header.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/EventDetail.jsx
git commit -m "feat(frontend): add event slug, check-in PIN, and sync pull button to event settings"
```

### Task 15: Add Documents tab to EventDetail

**Files:**
- Modify: `frontend/src/pages/EventDetail.jsx`

- [ ] **Step 1: Add "Dokumenty" tab**

Add a new tab trigger and content section. The content should render a table/list of event documents with:
- Name (text input)
- Type (select: acknowledge/provide)
- URL (text input)
- Required for (select: all/minors)
- Sort order (number input)
- Delete button per row
- "Add document" button

Use the same inline editing pattern as other tables in the app. Fetch with `useQuery(['documents', eventId], () => api.documents.list(eventId))`.

- [ ] **Step 2: Commit**

```bash
git add frontend/src/pages/EventDetail.jsx
git commit -m "feat(frontend): add Documents tab for managing event documents"
```

### Task 16: Update ParticipantsTable — phone, SMS, and check-in status

**Files:**
- Modify: `frontend/src/components/ParticipantsTable/ParticipantsTable.jsx`

- [ ] **Step 1: Add phone column**

Add a phone column to the table headers and an `EditableCell` for phone numbers in each row (same pattern as email/club cells).

- [ ] **Step 2: Add SMS status indicator and send button**

Add a column showing:
- If `smsSentAt` exists: green checkmark with timestamp tooltip
- If no `smsSentAt` but has phone: a "Send SMS" icon button that calls `api.sms.sendToParticipants(eventId, [participant.id])`
- If no phone: disabled/hidden

- [ ] **Step 3: Add bulk "Send Check-in SMS to All" button**

Above the table, add a button that opens a confirmation dialog showing:
- "Will send to X participants"
- "(Y without phone number — will be skipped)"
- "(Z already sent — will be skipped)"
Then calls `api.sms.sendToAll(eventId)`.

- [ ] **Step 4: Add check-in status from checkins join**

The participants API already returns data. Update the backend GET endpoint to include the checkin relation, or query checkins separately. Display status indicators:
- Documents completed: ✓/✗
- Checked in: ✓/✗ with timestamp

- [ ] **Step 5: Update check-in icon for minors**

When clicking the check-in icon for a participant with incomplete `provide`-type documents:
1. Check if participant is a minor (calculate age from `birthDate` vs event date)
2. If minor with incomplete provide docs: show a dialog listing the documents as checkboxes
3. Check-in button disabled until all provide docs are ticked
4. On confirm: call backend to write check-in to Supabase

For adults: existing behavior (single click to check in).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/ParticipantsTable/ParticipantsTable.jsx
git commit -m "feat(frontend): add phone, SMS status, bulk send, and minor check-in dialog to ParticipantsTable"
```

---

## Chunk 4: Unified Public App

### Task 17: Scaffold public/ app

**Files:**
- Create: `public/package.json`
- Create: `public/vite.config.js`
- Create: `public/index.html`
- Create: `public/src/main.jsx`
- Create: `public/src/App.jsx`
- Create: `public/src/app.css`
- Create: `public/src/lib/supabase.js`
- Create: `public/vercel.json`
- Create: `public/.gitignore`
- Modify: `package.json` (root workspaces)

- [ ] **Step 1: Create package.json**

```json
{
  "name": "leszyrun-public",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite --port 5173",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@supabase/supabase-js": "^2.0.0",
    "qrcode.react": "^4.0.0",
    "html5-qrcode": "^2.3.0",
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

- [ ] **Step 2: Create vite.config.js**

Same pattern as `liveresults/vite.config.js` — React plugin + Tailwind plugin.

- [ ] **Step 3: Create index.html**

Copy from `liveresults/index.html`, update title to "LeszyRun". Keep the Google Fonts imports (Bebas Neue, Inter, + add Barlow Condensed, Rajdhani, IBM Plex Mono for OVERDRIVE theme).

- [ ] **Step 4: Create supabase.js**

Copy from `liveresults/src/lib/supabase.js` — uses `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` env vars.

- [ ] **Step 5: Create App.jsx with route structure**

```jsx
import { Routes, Route, Navigate } from 'react-router-dom'
import EventHub from './pages/EventHub.jsx'
import Results from './pages/Results.jsx'
import Volunteer from './pages/Volunteer.jsx'
import Checkin from './pages/Checkin.jsx'
import AdminCheckin from './pages/AdminCheckin.jsx'
import Home from './pages/Home.jsx'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/:slug" element={<EventHub />} />
      <Route path="/:slug/results" element={<Results />} />
      <Route path="/:slug/results/:categoryId" element={<Results />} />
      <Route path="/:slug/volunteer" element={<Volunteer />} />
      <Route path="/:slug/checkin" element={<Checkin />} />
      <Route path="/:slug/admin/checkin" element={<AdminCheckin />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
```

- [ ] **Step 6: Create main.jsx**

```jsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.jsx'
import './app.css'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>
)
```

- [ ] **Step 7: Create vercel.json**

```json
{
  "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]
}
```

- [ ] **Step 8: Create .gitignore**

```
node_modules
dist
.env
```

- [ ] **Step 9: Update root package.json workspaces**

Add `"public"` to the workspaces array and add build script:

```json
"workspaces": ["backend", "frontend", "liveresults", "public", "packages/ui"],
```

- [ ] **Step 10: Run npm install to link workspace**

```bash
npm install
```

- [ ] **Step 11: Commit**

```bash
git add public/ package.json package-lock.json
git commit -m "feat(public): scaffold unified public app with route structure"
```

### Task 18: Migrate liveresults pages to public app

**Files:**
- Create: `public/src/pages/Home.jsx`
- Create: `public/src/pages/EventHub.jsx`
- Create: `public/src/pages/Results.jsx`
- Create: `public/src/hooks/useEvent.js`

- [ ] **Step 1: Create useEvent hook (slug → event lookup)**

Create `public/src/hooks/useEvent.js`:

```javascript
import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase.js'

export function useEvent() {
  const { slug } = useParams()
  const [event, setEvent] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!slug) { setLoading(false); return }

    supabase
      .from('events')
      .select('*')
      .eq('slug', slug)
      .single()
      .then(({ data, error }) => {
        if (error || !data) setError('Event not found')
        else setEvent(data)
        setLoading(false)
      })
  }, [slug])

  return { event, loading, error }
}
```

- [ ] **Step 2: Create Home.jsx (event list)**

Fetch all events from Supabase, display as cards with links to `/:slug`.

- [ ] **Step 3: Create EventHub.jsx**

Simple page showing event name, date, location, and links to `/:slug/results`, `/:slug/checkin`, `/:slug/volunteer`.

- [ ] **Step 4: Create Results.jsx**

Migrate from `liveresults/src/pages/Event.jsx` and `CategorySection.jsx`. Key changes:
- Use `useEvent()` hook instead of event ID from URL
- Routes use slug instead of eventId
- Import shared components from `packages/ui/` (Podium, CheckpointTrackingTable, PositionBadge)

- [ ] **Step 5: Commit**

```bash
git add public/src/
git commit -m "feat(public): add event lookup hook, home page, event hub, and results (migrated from liveresults)"
```

### Task 19: Migrate volunteer page to public app

**Files:**
- Create: `public/src/pages/Volunteer.jsx`

- [ ] **Step 1: Create Volunteer.jsx**

Migrate from `volunteer/src/App.jsx`. Key changes:
- Use `useEvent()` hook to resolve event
- Get checkpoint ID from URL query param (same as before)
- Use shared Supabase client from `public/src/lib/supabase.js`
- Same numpad UI, same bib entry flow

- [ ] **Step 2: Commit**

```bash
git add public/src/pages/Volunteer.jsx
git commit -m "feat(public): add volunteer checkpoint entry page (migrated from volunteer/)"
```

### Task 20: Build participant self-service check-in page

**Files:**
- Create: `public/src/pages/Checkin.jsx`

- [ ] **Step 1: Create Checkin.jsx**

This is the main new page. Flow:
1. Read `?p={participantId}` from URL
2. Fetch participant + event from Supabase using the slug and participant ID
3. Validate participant belongs to this event (event_id match)
4. Check if checkins row exists:
   - Exists with `checked_in_at`: show "You're checked in ✓" confirmation
   - Exists without `checked_in_at`: show QR code (skip to step 6)
   - Doesn't exist: show self-service flow
5. Show participant info (name, category, bib), minor banner if applicable
6. Fetch `event_documents` for this event, filter by `required_for` (all, or minors if participant is minor based on `birth_date`)
7. Show checkboxes for each `acknowledge`-type document (name links to URL)
8. Show download reminders for each `provide`-type document
9. "Confirm" button (disabled until all acknowledge docs are ticked)
10. On confirm: INSERT into `checkins`, INSERT into `checkin_documents` for each acknowledged doc
11. Show QR code (using `qrcode.react`) encoding participant ID
12. "Save to gallery" button — render QR to canvas, download as PNG

```jsx
import { useState, useEffect } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { QRCodeCanvas } from 'qrcode.react'
import { supabase } from '../lib/supabase.js'
import { useEvent } from '../hooks/useEvent.js'

export default function Checkin() {
  const { event, loading: eventLoading, error: eventError } = useEvent()
  const [searchParams] = useSearchParams()
  const participantId = searchParams.get('p')

  const [participant, setParticipant] = useState(null)
  const [checkin, setCheckin] = useState(null)
  const [documents, setDocuments] = useState([])
  const [acknowledged, setAcknowledged] = useState({})
  const [submitting, setSubmitting] = useState(false)
  const [loading, setLoading] = useState(true)

  // ... fetch participant, checkin status, documents on mount
  // ... render logic based on state (landing → documents → QR code)
  // ... QR save-to-gallery handler

  return (/* JSX */)
}
```

The full component will be ~150-200 lines. Implementation should follow the flow described above.

- [ ] **Step 2: Minor detection helper**

```javascript
function isMinor(birthDate, eventDate) {
  if (!birthDate) return false
  const birth = new Date(birthDate)
  const event = new Date(eventDate)
  const age = event.getFullYear() - birth.getFullYear()
  const monthDiff = event.getMonth() - birth.getMonth()
  if (monthDiff < 0 || (monthDiff === 0 && event.getDate() < birth.getDate())) {
    return age - 1 < 18
  }
  return age < 18
}
```

- [ ] **Step 3: Commit**

```bash
git add public/src/pages/Checkin.jsx
git commit -m "feat(public): add participant self-service check-in page with QR code"
```

### Task 21: Build admin check-in page (QR scan + manual)

**Files:**
- Create: `public/src/pages/AdminCheckin.jsx`

- [ ] **Step 1: Create AdminCheckin.jsx**

Flow:
1. PIN gate: prompt for 4-6 digit PIN, validate via Supabase RPC `verify_checkin_pin(event_id, pin)`
2. Store PIN in sessionStorage
3. Two-mode entry:
   - QR scan: use `html5-qrcode` to open camera, scan QR, extract participant ID
   - Manual search: text input, search participants by name or bib number
4. After participant identified:
   - Validate `participant.event_id` matches current event
   - Show participant card: name, BIB NUMBER (large), category
   - Fetch `event_documents` + `checkin_documents` for this participant
   - Show document status: ✓ completed / ✗ not completed
   - For incomplete `provide` docs: checkbox that admin must tick
   - For incomplete `acknowledge` docs (manual fallback): checkbox admin can tick
5. "Zamelduj" button → calls Supabase RPC `checkin_confirm(participant_id, pin, documents_json)`
6. Success flash → auto-return to scan/search

The full component will be ~250-300 lines.

- [ ] **Step 2: Commit**

```bash
git add public/src/pages/AdminCheckin.jsx
git commit -m "feat(public): add admin check-in page with QR scan, manual search, and PIN gate"
```

### Task 22: Verify public app runs locally

- [ ] **Step 1: Start the public app**

```bash
cd public && npm run dev
```

Expected: Vite dev server on port 5173

- [ ] **Step 2: Test routes**

- `http://localhost:5173/` — should show event list
- `http://localhost:5173/{slug}/results` — should show results
- `http://localhost:5173/{slug}/checkin?p={id}` — should show check-in flow
- `http://localhost:5173/{slug}/admin/checkin` — should show PIN prompt

- [ ] **Step 3: Commit any fixes**

---

## Chunk 5: Cleanup and Documentation

### Task 23: Route check-in through Supabase and deprecate old columns

**Files:**
- Modify: `backend/src/routes/participants.js`
- Modify: `backend/src/db/schema.js`

- [ ] **Step 1: Add backend endpoint for admin check-in via Supabase**

Create a new endpoint in `backend/src/routes/participants.js` that writes check-in data to Supabase using the service_role client:

```javascript
// Admin check-in (writes to Supabase, reverse sync pulls to local)
fastify.post('/participants/:id/checkin', async (req, reply) => {
  const { documents } = req.body || {}  // [{ documentId, completedBy }]
  const participant = await db.query.participants.findFirst({
    where: eq(participants.id, req.params.id),
  })
  if (!participant) return reply.code(404).send({ error: 'Participant not found' })

  const supabase = getSupabase()
  if (!supabase) return reply.code(503).send({ error: 'Supabase not configured' })

  // Upsert checkins row
  const { data: checkin, error: checkinError } = await supabase
    .from('checkins')
    .upsert({
      participant_id: participant.id,
      event_id: participant.eventId,
      checked_in_at: new Date().toISOString(),
    }, { onConflict: 'participant_id' })
    .select()
    .single()

  if (checkinError) return reply.code(500).send({ error: checkinError.message })

  // Insert document completions if provided
  if (documents?.length) {
    const docRows = documents.map(d => ({
      checkin_id: checkin.id,
      document_id: d.documentId,
      completed_at: new Date().toISOString(),
      completed_by: d.completedBy || 'admin',
    }))
    await supabase.from('checkin_documents').upsert(docRows, { onConflict: 'checkin_id,document_id' })
  }

  return { data: checkin }
})
```

Import `getSupabase` helper (same pattern as `eventSecrets.js`) or share it via a utility module.

- [ ] **Step 2: Update participants list to include checkin data**

Update `GET /events/:eventId/participants` in `participants.js` to join with checkins:

```javascript
const rows = await db.query.participants.findMany({
  where: eq(participants.eventId, req.params.eventId),
  with: { category: true, checkin: true },
  orderBy: participants.bibNumber,
})
```

This requires the `participantsRelations` update from Task 1 Step 8 (adding `checkin` relation).

- [ ] **Step 3: Remove `checkedIn` from PATCH allowed fields**

In the PATCH handler (line 45), remove `'checkedIn'` from the allowed array. Remove the `checkedInAt` auto-set logic (line 50). Check-in now goes through the new `POST /participants/:id/checkin` endpoint.

- [ ] **Step 4: Remove `checkedIn` and `checkedInAt` from Drizzle schema**

In `backend/src/db/schema.js`, remove these lines from the participants table:
```javascript
checkedIn: boolean('checked_in').notNull().default(false),
checkedInAt: timestamp('checked_in_at', { withTimezone: true }),
```

- [ ] **Step 5: Create migration to drop old columns**

Create `backend/src/db/migrations/0015_drop_checked_in.sql`:

```sql
-- Migrate existing checked_in data to checkins table
INSERT INTO checkins (participant_id, event_id, checked_in_at)
SELECT p.id, p.event_id, p.checked_in_at
FROM participants p
WHERE p.checked_in = true AND p.checked_in_at IS NOT NULL
ON CONFLICT (participant_id) DO NOTHING;

-- Drop old columns
ALTER TABLE participants DROP COLUMN checked_in;
ALTER TABLE participants DROP COLUMN checked_in_at;
```

Add journal entry (idx 15, tag `0015_drop_checked_in`).

- [ ] **Step 6: Add checkin endpoint to frontend API client**

In `frontend/src/lib/api.js`, add to the participants section:

```javascript
checkin: (id, documents) => request('POST', `/participants/${id}/checkin`, { documents }),
```

- [ ] **Step 7: Commit**

```bash
git add backend/src/routes/participants.js backend/src/db/schema.js backend/src/db/migrations/0015_drop_checked_in.sql backend/src/db/migrations/meta/_journal.json frontend/src/lib/api.js
git commit -m "refactor(participants): route check-in through Supabase, deprecate checked_in columns"
```

### Task 24: Update CLAUDE.md and ARCHITECTURE.md

**Files:**
- Modify: `CLAUDE.md`
- Modify: `ARCHITECTURE.md`

- [ ] **Step 1: Update CLAUDE.md**

Add to relevant sections:
- Monorepo structure: add `public/` app
- Environment variables: add `SMSAPI_TOKEN`, `SMSAPI_SENDER`
- Supabase sync section: document the reverse sync exception for `checkins` and `checkin_documents`
- Add `event_secrets` to Supabase-only tables
- Document new API endpoints

- [ ] **Step 2: Update ARCHITECTURE.md**

Update sync architecture to show the reverse sync flow for check-in data.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md ARCHITECTURE.md
git commit -m "docs: update CLAUDE.md and ARCHITECTURE.md for SMS check-in feature"
```

### Task 25: Remove old apps (Phase 2, after deploy verification)

**Files:**
- Delete: `liveresults/` directory
- Delete: `volunteer/` directory
- Modify: `package.json` (root — remove `liveresults` from workspaces; `volunteer` was never in workspaces)

**IMPORTANT:** Only do this after verifying the `public/` app is deployed and working on Vercel. This is a separate deployment step.

- [ ] **Step 1: Verify public/ works on Vercel**
- [ ] **Step 2: Remove liveresults/ and volunteer/ directories**
- [ ] **Step 3: Update root package.json workspaces**
- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: remove liveresults/ and volunteer/ (replaced by public/)"
```
