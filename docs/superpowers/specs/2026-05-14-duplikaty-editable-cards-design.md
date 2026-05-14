# DUPLIKATY — Editable Full-Detail Cards

**Date:** 2026-05-14
**Status:** Approved

## Problem

The DUPLIKATY tab shows duplicate calendar event groups, but each card only displays a minimal subset of fields (name, source, location, voivodeship, distances, event_type, price, a few flags). When resolving duplicates the admin often wants to edit one event (fix missing fields, correct a URL) and then delete the other — but there is currently no way to edit from within the DUPLIKATY view.

## Goal

Each event card in a duplicate group shows all fields that appear on the leszy.run public calendar, and every field is inline-editable using the same click-to-edit pattern as the main event table.

## Backend change

`GET /calendar-events/duplicates` — extend the Supabase `select()` call to include the currently missing fields:
- `is_night`
- `is_charity`
- `website`
- `locked_fields`

No other backend change is needed; the PATCH endpoint already handles all these fields.

## Frontend changes — `CalendarEventsList.jsx`

### New component: `InlineBoolToggle`

A small click-to-toggle component for boolean fields (`is_night`, `is_charity`). Displays "tak" (green) / "nie" (muted) and calls `onSave(eventId, { [field]: !current })` on click. Respects `locked_fields` with a lock indicator.

### Updated `DuplicatesView`

Add a `saveMutation` that calls `PATCH /calendar-events/:id` and invalidates the `calendar-events-duplicates` query on success. Pass `onSave(id, patch)` down to `DuplicateGroup`.

### Rewritten `DuplicateGroup`

Replace the current compact horizontal card per event with an expanded property-grid card. Layout:

**Card header (full-width row):**
- Left: event name (editable with `InlineEdit`, larger text)
- Right: source badge + "Usuń" button (with existing confirm flow)

**Property grid (2-column label/value grid):**

| Field | Component |
|---|---|
| Data | `InlineEdit` field="date" |
| Miejscowość | `InlineEdit` field="location" |
| Województwo | `InlineEdit` field="voivodeship" |
| Typ | `InlineArrayEdit` field="event_type" |
| Dystanse | `InlineArrayEdit` field="distances" |
| URL zapisy | `InlineEdit` field="registration_url" (value shown as clickable link) |
| Regulamin | `InlineEdit` field="regulamin_url" (value shown as clickable link) |
| Strona | `InlineEdit` field="website" (value shown as clickable link) |
| Deadline | `InlineEdit` field="registration_deadline" |
| Cena od | `InlineEdit` field="price_from" |
| Cena do | `InlineEdit` field="price_to" |
| Nocny | `InlineBoolToggle` field="is_night" |
| Charytatywny | `InlineBoolToggle` field="is_charity" |

**Card footer (full-width row):**
- Geo status badge (zielony "geo" if lat/lng present, red "brak geo" if not)
- `locked_fields` count badge if any fields are locked

URL fields show the current value as a `<a target="_blank">` link when set, with edit-on-click (same as the main table). Inline editing activates on click anywhere on the value.

## What stays the same

- "Nie duplikat" button on the group header
- "Usuń" per-card confirm flow (Enter/Y/Esc)
- `InlineEdit` and `InlineArrayEdit` implementations are unchanged
- `DuplicatesView` query and delete/dismiss mutations are unchanged

## Out of scope

- Geo editing (lat/lng) — no manual geocode UI exists elsewhere, skip
- Status change from DUPLIKATY view — use main table for that
- Adding new fields not currently in `calendar_events`
