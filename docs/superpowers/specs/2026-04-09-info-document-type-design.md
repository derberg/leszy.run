# Info Document Type — Design Spec

**Date:** 2026-04-09
**Scope:** Add `info` document type for non-blocking links (e.g. external survey forms) in check-in flow

## Summary

Add a third document type `info` alongside existing `acknowledge` and `provide`. Info documents display as clickable links during and after check-in, without gating the process. Typical use: linking to an external feedback form (Google Forms, Tally, etc.).

## Changes

### 1. Database migration (local + Supabase)

Alter the `type` column check constraint on `event_documents` to allow `'info'` in addition to `'acknowledge'` and `'provide'`.

No new tables. No new columns. No changes to `checkin_documents` — info docs don't generate checkin_document rows (nothing to accept/verify).

### 2. Admin documents tab (frontend)

**File:** `frontend/src/pages/EventDetail.jsx` — `DocumentsManager` component

- Add `'info'` to the document type dropdown (alongside acknowledge/provide)
- Label: "Info (link)" or similar
- Existing URL field works as-is for the external form URL
- `requiredFor` filter still applies (all/minors/adults)

### 3. Public check-in page

**File:** `public/src/pages/Checkin.jsx`

**During check-in (before confirm):**
- Fetch info docs alongside acknowledge/provide docs (already fetched, just filtered differently)
- Render info docs as non-blocking clickable links (opens in new tab)
- Visually distinct from acknowledge checkboxes — info icon + link, no checkbox
- Does NOT gate the confirm button

**After check-in (confirmation screen):**
- Show info doc links again below the QR code
- Same rendering: clickable link, opens in new tab

### 4. Admin check-in page

**File:** `public/src/pages/AdminCheckin.jsx`

- Show info docs as read-only links in the document checklist section
- No action required from admin (no checkbox, no verify button)

## What stays the same

- No new API endpoints — existing `/events/:eventId/documents` CRUD handles it
- No new DB tables
- `requiredFor` filtering works unchanged (all/minors/adults)
- Backend validation just needs to accept `'info'` as a valid type value
- Supabase sync works unchanged (event_documents already syncs)

## Out of scope

- Response collection/analytics from external forms
- Built-in survey/form builder
- Enforcing form completion
