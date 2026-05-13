# Community Locked Fields Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an admin accepts a community report, lock the accepted field against pipeline overwrites and record it as community-contributed so it's visible in the admin UI.

**Architecture:** Three targeted changes — the accept route appends the field to both `locked_fields` and `community_locked_fields` on `calendar_events`; the backend list route gains a `community=true` filter param; the frontend adds a `CommunityTab` component and wires it into the existing filter tabs in `CalendarEventsList`.

**Tech Stack:** Node.js + Fastify (backend), React + TanStack Query (frontend), Supabase JS client v2, Tailwind v4 + shadcn-style OVERDRIVE theme.

---

## File map

| File | Change |
|------|--------|
| `backend/src/routes/calendarEventReports.js` | Accept route: fetch lock arrays, append field to both, include in update payload |
| `backend/src/routes/calendarEvents.js` | GET `/calendar-events`: add `community=true` query param → `.not('community_locked_fields', 'eq', '{}')` filter |
| `frontend/src/pages/Moderation.jsx` | Add `CommunityTab` component + exported query hook `useCommunityQuery` |
| `frontend/src/pages/CalendarEventsList.jsx` | Import `CommunityTab` + `useCommunityQuery`, add "Community" filter button, render tab |

**DB:** Already applied — `community_locked_fields TEXT[] NOT NULL DEFAULT '{}'` on Supabase `calendar_events`.

---

## Task 1: Backend — accept route locks both arrays

**Files:**
- Modify: `backend/src/routes/calendarEventReports.js:17-58`

- [ ] **Step 1: Open the accept route**

In `backend/src/routes/calendarEventReports.js`, the `PATCH /calendar-event-reports/:id/accept` handler currently does a single Supabase fetch (the report) before building `eventUpdate`. We need to add a second fetch for the event's current lock arrays.

- [ ] **Step 2: Add the event lock fetch after the report fetch**

After line 27 (`if (fetchErr || !report) return reply.status(404)...`), insert:

```js
const { data: eventLocks, error: locksErr } = await supabase
  .from('calendar_events')
  .select('locked_fields, community_locked_fields')
  .eq('id', report.calendar_event_id)
  .single()

if (locksErr || !eventLocks) return reply.status(404).send({ error: 'Event not found' })
```

- [ ] **Step 3: Append the field to both lock arrays**

After the `eventUpdate` block (after line 42, before the `.update()` call on `calendar_events`), insert:

```js
eventUpdate.locked_fields = [...new Set([...(eventLocks.locked_fields ?? []), report.field])]
eventUpdate.community_locked_fields = [...new Set([...(eventLocks.community_locked_fields ?? []), report.field])]
```

`new Set(...)` dedups — accepting the same field twice won't create duplicate entries.

- [ ] **Step 4: Verify the full accept route looks correct**

The route should now read (condensed for reference):

```js
fastify.patch('/calendar-event-reports/:id/accept', async (request, reply) => {
  const { id } = request.params
  const { suggested_value: override } = request.body || {}

  const { data: report, error: fetchErr } = await supabase
    .from('calendar_event_reports').select('*').eq('id', id).single()
  if (fetchErr || !report) return reply.status(404).send({ error: 'Report not found' })

  const { data: eventLocks, error: locksErr } = await supabase
    .from('calendar_events')
    .select('locked_fields, community_locked_fields')
    .eq('id', report.calendar_event_id)
    .single()
  if (locksErr || !eventLocks) return reply.status(404).send({ error: 'Event not found' })

  const value = override !== undefined ? override : report.suggested_value
  const eventUpdate = { updated_at: new Date().toISOString() }

  if (report.field === 'cancelled') {
    eventUpdate.status = 'cancelled'
  } else if (report.field === 'distances') {
    eventUpdate.distances = value.split(',').map(s => s.trim()).filter(Boolean)
  } else if (report.field === 'event_type') {
    eventUpdate.event_type = value.split(',').map(s => s.trim()).filter(Boolean)
  } else {
    eventUpdate[report.field] = value
  }

  eventUpdate.locked_fields = [...new Set([...(eventLocks.locked_fields ?? []), report.field])]
  eventUpdate.community_locked_fields = [...new Set([...(eventLocks.community_locked_fields ?? []), report.field])]

  const { error: updateErr } = await supabase
    .from('calendar_events').update(eventUpdate).eq('id', report.calendar_event_id)
  if (updateErr) return reply.status(500).send({ error: updateErr.message })

  const { error: reportErr } = await supabase
    .from('calendar_event_reports')
    .update({ status: 'accepted', reviewed_at: new Date().toISOString() }).eq('id', id)
  if (reportErr) return reply.status(500).send({ error: reportErr.message })

  return { success: true }
})
```

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/calendarEventReports.js
git commit -m "feat: lock community-accepted fields in both locked_fields and community_locked_fields"
```

---

## Task 2: Backend — community filter on calendar-events list route

**Files:**
- Modify: `backend/src/routes/calendarEvents.js:113-131`

- [ ] **Step 1: Add `community` to destructured query params**

On line 114, change:

```js
const { page = 1, limit = 200, source, filter, status = 'active' } = request.query
```

to:

```js
const { page = 1, limit = 200, source, filter, status = 'active', community } = request.query
```

- [ ] **Step 2: Add the filter after the `source` check**

After `if (source) query = query.eq('source', source)` (line 126), add:

```js
if (community === 'true') query = query.not('community_locked_fields', 'eq', '{}')
```

This uses PostgREST's `not` operator to exclude rows where `community_locked_fields` equals the empty array literal `{}`. Only events with at least one community-locked field are returned.

- [ ] **Step 3: Commit**

```bash
git add backend/src/routes/calendarEvents.js
git commit -m "feat: add community=true filter to calendar-events list route"
```

---

## Task 3: Frontend — CommunityTab component

**Files:**
- Modify: `frontend/src/pages/Moderation.jsx` (append at end of file)

- [ ] **Step 1: Add the query hook**

At the bottom of `frontend/src/pages/Moderation.jsx`, after the `FeedbackTab` export, add:

```js
export const communityQueryKey = ['calendar-events', 'community']

