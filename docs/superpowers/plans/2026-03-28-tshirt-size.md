# T-Shirt Size Tracking — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track which participants bought a t-shirt and what size, show reminders during check-in.

**Architecture:** Single `tshirt_size` text column on participants. Flows through existing CSV import, API, admin table, and Supabase sync pipes. Check-in UIs show a yellow banner when size is present.

**Tech Stack:** Drizzle ORM, Fastify, React, Supabase

---

### Task 1: Database migration — local Drizzle

**Files:**
- Create: `backend/src/db/migrations/0020_tshirt_size.sql`
- Modify: `backend/src/db/migrations/meta/_journal.json`
- Modify: `backend/src/db/schema.js:37-58`

- [ ] **Step 1: Create migration SQL file**

Create `backend/src/db/migrations/0020_tshirt_size.sql`:

```sql
ALTER TABLE participants ADD COLUMN tshirt_size text;
```

- [ ] **Step 2: Register migration in journal**

In `backend/src/db/migrations/meta/_journal.json`, add this entry to the `entries` array after the last entry (idx 19):

```json
{
  "idx": 20,
  "version": "7",
  "when": 1743120000000,
  "tag": "0020_tshirt_size",
  "breakpoints": true
}
```

- [ ] **Step 3: Add tshirtSize to Drizzle schema**

In `backend/src/db/schema.js`, inside the `participants` table definition, add after line 51 (`smsSentAt`):

```js
  tshirtSize: text('tshirt_size'),
```

- [ ] **Step 4: Commit**

```bash
git add backend/src/db/migrations/0020_tshirt_size.sql backend/src/db/migrations/meta/_journal.json backend/src/db/schema.js
git commit -m "feat: add tshirt_size column to participants"
```

---

### Task 2: Supabase migration

- [ ] **Step 1: Apply migration to Supabase**

Use the Supabase MCP tool to apply the migration:

```
mcp__supabase__apply_migration with name "add_tshirt_size_to_participants" and query:
ALTER TABLE participants ADD COLUMN IF NOT EXISTS tshirt_size text;
```

- [ ] **Step 2: Verify**

Use `mcp__supabase__list_tables` to confirm `tshirt_size` column exists on `participants`.

- [ ] **Step 3: Commit** (nothing to commit — Supabase migration is remote only)

---

### Task 3: Backend — PATCH endpoint + CSV import

**Files:**
- Modify: `backend/src/routes/participants.js:53` (allowed fields in PATCH)
- Modify: `backend/src/routes/participants.js:142-150` (existing participant update in import)
- Modify: `backend/src/routes/participants.js:156-168` (new participant insert in import)

- [ ] **Step 1: Add tshirtSize to PATCH allowed fields**

In `backend/src/routes/participants.js`, line 53, add `'tshirtSize'` to the `allowed` array:

```js
    const allowed = ['firstName', 'lastName', 'email', 'gender', 'birthDate', 'club', 'bibNumber', 'categoryId', 'rfidEpc', 'phone', 'tshirtSize']
```

- [ ] **Step 2: Add tshirt_size to CSV import — existing participant update**

In `backend/src/routes/participants.js`, inside the `if (existing)` block (around line 142), add `tshirtSize` to the update set. Change the update call to:

```js
        await db.update(participants).set({
          firstName: row.first_name,
          lastName: row.last_name,
          gender: row.gender || existing.gender,
          birthDate: row.birth_date || (row.birth_year ? `${row.birth_year}-01-01` : existing.birthDate),
          club: row.club || existing.club,
          categoryId: categoryId || existing.categoryId,
          phone: phone || existing.phone,
          tshirtSize: row.tshirt_size || existing.tshirtSize,
        }).where(eq(participants.id, existing.id))
```

- [ ] **Step 3: Add tshirt_size to CSV import — new participant insert**

In `backend/src/routes/participants.js`, inside the `else` block (around line 156), add `tshirtSize` to the insert values. Change the insert call to:

```js
        await db.insert(participants).values({
          eventId: req.params.eventId,
          firstName: row.first_name,
          lastName: row.last_name,
          email: row.email || null,
          gender: row.gender || null,
          birthDate: row.birth_date || (row.birth_year ? `${row.birth_year}-01-01` : null),
          club: row.club || null,
          categoryId,
          bibNumber: nextBib,
          emoji,
          phone: phone || null,
          tshirtSize: row.tshirt_size || null,
        })
```

- [ ] **Step 4: Add tshirtSize to Supabase participant upsert in check-in route**

In `backend/src/routes/participants.js`, around line 188, inside the `supabase.from('participants').upsert(...)` call, add `tshirt_size: participant.tshirtSize`:

