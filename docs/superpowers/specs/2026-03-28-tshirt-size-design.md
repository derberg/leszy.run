# T-Shirt Size Tracking

## Summary

Add a `tshirt_size` field to participants so organizers can track who bought a t-shirt and what size. The field is free-text (supports standard sizes like S/M/L/XL and kids numeric sizes like 128/140). Presence of a value means the participant bought a t-shirt.

## Data Model

Single new column on `participants` table:

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| `tshirt_size` | text | yes | null |

No new tables, no enums. Free-text accommodates both letter sizes (S, M, L, XL, XXL, XXXL) and kids numeric sizes (128, 140, 152, etc.).

null = no t-shirt purchased. Any non-null value = t-shirt purchased in that size.

## Changes

### 1. Database migration (local + Supabase)

Add `tshirt_size` text column to `participants`. Both local Drizzle migration and Supabase migration.

### 2. Drizzle schema

Add `tshirtSize` field to participants table definition in `backend/src/db/schema.js`.

### 3. CSV import

Add optional `tshirt_size` column to participant CSV import in `backend/src/routes/participants.js`. Maps to `tshirtSize` on the participant record. Empty/missing = null.

### 4. Admin ParticipantsTable — inline editable column

Add a "Koszulka" (t-shirt) column to `ParticipantsTable.jsx`. Inline-editable like other fields. Shows the size value or empty if none. PATCH on blur/Enter as usual.

### 5. Check-in reminder — admin check-in

When `tshirt_size` is present, show a yellow/amber banner in the check-in flow — same visual style as the minor parental consent reminder ("Odbierz oswiadczenie od opiekuna"). Banner text: **"Wydaj koszulke: rozmiar {size}"**.

This applies in two places:
- **ParticipantsTable check-in dialog** (`frontend/src/components/ParticipantsTable/ParticipantsTable.jsx`) — the dialog that appears when admin clicks the check-in status icon
- **AdminCheckin page** (`public/src/pages/AdminCheckin.jsx`) — the volunteer check-in page with QR scan / manual search

### 6. Public self-check-in page

On `public/src/pages/Checkin.jsx`, after successful self-check-in, if `tshirt_size` is present, show a reminder banner (same yellow style): **"Pamietaj odebrac koszulke (rozmiar {size}) w biurze zawodow"** — reminding the participant to pick up their t-shirt at the race office.

### 7. Supabase sync

No extra work — `tshirt_size` rides existing participant sync. The `trg_reset_synced_at_participants` trigger handles re-sync on updates automatically.

## Out of scope

- T-shirt inventory management (counting how many of each size remain)
- T-shirt as a separate purchasable item (it's tied to participant, not a cart)
- Payment tracking
- Multiple t-shirt types or variants per event
