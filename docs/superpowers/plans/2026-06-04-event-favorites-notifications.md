# Event Favorites (Star) + Notifications + Club Visibility — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Logged-in users star calendar events, get in-app notifications for exactly three changes (cancelled / registration opened / deadline within 7 days), opt into a weekly email digest, and see which events club-mates follow; cancelled events become publicly visible with an ODWOŁANY badge.

**Architecture:** Fan-in notifications — one `event_notifications` row per event change (DB trigger + daily script), user feeds computed at read time. Custom cookie auth (`leszy_session` → `_shared/session.js`) means all authenticated reads/writes go through Supabase Edge Functions with service_role; both new tables have RLS enabled with zero policies. Weekly digest + daily deadline check run as backend scripts orchestrated by the existing `scheduler` container.

**Tech Stack:** Supabase (Postgres + Deno Edge Functions, deployed via `mcp__supabase__deploy_edge_function`), React/Vite public app, `node --test` for edge-function tests, Playwright for e2e, SendGrid v3 API, node-cron in scheduler.

**Spec:** `docs/superpowers/specs/2026-06-04-event-favorites-notifications-design.md`

**Conventions that bind every task:**
- Plain JavaScript only — no TypeScript.
- Edge functions follow the exact pattern of `supabase/functions/update-profile/index.js`: `json()` helper, `getCorsHeaders`/`handleOptions` from `../_shared/cors.js`, `getSession` from `../_shared/session.js`, service-role client from env.
- Edge-function tests follow `supabase/functions/tests/update-profile.test.js` style using `supabase/functions/tests/helpers.js` (`createTestSession`, `cleanupUser`, `callFunction`, `supabaseAdmin`).
- Run a single test file from `public/`: `node --env-file=../.env --env-file=.env --test ../supabase/functions/tests/<file>.test.js` (two env files: repo-root `.env` has `SUPABASE_SERVICE_ROLE_KEY`, `public/.env` has `VITE_SUPABASE_URL`; node accepts multiple `--env-file` flags — if either file lacks the var the other provides it). Full suite: `cd public && npm run test:functions`.
- Deploy edge functions with `mcp__supabase__deploy_edge_function` (NOT the CLI). Migrations with `mcp__supabase__apply_migration` — these tables are Supabase-only, **no Drizzle migration, no local Postgres changes**.
- All UI text in Polish, OVERDRIVE theme (rounded-none, `apex-*` tokens, border-style buttons).
- Git commits: no `Co-Authored-By` trailers.

---

### Task 1: Supabase migration — tables, profile columns, trigger

**Files:**
- No repo files. Apply via `mcp__supabase__apply_migration` with name `event_favorites_notifications`.

- [ ] **Step 1: Apply the migration**

Call `mcp__supabase__apply_migration` with name `event_favorites_notifications` and this SQL:

```sql
-- Star/follow shortlist
CREATE TABLE event_favorites (
  user_id    UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  event_id   UUID NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, event_id)
);
CREATE INDEX event_favorites_event_idx ON event_favorites(event_id);
-- No policies on purpose: custom cookie auth has no auth.uid(); only
-- service_role (edge functions / backend scripts) may read or write.
ALTER TABLE event_favorites ENABLE ROW LEVEL SECURITY;

-- Event-level notification log (fan-in: one row per event change, never per user)
CREATE TABLE event_notifications (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id   UUID NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  type       TEXT NOT NULL CHECK (type IN ('cancelled', 'registration_opened', 'deadline_soon')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, type)
);
CREATE INDEX event_notifications_event_idx ON event_notifications(event_id);
ALTER TABLE event_notifications ENABLE ROW LEVEL SECURITY;

-- Per-user notification cursor + digest opt-in
ALTER TABLE profiles
  ADD COLUMN notifications_seen_at TIMESTAMPTZ,
  ADD COLUMN weekly_digest BOOLEAN NOT NULL DEFAULT false;

-- Club visibility of favorites: ON by default (opt-out)
UPDATE profiles SET privacy_settings = privacy_settings || '{"favorites": true}'::jsonb;
ALTER TABLE profiles ALTER COLUMN privacy_settings
  SET DEFAULT '{"bio": true, "club": true, "display_name": true, "favorites": true}'::jsonb;

-- Notify on exactly two transitions; ignores pipeline timestamp noise by construction.
-- SECURITY DEFINER so the insert succeeds regardless of which role updates calendar_events.
CREATE OR REPLACE FUNCTION notify_calendar_event_changes() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled' THEN
    INSERT INTO event_notifications (event_id, type) VALUES (NEW.id, 'cancelled')
    ON CONFLICT (event_id, type) DO NOTHING;
  END IF;
  IF (OLD.registration_url IS NULL OR OLD.registration_url = '')
     AND NEW.registration_url IS NOT NULL AND NEW.registration_url <> '' THEN
    INSERT INTO event_notifications (event_id, type) VALUES (NEW.id, 'registration_opened')
    ON CONFLICT (event_id, type) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_notify_calendar_event_changes
AFTER UPDATE ON calendar_events
FOR EACH ROW EXECUTE FUNCTION notify_calendar_event_changes();
```

- [ ] **Step 2: Verify**

Run via `mcp__supabase__execute_sql`:

```sql
SELECT
  (SELECT count(*) FROM event_favorites) AS favs,
  (SELECT count(*) FROM event_notifications) AS notifs,
  (SELECT count(*) FROM profiles WHERE privacy_settings->>'favorites' = 'true') AS profiles_with_flag,
  (SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_notify_calendar_event_changes') AS trigger_count;
```

Expected: `favs=0`, `notifs=0`, `profiles_with_flag` = total profile count (currently 4), `trigger_count=1`.

- [ ] **Step 3: Commit a paper trail**

There are no repo file changes in this task; the migration lives in Supabase. Skip the commit — Task 2's test file documents the trigger behavior in-repo.

---

### Task 2: Trigger behavior tests

**Files:**
- Create: `supabase/functions/tests/event-notifications-trigger.test.js`

- [ ] **Step 1: Write the tests**

```js
// supabase/functions/tests/event-notifications-trigger.test.js
// Verifies the trg_notify_calendar_event_changes trigger on calendar_events.
import test from 'node:test'
import assert from 'node:assert/strict'
import { supabaseAdmin } from './helpers.js'

async function createTestEvent(overrides = {}) {
  const { data, error } = await supabaseAdmin
    .from('calendar_events')
    .insert({
      name: `Trigger Test Bieg ${Date.now()}`,
      date: '2030-01-01',
      source: 'test',
      source_id: `trigger-test-${crypto.randomUUID()}`,
      status: 'active',
      ...overrides,
    })
    .select('id')
    .single()
  if (error) throw error
  return data.id
}

async function notifCount(eventId, type) {
  const { count, error } = await supabaseAdmin
    .from('event_notifications')
    .select('id', { count: 'exact', head: true })
    .eq('event_id', eventId)
    .eq('type', type)
  if (error) throw error
  return count
}

async function cleanup(eventId) {
  // cascade removes event_notifications
  await supabaseAdmin.from('calendar_events').delete().eq('id', eventId)
}

test('status -> cancelled fires exactly once, even after re-cancel', async () => {
  const id = await createTestEvent()
  try {
    await supabaseAdmin.from('calendar_events').update({ status: 'cancelled' }).eq('id', id)
    assert.equal(await notifCount(id, 'cancelled'), 1)

    // flip back and re-cancel — unique constraint keeps it at 1
    await supabaseAdmin.from('calendar_events').update({ status: 'active' }).eq('id', id)
    await supabaseAdmin.from('calendar_events').update({ status: 'cancelled' }).eq('id', id)
    assert.equal(await notifCount(id, 'cancelled'), 1)
  } finally {
    await cleanup(id)
  }
})

test('status -> rejected does NOT fire', async () => {
  const id = await createTestEvent()
  try {
    await supabaseAdmin.from('calendar_events').update({ status: 'rejected' }).eq('id', id)
    assert.equal(await notifCount(id, 'cancelled'), 0)
  } finally {
    await cleanup(id)
  }
})

test('registration_url NULL -> value fires; value -> value does not', async () => {
  const id = await createTestEvent()
  try {
    await supabaseAdmin.from('calendar_events')
      .update({ registration_url: 'https://example.com/zapisy' }).eq('id', id)
    assert.equal(await notifCount(id, 'registration_opened'), 1)

    await supabaseAdmin.from('calendar_events')
      .update({ registration_url: 'https://example.com/zapisy-v2' }).eq('id', id)
    assert.equal(await notifCount(id, 'registration_opened'), 1)
  } finally {
    await cleanup(id)
  }
})

test('event created WITH registration_url never fires registration_opened on later edits', async () => {
  const id = await createTestEvent({ registration_url: 'https://example.com/zapisy' })
  try {
    await supabaseAdmin.from('calendar_events')
      .update({ registration_url: 'https://example.com/other' }).eq('id', id)
    assert.equal(await notifCount(id, 'registration_opened'), 0)
  } finally {
    await cleanup(id)
  }
})

test('pipeline-style touch (timestamps only) fires nothing', async () => {
  const id = await createTestEvent()
  try {
    await supabaseAdmin.from('calendar_events')
      .update({ updated_at: new Date().toISOString(), enriched_at: new Date().toISOString() })
      .eq('id', id)
    const { count } = await supabaseAdmin
      .from('event_notifications')
      .select('id', { count: 'exact', head: true })
      .eq('event_id', id)
    assert.equal(count, 0)
  } finally {
    await cleanup(id)
  }
})
```

