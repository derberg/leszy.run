# Website Feedback — "Pomóż ulepszyć" (Help Improve)

**Date:** 2026-03-27
**Status:** Approved

## Overview

Add a general website feedback mechanism to leszy.run. Users can submit suggestions,
bug reports, and improvement ideas via the public Kalendarz page. Admin reviews
submissions in a new third tab on the existing Moderation panel.

This complements the two existing community contribution flows:
- **DodajWydarzenie** — submit a new event
- **ReportEventModal** — report a problem with a specific event

The new flow covers everything else — general UX feedback, missing features, bugs,
content suggestions.

## Supabase Table: `website_feedback`

Supabase-only table (no local Drizzle schema, no local migration). Applied via
`mcp__supabase__apply_migration`.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | UUID | `gen_random_uuid()` | PK |
| `category` | text | — | Required. One of: `'missing_feature'`, `'bug'`, `'content'`, `'other'` |
| `message` | text | — | Required. Free-text feedback |
| `email` | text | — | Optional. User's contact email |
| `status` | text | `'pending'` | `'pending'` / `'reviewed'` / `'dismissed'` |
| `admin_note` | text | — | Optional. Admin can add a note when reviewing |
| `created_at` | timestamptz | `now()` | Submission timestamp |
| `reviewed_at` | timestamptz | — | Set when admin changes status |

### RLS Policies

- **INSERT** — allowed for anon key (public submissions)
- **SELECT** — denied for anon. Service role reads all (admin backend).
- **UPDATE** — denied for anon. Service role updates (admin backend).

## Public UI — Feedback Modal in Kalendarz

### Entry Point

A button in the Kalendarz action area, next to the existing "Dodaj wydarzenie" button.
Label: **"Pomóż ulepszyć"** or similar. Same visual weight as "Dodaj wydarzenie".

### Modal: `FeedbackModal.jsx`

New component in `public/src/components/FeedbackModal.jsx`. Follows the same pattern
as `ReportEventModal.jsx`.

**Fields:**

1. **Kategoria** (required) — select dropdown:
   - `missing_feature` → "Brakująca funkcja"
   - `bug` → "Błąd"
   - `content` → "Treść / dane"
   - `other` → "Inne"

2. **Wiadomość** (required) — textarea, placeholder: "Opisz swoją sugestię..."

3. **Email** (optional) — text input, placeholder: "opcjonalnie, jeśli chcesz odpowiedź"

4. **Honeypot** — hidden field, same anti-spam pattern as `DodajWydarzenie.jsx`

**Submit flow:**
- Validate: category selected, message non-empty, honeypot empty
- Insert directly to Supabase `website_feedback` table via anon key
- Show success toast: "Dziękujemy za sugestię!"
- Close modal

## Backend API

New route file: `backend/src/routes/websiteFeedback.js`

Registered in `server.js` with prefix `/api/website-feedback`.

### Endpoints

```
GET   /api/website-feedback
```
- Query params: `status` (filter, default `'pending'`), `category` (optional filter)
- Returns: `{ data: [...] }` ordered by `created_at DESC`
- Reads from Supabase via service role key

```
PATCH /api/website-feedback/:id/review
```
- Body: `{ admin_note }` (optional)
- Sets `status = 'reviewed'`, `reviewed_at = now()`
- Updates in Supabase via service role key

```
PATCH /api/website-feedback/:id/dismiss
```
- Body: `{ admin_note }` (optional)
- Sets `status = 'dismissed'`, `reviewed_at = now()`
- Updates in Supabase via service role key

## Backoffice — Moderation Panel, 3rd Tab

### Tab: "Sugestie"

Added as the third tab in `frontend/src/pages/Moderation.jsx`, after "Oczekujące" and
"Zgłoszenia".

### List View

Each feedback item displays:
- **Category badge** — color-coded (same rectangular badge style as event type badges)
  - `missing_feature` → cyan badge "Funkcja"
  - `bug` → red badge "Błąd"
  - `content` → yellow badge "Treść"
  - `other` → muted badge "Inne"
- **Message** — full text
- **Email** — shown if provided, otherwise "—"
- **Timestamp** — relative time (e.g. "2 dni temu")

### Actions per item

- **Oznacz jako przeczytane** — marks as `reviewed`
- **Odrzuć** — marks as `dismissed`
- **Notatka** — optional text field for admin note (saved with either action)

### Filtering

Simple status filter at the top: Oczekujące (default) / Przeczytane / Odrzucone / Wszystkie.

## Files to Create or Modify

| File | Action |
|------|--------|
| Supabase migration | Create `website_feedback` table + RLS policies |
| `public/src/components/FeedbackModal.jsx` | New — feedback form modal |
| `public/src/pages/Kalendarz.jsx` | Modify — add "Pomóż ulepszyć" button + modal trigger |
| `backend/src/routes/websiteFeedback.js` | New — API routes for admin |
| `backend/src/server.js` | Modify — register new route |
| `frontend/src/pages/Moderation.jsx` | Modify — add "Sugestie" tab |

## Out of Scope

- Email notifications to admin on new feedback (can be added later)
- Public feedback status tracking (user doesn't see if their feedback was reviewed)
- Rate limiting beyond honeypot (Supabase RLS + honeypot sufficient for now)
