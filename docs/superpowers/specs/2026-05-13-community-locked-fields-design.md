# Community Locked Fields — Design Spec

**Date:** 2026-05-13

## Problem

When a community report is accepted, the fix is applied to `calendar_events` but no trace is left that the change came from a community contribution. The automated pipeline can silently overwrite the fix on the next run, and there is no way to see which events have community-validated data.

## Solution

Add a `community_locked_fields TEXT[]` column to `calendar_events`, parallel to the existing `locked_fields`. When an admin accepts a community report, the accepted field is appended to both arrays: `locked_fields` (pipeline protection) and `community_locked_fields` (visibility label). A "Community" tab in the Moderation page lists all events that have at least one community-locked field.

## Data layer

Column already applied to Supabase via migration `add_community_locked_fields_to_calendar_events`:

```sql
ALTER TABLE calendar_events
  ADD COLUMN community_locked_fields TEXT[] NOT NULL DEFAULT '{}';
```

- Supabase-only table — no local Drizzle schema or migration needed.
- No RLS change needed — only the service role (backend) writes this column.
- No index needed at current table scale.

## Backend

**File:** `backend/src/routes/calendarEventReports.js`
**Route:** `PATCH /api/calendar-event-reports/:id/accept`

Before building the event update payload, fetch the event's current lock arrays:

```js
const { data: event } = await supabase
  .from('calendar_events')
  .select('locked_fields, community_locked_fields')
  .eq('id', report.calendar_event_id)
  .single()

const lockedFields = [...new Set([...(event.locked_fields ?? []), report.field])]
const communityLockedFields = [...new Set([...(event.community_locked_fields ?? []), report.field])]

eventUpdate.locked_fields = lockedFields
eventUpdate.community_locked_fields = communityLockedFields
```

Rules:
- Deduped — accepting the same field twice does not add a duplicate entry.
- Special-case fields (`cancelled`, `distances`, `event_type`) still have their value transformed as today, but the field name goes into both lock arrays regardless.
- The reject route is unchanged — rejecting a report never touches lock arrays.

## Admin UI

**File:** `frontend/src/pages/Moderation.jsx`

Add a "Community" sub-tab alongside the existing moderation tabs.

**Query:** `calendar_events` where `community_locked_fields != '{}'`, ordered by `updated_at DESC`.

**Display per event:**
- Event name + date
- Community-locked field names as small badges (e.g. `name`, `price_from`, `registration_url`)
- Link to open the event in the calendar events list

The tab is read-only — no actions. Its purpose is to give context when reviewing a new report: you can see at a glance which fields on an event were already community-corrected.

## What this does NOT change

- The enricher's `locked_fields` check already covers community-locked fields (since they are added to `locked_fields` too) — no enricher changes needed.
- The sync worker is unaffected.
- The public kalendarz is unaffected — `community_locked_fields` is an internal metadata column.
- Admin manual edits continue to write only to `locked_fields` (not `community_locked_fields`).