- [ ] **Step 2: Run the tests**

```bash
cd public && node --env-file=../.env --env-file=.env --test ../supabase/functions/tests/event-notifications-trigger.test.js
```

Expected: all 5 tests PASS (migration from Task 1 is already live).

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/tests/event-notifications-trigger.test.js
git commit -m "test(notifications): trigger fires on cancel + registration-opened transitions only"
```

---

### Task 3: `toggle-favorite` edge function

**Files:**
- Create: `supabase/functions/toggle-favorite/index.js`
- Test: `supabase/functions/tests/toggle-favorite.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// supabase/functions/tests/toggle-favorite.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { createTestSession, cleanupUser, callFunction, supabaseAdmin } from './helpers.js'

async function createTestEvent(status = 'active') {
  const { data, error } = await supabaseAdmin
    .from('calendar_events')
    .insert({
      name: `Fav Test Bieg ${Date.now()}`,
      date: '2030-01-01',
      source: 'test',
      source_id: `fav-test-${crypto.randomUUID()}`,
      status,
    })
    .select('id')
    .single()
  if (error) throw error
  return data.id
}

test('toggle-favorite stars then unstars', async () => {
  const { user, sessionToken } = await createTestSession('fav')
  const eventId = await createTestEvent()
  try {
    const on = await callFunction('toggle-favorite', { event_id: eventId }, sessionToken)
    assert.equal(on.status, 200)
    assert.equal(on.data.starred, true)

    const { count } = await supabaseAdmin
      .from('event_favorites')
      .select('event_id', { count: 'exact', head: true })
      .eq('user_id', user.id)
    assert.equal(count, 1)

    const off = await callFunction('toggle-favorite', { event_id: eventId }, sessionToken)
    assert.equal(off.data.starred, false)

    const { count: after } = await supabaseAdmin
      .from('event_favorites')
      .select('event_id', { count: 'exact', head: true })
      .eq('user_id', user.id)
    assert.equal(after, 0)
  } finally {
    await supabaseAdmin.from('calendar_events').delete().eq('id', eventId)
    await cleanupUser(user.id)
  }
})

test('toggle-favorite requires auth', async () => {
  const res = await callFunction('toggle-favorite', { event_id: crypto.randomUUID() })
  assert.equal(res.status, 401)
})

test('toggle-favorite rejects unknown and rejected events', async () => {
  const { user, sessionToken } = await createTestSession('fav404')
  const rejectedId = await createTestEvent('rejected')
  try {
    const unknown = await callFunction('toggle-favorite', { event_id: crypto.randomUUID() }, sessionToken)
    assert.equal(unknown.status, 404)

    const rejected = await callFunction('toggle-favorite', { event_id: rejectedId }, sessionToken)
    assert.equal(rejected.status, 404)
  } finally {
    await supabaseAdmin.from('calendar_events').delete().eq('id', rejectedId)
    await cleanupUser(user.id)
  }
})

test('toggle-favorite allows starring a cancelled event', async () => {
  const { user, sessionToken } = await createTestSession('favcanc')
  const eventId = await createTestEvent('cancelled')
  try {
    const res = await callFunction('toggle-favorite', { event_id: eventId }, sessionToken)
    assert.equal(res.status, 200)
    assert.equal(res.data.starred, true)
  } finally {
    await supabaseAdmin.from('calendar_events').delete().eq('id', eventId)
    await cleanupUser(user.id)
  }
})
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd public && node --env-file=../.env --env-file=.env --test ../supabase/functions/tests/toggle-favorite.test.js
```

Expected: FAIL — the function doesn't exist yet (404/not-found responses instead of expected statuses).

- [ ] **Step 3: Write the function**

```js
// supabase/functions/toggle-favorite/index.js
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, handleOptions } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'

function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  const optRes = handleOptions(req)
  if (optRes) return optRes

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL'),
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  const session = await getSession(req, supabaseAdmin)
  if (!session) return json({ error: 'Authorization required' }, 401, req)

  try {
    const { event_id } = await req.json()
    if (!event_id) return json({ error: 'event_id required' }, 400, req)

    // Only events visible in the public UI can be starred
    const { data: event } = await supabaseAdmin
      .from('calendar_events')
      .select('id, status')
      .eq('id', event_id)
      .single()
    if (!event || !['active', 'cancelled'].includes(event.status)) {
      return json({ error: 'Event not found' }, 404, req)
    }

    const { data: existing } = await supabaseAdmin
      .from('event_favorites')
      .select('event_id')
      .eq('user_id', session.userId)
      .eq('event_id', event_id)
      .maybeSingle()

    if (existing) {
      const { error } = await supabaseAdmin
        .from('event_favorites')
        .delete()
        .eq('user_id', session.userId)
        .eq('event_id', event_id)
      if (error) return json({ error: 'Delete failed' }, 500, req)
      return json({ starred: false }, 200, req)
    }

    const { error } = await supabaseAdmin
      .from('event_favorites')
      .insert({ user_id: session.userId, event_id })
    // 23505 = unique violation (double-click race) — treat as already starred
    if (error && error.code !== '23505') return json({ error: 'Insert failed' }, 500, req)
    return json({ starred: true }, 200, req)
  } catch {
    return json({ error: 'Invalid request' }, 400, req)
  }
})
```

- [ ] **Step 4: Deploy and run tests — verify they pass**

Deploy via `mcp__supabase__deploy_edge_function` with name `toggle-favorite`, entrypoint `index.js`, and the file content above. Then:

```bash
cd public && node --env-file=../.env --env-file=.env --test ../supabase/functions/tests/toggle-favorite.test.js
```

Expected: all 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/toggle-favorite/ supabase/functions/tests/toggle-favorite.test.js
git commit -m "feat(favorites): toggle-favorite edge function"
```

---

### Task 4: `get-favorites` edge function (own stars + club counts)

**Files:**
- Create: `supabase/functions/get-favorites/index.js`
- Test: `supabase/functions/tests/get-favorites.test.js`

- [ ] **Step 1: Write the failing tests**

Club setup note: `clubs` requires `name` + unique `normalized_name` (see the clubs spec). Generate unique names per run.

```js
// supabase/functions/tests/get-favorites.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { createTestSession, cleanupUser, callFunction, supabaseAdmin } from './helpers.js'

async function createTestEvent() {
  const { data, error } = await supabaseAdmin
    .from('calendar_events')
    .insert({
      name: `GetFav Test Bieg ${Date.now()}`,
      date: '2030-01-01',
      source: 'test',
      source_id: `getfav-test-${crypto.randomUUID()}`,
      status: 'active',
    })
    .select('id')
    .single()
  if (error) throw error
  return data.id
}

async function createClub() {
  const name = `Test Klub ${crypto.randomUUID().slice(0, 8)}`
  const { data, error } = await supabaseAdmin
    .from('clubs')
    .insert({ name, normalized_name: name.toLowerCase() })
    .select('id')
    .single()
  if (error) throw error
  return data.id
}

test('get-favorites returns own starred events and club counts respecting privacy', async () => {
  const clubId = await createClub()
  const otherClubId = await createClub()
  const me = await createTestSession('gf-me')
  const mate = await createTestSession('gf-mate')        // same club, default privacy
  const hiddenMate = await createTestSession('gf-hidden') // same club, favorites=false
  const stranger = await createTestSession('gf-stranger') // different club
  const eventId = await createTestEvent()

  try {
    await supabaseAdmin.from('profiles').update({ club_id: clubId }).eq('id', me.user.id)
    await supabaseAdmin.from('profiles').update({ club_id: clubId }).eq('id', mate.user.id)
    await supabaseAdmin.from('profiles')
      .update({ club_id: clubId, privacy_settings: { favorites: false } })
      .eq('id', hiddenMate.user.id)
    await supabaseAdmin.from('profiles').update({ club_id: otherClubId }).eq('id', stranger.user.id)

    // everyone stars the same event
    for (const u of [me, mate, hiddenMate, stranger]) {
      await supabaseAdmin.from('event_favorites').insert({ user_id: u.user.id, event_id: eventId })
    }

    const res = await callFunction('get-favorites', {}, me.sessionToken)
    assert.equal(res.status, 200)

    // own list contains the event with details
    assert.equal(res.data.events.length, 1)
    assert.equal(res.data.events[0].id, eventId)
    assert.ok(res.data.events[0].name)
    assert.equal(res.data.events[0].status, 'active')

    // club count: only `mate` counts — not me, not hiddenMate (privacy off), not stranger (other club)
    assert.equal(res.data.clubCounts[eventId], 1)
  } finally {
    await supabaseAdmin.from('calendar_events').delete().eq('id', eventId)
    for (const u of [me, mate, hiddenMate, stranger]) await cleanupUser(u.user.id)
    await supabaseAdmin.from('clubs').delete().in('id', [clubId, otherClubId])
  }
})

test('get-favorites without club returns empty clubCounts', async () => {
  const me = await createTestSession('gf-noclub')
  try {
    const res = await callFunction('get-favorites', {}, me.sessionToken)
    assert.equal(res.status, 200)
    assert.deepEqual(res.data.events, [])
    assert.deepEqual(res.data.clubCounts, {})
  } finally {
    await cleanupUser(me.user.id)
  }
})

test('get-favorites requires auth', async () => {
  const res = await callFunction('get-favorites', {})
  assert.equal(res.status, 401)
})
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd public && node --env-file=../.env --env-file=.env --test ../supabase/functions/tests/get-favorites.test.js
```