```js
    await supabase.from('participants').upsert({
      id: participant.id,
      event_id: participant.eventId,
      first_name: participant.firstName,
      last_name: participant.lastName,
      bib_number: participant.bibNumber,
      category_id: participant.categoryId,
      email: participant.email,
      phone: participant.phone,
      gender: participant.gender,
      birth_date: participant.birthDate,
      club: participant.club,
      rfid_epc: participant.rfidEpc,
      emoji: participant.emoji,
      tshirt_size: participant.tshirtSize,
    }, { onConflict: 'id' })
```

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/participants.js
git commit -m "feat: support tshirt_size in PATCH and CSV import"
```

---

### Task 4: Frontend — ParticipantsTable column

**Files:**
- Modify: `frontend/src/components/ParticipantsTable/ParticipantsTable.jsx:200` (header row)
- Modify: `frontend/src/components/ParticipantsTable/ParticipantsTable.jsx:258` (body row, after Kategoria cell)

- [ ] **Step 1: Add column header**

In `frontend/src/components/ParticipantsTable/ParticipantsTable.jsx`, line 200, add `'Koszulka'` to the headers array. Insert it after `'Kategoria'` and before `'RFID'`:

```js
              {['Emoji', 'Nr', 'Imię', 'Nazwisko', 'Email', 'Tel', 'Klub', 'Płeć', 'Data ur.', 'Kategoria', 'Koszulka', 'RFID', 'SMS', 'Z', ''].map(h => (
```

- [ ] **Step 2: Add editable cell in body row**

In `frontend/src/components/ParticipantsTable/ParticipantsTable.jsx`, after the Kategoria `<td>` (line 258) and before the RFID `<td>` (line 259), add:

```jsx
                <td className="px-2 py-1 w-20"><EditableCell participant={p} field="tshirtSize" /></td>
```

- [ ] **Step 3: Add tshirtSize to the "Add participant" form**

In the same file, in the add participant form section (around line 392), add tshirtSize to the field list. Change the array to:

```js
              {[['firstName','Imię *'],['lastName','Nazwisko *'],['phone','Telefon'],['club','Klub'],['tshirtSize','Koszulka']].map(([k, l]) => (
```

Also update the `addForm` initial state (line 21) to include `tshirtSize`:

```js
  const [addForm, setAddForm] = useState({ firstName: '', lastName: '', email: '', phone: '', club: '', gender: '', birthDate: '', categoryId: '', tshirtSize: '' })
```

And update the reset in `onSuccess` of `addPart` mutation (line 73):

```js
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['participants', eventId] }); setAddOpen(false); setAddForm({ firstName: '', lastName: '', email: '', phone: '', club: '', gender: '', birthDate: '', categoryId: '', tshirtSize: '' }); setEmailError('') },
```

And update the `addPart.mutate` call (around line 448) to include tshirtSize:

```js
                onClick={() => addPart.mutate({ ...addForm, birthDate: addForm.birthDate || null, categoryId: addForm.categoryId || null, phone: addForm.phone || null, tshirtSize: addForm.tshirtSize || null })}
```

- [ ] **Step 4: Add CSV column hint in ImportWizard**

In `frontend/src/components/ImportWizard/ImportWizard.jsx`, update the description and example for participant import (line 20-21):

```js
        description="CSV z kolumnami: first_name, last_name, email, gender, birth_year, club, category_id, tshirt_size"
        example={"first_name,last_name,email,gender,birth_year,club,category_id,tshirt_size\nJan,Kowalski,jan@example.com,M,1990,KS Biega,bieg-5km,L"}
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/ParticipantsTable/ParticipantsTable.jsx frontend/src/components/ImportWizard/ImportWizard.jsx
git commit -m "feat: add Koszulka column to admin participants table"
```

---

### Task 5: Check-in reminder — ParticipantsTable check-in flow

**Files:**
- Modify: `frontend/src/components/ParticipantsTable/ParticipantsTable.jsx:111-118` (handleCheckinClick)
- Modify: `frontend/src/components/ParticipantsTable/ParticipantsTable.jsx:316-343` (check-in status cell)

- [ ] **Step 1: Show t-shirt reminder in check-in status column tooltip**

In `frontend/src/components/ParticipantsTable/ParticipantsTable.jsx`, in the check-in cell (around line 316-343), update the `title` for the unchecked-in state to include t-shirt info. Replace the title computation (lines 321-325):

```js
                    const tshirtNote = p.tshirtSize ? ` | 👕 Koszulka: ${p.tshirtSize}` : ''
                    const title = confirmedAt
                      ? `Zameldowany przez organizatora: ${new Date(confirmedAt).toLocaleString('pl-PL')} — kliknij aby cofnąć`
                      : selfCheckedIn
                      ? `Samozameldowanie online${p.checkin.createdAt ? ': ' + new Date(p.checkin.createdAt).toLocaleString('pl-PL') : ''} — potwierdź odbiór pakietu${tshirtNote}`
                      : `Zamelduj${tshirtNote}`
```

- [ ] **Step 2: Add t-shirt banner in minor check-in dialog**

In the minor check-in dialog (around lines 497-534), after the `<p>` with participant name (line 504-506), add a t-shirt reminder banner if applicable:

```jsx
            {minorCheckinTarget?.tshirtSize && (
              <div className="border border-apex-yellow/40 bg-apex-yellow/10 p-3">
                <span className="text-sm text-apex-yellow font-bold">👕 Wydaj koszulkę: rozmiar {minorCheckinTarget.tshirtSize}</span>
              </div>
            )}
```

- [ ] **Step 3: Show t-shirt banner for non-minor check-in too**

Currently, non-minor check-in has no dialog — it calls `checkinMutation.mutate` directly. To show a t-shirt reminder, we need a confirmation dialog when `tshirtSize` is present on a non-minor participant.

In `handleCheckinClick` (lines 111-118), add a path for t-shirt participants. We'll reuse the minor dialog by extending it to also handle t-shirt-only confirmations.

Replace `handleCheckinClick`:

```js
  const handleCheckinClick = (p) => {
    const needsMinorDocs = isMinor(p) && minorProvideDocs.length > 0
    if (needsMinorDocs || p.tshirtSize) {
      setMinorCheckinTarget(p)
      setMinorDocChecks({})
    } else {
      checkinMutation.mutate({ participantId: p.id })
    }
  }
```

Then update the dialog title to be context-aware. Replace the `<DialogTitle>` (line 501):

```jsx
            <DialogTitle>{isMinor(minorCheckinTarget) && minorProvideDocs.length > 0 ? 'Zamelduj nieletniego' : 'Zamelduj uczestnika'}</DialogTitle>
```

And conditionally show the document checklist only when minor docs apply. Wrap the existing doc checklist section (lines 507-518) with a condition:

```jsx
            {isMinor(minorCheckinTarget) && minorProvideDocs.length > 0 && (
              <div className="space-y-2">
                {minorProvideDocs.map(doc => (
                  <label key={doc.id} className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      checked={!!minorDocChecks[doc.id]}
                      onChange={e => setMinorDocChecks(prev => ({ ...prev, [doc.id]: e.target.checked }))}
                      className="accent-apex-yellow w-4 h-4"
                    />
                    <span className="text-apex-text">{doc.name}</span>
                  </label>
                ))}
              </div>
            )}
```

And update the button disabled condition (line 528) to only require doc checks when there are minor docs:

```jsx
              disabled={checkinMutation.isPending || (isMinor(minorCheckinTarget) && minorProvideDocs.length > 0 && minorProvideDocs.some(d => !minorDocChecks[d.id]))}
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/ParticipantsTable/ParticipantsTable.jsx
git commit -m "feat: t-shirt reminder in admin check-in flow"
```

---

### Task 6: Check-in reminder — AdminCheckin.jsx (volunteer check-in page)

**Files:**
- Modify: `public/src/pages/AdminCheckin.jsx:458-478` (after the minor warning section)

- [ ] **Step 1: Read current AdminCheckin.jsx to find exact insertion point**

Read `public/src/pages/AdminCheckin.jsx` around lines 450-490 to find the minor warning block and what comes after it.

- [ ] **Step 2: Add t-shirt banner after minor warning**

After the minor warning block (ends around line 478) and before the check-in confirm button, add:

```jsx
{/* T-shirt reminder */}
{selectedParticipant?.tshirt_size && (
  <div className="border border-apex-yellow/40 bg-apex-yellow/10 p-5 mb-6">
    <div className="font-display text-lg uppercase tracking-wider text-apex-yellow mb-1">Wydaj koszulkę</div>
    <div className="text-apex-text-bright text-sm">
      Rozmiar: <strong className="text-apex-yellow">{selectedParticipant.tshirt_size}</strong>
    </div>
  </div>
)}
```

Note: AdminCheckin.jsx reads data from Supabase directly using snake_case column names, so use `tshirt_size` (not `tshirtSize`).

- [ ] **Step 3: Commit**

```bash
git add public/src/pages/AdminCheckin.jsx
git commit -m "feat: t-shirt reminder on volunteer check-in page"
```

---

### Task 7: Check-in reminder — public self-check-in page (Checkin.jsx)

**Files:**
- Modify: `public/src/pages/Checkin.jsx:214-226` (after the minor warning section, in the post-check-in view)

- [ ] **Step 1: Read current Checkin.jsx to find the post-check-in success screen**

Read `public/src/pages/Checkin.jsx` to find the success screen that shows after self-check-in (the "Zameldowano!" message area with QR code and the yellow race-office banner).

- [ ] **Step 2: Add t-shirt pickup reminder in post-check-in screen**

After the existing yellow banner about picking up the race kit, add a t-shirt-specific reminder if `tshirt_size` is present:

```jsx
{participant?.tshirt_size && (
  <div className="border border-apex-yellow/40 bg-apex-yellow/10 p-5">
    <div className="font-display text-lg uppercase tracking-wider text-apex-yellow mb-1">👕 Koszulka</div>
    <div className="text-apex-text-bright text-sm">
      Pamiętaj odebrać koszulkę (rozmiar <strong className="text-apex-yellow">{participant.tshirt_size}</strong>) w biurze zawodów.
    </div>
  </div>
)}
```

Note: Checkin.jsx reads data from Supabase directly, so use `tshirt_size` (snake_case).

- [ ] **Step 3: Commit**

```bash
git add public/src/pages/Checkin.jsx
git commit -m "feat: t-shirt pickup reminder on public check-in page"
```
