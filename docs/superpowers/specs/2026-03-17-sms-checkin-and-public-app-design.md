# SMS Check-in & Unified Public App — Design Spec

**Date:** 2026-03-17
**Status:** Draft

## Overview

Add SMS-based pre-event check-in for participants and merge the three public-facing apps (`liveresults/`, `volunteer/`, and the new check-in flow) into a single `public/` app deployed on Vercel at `leszy.run`.

Participants receive an SMS with a link to a self-service check-in page where they review their info, acknowledge required documents, and receive a QR code. At the event, staff scan the QR (or search manually) to confirm check-in. A scoped reverse sync (Supabase → local) ensures the local backend knows who is checked in for race seeding.

## Goals

- Participants can self-service check-in from their phones before event day
- Staff at the event counter can confirm check-in via QR scan or manual lookup
- Flexible document/agreement system (not hardcoded to specific document names)
- Merge three Vercel apps into one with slug-based event routing
- Maintain one-way local → Supabase sync for all existing data; add scoped reverse sync for check-in data only

## Non-goals (future work)

- Event registration platform (leszy.run as browsable event directory)
- Subdomain per event (niebocross.leszy.run)
- Apple Wallet / Google Wallet pass generation (noted as future enhancement via Supabase Edge Functions or Vercel serverless functions)
- Offline check-in support
- User accounts / authentication system

---

## Data Model

### Local DB changes

#### `events` table — new columns

| Column | Type | Notes |
|---|---|---|
| `slug` | `TEXT UNIQUE NOT NULL` | URL-friendly identifier, auto-generated from event name, editable. Lowercase, alphanumeric + hyphens only. Used in all public URLs: `leszy.run/{slug}/...` |

Note: `checkin_pin` is NOT stored on the local events table. It lives in a separate Supabase-only table (`event_secrets`) to prevent exposure via public SELECT on events. See "Supabase-only additions" section.

#### `participants` table — new columns

| Column | Type | Notes |
|---|---|---|
| `phone` | `TEXT` | Mobile number for SMS. Populated via CSV import. Synced to Supabase via existing local → Supabase flow. |
| `sms_sent_at` | `TIMESTAMPTZ` | Set by backend when check-in SMS is sent. Synced to Supabase. |

#### `event_documents` table — new (local, synced → Supabase)

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID PK` | |
| `event_id` | `UUID → events(id) ON DELETE CASCADE` | |
| `name` | `TEXT NOT NULL` | Display name, e.g. "Regulamin", "Oświadczenie rodzica", "RODO" |
| `type` | `TEXT NOT NULL` | `acknowledge` (participant ticks checkbox online) or `provide` (admin verifies physical document at counter) |
| `url` | `TEXT` | Link to view or download the document |
| `required_for` | `TEXT NOT NULL DEFAULT 'all'` | `all` or `minors` — who must complete this document |
| `sort_order` | `INTEGER DEFAULT 0` | Display order |
| `created_at` | `TIMESTAMPTZ` | |
| `updated_at` | `TIMESTAMPTZ` | |
| `synced_at` | `TIMESTAMPTZ` | |

**Important:** This table syncs local → Supabase and must have a `trg_reset_synced_at_event_documents` trigger in the migration (per CLAUDE.md convention for all forward-synced tables).

#### `checkins` table — new (Supabase → local mirror)

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID PK` | |
| `participant_id` | `UUID UNIQUE → participants(id) ON DELETE CASCADE` | One check-in record per participant |
| `event_id` | `UUID → events(id) ON DELETE CASCADE` | |
| `checked_in_at` | `TIMESTAMPTZ` | Set when admin confirms check-in at counter |
| `created_at` | `TIMESTAMPTZ` | When the checkins row was first created (document acknowledgment step or admin manual) |
| `updated_at` | `TIMESTAMPTZ` | Auto-updated on any modification (Supabase trigger). Used by reverse sync to detect changes. |
| `synced_at` | `TIMESTAMPTZ` | For reverse sync tracking |

This table is a mirror of the Supabase `checkins` table. It is one of only two tables with Supabase → local sync direction. Race seeding joins `participants` with `checkins` to determine who is checked in.