Expected: FAIL (function does not exist).

- [ ] **Step 3: Write the function**

```js
// supabase/functions/get-favorites/index.js
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, handleOptions } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'

function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  const optRes = handleOptions(req)
  if (optRes) return optRes

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL'),
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  const session = await getSession(req, supabaseAdmin)
  if (!session) return json({ error: 'Authorization required' }, 401, req)

  // Own starred events with display details (rejected events drop out here)
  const { data: favs } = await supabaseAdmin
    .from('event_favorites')
    .select('created_at, calendar_events(id, name, date, location, status, registration_deadline, registration_url)')
    .eq('user_id', session.userId)
    .order('created_at', { ascending: false })

  const events = (favs ?? [])
    .map((f) => f.calendar_events)
    .filter((e) => e && ['active', 'cancelled'].includes(e.status))

  // Club counts: favorites of OTHER members of my club who haven't opted out
  const clubCounts = {}
  const { data: me } = await supabaseAdmin
    .from('profiles')
    .select('club_id')
    .eq('id', session.userId)
    .single()

  if (me?.club_id) {
    const { data: mates } = await supabaseAdmin
      .from('profiles')
      .select('id, privacy_settings')
      .eq('club_id', me.club_id)
      .neq('id', session.userId)
      .is('deleted_at', null)

    const visibleIds = (mates ?? [])
      .filter((m) => (m.privacy_settings?.favorites ?? true) !== false)
      .map((m) => m.id)

    if (visibleIds.length) {
      const { data: mateFavs } = await supabaseAdmin
        .from('event_favorites')
        .select('event_id')
        .in('user_id', visibleIds)
      for (const f of mateFavs ?? []) {
        clubCounts[f.event_id] = (clubCounts[f.event_id] || 0) + 1
      }
    }
  }

  return json({ events, clubCounts }, 200, req)
})
```

- [ ] **Step 4: Deploy and run tests — verify they pass**

Deploy via `mcp__supabase__deploy_edge_function` (name `get-favorites`), then re-run the Step 2 command. Expected: all 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/get-favorites/ supabase/functions/tests/get-favorites.test.js
git commit -m "feat(favorites): get-favorites edge function with club visibility counts"
```

---

### Task 5: `get-notifications` edge function (feed + unseen cursor)

**Files:**
- Create: `supabase/functions/get-notifications/index.js`
- Test: `supabase/functions/tests/get-notifications.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// supabase/functions/tests/get-notifications.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { createTestSession, cleanupUser, callFunction, supabaseAdmin } from './helpers.js'

async function createTestEvent() {
  const { data, error } = await supabaseAdmin
    .from('calendar_events')
    .insert({
      name: `Notif Test Bieg ${Date.now()}`,
      date: '2030-01-01',
      source: 'test',
      source_id: `notif-test-${crypto.randomUUID()}`,
      status: 'active',
    })
    .select('id')
    .single()
  if (error) throw error
  return data.id
}

test('feed shows notifications created after starring, not before', async () => {
  const me = await createTestSession('gn')
  const earlyEvent = await createTestEvent()  // notification BEFORE star
  const lateEvent = await createTestEvent()   // notification AFTER star
  try {
    // earlyEvent: notification exists before the user stars it
    await supabaseAdmin.from('event_notifications')
      .insert({ event_id: earlyEvent, type: 'registration_opened' })
    await supabaseAdmin.from('event_favorites')
      .insert({ user_id: me.user.id, event_id: earlyEvent })

    // lateEvent: starred first (created_at in the past), notification after
    await supabaseAdmin.from('event_favorites')
      .insert({ user_id: me.user.id, event_id: lateEvent, created_at: new Date(Date.now() - 60_000).toISOString() })
    await supabaseAdmin.from('event_notifications')
      .insert({ event_id: lateEvent, type: 'cancelled' })

    const res = await callFunction('get-notifications', {}, me.sessionToken)
    assert.equal(res.status, 200)
    assert.equal(res.data.notifications.length, 1)
    assert.equal(res.data.notifications[0].event_id, lateEvent)
    assert.equal(res.data.notifications[0].type, 'cancelled')
    assert.ok(res.data.notifications[0].event_name)
    assert.equal(res.data.unseenCount, 1)
  } finally {
    await supabaseAdmin.from('calendar_events').delete().in('id', [earlyEvent, lateEvent])
    await cleanupUser(me.user.id)
  }
})

test('markSeen zeroes unseenCount on next read', async () => {
  const me = await createTestSession('gn-seen')
  const eventId = await createTestEvent()
  try {
    await supabaseAdmin.from('event_favorites')
      .insert({ user_id: me.user.id, event_id: eventId, created_at: new Date(Date.now() - 60_000).toISOString() })
    await supabaseAdmin.from('event_notifications')
      .insert({ event_id: eventId, type: 'deadline_soon' })

    const first = await callFunction('get-notifications', { markSeen: true }, me.sessionToken)
    assert.equal(first.data.unseenCount, 1) // counted against the PRE-markSeen cursor

    const second = await callFunction('get-notifications', {}, me.sessionToken)
    assert.equal(second.data.notifications.length, 1) // feed still shows it
    assert.equal(second.data.unseenCount, 0)           // but it's seen now
  } finally {
    await supabaseAdmin.from('calendar_events').delete().eq('id', eventId)
    await cleanupUser(me.user.id)
  }
})

test('get-notifications requires auth', async () => {
  const res = await callFunction('get-notifications', {})
  assert.equal(res.status, 401)
})
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd public && node --env-file=../.env --env-file=.env --test ../supabase/functions/tests/get-notifications.test.js
```

Expected: FAIL (function does not exist).

- [ ] **Step 3: Write the function**

```js
// supabase/functions/get-notifications/index.js
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, handleOptions } from '../_shared/cors.js'
import { getSession } from '../_shared/session.js'

function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  const optRes = handleOptions(req)
  if (optRes) return optRes

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL'),
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  const session = await getSession(req, supabaseAdmin)
  if (!session) return json({ error: 'Authorization required' }, 401, req)

  let markSeen = false
  try {
    const body = await req.json()
    markSeen = body?.markSeen === true
  } catch { /* empty body is fine */ }

  const [{ data: profile }, { data: favs }] = await Promise.all([
    supabaseAdmin.from('profiles').select('notifications_seen_at').eq('id', session.userId).single(),
    supabaseAdmin.from('event_favorites').select('event_id, created_at').eq('user_id', session.userId),
  ])

  const favMap = new Map((favs ?? []).map((f) => [f.event_id, f.created_at]))
  let notifications = []

  if (favMap.size) {
    const { data: notifs } = await supabaseAdmin
      .from('event_notifications')
      .select('id, event_id, type, created_at, calendar_events(name, date, status)')
      .in('event_id', [...favMap.keys()])
      .order('created_at', { ascending: false })
      .limit(50)

    notifications = (notifs ?? [])
      // never notify about things that happened before the user starred
      .filter((n) => new Date(n.created_at) > new Date(favMap.get(n.event_id)))
      .map((n) => ({
        id: n.id,
        event_id: n.event_id,
        type: n.type,
        created_at: n.created_at,
        event_name: n.calendar_events?.name ?? null,
        event_date: n.calendar_events?.date ?? null,
      }))
  }

  const seenAt = profile?.notifications_seen_at
  const unseenCount = notifications
    .filter((n) => !seenAt || new Date(n.created_at) > new Date(seenAt)).length

  if (markSeen) {
    await supabaseAdmin
      .from('profiles')
      .update({ notifications_seen_at: new Date().toISOString() })
      .eq('id', session.userId)
  }

  return json({ notifications, unseenCount }, 200, req)
})
```

- [ ] **Step 4: Deploy and run tests — verify they pass**

Deploy via `mcp__supabase__deploy_edge_function` (name `get-notifications`), then re-run the Step 2 command. Expected: all 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/get-notifications/ supabase/functions/tests/get-notifications.test.js
git commit -m "feat(notifications): get-notifications edge function — fan-in feed + seen cursor"
```

---

### Task 6: `weekly_digest` in update-profile / get-profile-data; favorites in export + account deletion

