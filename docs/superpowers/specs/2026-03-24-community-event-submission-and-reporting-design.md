# Community Event Submission & Issue Reporting — Design Spec

**Date:** 2026-03-24
**Status:** Approved

## Problem

The kalendarz (public calendar) has no way for the community to contribute. Event data comes only from scrapers + admin manual entry. Users who find missing events or incorrect data have no way to help.

## Features

1. **Anonymous event submission** — public form at `/kalendarz/dodaj` where anyone can submit a new event. Goes to `status = 'pending'` for admin moderation.
2. **Issue reporting** — inline on each EventRow in Kalendarz. Users flag incorrect fields and provide corrected values + source link.
3. **Admin moderation** — new page in admin frontend showing pending events and open reports with accept/edit/reject actions.

## Schema Changes (Supabase-only)

### `calendar_events` table — allow `status = 'pending'`

No DDL change needed — `status` is a TEXT column, not an enum. Events with `status = 'pending'` are already excluded from the Kalendarz query (which filters `status = 'active'`).

### New table: `calendar_event_reports`

```sql
CREATE TABLE calendar_event_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  calendar_event_id UUID NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  field TEXT NOT NULL,
  old_value TEXT,
  suggested_value TEXT,
  source_url TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_reports_event_id ON calendar_event_reports(calendar_event_id);
CREATE INDEX idx_reports_status ON calendar_event_reports(status);
```

`field` values: `name`, `date`, `location`, `voivodeship`, `distances`, `event_type`, `organizer`, `registration_url`, `cancelled` (to report event is cancelled).

`status` values: `pending`, `accepted`, `rejected`.

### RLS Policies

```sql
-- calendar_event_reports: anyone can insert, only service_role can update/delete
ALTER TABLE calendar_event_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can create reports" ON calendar_event_reports
  FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY "Anyone can read reports" ON calendar_event_reports
  FOR SELECT TO anon USING (true);

-- calendar_events: allow anon inserts with status = 'pending'
CREATE POLICY "Anyone can submit pending events" ON calendar_events
  FOR INSERT TO anon WITH CHECK (status = 'pending');
```

Note: The existing RLS policies for `calendar_events` may need adjustment. The public app uses the anon key. Ensure anon can SELECT active events (already works for Kalendarz) and INSERT pending events.

## Public UI — Event Submission Form

### Route: `/kalendarz/dodaj`

**File:** `public/src/pages/DodajWydarzenie.jsx`

Link from Kalendarz page — button near the top (next to filters or as a CTA).

### Form fields

| Field | Input | Notes |
|-------|-------|-------|
| Nazwa wydarzenia | Text input | Required |
| Data | Date input | Required |
| Miasto | Text input | Optional |
| Wojewodztwo | Dropdown — 16 voivodeships | Optional |
| Dystanse | Preset chips (5 km, 10 km, 21.1 km, 42.2 km, 50 km, 100 km) + custom input | Optional, multi-select |
| Typ wydarzenia | Multi-select dropdown/chips (trail, nocny, ocr, nordic, ultra, charytatywny, uliczny) | Optional |
| Link do rejestracji | URL input | Optional |
| Organizator | Text input | Optional |
| Opis | Textarea (3 rows) | Optional |

### Submission

```js
await supabase.from('calendar_events').insert({
  name,
  date,
  location: location || null,
  voivodeship: voivodeship || null,
  distances: distances.length ? distances : null,
  distances_meters: distances.length ? distances.map(d => Math.round(parseFloat(d) * 1000)) : null,
  event_type: eventTypes.length ? eventTypes : null,
  registration_url: registrationUrl || null,
  organizer: organizer || null,
  description: description || null,
  source: 'community',
  status: 'pending',
})
```

### Success state

Replace form with confirmation message: "Wydarzenie zostalo zgloszone i oczekuje na moderacje."

### UX details

- OVERDRIVE theme, consistent with Kalendarz styling
- Chip-based multi-select for distances and event types (tap to toggle, yellow border when selected)
- Distance chips: preset values + "Inny" button that shows a custom km input
- All inputs use existing apex-* tokens: `bg-apex-surface border border-apex-border text-apex-text-bright focus:border-apex-yellow-dim`
- Submit button: `bg-apex-yellow text-apex-ink` style, disabled until name + date filled