**Important:** This table must NOT have the `trg_reset_synced_at` trigger (used by forward-sync tables). It must also be excluded from the `SYNC_TABLES` array in the forward sync worker (`src/sync/supabase.js`). The reverse sync worker manages `synced_at` independently.

#### `checkin_documents` table — new (Supabase → local mirror)

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID PK` | |
| `checkin_id` | `UUID → checkins(id) ON DELETE CASCADE` | |
| `document_id` | `UUID → event_documents(id) ON DELETE CASCADE` | |
| `completed_at` | `TIMESTAMPTZ` | When the document was acknowledged/provided |
| `completed_by` | `TEXT` | `participant` (self-service) or `admin` (at counter) |
| `created_at` | `TIMESTAMPTZ` | |
| `updated_at` | `TIMESTAMPTZ` | Auto-updated on modification (Supabase trigger) |
| `synced_at` | `TIMESTAMPTZ` | For reverse sync tracking |

This is the join table tracking which documents each participant has completed. Mirrored from Supabase alongside `checkins`.

**Important:** Same sync exclusion rules as `checkins` — no `trg_reset_synced_at` trigger, excluded from forward sync `SYNC_TABLES`.

### Supabase-only additions

#### `event_secrets` table — Supabase only, no public read

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID PK` | |
| `event_id` | `UUID UNIQUE → events(id) ON DELETE CASCADE` | |
| `checkin_pin` | `TEXT` | 4–6 digit PIN for admin check-in view access. Auto-generated on event creation, changeable. |

**RLS:** No public SELECT. Only accessible via the `checkin_confirm` DB function which validates the PIN without exposing it. The admin panel (frontend/) manages this via a dedicated backend endpoint that uses the Supabase service_role key.

The `checkins` and `checkin_documents` tables exist in Supabase as the source of truth. They contain the same columns as the local mirrors, plus Supabase auto-manages `updated_at` via trigger. The public app reads and writes these directly via Supabase client + RLS.

The `event_documents` table is synced local → Supabase (same direction as other config tables).

### Sync summary

| Direction | Tables |
|---|---|
| **Local → Supabase** (existing + extended) | `events` (+slug), `participants` (+phone, +sms_sent_at), `event_documents` (new), all other existing tables |
| **Supabase → Local** (new, scoped) | `checkins`, `checkin_documents` |
| **Supabase only** | `event_secrets` (checkin_pin) |

**Documentation updates required:** CLAUDE.md and ARCHITECTURE.md must be updated to document the reverse sync exception for `checkins` and `checkin_documents`. The one-way sync rule remains the default; these two tables are the only exception, clearly scoped to check-in data.

### What replaces `checked_in` / `checked_in_at` on participants

The existing `checked_in` boolean and `checked_in_at` timestamp on the participants table are replaced by the presence of a `checkins` row with a non-null `checked_in_at`. Race seeding query becomes:

```sql
SELECT p.*, c.checked_in_at
FROM participants p
LEFT JOIN checkins c ON c.participant_id = p.id
```

A participant is considered checked in when `c.checked_in_at IS NOT NULL`.

**Deprecation of `checked_in` / `checked_in_at` on participants:** These columns are removed via migration. All code that reads `checkedIn` or `checkedInAt` from the participants table is refactored to use the `checkins` join instead. This includes:
- Race seeding in `backend/src/routes/races.js` (checks `p.checkedIn` to set initial result status)
- `ParticipantsTable` check-in toggle in `frontend/`
- The `PATCH /api/participants/:id` handler that auto-sets `checkedInAt`
- Supabase sync (remove these columns from the forward sync upsert)

---

## User Flows

### Flow 1: Admin sends SMS (local admin panel → backend → SMSAPI)

1. Admin opens event → Participants tab in `frontend/`
2. Sees phone column + SMS status (sent/not sent with timestamp) per participant
3. Can send SMS per participant (icon in row) or bulk ("Send Check-in SMS to All" button)
4. Bulk send shows confirmation dialog: "Will send to X participants (Y without phone, Z already sent)"
5. Backend calls SMSAPI for each eligible participant
6. SMS text: `"Cześć {firstName}! Zamelduj się na {eventName}: leszy.run/{slug}/checkin?p={participantId}"`
7. Backend sets `sms_sent_at` on each participant after successful send
8. Returns `{ sent: N, skipped: N, errors: [...] }`