**Files:**
- Modify: `supabase/functions/update-profile/index.js` (accept `weekly_digest`)
- Modify: `supabase/functions/get-profile-data/index.js` (select `weekly_digest`)
- Modify: `supabase/functions/export-my-data/index.js` (include favorites + `weekly_digest`)
- Modify: `supabase/functions/delete-my-account/index.js` (delete `event_favorites` rows)
- Test: extend `supabase/functions/tests/update-profile.test.js` and `supabase/functions/tests/export-my-data.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `supabase/functions/tests/update-profile.test.js` (reuse that file's existing imports/helpers):

```js
test('update-profile accepts weekly_digest boolean and rejects non-boolean', async () => {
  const { user, sessionToken } = await createTestSession('digest')
  try {
    const ok = await callFunction('update-profile', { weekly_digest: true }, sessionToken)
    assert.equal(ok.status, 200)
    assert.equal(ok.data.data.weekly_digest, true)

    const bad = await callFunction('update-profile', { weekly_digest: 'yes' }, sessionToken)
    assert.equal(bad.status, 400)
  } finally {
    await cleanupUser(user.id)
  }
})
```

Append to `supabase/functions/tests/export-my-data.test.js` (reuse its imports; create a calendar event + favorite inside the test):

```js
test('export includes event favorites and weekly_digest', async () => {
  const { user, sessionToken } = await createTestSession('export-fav')
  const { data: ev } = await supabaseAdmin.from('calendar_events')
    .insert({
      name: `Export Fav Bieg ${Date.now()}`, date: '2030-01-01',
      source: 'test', source_id: `export-fav-${crypto.randomUUID()}`, status: 'active',
    })
    .select('id').single()
  try {
    await supabaseAdmin.from('event_favorites').insert({ user_id: user.id, event_id: ev.id })
    const res = await callFunction('export-my-data', {}, sessionToken)
    assert.equal(res.status, 200)
    assert.ok(Array.isArray(res.data.favorites))
    assert.equal(res.data.favorites.length, 1)
    assert.ok('weekly_digest' in res.data.profile)
  } finally {
    await supabaseAdmin.from('calendar_events').delete().eq('id', ev.id)
    await cleanupUser(user.id)
  }
})
```

Note: adjust the export assertion shape to the file's actual response structure after reading `export-my-data/index.js` — if the export nests sections differently (e.g. `res.data.data.favorites`), match it; the requirement is: favorites array + weekly_digest present somewhere in the export payload.

- [ ] **Step 2: Run tests — verify the new ones fail**

```bash
cd public && node --env-file=../.env --env-file=.env --test ../supabase/functions/tests/update-profile.test.js ../supabase/functions/tests/export-my-data.test.js
```

Expected: existing tests PASS, the two new tests FAIL.

- [ ] **Step 3: Implement**

In `update-profile/index.js`:
1. Add `weekly_digest` to the destructured body fields.
2. Add validation next to the other validators:
```js
if (weekly_digest !== undefined && typeof weekly_digest !== 'boolean') {
  return json({ error: 'weekly_digest musi być wartością logiczną' }, 400, req)
}
```
3. Add to the updates object: `if (weekly_digest !== undefined) updates.weekly_digest = weekly_digest`
4. Ensure the post-update select returned to the client includes `weekly_digest` (mirror however the function selects the updated row).

In `get-profile-data/index.js`: add `weekly_digest` to the profiles select string (after `voivodeship`).

In `export-my-data/index.js`: add a query for the user's favorites and include in the response, plus add `weekly_digest` to the profile select:
```js
const { data: favorites } = await supabaseAdmin
  .from('event_favorites')
  .select('event_id, created_at, calendar_events(name, date)')
  .eq('user_id', session.userId)
```

In `delete-my-account/index.js`: next to the existing per-table cleanup, add:
```js
await supabaseAdmin.from('event_favorites').delete().eq('user_id', session.userId)
```
(The profile row is soft-deleted via `deleted_at`, so the FK cascade never fires — favorites must be deleted explicitly for GDPR erasure.)

- [ ] **Step 4: Deploy and run tests — verify they pass**

Deploy all four modified functions via `mcp__supabase__deploy_edge_function` (`update-profile`, `get-profile-data`, `export-my-data`, `delete-my-account`). Re-run the Step 2 command plus:

```bash
cd public && node --env-file=../.env --env-file=.env --test ../supabase/functions/tests/delete-my-account.test.js
```

Expected: all PASS (including pre-existing tests — no regressions).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/update-profile/ supabase/functions/get-profile-data/ supabase/functions/export-my-data/ supabase/functions/delete-my-account/ supabase/functions/tests/update-profile.test.js supabase/functions/tests/export-my-data.test.js
git commit -m "feat(profile): weekly_digest setting; favorites in GDPR export and account deletion"
```

---

### Task 7: `useFavorites` hook + `StarButton` component

**Files:**
- Create: `public/src/hooks/useFavorites.js`
- Create: `public/src/components/StarButton.jsx`

- [ ] **Step 1: Write the hook**

Module-level cache mirroring `useAuth.js` (`public/src/hooks/useAuth.js`), extended with a listener set so every mounted StarButton re-renders on toggle:

```js
// public/src/hooks/useFavorites.js
import { useState, useEffect } from 'react'
import { callFunction } from '../lib/auth.js'
import useAuth from './useAuth.js'

// Module-level cache: get-favorites is fetched once per page load and shared
// across all StarButton mounts. `undefined` = not fetched yet.
let cache
let inflight = null
const listeners = new Set()

function notifyAll() { listeners.forEach((fn) => fn()) }

/** Reset after login/logout without a full reload. */
export function clearFavoritesCache() {
  cache = undefined
  inflight = null
}

export default function useFavorites() {
  const { user } = useAuth()
  const [, force] = useState(0)

  useEffect(() => {
    const fn = () => force((x) => x + 1)
    listeners.add(fn)
    return () => listeners.delete(fn)
  }, [])

  useEffect(() => {
    if (!user || cache !== undefined || inflight) return
    inflight = callFunction('get-favorites', {})
      .then((d) => {
        cache = {
          ids: new Set((d.events ?? []).map((e) => e.id)),
          events: d.events ?? [],
          clubCounts: d.clubCounts ?? {},
        }
      })
      .catch(() => { cache = { ids: new Set(), events: [], clubCounts: {} } })
      .finally(() => { inflight = null; notifyAll() })
  }, [user])

  const isStarred = (eventId) => !!cache?.ids?.has(eventId)

  /** Optimistic toggle. Returns true when this was the user's FIRST ever star. */
  async function toggle(eventId) {
    if (!cache) return false
    const wasFirstStar = cache.ids.size === 0 && !cache.ids.has(eventId)
    const had = cache.ids.has(eventId)
    if (had) cache.ids.delete(eventId)
    else cache.ids.add(eventId)
    notifyAll()
    try {
      const res = await callFunction('toggle-favorite', { event_id: eventId })
      if (res.starred) cache.ids.add(eventId)
      else cache.ids.delete(eventId)
    } catch {
      // revert optimistic change
      if (had) cache.ids.add(eventId)
      else cache.ids.delete(eventId)
    }
    notifyAll()
    return wasFirstStar && cache.ids.has(eventId)
  }

  return {
    ready: cache !== undefined,
    isStarred,
    toggle,
    starredEvents: cache?.events ?? [],
    clubCounts: cache?.clubCounts ?? {},
  }
}
```

- [ ] **Step 2: Write the StarButton**

