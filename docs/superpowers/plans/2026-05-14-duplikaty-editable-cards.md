# DUPLIKATY — Editable Full-Detail Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand each event card in the DUPLIKATY view to show all leszy.run calendar fields with inline editing, so admins can fix one event and delete the duplicate in a single workflow.

**Architecture:** Backend `/calendar-events/duplicates` needs 4 extra columns in its Supabase select. Frontend adds `InlineBoolToggle` + `DuplicateUrlField` helper components, replaces the compact `DuplicateGroup` card markup with an expanded `DuplicateEventCard`, and wires a PATCH mutation in `DuplicatesView`.

**Tech Stack:** React, TanStack Query (`useMutation`), Tailwind v4 with `apex-*` tokens, existing `InlineEdit`/`InlineArrayEdit` components, `api.patch()` helper.

---

## File Map

| File | Change |
|---|---|
| `backend/src/routes/calendarEvents.js` | Line 19 — add `is_night, is_charity, website, locked_fields` to select |
| `frontend/src/pages/CalendarEventsList.jsx` | Add `InlineBoolToggle` + `DuplicateUrlField` components; add `DuplicateEventCard`; simplify `DuplicateGroup`; add `saveMutation` to `DuplicatesView` |

---

## Task 1: Extend the backend duplicates select

**Files:**
- Modify: `backend/src/routes/calendarEvents.js:19`

- [ ] **Step 1: Update the Supabase select call**

In `backend/src/routes/calendarEvents.js`, find line 19:
```js
        .select('id, name, date, location, voivodeship, source, source_id, registration_url, regulamin_url, registration_deadline, source_url, event_type, distances, price_from, price_to, lat, lng')
```
Replace with:
```js
        .select('id, name, date, location, voivodeship, source, source_id, registration_url, regulamin_url, website, registration_deadline, source_url, event_type, distances, price_from, price_to, lat, lng, is_night, is_charity, locked_fields')
```

- [ ] **Step 2: Verify the backend returns the new fields**

With docker compose running, run:
```bash
curl -s http://localhost:3001/api/calendar-events/duplicates | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  const ev = d.data?.[0]?.[0];
  if (!ev) { console.log('no duplicates found — OK if empty'); process.exit(0); }
  console.log('is_night:', ev.is_night, '| is_charity:', ev.is_charity, '| website:', ev.website, '| locked_fields:', ev.locked_fields);
"
```
Expected: fields present (values may be null/false/empty-array — that is correct).

- [ ] **Step 3: Commit**

```bash
git add backend/src/routes/calendarEvents.js
git commit -m "feat: add is_night, is_charity, website, locked_fields to duplicates endpoint"
```

---

## Task 2: Add `InlineBoolToggle` component

**Files:**
- Modify: `frontend/src/pages/CalendarEventsList.jsx` (insert after line 136, after `InlineArrayEdit`)

- [ ] **Step 1: Insert the component**

After the closing `}` of `InlineArrayEdit` (line 136), insert:

```jsx
function InlineBoolToggle({ event, field, onSave }) {
  const current = !!event[field]
  return (
    <span
      className={`cursor-pointer font-mono text-[11px] tracking-wide select-none ${current ? 'text-green-400 hover:text-green-300' : 'text-apex-muted hover:text-apex-text-bright'}`}
      onClick={() => onSave(event.id, { [field]: !current })}
      title="Kliknij aby zmienić"
    >
      {current ? 'tak' : 'nie'}
    </span>
  )
}
```

- [ ] **Step 2: Verify no syntax errors**

```bash
cd /path/to/project && docker compose exec frontend npx vite --version 2>&1 | head -1
```
Or open the admin UI at http://localhost:3000 and confirm no console errors. (Vite shows compile errors in the browser.)

---

## Task 3: Add `DuplicateUrlField` component

**Files:**
- Modify: `frontend/src/pages/CalendarEventsList.jsx` (insert after `InlineBoolToggle`)

- [ ] **Step 1: Insert the component**

After the closing `}` of `InlineBoolToggle`, insert:

```jsx
function DuplicateUrlField({ event, field, onSave }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const current = event[field]
  const isLocked = (event.locked_fields || []).includes(field)

  const startEdit = () => { setValue(current || ''); setEditing(true) }

  const save = () => {
    const trimmed = value.trim()
    if (trimmed !== (current || '')) {
      onSave(event.id, { [field]: trimmed || null })
    }
    setEditing(false)
  }

  const markEmpty = (e) => {
    e.stopPropagation()
    onSave(event.id, { [field]: null })
  }

  if (editing) {
    return (
      <input
        className={inputClass}
        value={value}
        onChange={e => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={e => e.key === 'Enter' && save()}
        autoFocus
      />
    )
  }

  if (current) {
    return (
      <span className="inline-flex items-center gap-1.5 min-w-0 max-w-full">
        <a
          href={current}
          target="_blank"
          rel="noopener"
          className="text-apex-yellow-dim hover:text-apex-yellow underline decoration-apex-border-mid hover:decoration-apex-yellow truncate"
          onClick={e => e.stopPropagation()}
        >
          {current}
        </a>
        <button
          onClick={startEdit}
          className="text-apex-muted hover:text-apex-text-bright shrink-0 text-[10px]"
          title="Edytuj"
        >
          ✎
        </button>
      </span>
    )
  }

  if (isLocked) {
    return (
      <span
        className="cursor-pointer hover:text-apex-yellow-dim text-apex-muted italic"
        onClick={startEdit}
        title="Oznaczone jako brak (zatwierdzone)"
      >
        brak
      </span>
    )
  }

  return (
    <span className="inline-flex items-center gap-2">
      <span
        className="cursor-pointer hover:text-apex-yellow-dim text-apex-red italic"
        onClick={startEdit}
        title="Kliknij aby edytować"
      >
        —
      </span>
      <button
        onClick={markEmpty}
        className="font-mono text-[9px] tracking-wide uppercase text-apex-muted hover:text-apex-text-bright underline decoration-dotted underline-offset-2"
        title="Zatwierdź jako brak"
      >
        brak
      </button>
    </span>
  )
}
```

---

## Task 4: Add `DuplicateEventCard` and simplify `DuplicateGroup`

**Files:**
- Modify: `frontend/src/pages/CalendarEventsList.jsx` lines 245–377

- [ ] **Step 1: Insert `DuplicateEventCard` before `DuplicateGroup` (line 245)**

Insert this new component before `function DuplicateGroup(`:

```jsx
function DuplicateEventCard({ event, onSave, onDelete }) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const confirmRef = useRef(null)

  useEffect(() => {
    if (confirmDelete && confirmRef.current) confirmRef.current.focus()
  }, [confirmDelete])

  return (
    <div className="border-b border-apex-border last:border-b-0 px-3 py-3">
      {/* Header: name + source + delete */}
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex-1 min-w-0 text-sm text-apex-text-bright font-semibold">
          <InlineEdit event={event} field="name" onSave={onSave} />
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="font-mono text-[10px] text-apex-muted px-1.5 py-0.5 border border-apex-border">
            {event.source}
          </span>
          {confirmDelete ? (
            <div
              ref={confirmRef}
              tabIndex={0}
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === 'y' || e.key === 'Y') {
                  e.preventDefault()
                  onDelete(event.id)
                  setConfirmDelete(false)
                } else if (e.key === 'Escape') {
                  setConfirmDelete(false)
                }
              }}
              onBlur={() => setConfirmDelete(false)}
              className="flex items-center gap-1"
            >
              <span className="text-xs text-apex-red font-semibold">Usunąć?</span>
              <button
                onClick={() => { onDelete(event.id); setConfirmDelete(false) }}
                className="font-mono text-[10px] font-bold tracking-wide uppercase px-2.5 py-1 border border-red-600 text-red-400 hover:bg-red-600 hover:text-white transition-all"
              >
                Enter / Y
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="font-mono text-[10px] tracking-wide uppercase px-2 py-1 border border-apex-border text-apex-muted hover:text-apex-text-bright transition-all"
              >
                Esc
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              className="font-mono text-[10px] font-semibold tracking-wide uppercase px-3 py-1 border border-apex-border text-apex-muted hover:border-red-600 hover:text-red-400 transition-all"
            >
              Usuń
            </button>
          )}
        </div>
      </div>

      {/* Property grid — 2-column for short fields, full-width for URLs */}
      <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
        <div className="flex gap-2 items-baseline">
          <span className="text-apex-muted w-24 shrink-0">Data</span>
          <span className="flex-1 min-w-0"><InlineEdit event={event} field="date" onSave={onSave} /></span>
        </div>
        <div className="flex gap-2 items-baseline">
          <span className="text-apex-muted w-24 shrink-0">Miejscowość</span>
          <span className="flex-1 min-w-0"><InlineEdit event={event} field="location" onSave={onSave} /></span>
        </div>
        <div className="flex gap-2 items-baseline">
          <span className="text-apex-muted w-24 shrink-0">Województwo</span>
          <span className="flex-1 min-w-0"><InlineEdit event={event} field="voivodeship" onSave={onSave} /></span>
        </div>
        <div className="flex gap-2 items-baseline">
          <span className="text-apex-muted w-24 shrink-0">Typ</span>
          <span className="flex-1 min-w-0"><InlineArrayEdit event={event} field="event_type" onSave={onSave} /></span>
        </div>
        <div className="flex gap-2 items-baseline">
          <span className="text-apex-muted w-24 shrink-0">Dystanse</span>
          <span className="flex-1 min-w-0"><InlineArrayEdit event={event} field="distances" onSave={onSave} /></span>
        </div>
        <div className="flex gap-2 items-baseline">
          <span className="text-apex-muted w-24 shrink-0">Deadline</span>
          <span className="flex-1 min-w-0"><InlineEdit event={event} field="registration_deadline" onSave={onSave} /></span>
        </div>
        <div className="flex gap-2 items-baseline">
          <span className="text-apex-muted w-24 shrink-0">Cena od</span>
          <span className="flex-1 min-w-0"><InlineEdit event={event} field="price_from" onSave={onSave} /></span>
        </div>
        <div className="flex gap-2 items-baseline">
          <span className="text-apex-muted w-24 shrink-0">Cena do</span>
          <span className="flex-1 min-w-0"><InlineEdit event={event} field="price_to" onSave={onSave} /></span>
        </div>
        <div className="flex gap-2 items-baseline">
          <span className="text-apex-muted w-24 shrink-0">Nocny</span>
          <span className="flex-1 min-w-0"><InlineBoolToggle event={event} field="is_night" onSave={onSave} /></span>
        </div>
        <div className="flex gap-2 items-baseline">
          <span className="text-apex-muted w-24 shrink-0">Charytatywny</span>
          <span className="flex-1 min-w-0"><InlineBoolToggle event={event} field="is_charity" onSave={onSave} /></span>
        </div>
        <div className="col-span-2 flex gap-2 items-baseline">
          <span className="text-apex-muted w-24 shrink-0">URL zapisy</span>
          <span className="flex-1 min-w-0"><DuplicateUrlField event={event} field="registration_url" onSave={onSave} /></span>
        </div>
        <div className="col-span-2 flex gap-2 items-baseline">
          <span className="text-apex-muted w-24 shrink-0">Regulamin</span>
          <span className="flex-1 min-w-0"><DuplicateUrlField event={event} field="regulamin_url" onSave={onSave} /></span>
        </div>
        <div className="col-span-2 flex gap-2 items-baseline">
          <span className="text-apex-muted w-24 shrink-0">Strona</span>
          <span className="flex-1 min-w-0"><DuplicateUrlField event={event} field="website" onSave={onSave} /></span>
        </div>
      </div>

      {/* Footer: geo status + locked fields list */}
      <div className="flex gap-1.5 mt-2.5 flex-wrap">
        {event.lat != null ? (
          <span className="font-mono text-[9px] tracking-wide uppercase px-1.5 py-0.5 border border-green-800 text-green-500 bg-green-950/30">geo</span>
        ) : (
          <span className="font-mono text-[9px] tracking-wide uppercase px-1.5 py-0.5 border border-red-900 text-red-500">brak geo</span>
        )}
        {(event.locked_fields || []).length > 0 && (
          <span className="font-mono text-[9px] tracking-wide uppercase px-1.5 py-0.5 border border-apex-border text-apex-muted">
            locked: {(event.locked_fields || []).join(', ')}
          </span>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Replace the body of `DuplicateGroup` (lines 245–377)**

Replace the entire `function DuplicateGroup` (from `function DuplicateGroup({ group, onDelete, onDismiss })` through its closing `}`) with:

```jsx
function DuplicateGroup({ group, onDelete, onDismiss, onSave }) {
  return (
    <div className="border border-apex-border mb-4 bg-apex-surface">
      <div className="flex items-center justify-between font-mono text-[10px] tracking-widest uppercase text-apex-yellow-dim px-3 py-2 border-b border-apex-border bg-apex-bg">
        <span>{group[0].date} &middot; {group.length} wpisy</span>
        <button
          onClick={() => onDismiss(group.map(e => e.id))}
          className="font-mono text-[10px] font-semibold tracking-wide uppercase px-2.5 py-0.5 border border-apex-border text-apex-muted hover:border-apex-cyan hover:text-apex-cyan transition-all"
        >
          Nie duplikat
        </button>
      </div>
      {group.map(ev => (
        <DuplicateEventCard key={ev.id} event={ev} onSave={onSave} onDelete={onDelete} />
      ))}
    </div>
  )
}
```

---

## Task 5: Add `saveMutation` to `DuplicatesView` and pass `onSave`

**Files:**
- Modify: `frontend/src/pages/CalendarEventsList.jsx` lines 379–428

- [ ] **Step 1: Replace the entire `DuplicatesView` function**

Replace the entire `function DuplicatesView()` (lines 379–428) with:

```jsx
function DuplicatesView() {
  const queryClient = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ['calendar-events-duplicates'],
    queryFn: async () => {
      const res = await fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:3001'}/api/calendar-events/duplicates`)
      const json = await res.json()
      return json.data
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id) => api.del(`/calendar-events/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['calendar-events-duplicates'] })
      queryClient.invalidateQueries({ queryKey: ['calendar-events-admin'] })
    },
  })

  const dismissMutation = useMutation({
    mutationFn: (eventIds) => api.post('/calendar-events/dismiss-duplicates', { eventIds }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['calendar-events-duplicates'] })
    },
  })

  const saveMutation = useMutation({
    mutationFn: ({ id, updates }) => api.patch(`/calendar-events/${id}`, updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['calendar-events-duplicates'] })
    },
  })

  const handleSave = (id, updates) => saveMutation.mutate({ id, updates })

  const groups = data || []
  const totalDupes = groups.reduce((sum, g) => sum + g.length - 1, 0)

  return (
    <div>
      {isLoading && <div className="text-apex-muted py-8">Szukanie duplikatów...</div>}

      {!isLoading && groups.length === 0 && (
        <div className="text-apex-muted text-center py-12">Brak duplikatów!</div>
      )}

      {!isLoading && groups.length > 0 && (
        <div className="mb-4 text-sm text-apex-muted">
          {groups.length} grup &middot; ~{totalDupes} nadmiarowych wpisów
        </div>
      )}

      {groups.map((group, i) => (
        <DuplicateGroup
          key={i}
          group={group}
          onDelete={(id) => deleteMutation.mutate(id)}
          onDismiss={(ids) => dismissMutation.mutate(ids)}
          onSave={handleSave}
        />
      ))}
    </div>
  )
}
```

---

## Task 6: Smoke-test in browser and commit

- [ ] **Step 1: Open the DUPLIKATY tab**

Navigate to http://localhost:3000/calendar-events and click **Duplikaty**.

Verify:
- Each event in a group shows the full property grid (Data, Miejscowość, Województwo, Typ, Dystanse, Deadline, Cena od, Cena do, Nocny, Charytatywny, URL zapisy, Regulamin, Strona)
- URL fields with values show as yellow truncated links with a ✎ icon
- "Nie duplikat" button on group header still works
- "Usuń" + Enter/Y/Esc confirm flow still works

- [ ] **Step 2: Test inline editing**

Click on a text field (e.g. Miejscowość) — it should become an editable input. Change the value, press Enter. Verify:
- The value updates in the card
- No console errors
- Refreshing the page preserves the change (confirming the PATCH saved to Supabase)

- [ ] **Step 3: Test boolean toggle**

Click "nie" on Nocny for an event. It should flip to "tak" (green). Reload to confirm persisted.

- [ ] **Step 4: Test URL field**

If a URL is present: click ✎, edit it, blur to save. If URL is absent: click "—" to get the input, enter a URL, Enter to save.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/CalendarEventsList.jsx
git commit -m "feat: editable full-detail cards in DUPLIKATY view"
```