**Note on SMS encoding:** Polish diacritics (ą, ć, ę, etc.) force UCS-2 encoding, which limits a single SMS segment to 70 characters. Long event names or participant names may push messages to 2 segments (doubling cost). Consider keeping event names concise or using a URL shortener for the link.

### Flow 2: Participant self-service check-in (public app)

1. Participant opens SMS link: `leszy.run/{slug}/checkin?p={participantId}`
2. Public app looks up participant + event from Supabase
3. **Landing:** Shows greeting with name, category, bib number. If minor (calculated from `birth_date` — participant is under 18 on event date): yellow banner with reminder about any `provide`-type documents, with download links.
4. **Documents:** For each `event_document` where `type = 'acknowledge'` and applicable to this participant (`required_for = 'all'` or `= 'minors'` if minor): checkbox with document name as link to URL. "Confirm" button disabled until all are ticked.
5. **On confirm:** INSERT into Supabase `checkins` table (participant_id, event_id, created_at). INSERT into `checkin_documents` for each acknowledged document (completed_by = 'participant').
6. **QR Code:** Shows large QR encoding the participant ID. Buttons: "Save to gallery" (download as PNG). Below: reminder about any `provide`-type documents if applicable.
7. **Revisit:** If participant opens link again and checkins row exists — skip to QR step. If `checked_in_at` is set — show "You're checked in" confirmation.

**Note on link security:** The SMS link contains the participant UUID. Anyone with the link can view basic participant info (name, category, bib number). This is accepted as low risk — the same information is publicly visible on race results pages. The link does not expose sensitive data (phone, email, birth date).

### Flow 3: Admin check-in at event counter (public app)

1. Staff opens `leszy.run/{slug}/admin/checkin` on phone/tablet
2. **PIN gate:** Prompted for PIN (4–6 digits). Validated via Supabase DB function `verify_checkin_pin(event_id, pin)` which checks against `event_secrets` table (never exposed to client). Stored in `sessionStorage` for the tab session.
3. **Entry — two paths:**
   - **QR scan:** Camera button → scans QR → extracts participant ID → validates participant belongs to this event (by checking `participant.event_id` matches current event from slug). Shows "Not found" if mismatched or invalid.
   - **Manual search:** Text field → type name or bib number → select from results (filtered to current event)