Anon users navigate to `/login?from=` (same pattern as `ReportEventModal.jsx`'s `loginHref`). First star opens a one-time info modal — the "make it clear in UI" requirement.

```jsx
// public/src/components/StarButton.jsx
import { useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import useAuth from '../hooks/useAuth.js'
import useFavorites from '../hooks/useFavorites.js'

function StarIcon({ filled }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  )
}

function FirstStarModal({ onClose }) {
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 px-4" onClick={onClose}>
      <div
        data-testid="first-star-modal"
        className="bg-apex-bg border border-apex-yellow max-w-md w-full p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-display font-bold text-sm tracking-widest uppercase text-apex-yellow mb-3">
          Obserwujesz ten bieg
        </h3>
        <p className="font-sans text-sm text-apex-text mb-3">
          Dostaniesz powiadomienie (w profilu), gdy:
        </p>
        <ul className="font-sans text-sm text-apex-text list-disc pl-5 space-y-1 mb-4">
          <li>bieg zostanie odwołany,</li>
          <li>pojawi się link do zapisów,</li>
          <li>zostanie 7 dni do końca zapisów.</li>
        </ul>
        <p className="font-sans text-xs text-apex-muted mb-4">
          Chcesz też cotygodniowe podsumowanie e-mailem? Włącz je w{' '}
          <a href="/profil" className="text-apex-yellow underline">swoim profilu</a>.
          Członkowie Twojego klubu widzą, które biegi obserwujesz — możesz to wyłączyć
          w ustawieniach prywatności w profilu.
        </p>
        <button
          onClick={onClose}
          className="font-display font-bold text-[11px] tracking-widest uppercase px-5 py-2 border-2 border-apex-yellow text-apex-yellow hover:bg-apex-yellow hover:text-apex-ink transition-all"
        >
          Rozumiem
        </button>
      </div>
    </div>
  )
}

export default function StarButton({ eventId, className = '' }) {
  const { user } = useAuth()
  const { ready, isStarred, toggle } = useFavorites()
  const navigate = useNavigate()
  const location = useLocation()
  const [showFirstStar, setShowFirstStar] = useState(false)

  const starred = isStarred(eventId)

  const handleClick = async (e) => {
    e.stopPropagation()
    e.preventDefault()
    if (!user) {
      navigate(`/login?from=${encodeURIComponent(location.pathname + location.search)}`)
      return
    }
    if (!ready) return
    const wasFirst = await toggle(eventId)
    if (wasFirst) setShowFirstStar(true)
  }

  return (
    <>
      <button
        data-testid="star-event-btn"
        onClick={handleClick}
        title={starred ? 'Przestań obserwować' : 'Obserwuj ten bieg'}
        aria-label={starred ? 'Przestań obserwować' : 'Obserwuj ten bieg'}
        aria-pressed={starred}
        className={`px-2 py-1 border transition-colors shrink-0 ${
          starred
            ? 'border-apex-yellow text-apex-yellow'
            : 'border-apex-border text-apex-muted hover:text-apex-yellow hover:border-apex-yellow/40'
        } ${className}`}
      >
        <StarIcon filled={starred} />
      </button>
      {showFirstStar && <FirstStarModal onClose={() => setShowFirstStar(false)} />}
    </>
  )
}
```

- [ ] **Step 3: Verify it builds**

```bash
cd public && npx vite build 2>&1 | tail -5
```

Expected: build succeeds (components not yet mounted anywhere — that's Task 8).

- [ ] **Step 4: Commit**

```bash
git add public/src/hooks/useFavorites.js public/src/components/StarButton.jsx
git commit -m "feat(favorites): useFavorites hook with module cache + StarButton with first-star explainer"
```

---

### Task 8: Kalendarz — star on rows, ODWOŁANY badge, cancelled visible, club filter

**Files:**
- Modify: `public/src/components/EventRow.jsx`
- Modify: `public/src/pages/Kalendarz.jsx` (status query ~line 265, club filter chip)

- [ ] **Step 1: EventRow — star button, cancelled badge, club count**

In `public/src/components/EventRow.jsx`:

1. Add imports:
```js
import StarButton from './StarButton.jsx'
import useFavorites from '../hooks/useFavorites.js'
```
2. Inside the component body add:
```js
const { clubCounts } = useFavorites()
const clubCount = clubCounts[event.id] || 0
const isCancelled = event.status === 'cancelled'
```
3. **Desktop badges block** (next to the `regClosed` badge): add cancelled + club badges:
```jsx
{isCancelled && (
  <span data-testid="cancelled-badge" className={`${baseTag} border-apex-red text-apex-red bg-apex-red/10`}>Odwołany</span>
)}
{clubCount > 0 && (
  <span title="Tyle osób z Twojego klubu obserwuje ten bieg" className={`${baseTag} border-apex-yellow/40 text-apex-yellow`}>★ {clubCount} z klubu</span>
)}
```
4. **Desktop action area**: render `<StarButton eventId={event.id} />` immediately before the report button (inside the same flex container, so it inherits row alignment).
5. **Mobile**: add the same two badges in the mobile badge wrap block, and `<StarButton eventId={event.id} className="mt-2" />` next to the mobile report button (wrap both in `<div className="flex gap-2 items-center">` if needed for alignment).
6. When `isCancelled`, add line-through to the title: change the title `<div>`/`<span>` className to include `${isCancelled ? 'line-through opacity-60' : ''}` (both desktop and mobile variants).

- [ ] **Step 2: Kalendarz — include cancelled + club filter**

In `public/src/pages/Kalendarz.jsx`:

1. Change the status filter (~line 265):
```js
// before
.eq('status', 'active')
// after — cancelled events stay visible with an Odwołany badge
.in('status', ['active', 'cancelled'])
```
2. Make sure the select includes `status` (if it's `select('*')` nothing to do).
3. Add the club filter. Imports:
```js
import useAuth from '../hooks/useAuth.js'
import useFavorites from '../hooks/useFavorites.js'
```
In the component that owns `filters` state, add state + data:
```js
const { user } = useAuth()
const { clubCounts, ready: favoritesReady } = useFavorites()
const [clubOnly, setClubOnly] = useState(false)
```
Apply to the DB query (next to the other filter applications): when `clubOnly` is true, restrict to club-starred event ids:
```js
if (clubOnly) {
  const clubIds = Object.keys(clubCounts)
  query = query.in('id', clubIds.length ? clubIds : ['00000000-0000-0000-0000-000000000000'])
}
```
(The placeholder UUID makes "no club stars" return an empty list instead of an unfiltered one.)
Add `clubOnly` to the query's `useEffect` dependency array so toggling refetches.
4. Render the toggle chip next to/under the FilterBar — only for logged-in users with a club (`user?.club`):
```jsx
{user?.club && (
  <button
    data-testid="club-filter-toggle"
    onClick={() => setClubOnly((v) => !v)}
    disabled={!favoritesReady}
    className={`font-mono text-[10px] px-2 py-1 border transition-all ${clubOnly ? 'border-apex-yellow text-apex-yellow' : 'border-apex-border text-apex-muted hover:border-apex-yellow/40'}`}
  >
    ★ Obserwowane w moim klubie
  </button>
)}
```
Place it in the row that renders result count / view toggles (read the JSX around the FilterBar usage and put it in the most natural existing flex row — do not restructure the page).

- [ ] **Step 3: Manual smoke test**

```bash
cd public && npx vite --port 3002
```

Open http://localhost:3002/kalendarz — verify: rows render with star buttons; clicking a star while logged out routes to `/login?from=/kalendarz`; log in (magic code via the login page), star two events, star icon fills; first star shows the explainer modal; reload — stars persist.

- [ ] **Step 4: Commit**

```bash
git add public/src/components/EventRow.jsx public/src/pages/Kalendarz.jsx
git commit -m "feat(kalendarz): star buttons, cancelled events visible with badge, club filter"
```

---

### Task 9: EventPage + static manifest — cancelled visible, star button, CTA hidden

**Files:**
- Modify: `public/src/pages/EventPage.jsx` (status query ~line 193, header area ~line 318, CTA ~line 363)
- Modify: `backend/scripts/publish-event-pages.js` (status filter ~line 81)

- [ ] **Step 1: EventPage changes**

1. Status query (~line 193): `.eq('status', 'active')` → `.in('status', ['active', 'cancelled'])`.
2. Import StarButton: `import StarButton from '../components/StarButton.jsx'`.
3. In the date-badge/countdown row (~line 319), add a cancelled banner + star:
```jsx
{event.status === 'cancelled' && (
  <span data-testid="cancelled-badge" className="font-mono text-[11px] font-semibold px-2 py-0.5 border border-apex-red text-apex-red bg-apex-red/10 uppercase">
    Odwołany
  </span>
)}
<StarButton eventId={event.id} />
```
(Star goes at the end of that flex row; it already has `items-center gap-3`.)
4. Hide the countdown ("za N dni") chip when cancelled: wrap the existing `days != null` condition as `{event.status !== 'cancelled' && days != null && (...)}`.
5. Registration CTA (~line 365): change `{event.registration_url && (` to `{event.status !== 'cancelled' && event.registration_url && (`.

- [ ] **Step 2: Manifest includes cancelled events**

In `backend/scripts/publish-event-pages.js` (~line 81): `.eq('status', 'active')` → `.in('status', ['active', 'cancelled'])`. Check the select on the same query includes `status`; add it if the select is an explicit column list. This keeps pre-rendered pages of cancelled events live (no 404 for indexed URLs) and the embedded JSON carries `status` so the SPA renders the badge.

- [ ] **Step 2b: Cancelled stickiness in the publisher's fuzzy dedup**

Verified facts (checked during planning): the enricher sync (`enricher/enricher/sync.py` `SYNC_FIELDS`) never writes `status`; `publishToCalendar`'s primary `source:source_id` match (`backend/src/scrapers/index.js` ~line 987) fetches ALL statuses, so cancelled rows match and are never re-inserted or status-overwritten. One real gap: the **fuzzy-dedup pool** (~line 1022) filters `.in('status', ['active', 'rejected'])` — a *different source* scraping the same cancelled race would miss the fuzzy match and insert a fresh pending duplicate. Fix:

```js
// backend/src/scrapers/index.js ~line 1022
.in('status', ['active', 'rejected', 'cancelled'])
```

- [ ] **Step 3: Manual smoke test**

With `cd public && npx vite --port 3002` running, open any event page from the kalendarz — verify star button shows next to the date and toggles. To verify the cancelled rendering without mutating real data: temporarily set a test event to cancelled is NOT allowed against calendar_events without user confirmation — instead rely on the e2e test in Task 14 which creates its own test event.

- [ ] **Step 4: Commit**

```bash
git add public/src/pages/EventPage.jsx backend/scripts/publish-event-pages.js
git commit -m "feat(event-page): cancelled banner + hidden CTA, star button, cancelled pages stay in manifest"
```

---

### Task 10: Profil — Obserwowane section, notification feed, settings toggles; Navbar unread badge

**Files:**
- Create: `public/src/hooks/useNotifications.js`
- Modify: `public/src/pages/Profil.jsx`
- Modify: `public/src/components/Navbar.jsx`

- [ ] **Step 1: useNotifications hook**

```js
// public/src/hooks/useNotifications.js
import { useState, useEffect } from 'react'
import { callFunction } from '../lib/auth.js'
import useAuth from './useAuth.js'

// Module cache so the navbar badge costs one fetch per page load.
let cache
let inflight = null
const listeners = new Set()

function notifyAll() { listeners.forEach((fn) => fn()) }

export function clearNotificationsCache() {
  cache = undefined
  inflight = null
}

export default function useNotifications({ markSeen = false } = {}) {
  const { user } = useAuth()
  const [, force] = useState(0)

  useEffect(() => {
    const fn = () => force((x) => x + 1)
    listeners.add(fn)
    return () => listeners.delete(fn)
  }, [])

  useEffect(() => {
    if (!user) return
    // markSeen consumers (the profile feed) always refetch so the cursor advances
    if (cache !== undefined && !markSeen) return
    if (inflight) return
    inflight = callFunction('get-notifications', markSeen ? { markSeen: true } : {})
      .then((d) => {
        cache = { notifications: d.notifications ?? [], unseenCount: markSeen ? 0 : (d.unseenCount ?? 0) }
      })
      .catch(() => { cache = { notifications: [], unseenCount: 0 } })
      .finally(() => { inflight = null; notifyAll() })
  }, [user, markSeen])

  return {
    ready: cache !== undefined,
    notifications: cache?.notifications ?? [],
    unseenCount: cache?.unseenCount ?? 0,
  }
}
```

- [ ] **Step 2: Profil — replace the "Wkrótce" box and add the main section**

In `public/src/pages/Profil.jsx`:

1. Imports:
```js
import useFavorites from '../hooks/useFavorites.js'
import useNotifications from '../hooks/useNotifications.js'
import StarButton from '../components/StarButton.jsx'
import { slugify } from '../lib/slugify.js'
```
2. In `ProfilContent`, pull data:
```js
const { starredEvents } = useFavorites()
const { notifications } = useNotifications({ markSeen: true })
```
3. Replace the sidebar placeholder block (lines 421–424, the `Powiadomienia / Wkrótce` box) with settings toggles:
```jsx
<div className="mb-6">
  <div className={sectionTitle}>Powiadomienia</div>
  <label className="flex items-start gap-2 cursor-pointer mb-3">
    <input
      data-testid="toggle-weekly-digest"
      type="checkbox"
      checked={!!profile?.weekly_digest}
      onChange={(e) => handleSave('weekly_digest', e.target.checked)}
      className="mt-0.5 accent-[#BBDD00]"
    />
    <span className="font-sans text-xs text-apex-text">
      Cotygodniowe podsumowanie e-mailem
      <span className="block text-[10px] text-apex-muted">Zmiany w obserwowanych biegach, raz w tygodniu.</span>
    </span>
  </label>
  <label className="flex items-start gap-2 cursor-pointer">
    <input
      data-testid="toggle-club-visibility"
      type="checkbox"
      checked={(profile?.privacy_settings?.favorites ?? true) !== false}
      onChange={(e) => handleSave('privacy_settings', { ...profile?.privacy_settings, favorites: e.target.checked })}
      className="mt-0.5 accent-[#BBDD00]"
    />
    <span className="font-sans text-xs text-apex-text">
      Pokazuj klubowiczom co obserwuję
      <span className="block text-[10px] text-apex-muted">Członkowie Twojego klubu widzą, które biegi obserwujesz.</span>
    </span>
  </label>
</div>
```
4. In the main column, ABOVE the `Moje zgłoszenia` section, add:
```jsx
<div className="mb-10">
  <div className={sectionTitle}>Obserwowane biegi</div>
  <p className="font-sans text-xs text-apex-muted -mt-2 mb-4">
    Powiadomimy Cię tutaj, gdy obserwowany bieg zostanie odwołany, pojawi się link do zapisów
    lub zostanie 7 dni do końca zapisów.
  </p>

  {notifications.length > 0 && (
    <div className="mb-5 space-y-0" data-testid="notifications-feed">
      {notifications.map((n) => (
        <div key={n.id} className="flex items-center gap-3 py-2 border-b border-apex-border/50 text-xs">
          <span className={`px-1.5 py-0.5 font-mono text-[9px] border flex-shrink-0 ${
            n.type === 'cancelled' ? 'border-apex-red/40 text-apex-red'
            : n.type === 'registration_opened' ? 'border-green-800 text-green-400'
            : 'border-apex-yellow-dim text-apex-yellow'
          }`}>
            {n.type === 'cancelled' ? 'Odwołany' : n.type === 'registration_opened' ? 'Zapisy ruszyły' : 'Koniec zapisów blisko'}
          </span>
          <a href={`/kalendarz/${slugify(n.event_name || '', n.event_date)}`} className="flex-1 text-apex-text truncate no-underline hover:text-apex-yellow">
            {n.event_name}
          </a>
          <span className="text-apex-muted flex-shrink-0">{new Date(n.created_at).toLocaleDateString('pl-PL')}</span>
        </div>
      ))}
    </div>
  )}

  {starredEvents.length === 0 ? (
    <p className="font-sans text-sm text-apex-muted py-4">
      Nie obserwujesz jeszcze żadnych biegów. Wejdź do{' '}
      <a href="/kalendarz" className="text-apex-yellow underline">kalendarza</a>{' '}
      i kliknij ★ przy biegu, który Cię interesuje.
    </p>
  ) : (
    <div className="space-y-0" data-testid="starred-list">
      {starredEvents.map((ev) => (
        <div key={ev.id} className="flex items-center gap-3 py-2.5 border-b border-apex-border/50 text-xs">
          <span className="font-mono text-[11px] font-semibold text-apex-yellow flex-shrink-0">
            {new Date(ev.date).toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric' })}
          </span>
          <a href={`/kalendarz/${slugify(ev.name, ev.date)}`} className={`flex-1 truncate no-underline hover:text-apex-yellow ${ev.status === 'cancelled' ? 'line-through text-apex-muted' : 'text-apex-text'}`}>
            {ev.name}
          </a>
          {ev.status === 'cancelled' && (
            <span className="px-1.5 py-0.5 text-[9px] font-mono border border-apex-red/40 text-apex-red flex-shrink-0">Odwołany</span>
          )}
          <StarButton eventId={ev.id} />
        </div>
      ))}
    </div>
  )}
</div>
```
Note: `slugify` import path is `../lib/slugify.js`, signature `slugify(name, date)` — matches EventRow's usage.

- [ ] **Step 3: Navbar unread badge**

In `public/src/components/Navbar.jsx`:
1. Import: `import useNotifications from '../hooks/useNotifications.js'`
2. In the component: `const { unseenCount } = useNotifications()`
3. Desktop auth chip (the `<button>` showing username, ~line 120) — append after the username text:
```jsx
{unseenCount > 0 && (
  <span data-testid="notif-badge" className="ml-1 min-w-[16px] h-4 px-1 inline-flex items-center justify-center bg-apex-yellow text-apex-ink font-mono text-[9px] font-bold leading-none">
    {unseenCount}
  </span>
)}
```
4. Mobile auth chip (the `/profil` Link, ~line 174) — same span inside the link.

- [ ] **Step 4: Manual smoke test**

With dev server running and a logged-in user that has starred events: visit `/profil` — Obserwowane list shows starred events; toggles persist after reload (flip digest on, reload, still on). To see a feed entry + badge: the trigger tests from Task 2 use disposable events, so instead insert a synthetic notification for one of YOUR starred test events via `mcp__supabase__execute_sql` **(ask the user before this insert — DB write)**:
```sql
INSERT INTO event_notifications (event_id, type)
SELECT event_id, 'deadline_soon' FROM event_favorites LIMIT 1
ON CONFLICT DO NOTHING;
```
Reload any page → navbar shows badge `1`; open `/profil` → feed shows the entry; navigate elsewhere and back → badge gone (markSeen). Clean up: `DELETE FROM event_notifications WHERE type='deadline_soon' AND event_id IN (SELECT event_id FROM event_favorites)` **(confirm with user first)**.

- [ ] **Step 5: Commit**

```bash
git add public/src/hooks/useNotifications.js public/src/pages/Profil.jsx public/src/components/Navbar.jsx
git commit -m "feat(profil): obserwowane section with notification feed, digest + club-privacy toggles, navbar unread badge"
```

---

### Task 11: Backend script — daily `deadline_soon` producer

**Files:**
- Create: `backend/scripts/run-deadline-notifications.js`

- [ ] **Step 1: Write the script**

Follows the repo script conventions: dry-run by default, `--apply` to write, `node --env-file=../.env` invocation.

```js
// backend/scripts/run-deadline-notifications.js
// Usage: cd backend && node --env-file=../.env scripts/run-deadline-notifications.js [--apply]
//
// Inserts 'deadline_soon' rows into event_notifications for active calendar
// events whose registration_deadline falls within the next 7 days. Range check
// (not equality) so a deadline ADDED 4 days out still fires. The UNIQUE
// (event_id, type) constraint makes re-runs idempotent.
// Dry run by default — use --apply to write.
import { createClient } from '@supabase/supabase-js'

const dryRun = !process.argv.includes('--apply')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

function isoDate(d) {
  return d.toISOString().slice(0, 10)
}

const today = new Date()
const plus7 = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000)

const { data: candidates, error } = await supabase
  .from('calendar_events')
  .select('id, name, registration_deadline')
  .eq('status', 'active')
  .gte('registration_deadline', isoDate(today))
  .lte('registration_deadline', isoDate(plus7))
if (error) {
  console.error('query failed:', error.message)
  process.exit(1)
}

// Which already have a deadline_soon row? (candidate set is small, well under
// the PostgREST 1000-row cap)
const ids = (candidates ?? []).map((c) => c.id)
let have = new Set()
if (ids.length) {
  const { data: existing, error: exErr } = await supabase
    .from('event_notifications')
    .select('event_id')
    .eq('type', 'deadline_soon')
    .in('event_id', ids)
  if (exErr) {
    console.error('existing-notifications query failed:', exErr.message)
    process.exit(1)
  }
  have = new Set((existing ?? []).map((e) => e.event_id))
}

const missing = (candidates ?? []).filter((c) => !have.has(c.id))
console.log(`deadline within 7 days: ${ids.length} events, already notified: ${have.size}, to insert: ${missing.length}`)
for (const m of missing) {
  console.log(`  + ${m.registration_deadline}  ${m.name}`)
}

if (dryRun) {
  console.log('\nDRY RUN — nothing written. Use --apply to insert.')
  process.exit(0)
}

if (missing.length) {
  const { error: insErr } = await supabase
    .from('event_notifications')
    .insert(missing.map((c) => ({ event_id: c.id, type: 'deadline_soon' })))
  if (insErr) {
    console.error('insert failed:', insErr.message)
    process.exit(1)
  }
}
console.log(`inserted ${missing.length} deadline_soon notifications`)
```

- [ ] **Step 2: Dry-run it**

```bash
cd backend && node --env-file=../.env scripts/run-deadline-notifications.js
```

Expected: prints candidate counts and `DRY RUN — nothing written.`, exit 0. Do NOT run with `--apply` now — that's the scheduler's job (and a DB write needing no manual seeding).

- [ ] **Step 3: Commit**

```bash
git add backend/scripts/run-deadline-notifications.js
git commit -m "feat(notifications): daily deadline_soon producer script (dry-run default)"
```

---

### Task 12: Backend script — weekly digest email

**Files:**
- Create: `backend/scripts/run-weekly-digest.js`
- Modify: `docker-compose.yml` (add `SENDGRID_API_KEY` + `SENDGRID_FROM_EMAIL` to the `backend` service environment, mirroring the `scheduler` service entries)

- [ ] **Step 1: Write the script**

```js
// backend/scripts/run-weekly-digest.js
// Usage: cd backend && node --env-file=../.env scripts/run-weekly-digest.js [--apply]
//
// For every profile with weekly_digest=true, collects event_notifications from
// the last 7 days on their starred events (only notifications created AFTER the
// star) and sends one summary email via SendGrid. The 7-day deadline_soon
// window guarantees the weekly cadence always catches deadlines in time.
// Dry run by default (prints would-send summaries) — use --apply to send.
import { createClient } from '@supabase/supabase-js'

const dryRun = !process.argv.includes('--apply')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

const TYPE_LABELS = {
  cancelled: 'Bieg odwołany',
  registration_opened: 'Zapisy ruszyły',
  deadline_soon: 'Zostało mniej niż 7 dni do końca zapisów',
}

// Slugify duplicated from public/src/lib/slugify.js for Node compat
// (same established duplication as backend/scripts/publish-event-pages.js)
const POLISH_MAP = {
  'ą': 'a', 'ć': 'c', 'ę': 'e', 'ł': 'l', 'ń': 'n',
  'ó': 'o', 'ś': 's', 'ź': 'z', 'ż': 'z',
}
function slugify(name, date) {
  const base = (name || '')
    .toLowerCase()
    .replace(/[ąćęłńóśźż]/g, (ch) => POLISH_MAP[ch] || ch)
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return `${base}-${date}`
}

// SENDGRID_FROM_EMAIL may be '"Name" <email@x>' or a bare address
function parseFrom(raw) {
  const m = (raw || '').match(/^(.*)<([^>]+)>\s*$/)
  return m
    ? { name: m[1].trim().replace(/^"|"$/g, ''), email: m[2].trim() }
    : { email: (raw || 'biuro@zatyrani.pl').trim() }
}

async function sendEmail(to, subject, html) {
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: parseFrom(process.env.SENDGRID_FROM_EMAIL),
      subject,
      content: [{ type: 'text/html', value: html }],
    }),
  })
  if (!res.ok) throw new Error(`SendGrid ${res.status}: ${await res.text()}`)
}

if (!dryRun && !process.env.SENDGRID_API_KEY) {
  console.error('SENDGRID_API_KEY missing — cannot send. Aborting.')
  process.exit(1)
}

// 1. Opted-in users
const { data: users, error: usersErr } = await supabase
  .from('profiles')
  .select('id, email, username')
  .eq('weekly_digest', true)
  .is('deleted_at', null)
  .not('email', 'is', null)
if (usersErr) { console.error(usersErr.message); process.exit(1) }
if (!users?.length) { console.log('no digest subscribers — nothing to do'); process.exit(0) }

// 2. Their favorites (single query; paginate if this ever nears 1000 rows)
const { data: favs, error: favsErr } = await supabase
  .from('event_favorites')
  .select('user_id, event_id, created_at')
  .in('user_id', users.map((u) => u.id))
if (favsErr) { console.error(favsErr.message); process.exit(1) }

// 3. Notifications from the last 7 days on any of those events
const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
const eventIds = [...new Set((favs ?? []).map((f) => f.event_id))]
let notifs = []
if (eventIds.length) {
  const { data, error: nErr } = await supabase
    .from('event_notifications')
    .select('event_id, type, created_at, calendar_events(name, date)')
    .gte('created_at', since)
    .in('event_id', eventIds)
  if (nErr) { console.error(nErr.message); process.exit(1) }
  notifs = data ?? []
}

// 4. Per-user digest: notification must postdate that user's star
const favsByUser = new Map()
for (const f of favs ?? []) {
  if (!favsByUser.has(f.user_id)) favsByUser.set(f.user_id, new Map())
  favsByUser.get(f.user_id).set(f.event_id, f.created_at)
}

let sent = 0
for (const user of users) {
  const myFavs = favsByUser.get(user.id)
  if (!myFavs) continue
  const mine = notifs.filter(
    (n) => myFavs.has(n.event_id) && new Date(n.created_at) > new Date(myFavs.get(n.event_id))
  )
  if (!mine.length) continue

  const items = mine
    .map((n) => {
      const name = n.calendar_events?.name ?? 'Wydarzenie'
      const url = `https://www.leszy.run/kalendarz/${slugify(name, n.calendar_events?.date)}`
      return `<li><strong>${TYPE_LABELS[n.type]}</strong> — <a href="${url}">${name}</a></li>`
    })
    .join('\n')
  const html = `
    <p>Cześć${user.username ? ` ${user.username}` : ''}!</p>
    <p>W obserwowanych przez Ciebie biegach w ostatnim tygodniu:</p>
    <ul>${items}</ul>
    <p><a href="https://www.leszy.run/profil">Zarządzaj obserwowanymi i powiadomieniami</a></p>
    <p style="color:#888;font-size:12px">Dostajesz tę wiadomość, bo masz włączone cotygodniowe
    podsumowanie na leszy.run. Możesz je wyłączyć w swoim profilu.</p>`

  if (dryRun) {
    console.log(`WOULD SEND to ${user.email}: ${mine.length} item(s)`)
    for (const n of mine) console.log(`   - [${n.type}] ${n.calendar_events?.name}`)
  } else {
    await sendEmail(user.email, 'Leszy.run — co nowego w obserwowanych biegach', html)
    sent++
  }
}