export function useCommunityQuery() {
  return useQuery({
    queryKey: communityQueryKey,
    queryFn: () => api.get('/calendar-events?community=true&status=active&limit=500'),
  })
}
```

`limit=500` is a practical cap — community-edited events are a small subset of all active events.

- [ ] **Step 2: Add the CommunityTab component**

Directly after the hook, add:

```js
export function CommunityTab() {
  const { data, isLoading, error } = useCommunityQuery()
  const events = data?.data || []

  if (isLoading) return <div className="text-apex-muted py-8">Ładowanie...</div>
  if (error) return <div className="border border-apex-red bg-apex-red/10 text-apex-red text-sm px-4 py-2">{error.message}</div>

  return (
    <div className="space-y-3">
      {events.length === 0 && (
        <div className="text-apex-muted py-8 text-center">Brak wydarzeń z poprawkami społeczności.</div>
      )}
      {events.map(event => (
        <div key={event.id} className="bg-apex-surface border border-apex-border p-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="font-display font-bold text-sm tracking-wide uppercase text-apex-text-bright">
                {event.name}
              </div>
              <div className="text-xs text-apex-muted mt-0.5">
                {event.date} &middot; {event.location || '—'} &middot; {event.voivodeship || '—'}
              </div>
            </div>
            <a
              href={`/calendar-events?highlight=${event.id}`}
              className="font-mono text-[10px] tracking-widest uppercase text-apex-cyan hover:underline shrink-0"
            >
              Otwórz
            </a>
          </div>
          <div className="flex flex-wrap gap-1.5 mt-3">
            {(event.community_locked_fields || []).map(field => (
              <span
                key={field}
                className="font-mono text-[10px] font-semibold px-2 py-0.5 border border-apex-yellow-dim text-apex-yellow-dim"
              >
                {field}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/Moderation.jsx
git commit -m "feat: add CommunityTab component showing events with community-locked fields"
```

---

## Task 4: Frontend — wire Community tab into CalendarEventsList

**Files:**
- Modify: `frontend/src/pages/CalendarEventsList.jsx`

- [ ] **Step 1: Import CommunityTab and useCommunityQuery**

At line 4 where `ReportsTab`, `FeedbackTab`, etc. are imported from `Moderation.jsx`, add `CommunityTab` and `useCommunityQuery`:

```js
import { ReportsTab, FeedbackTab, CommunityTab, useReportsQuery, useFeedbackQuery, useCommunityQuery } from './Moderation.jsx'
```

- [ ] **Step 2: Call useCommunityQuery for the tab badge count**

Near where `reportsCount` and `feedbackCount` are derived (around line 462), add:

```js
const { data: communityData } = useCommunityQuery()
const communityCount = communityData?.data?.length || 0
```

- [ ] **Step 3: Add the "Community" filter button**

In the tab button group (around line 584, after the "Sugestie" button), add:

```js
<button onClick={() => setFilter('community')} className={btnClass(filter === 'community')}>
  Community{communityCount > 0 ? ` (${communityCount})` : ''}
</button>
```

- [ ] **Step 4: Add the subtitle and source label for the community filter**

In the subtitle `<p>` (around line 558) add:

```js
{filter === 'community' && `${communityCount} wydarzeń z poprawkami społeczności`}
```

In the source label block (around line 566) add:

```js
{filter === 'community' && <span className="text-apex-text-bright">calendar_events · community_locked_fields</span>}
```

- [ ] **Step 5: Render CommunityTab**

In the conditional render block (around line 605), extend the chain:

```js
{filter === 'duplicates' ? (
  <DuplicatesView />
) : filter === 'reports' ? (
  <ReportsTab />
) : filter === 'feedback' ? (
  <FeedbackTab />
) : filter === 'community' ? (
  <CommunityTab />
) : (
  // existing table render...
```

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/CalendarEventsList.jsx
git commit -m "feat: add Community tab to calendar events admin view"
```