## Public UI — Issue Reporting

### Trigger

Each `EventRow` in Kalendarz gets a small report icon (flag/exclamation). Clicking opens a modal/sheet.

**File:** `public/src/components/ReportEventModal.jsx`

### Modal content

1. **Which field is wrong?** — Dropdown with options:
   - Nazwa (name)
   - Data (date)
   - Miejsce (location)
   - Wojewodztwo (voivodeship)
   - Dystanse (distances)
   - Typ wydarzenia (event_type)
   - Organizator (organizer)
   - Link do rejestracji (registration_url)
   - Wydarzenie odwolane (cancelled)

2. **Current value** — shown read-only, auto-populated from event data

3. **Suggested value** — input matching the field type:
   - Text for name, location, organizer
   - Date picker for date
   - Dropdown for voivodeship
   - Chips for distances, event_type
   - URL input for registration_url
   - No input for "cancelled" (just the source link)

4. **Link do zrodla** — URL input, required ("Podaj link do strony ze zrodlem")

5. **Notatka** — optional text, small textarea

### Submission

```js
await supabase.from('calendar_event_reports').insert({
  calendar_event_id: event.id,
  field,
  old_value: String(event[field] ?? ''),
  suggested_value: suggestedValue,
  source_url: sourceUrl,
  note: note || null,
})
```

Success: close modal, show brief toast "Zgloszenie wyslane".

## Admin UI — Moderation Page

### Route: `/moderation`

**File:** `frontend/src/pages/Moderation.jsx`

### Two tabs

#### Tab 1: Oczekujace wydarzenia (Pending Events)

Query: `calendar_events` where `status = 'pending'`, ordered by `created_at DESC`.

Each pending event displayed as a card:
- All submitted fields visible
- Source link if provided
- Two action buttons:
  - **Zatwierdz** (Approve) → `PATCH` status to `active` via admin API
  - **Usun** (Delete) → `DELETE` via admin API

#### Tab 2: Zgloszenia (Reports)

Query: `calendar_event_reports` where `status = 'pending'`, joined with `calendar_events` for context.

Grouped by event. Each report shows:
- **Field name** label
- **Left:** current value (from event)
- **Right:** suggested value (from report)
- Source link (clickable, opens in new tab)
- Note if provided
- Three action buttons:
  - **Akceptuj** (Accept) → updates the field on `calendar_events`, sets report `status = 'accepted'`
  - **Edytuj** (Edit) → inline-edit the suggested value, then accept
  - **Odrzuc** (Reject) → sets report `status = 'rejected'`

### Admin API endpoints needed

**File:** `backend/src/routes/calendarEvents.js` (extend existing)

- `GET /api/calendar-events/pending` — list events with `status = 'pending'`
- `PATCH /api/calendar-events/:id/approve` — set `status = 'active'`
- `GET /api/calendar-events/reports` — list pending reports with event data
- `PATCH /api/calendar-events/reports/:id/accept` — update event field + set report accepted
- `PATCH /api/calendar-events/reports/:id/reject` — set report rejected

These go through the backend (admin frontend uses backend API, not Supabase directly) using the service_role key.

## Files Summary

### New files
| File | Purpose |
|------|---------|
| `public/src/pages/DodajWydarzenie.jsx` | Public event submission form |
| `public/src/components/ReportEventModal.jsx` | Issue reporting modal |
| `frontend/src/pages/Moderation.jsx` | Admin moderation page (pending events + reports) |

### Modified files
| File | Change |
|------|--------|
| `public/src/App.jsx` | Add route `/kalendarz/dodaj` |
| `public/src/pages/Kalendarz.jsx` | Add "Dodaj wydarzenie" button/link |
| `public/src/components/EventRow.jsx` | Add report icon |
| `backend/src/routes/calendarEvents.js` | Add pending/approve/reports/accept/reject endpoints |
| `backend/src/server.js` | Register new routes (if separate file) |
| `frontend/src/App.jsx` | Add `/moderation` route |

### Supabase migrations
- Create `calendar_event_reports` table with indexes
- Add RLS policies for anon insert on reports and pending events