console.log(dryRun ? '\nDRY RUN — no emails sent. Use --apply to send.' : `sent ${sent} digest(s)`)
```

- [ ] **Step 2: Add SendGrid env to the backend container**

In `docker-compose.yml`, under the `backend` service `environment:` block, add (copy the exact lines from the `scheduler` service at ~lines 79–80):

```yaml
      SENDGRID_API_KEY: ${SENDGRID_API_KEY:-}
      SENDGRID_FROM_EMAIL: ${SENDGRID_FROM_EMAIL:-biuro@zatyrani.pl}
```

- [ ] **Step 3: Dry-run it**

```bash
cd backend && node --env-file=../.env scripts/run-weekly-digest.js
```

Expected: `no digest subscribers — nothing to do` (or WOULD SEND lines if a test profile has the flag), exit 0. Never run `--apply` manually during development.

- [ ] **Step 4: Commit**

```bash
git add backend/scripts/run-weekly-digest.js docker-compose.yml
git commit -m "feat(notifications): weekly digest email script + SendGrid env for backend"
```

---

### Task 13: Scheduler — cron entries for both scripts

**Files:**
- Create: `scheduler/src/notifications.js`
- Modify: `scheduler/src/index.js`

- [ ] **Step 1: Write the notifications runner**

Mirrors the pipeline's docker-exec pattern (`scheduler/src/pipeline.js` `dockerArgv` for `type: 'backend'`) and reuses `runCommand` + `sendFailureEmail`:

```js
// scheduler/src/notifications.js
import { mkdir } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import path from 'node:path'
import { runCommand } from './exec.js'
import { sendFailureEmail } from './mailer.js'