4. **Participant card:** Shows name, bib number (large, prominent — staff uses this to grab the right bib card with RFID attached), category. Status indicators for each event document: ✓ completed / ✗ not completed.
5. **For `provide`-type documents not yet completed:** Checkbox that admin must tick before check-in is allowed (e.g., "Oświadczenie rodzica — received"). For participants with missing `provide` documents, the check-in button is disabled until all are ticked.
6. **For `acknowledge`-type documents not completed** (manual fallback — participant didn't do self-service): Admin can tick these on behalf of participant after verbal confirmation.
7. **Confirm check-in:** Button calls Supabase DB function `checkin_confirm(participant_id, pin, documents)` — validates PIN, updates `checkins.checked_in_at`, inserts any newly completed `checkin_documents` rows.
8. **Success:** Green flash + "Checked in ✓" + auto-return to scan/search for next participant.
9. **Invalid/malformed QR:** Shows "Not found" — no errors, no data leaks.

### Flow 4: Existing admin panel check-in (frontend/)

The existing check-in icon in `ParticipantsTable` continues to work for on-site use from the local admin. Since `checkins` is Supabase → local (not bidirectional), the admin panel writes check-in data **directly to Supabase** (the backend already has the Supabase service_role client for sync), and the reverse sync pulls it into the local DB.

- **Adult:** Click → confirms check-in (backend writes to Supabase `checkins` table via service_role, reverse sync mirrors to local)
- **Minor (or any participant with incomplete `provide`-type documents):** Click → dialog pops up listing all incomplete `provide`-type documents as checkboxes. Check-in button disabled until all are ticked. On confirm, backend writes `checkins` + `checkin_documents` rows to Supabase.

This avoids bidirectional sync complexity — Supabase is always the source of truth for check-in data, regardless of whether the write originates from the public app or the admin panel.

---

## App Architecture

### New `public/` app (replaces `liveresults/` and `volunteer/`)

**Route structure:**

| Route | Purpose | Source |
|---|---|---|
| `/:slug` | Event hub page — links to results, check-in, etc. Simple placeholder for now. | New |
| `/:slug/results` | Live results, podium, checkpoint tracking | Migrated from `liveresults/` |
| `/:slug/volunteer` | Checkpoint bib entry numpad | Migrated from `volunteer/` |
| `/:slug/checkin?p={id}` | Participant self-service check-in | New |
| `/:slug/admin/checkin` | Staff QR scan + manual lookup, PIN-gated | New |
| `/` | Root — redirect to latest event or simple event list (placeholder for future platform) | New |

**Tech stack:**

- React + Vite + React Router (same stack as other apps)
- `@supabase/supabase-js` with anon key + RLS
- Supabase Realtime for live results (existing pattern from `liveresults/`)
- `packages/ui/` shared components (Podium, CheckpointTrackingTable, PositionBadge)
- Tailwind v4 + OVERDRIVE theme
- `qrcode.react` — QR code generation (participant view)
- `html5-qrcode` — camera-based QR scanning (admin view)
- Deployed to Vercel at `leszy.run`

**Wallet integration (future):** Apple Wallet (.pkpass) and Google Wallet (JWT) pass generation can be added via Supabase Edge Functions or Vercel serverless functions. Out of scope for initial implementation — "save QR as image" covers the basic need.

### Migration plan

**Phase 1 — Build alongside existing apps:**
- Create `public/` with new route structure
- Move `liveresults/` pages → `/:slug/results` routes
- Move `volunteer/` pages → `/:slug/volunteer` routes
- Build new check-in routes
- Shared components already in `packages/ui/`

**Phase 2 — Deploy and switch:**
- Deploy `public/` to Vercel on `leszy.run`
- Verify all routes work
- Remove `liveresults/` and `volunteer/` directories from repo

### Supabase RLS policies

**`participants` table:** Public SELECT (already exists for results display).

**`event_documents` table:** Public SELECT (needed to render document lists in check-in flow).

**`event_secrets` table:**
- SELECT: **none** (no public read). Only accessible through DB functions.
- INSERT/UPDATE: via backend service_role key only (admin panel manages PIN).

**`checkins` table:**
- SELECT: public (anyone can check status)
- INSERT: anon can insert WHERE `participant_id` matches a valid participant AND no existing row for that `participant_id` (one-time self-service)
- UPDATE: via Supabase DB function `checkin_confirm(participant_id, pin, documents)` only — validates PIN against `event_secrets.checkin_pin`, sets `checked_in_at` and related fields. Admin actions go through the function, not direct UPDATE.

**`checkin_documents` table:**
- SELECT: public
- INSERT: anon can insert WHERE linked `checkin_id` exists (open to anyone with a valid checkin_id — acceptable since checkin_ids are not guessable and document acknowledgment is not sensitive)
- UPDATE: via same `checkin_confirm` DB function (for admin-verified documents)

### Supabase DB functions

**`verify_checkin_pin(p_event_id UUID, p_pin TEXT) → BOOLEAN`**
- Checks `event_secrets` for matching event_id + pin
- Returns true/false, never exposes the actual PIN
- Used by admin check-in view on PIN entry

**`checkin_confirm(p_participant_id UUID, p_pin TEXT, p_documents JSONB) → JSONB`**
- Validates PIN against event_secrets for the participant's event
- Sets `checkins.checked_in_at = now()` (creates checkins row if it doesn't exist)
- Inserts `checkin_documents` rows for each document in p_documents array
- Returns the updated checkin record
- Single atomic operation — all or nothing

---

## SMS Integration

### SMSAPI setup

**New backend files:**
- `backend/src/sms/smsapi.js` — SMSAPI client wrapper (REST API calls)
- `backend/src/routes/sms.js` — SMS endpoints

**Environment variables (new):**
- `SMSAPI_TOKEN` — SMSAPI OAuth bearer token
- `SMSAPI_SENDER` — Sender name displayed on SMS (e.g. "LeszyRun")

**Endpoints:**

```
POST /api/events/:eventId/sms/checkin
  body: { participantIds: ["uuid", ...] }
  — sends to specific participants

POST /api/events/:eventId/sms/checkin-all
  — sends to all participants with phone number and no sms_sent_at
```

**Behavior:**
- Skips participants without phone number
- Skips participants with existing `sms_sent_at` (for bulk endpoint)
- Sets `sms_sent_at` on each participant after successful send
- Returns `{ sent: N, skipped: N, errors: [{ participantId, message }] }`
- SMSAPI handles rate limiting; backend sends sequentially

**SMS message template:**
```
Cześć {firstName}! Zamelduj się na {eventName}: leszy.run/{slug}/checkin?p={participantId}
```

---

## Reverse Sync: Supabase → Local

### New file: `backend/src/sync/checkinSync.js`

Runs alongside the existing local → Supabase sync worker on a 30-second interval.

**Logic:**
1. Query Supabase `checkins` where `updated_at > last_sync_timestamp` (or all rows if first run)
2. Upsert into local `checkins` table
3. Query Supabase `checkin_documents` for the affected checkin IDs
4. Upsert into local `checkin_documents` table
5. Set `synced_at = now()` on local rows

**`last_sync_timestamp` storage:** Stored in-memory in the sync worker. On backend restart, performs a full fetch (acceptable — checkins table is small, bounded by participant count per event). No persistent storage needed.

**Manual trigger:** Admin UI gets a "Pull check-ins" button that triggers an immediate sync cycle via `POST /api/events/:eventId/sync/checkins`. Useful right before starting a race.

**Important:** The `checkins` and `checkin_documents` tables are excluded from the forward sync worker's `SYNC_TABLES` array and do not have the `trg_reset_synced_at` trigger. This prevents infinite sync loops.

---

## Admin Panel Changes (frontend/)

### Event settings section

New fields in the event edit form:
- **Slug** — text input, auto-generated from event name (slugify), editable. Validation: lowercase, `[a-z0-9-]` only, unique.
- **Check-in PIN** — auto-generated on event creation, displayed with copy button, regeneratable. Managed via backend endpoint that writes to Supabase `event_secrets` table using service_role key.

### Event documents management

New section/tab in event detail page for managing documents:
- Add/remove documents with: name, type (`acknowledge` or `provide`), URL, applies to (`all` or `minors`), sort order
- Inline editing in a simple table or card list

### ParticipantsTable updates

**New columns:**
- Phone (editable inline, from CSV import)
- SMS status (icon: sent ✓ with timestamp / not sent)
- Check-in status summary (from local `checkins` + `checkin_documents` mirror): document completion ✓/✗ per document, checked in ✓/✗

**New actions:**
- Per-row "Send SMS" icon (visible only if phone present + not yet sent)
- Bulk "Send Check-in SMS to All" button above table with confirmation dialog showing count breakdown

**Check-in icon behavior update:**
- Adult (no incomplete `provide`-type documents): click → confirms check-in (backend writes to Supabase `checkins` via service_role)
- Participant with incomplete `provide`-type documents: click → dialog listing incomplete documents as checkboxes. Check-in button disabled until all ticked.

### CSV import extension

New mappable column in import wizard: `phone` / `telefon` / `tel`. Validates E.164 format for flexibility (Polish numbers: +48 followed by 9 digits, but international participants supported). Stored on participant, synced to Supabase.

---

## Required Documentation Updates

After implementation, update these files to reflect the new patterns:

- **CLAUDE.md:** Document the reverse sync exception for `checkins` and `checkin_documents`. Update sync rules to note that these two tables are Supabase → local. Add `event_secrets` to the list of Supabase-only tables. Add `SMSAPI_TOKEN` and `SMSAPI_SENDER` to environment variables section. Document the `public/` app in the monorepo structure.
- **ARCHITECTURE.md:** Update the sync architecture diagram to show bidirectional flow for check-in data. Document the `event_documents` / `checkins` / `checkin_documents` tables and their sync directions.

---

## Open Questions

1. **SMS language:** Should the SMS template be configurable per event, or is Polish-only fine for now?
2. **Check-in deadline:** Should there be a cutoff after which self-service check-in is disabled (e.g., 1 hour before event)?
3. **Slug collision:** Auto-generated slugs could collide across events. Validation ensures uniqueness, but should we namespace by year (e.g., `niebocross-2026`)?