const LOG_DIR = process.env.LOG_DIR || '/app/logs'
const COMPOSE_DIR = process.env.COMPOSE_DIR || '/workspace'

async function runBackendScript(name, scriptArgs) {
  await mkdir(LOG_DIR, { recursive: true })
  const logPath = path.join(LOG_DIR, `${name}.log`)
  const logStream = createWriteStream(logPath, { flags: 'a' })
  const logWrite = (line) => logStream.write(line)
  logWrite(`\n==== ${new Date().toISOString()} ${name} starting ====\n`)

  const result = await runCommand({
    argv: ['docker', 'compose', 'exec', '-T', '--workdir', '/app/backend', 'backend', 'node', ...scriptArgs],
    cwd: COMPOSE_DIR,
    logWrite,
    timeoutMs: 10 * 60 * 1000,
  })

  logStream.end()

  if (result.exitCode !== 0) {
    await sendFailureEmail({
      stepIndex: 1,
      totalSteps: 1,
      stepName: name,
      exitCode: result.exitCode,
      stderrTail: result.stderrTail,
      logPath: path.join('logs', `${name}.log`),
      durationMs: result.durationMs,
    })
  }
  return result
}

export function runDeadlineNotifications() {
  return runBackendScript('deadline-notifications', ['scripts/run-deadline-notifications.js', '--apply'])
}

export function runWeeklyDigest() {
  return runBackendScript('weekly-digest', ['scripts/run-weekly-digest.js', '--apply'])
}
```

Note: before finalizing, read `scheduler/src/exec.js`'s resolve shape (it resolves an object — confirm the field names `exitCode`, `stderrTail`, `durationMs` against the actual code at the bottom of `runCommand`; adjust if they differ) and `sendFailureEmail`'s exact parameter names in `scheduler/src/mailer.js:40`. Match them exactly.

- [ ] **Step 2: Register the crons in `scheduler/src/index.js`**

Add imports and two more `cron.schedule` blocks following the existing pattern (re-entrancy guard + try/catch):

```js
import { runDeadlineNotifications, runWeeklyDigest } from './notifications.js'

const DEADLINE_CRON = process.env.DEADLINE_CRON || '30 8 * * *'   // daily 08:30
const DIGEST_CRON = process.env.DIGEST_CRON || '0 9 * * 1'       // Monday 09:00

let deadlineRunning = false
cron.schedule(DEADLINE_CRON, async () => {
  if (deadlineRunning) return
  deadlineRunning = true
  console.log(`[cron] deadline-notifications trigger at ${new Date().toISOString()}`)
  try {
    await runDeadlineNotifications()
  } catch (err) {
    console.error('[cron] deadline-notifications threw:', err)
  } finally {
    deadlineRunning = false
  }
}, { timezone: TZ })

let digestRunning = false
cron.schedule(DIGEST_CRON, async () => {
  if (digestRunning) return
  digestRunning = true
  console.log(`[cron] weekly-digest trigger at ${new Date().toISOString()}`)
  try {
    await runWeeklyDigest()
  } catch (err) {
    console.error('[cron] weekly-digest threw:', err)
  } finally {
    digestRunning = false
  }
}, { timezone: TZ })
```

Also extend the final `console.log` status line to include the two new cron expressions.

- [ ] **Step 3: Verify the scheduler boots**

```bash
docker compose up -d --build scheduler && sleep 3 && docker compose logs --tail 5 scheduler
```

Expected: the `[scheduler] up.` line includes all four cron expressions, no errors.

- [ ] **Step 4: Commit**

```bash
git add scheduler/src/notifications.js scheduler/src/index.js
git commit -m "feat(scheduler): daily deadline-notifications + Monday weekly-digest crons"
```

---

### Task 14: E2E tests (Playwright)

**Files:**
- Create: `public/tests/e2e/favorites.spec.js`

- [ ] **Step 1: Write the tests**

Use the existing helpers (`public/tests/e2e/helpers.js`: `createTestUser` → has `injectSession(context)`; read the file for the exact API and cleanup helper before writing — match how `profile.spec.js` authenticates). Test events are created/cleaned via `supabaseAdmin` from the same helpers file.

```js
// public/tests/e2e/favorites.spec.js
import { test, expect } from '@playwright/test'
import { createTestUser, supabaseAdmin } from './helpers.js'

async function createTestEvent(status = 'active') {
  const { data, error } = await supabaseAdmin
    .from('calendar_events')
    .insert({
      name: `E2E Fav Bieg ${Date.now()}`,
      date: '2030-06-01',
      location: 'Testowo',
      source: 'test',
      source_id: `e2e-fav-${crypto.randomUUID()}`,
      status,
    })
    .select('id, name, date')
    .single()
  if (error) throw error
  return data
}

test('anon star click routes to login with from-param', async ({ page }) => {
  const event = await createTestEvent()
  try {
    await page.goto('/kalendarz?search=' + encodeURIComponent(event.name))
    const star = page.getByTestId('star-event-btn').first()
    await expect(star).toBeVisible()
    await star.click()
    await expect(page).toHaveURL(/\/login\?from=/)
  } finally {
    await supabaseAdmin.from('calendar_events').delete().eq('id', event.id)
  }
})

test('logged-in user stars an event, sees it in profil, first-star modal explains notifications', async ({ browser }) => {
  const user = await createTestUser('fav')
  const event = await createTestEvent()
  const context = await browser.newContext()
  try {
    await user.injectSession(context)
    const page = await context.newPage()

    await page.goto('/kalendarz?search=' + encodeURIComponent(event.name))
    const star = page.getByTestId('star-event-btn').first()
    await star.click()

    // first-star explainer lists the three notification types
    const modal = page.getByTestId('first-star-modal')
    await expect(modal).toBeVisible()
    await expect(modal).toContainText('odwołany')
    await expect(modal).toContainText('link do zapisów')
    await expect(modal).toContainText('7 dni')
    await modal.getByRole('button', { name: 'Rozumiem' }).click()

    await expect(star).toHaveAttribute('aria-pressed', 'true')

    // shows up in /profil
    await page.goto('/profil')
    await expect(page.getByTestId('starred-list')).toContainText(event.name)
  } finally {
    await supabaseAdmin.from('calendar_events').delete().eq('id', event.id)
    await user.cleanup?.()
    await context.close()
  }
})

test('cancelled event shows ODWOŁANY badge in kalendarz and on event page, CTA hidden', async ({ page }) => {
  const event = await createTestEvent('cancelled')
  await supabaseAdmin.from('calendar_events')
    .update({ registration_url: 'https://example.com/zapisy' })
    .eq('id', event.id)
  try {
    await page.goto('/kalendarz?search=' + encodeURIComponent(event.name))
    await expect(page.getByTestId('cancelled-badge').first()).toBeVisible()

    // open the event page
    await page.getByText(event.name).first().click()
    await expect(page.getByTestId('cancelled-badge')).toBeVisible()
    await expect(page.getByRole('link', { name: /zapisz/i })).toHaveCount(0)
  } finally {
    await supabaseAdmin.from('calendar_events').delete().eq('id', event.id)
  }
})
```

Adjust selectors to reality before finalizing: read `public/tests/e2e/helpers.js` for `createTestUser`'s exact return shape (cleanup function name, `injectSession` signature), the playwright config baseURL, and how existing specs (e.g. `profile.spec.js`) launch contexts; the registration-CTA selector on EventPage must match the actual link text in `EventPage.jsx` (~line 365). Also check whether the kalendarz search input is driven by URL param `?search=` — if not, type into the FilterBar search field instead (read `FilterBar.jsx` for its test id / placeholder).

- [ ] **Step 2: Run them**

```bash
cd public && npx playwright test tests/e2e/favorites.spec.js
```

Expected: 3 tests PASS (dev server per playwright config; if config expects a running server, start `npx vite --port 3002` first — match whatever `auth.spec.js` requires).

- [ ] **Step 3: Commit**

```bash
git add public/tests/e2e/favorites.spec.js
git commit -m "test(e2e): star flow, first-star explainer, cancelled badge + hidden CTA"
```

---

### Task 15: Privacy policy + docs

**Files:**
- Modify: `public/src/pages/PolitykaPrywatnosci.jsx`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Privacy policy addition**

Read `public/src/pages/PolitykaPrywatnosci.jsx` and find the section describing profile data processing. Add a paragraph (matching the page's existing JSX structure/classes) covering:

- Obserwowane biegi (favorites) are stored with the account and used for in-app notifications and the optional weekly email digest.
- Club visibility default: *"Jeśli masz ustawiony klub, pozostali członkowie Twojego klubu widzą, które biegi obserwujesz. Możesz to wyłączyć w ustawieniach prywatności w swoim profilu."*
- The weekly email digest is sent only after opt-in and can be disabled anytime in the profile.
- Favorites are included in the data export and removed on account deletion.

- [ ] **Step 2: CLAUDE.md**

In `CLAUDE.md`, in the section describing the monorepo `scheduler/` entry, extend the description to mention the two new jobs: daily deadline-notifications at 08:30 and weekly digest Monday 09:00. Add a short subsection after "Supabase-only tables" listing the two new tables:

```markdown
- `event_favorites` — user star/follow shortlist (service-role only, written via `toggle-favorite` edge function)
- `event_notifications` — event-level notification log (`cancelled` / `registration_opened` / `deadline_soon`); rows produced by a `calendar_events` trigger + `run-deadline-notifications.js`; UNIQUE(event_id, type)
```

- [ ] **Step 3: Commit**

```bash
git add public/src/pages/PolitykaPrywatnosci.jsx CLAUDE.md
git commit -m "docs: privacy policy covers favorites + club visibility; CLAUDE.md notification tables and scheduler jobs"
```

---

## Final verification

- [ ] Full edge-function test suite: `cd public && npm run test:functions` — all green (env vars per the convention note at the top).
- [ ] Full e2e suite: `cd public && npx playwright test` — all green.
- [ ] Public app builds: `cd public && npx vite build` — success.
- [ ] Scheduler logs show all four crons registered.
- [ ] Use superpowers:verification-before-completion before claiming done.
