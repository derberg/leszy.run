# Gender-Split Podium & Results — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add gender-based sub-views (Open / Mężczyźni / Kobiety) to podium, admin results, and public results — filtering by participant gender at the API and UI layers.

**Architecture:** No schema changes. Backend results endpoint gets a `?gender=M|K` query param that filters results before returning them. Frontend and public app add sub-tabs within each category to switch between Open/M/K views. Podium auto-rotation expands to cycle through all 3 gender views per category.

**Tech Stack:** Fastify (backend), React + TanStack Query (frontend), Supabase direct queries (public app), `@leszyrun/ui` shared components (unchanged).

---

### Task 1: Backend — Add `?gender` filter to race results endpoint

**Files:**
- Modify: `backend/src/routes/results.js:11-20`

- [ ] **Step 1: Add gender query param filtering to GET /races/:raceRunId/results**

In `backend/src/routes/results.js`, modify the `GET /races/:raceRunId/results` handler. After fetching all results, filter by participant gender if `?gender` is provided, then recalculate positions within the filtered set:

```javascript
// Results for a race run (full leaderboard)
fastify.get('/races/:raceRunId/results', async (req) => {
  const rows = await db.query.results.findMany({
    where: eq(results.raceRunId, req.params.raceRunId),
    with: {
      participant: { with: { category: true } },
    },
    orderBy: [asc(results.position), asc(results.finishTime), asc(results.startTime)],
  })

  const gender = req.query.gender
  if (gender) {
    const filtered = rows.filter(r => r.participant?.gender === gender)
    // Recalculate positions within the filtered set
    let pos = 1
    const reranked = filtered.map(r => {
      const newPos = r.finishTime ? pos++ : null
      return { ...r, position: newPos }
    })
    return { data: reranked }
  }

  return { data: rows }
})
```

- [ ] **Step 2: Verify the endpoint works**

Start the backend and test:
```bash
# All results (unchanged behavior)
curl http://localhost:3001/api/races/<raceRunId>/results | jq '.data | length'

# Filtered by gender
curl "http://localhost:3001/api/races/<raceRunId>/results?gender=M" | jq '.data | length'
curl "http://localhost:3001/api/races/<raceRunId>/results?gender=K" | jq '.data | length'
```

Expected: gender-filtered responses return fewer results, positions renumbered starting from 1.

- [ ] **Step 3: Add gender filter to CSV export**

In the same file, modify `GET /races/:raceRunId/export/csv` (around line 101). After fetching rows, filter by gender if param present, same pattern:

```javascript
fastify.get('/races/:raceRunId/export/csv', async (req, reply) => {
  const run = await db.query.raceRuns.findFirst({
    where: eq(raceRuns.id, req.params.raceRunId),
    with: { category: { with: { event: true } } },
  })
  if (!run) return reply.code(404).send({ error: 'Race run not found' })

  let rows = await db.query.results.findMany({
    where: eq(results.raceRunId, req.params.raceRunId),
    with: { participant: true },
    orderBy: [asc(results.position), asc(results.finishTime)],
  })

  const gender = req.query.gender
  if (gender) {
    rows = rows.filter(r => r.participant?.gender === gender)
    let pos = 1
    rows = rows.map(r => ({ ...r, position: r.finishTime ? pos++ : null }))
  }

  const genderSuffix = gender ? `-${gender}` : ''
  const csvData = rows.map(r => ({
    position: r.position || '',
    bib: r.participant.bibNumber,
    first_name: r.participant.firstName,
    last_name: r.participant.lastName,
    club: r.participant.club || '',
    gender: r.participant.gender || '',
    birth_year: r.participant.birthYear || '',
    status: r.status,
    start_time: r.startTime ? new Date(r.startTime).toISOString() : '',
    finish_time: r.finishTime ? new Date(r.finishTime).toISOString() : '',
    chip_time: r.durationMs ? formatDuration(r.durationMs) : '',
    gun_time: r.gunDurationMs ? formatDuration(r.gunDurationMs) : '',
    manual_override: r.manualOverride ? 'yes' : 'no',
  }))

  const csv = Papa.unparse(csvData)
  reply.header('Content-Type', 'text/csv')
  reply.header('Content-Disposition', `attachment; filename="results-${run.category.name}${genderSuffix}.csv"`)
  return reply.send(csv)
})
```

- [ ] **Step 4: Add gender filter to PDF export**

Same pattern for `GET /races/:raceRunId/export/pdf` (around line 137). After fetching rows, filter and rerank:

```javascript
let rows = await db.query.results.findMany({
  where: eq(results.raceRunId, req.params.raceRunId),
  with: { participant: true },
  orderBy: [asc(results.position), asc(results.finishTime)],
})

const gender = req.query.gender
if (gender) {
  rows = rows.filter(r => r.participant?.gender === gender)
  let pos = 1
  rows = rows.map(r => ({ ...r, position: r.finishTime ? pos++ : null }))
}

const genderSuffix = gender ? ` — ${gender === 'M' ? 'Mężczyźni' : 'Kobiety'}` : ''
```

Update the PDF header line to include gender suffix:
```javascript
drawText(`${run.category.event.name} — ${run.category.name}${genderSuffix}`, margin, y, 16, boldFont)
```

And the filename:
```javascript
reply.header('Content-Disposition', `attachment; filename="results-${run.category.name}${gender ? '-' + gender : ''}.pdf"`)
```

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/results.js
git commit -m "feat: add gender filter to results, CSV, and PDF endpoints"
```

---

### Task 2: Frontend API helper — Add gender param support

**Files:**
- Modify: `frontend/src/lib/api.js:96-105`

- [ ] **Step 1: Update API helper to accept gender param**

In `frontend/src/lib/api.js`, update the results methods to accept an optional gender parameter:

```javascript
// Results
results: {
  list: (raceRunId, gender) => request('GET', `/races/${raceRunId}/results${gender ? `?gender=${gender}` : ''}`),
  listForEvent: (eventId) => request('GET', `/events/${eventId}/results`),
  update: (id, body) => request('PATCH', `/results/${id}`, body),
  exportCsv: (raceRunId, gender) => `${BASE}/api/races/${raceRunId}/export/csv${gender ? `?gender=${gender}` : ''}`,
  exportPdf: (raceRunId, gender) => `${BASE}/api/races/${raceRunId}/export/pdf${gender ? `?gender=${gender}` : ''}`,
  importCheckpoint: (raceRunId, formData, label) =>
    request('POST', `/races/${raceRunId}/checkpoint-imports?label=${encodeURIComponent(label)}`, formData, true),
},
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/lib/api.js
git commit -m "feat: add gender param to results API helpers"
```

---

### Task 3: Frontend — Gender sub-tabs on admin Results page

**Files:**
- Modify: `frontend/src/pages/Results.jsx`

- [ ] **Step 1: Add gender sub-tabs and filtered data fetching**

In `frontend/src/pages/Results.jsx`, add a `GenderTabs` component and wire it into each category section. The sub-tabs control a gender state that re-fetches results with the `?gender` param.

Add the `GENDER_VIEWS` constant and `GenderTabs` component above the `Results` function:

```javascript
const GENDER_VIEWS = [
  { key: null, label: 'Open' },
  { key: 'M', label: 'Mężczyźni' },
  { key: 'K', label: 'Kobiety' },
]

function GenderTabs({ value, onChange }) {
  return (
    <div className="flex gap-1 mb-4">
      {GENDER_VIEWS.map(v => (
        <button
          key={v.key ?? 'open'}
          onClick={() => onChange(v.key)}
          className={cn(
            'px-3 py-1.5 text-xs font-bold tracking-widest uppercase transition-colors border',
            value === v.key
              ? 'bg-apex-yellow text-apex-bg border-apex-yellow'
              : 'text-apex-muted border-apex-border hover:text-apex-text'
          )}
        >
          {v.label}
        </button>
      ))}
    </div>
  )
}
```

- [ ] **Step 2: Add gender state to each category block**

Replace the category mapping in the `Results` component with a new `CategoryBlock` component that manages its own gender state:

```javascript
function CategoryBlock({ cat, eventId }) {
  const [gender, setGender] = useState(null)
  const run = cat.raceRuns?.[0]

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h2 className="font-display text-2xl uppercase tracking-wider text-apex-text">{cat.name}</h2>
        <div className="flex items-center gap-2">
          {run && (
            <>
              <a href={api.results.exportCsv(run.id, gender)} target="_blank" rel="noreferrer">
                <Button variant="outline" size="sm"><Download size={12} /> CSV</Button>
              </a>
              <a href={api.results.exportPdf(run.id, gender)} target="_blank" rel="noreferrer">
                <Button variant="outline" size="sm"><Download size={12} /> PDF</Button>
              </a>
            </>
          )}
        </div>
      </div>

      <GenderTabs value={gender} onChange={setGender} />

      {!run ? (
        <div className="text-sm text-apex-muted py-4">Brak biegu.</div>
      ) : (
        <ResultsTable raceRunId={run.id} results={run.results || []} categoryId={cat.id} gender={gender} />
      )}
    </div>
  )
}
```

Update the `Results` component to use `CategoryBlock`:

```javascript
<div className="space-y-6">
  {categories.map(cat => (
    <CategoryBlock key={cat.id} cat={cat} eventId={id} />
  ))}
</div>
```

- [ ] **Step 3: Update ResultsTable to use gender-filtered query**

In the `ResultsTable` component, accept a `gender` prop and use it in the query:

```javascript
function ResultsTable({ raceRunId, results, categoryId, gender }) {
  const qc = useQueryClient()
  const [editRow, setEditRow] = useState(null)

  const { data: rows = results } = useQuery({
    queryKey: ['results', raceRunId, gender],
    queryFn: () => api.results.list(raceRunId, gender),
    initialData: gender ? undefined : results,
    refetchInterval: 10_000,
  })
```

Note: `initialData` is only used when no gender filter (Open view), since the parent already has full results. Filtered views fetch on mount.

- [ ] **Step 4: Verify admin results page**

Open `http://localhost:3000/events/<eventId>/results` in the browser. Each category should show Open/Mężczyźni/Kobiety tabs. Switching tabs should re-fetch and show filtered results with renumbered positions.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/Results.jsx
git commit -m "feat: add gender sub-tabs to admin results page"
```

---

### Task 4: Frontend — Gender rotation on Podium page

**Files:**
- Modify: `frontend/src/pages/PodiumPage.jsx`

- [ ] **Step 1: Build gender rotation slots**

The rotation should cycle: cat1-Open → cat1-M → cat1-K → cat2-Open → cat2-M → cat2-K → ...

In `PodiumPage.jsx`, add the `GENDER_VIEWS` constant and build rotation slots from active categories. Replace the existing rotation logic.

Add above the `PodiumPage` component:

```javascript
const GENDER_VIEWS = [
  { key: null, label: 'OPEN' },
  { key: 'M', label: 'MĘŻCZYŹNI' },
  { key: 'K', label: 'KOBIETY' },
]
```

Inside the `PodiumPage` component, replace the `currentRotateCategory` derivation (around line 151) with a slot-based approach:

```javascript
// Build rotation slots: [{ category, gender }] for each active category × gender view
const rotationSlots = activeCategories.flatMap(cat =>
  GENDER_VIEWS.map(g => ({ category: cat, gender: g.key, genderLabel: g.label }))
)

// Current slot in auto-rotate mode
const currentSlot = !categoryId && rotationSlots.length > 0
  ? rotationSlots[rotateIndex % rotationSlots.length]
  : null

// For single-category view, also rotate through gender views
const [singleGenderIndex, setSingleGenderIndex] = useState(0)
const singleGenderView = categoryId ? GENDER_VIEWS[singleGenderIndex % GENDER_VIEWS.length] : null
```

- [ ] **Step 2: Update activeCategory and data fetching to use gender**

Replace the `activeCategory` / `activeRun` derivation:

```javascript
const activeCategory = categoryId
  ? categories.find(c => c.id === categoryId)
  : currentSlot?.category
const activeRun = activeCategory?.raceRuns?.[0]
const activeGender = categoryId ? singleGenderView?.key : currentSlot?.gender
const activeGenderLabel = categoryId ? singleGenderView?.label : currentSlot?.genderLabel
```

Update the results query to fetch gender-filtered data. Replace `displayedResults` / `enrichedResults` (around line 234):

```javascript
// Fetch gender-filtered results when a gender is active
const { data: genderResults } = useQuery({
  queryKey: ['results-gender', activeRun?.id, activeGender],
  queryFn: () => api.results.list(activeRun.id, activeGender),
  enabled: !!activeRun?.id && !!activeGender,
  refetchInterval: 5000,
})

const displayedResults = activeGender ? (genderResults || []) : (activeRun?.results || [])
const enrichedResults = activeCategory
  ? estimatePositions(displayedResults, categoryCheckpoints, activeGender ? [] : observations)
  : []
```

Note: When gender-filtered, checkpoint observations are not passed because the backend already handles position ordering. The `estimatePositions` call with empty observations just adds `positionType` metadata.

- [ ] **Step 3: Update the rotation timer for gender slots**

Update the auto-rotate effect (around line 175). Change the condition from `activeCategories.length <= 1` to `rotationSlots.length <= 1`:

```javascript
useEffect(() => {
  if (categoryId || rotationSlots.length <= 1) {
    setProgress(0)
    return
  }

  rotateStartRef.current = Date.now()

  const tickProgress = () => {
    const elapsed = Date.now() - rotateStartRef.current
    setProgress(Math.min(elapsed / ROTATE_INTERVAL_MS, 1))
    progressRafRef.current = requestAnimationFrame(tickProgress)
  }
  progressRafRef.current = requestAnimationFrame(tickProgress)

  rotateTimerRef.current = setInterval(() => {
    setRotateIndex(prev => prev + 1)
    rotateStartRef.current = Date.now()
  }, ROTATE_INTERVAL_MS)

  return () => {
    clearInterval(rotateTimerRef.current)
    cancelAnimationFrame(progressRafRef.current)
  }
}, [categoryId, rotationSlots.length])
```

For single-category mode, add a similar timer for gender rotation:

```javascript
useEffect(() => {
  if (!categoryId) return
  const timer = setInterval(() => {
    setSingleGenderIndex(prev => prev + 1)
  }, ROTATE_INTERVAL_MS)
  return () => clearInterval(timer)
}, [categoryId])
```

Update the `rotateIndex` reset effect:

```javascript
useEffect(() => {
  if (rotationSlots.length > 0) {
    setRotateIndex(prev => prev % rotationSlots.length)
  }
}, [rotationSlots.length])
```

- [ ] **Step 4: Add gender label to the display**

In the content area (around line 333), add the gender label below the category name:

```javascript
<div className="font-display text-4xl tracking-widest uppercase text-white text-center mb-1">
  {activeCategory.name}
</div>
{activeGenderLabel && (
  <div className="font-display text-xl tracking-widest uppercase text-apex-yellow text-center mb-1">
    {activeGenderLabel}
  </div>
)}
{activeCategory.distanceMeters && (
  <div className="text-apex-muted text-sm text-center mb-8">
    {(activeCategory.distanceMeters / 1000).toFixed(1)} km
  </div>
)}
```

- [ ] **Step 5: Update document.title to include gender**

Update the title effect (around line 209):

```javascript
useEffect(() => {
  if (!event) return
  const genderSuffix = activeGenderLabel ? ` — ${activeGenderLabel}` : ''
  if (categoryId) {
    const cat = categories.find(c => c.id === categoryId)
    document.title = cat ? `${cat.name}${genderSuffix} — ${event.name}` : event.name
  } else if (currentSlot) {
    document.title = `${currentSlot.category.name}${genderSuffix} — ${event.name}`
  } else {
    document.title = event.name
  }
}, [event, categories, categoryId, currentSlot, activeGenderLabel])
```

- [ ] **Step 6: Verify podium page**

Open `http://localhost:3000/events/<eventId>/podium` in the browser. The rotation should now cycle through: Cat1 OPEN → Cat1 MĘŻCZYŹNI → Cat1 KOBIETY → Cat2 OPEN → ... Gender label should appear below category name. Each gender view should show its own top 3 with renumbered positions.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/PodiumPage.jsx
git commit -m "feat: add gender rotation to podium page"
```

---

### Task 5: Public app — Gender sub-tabs on CategorySection

**Files:**
- Modify: `public/src/pages/CategorySection.jsx`

- [ ] **Step 1: Add gender state and sub-tabs**

In `public/src/pages/CategorySection.jsx`, add gender state and filter results client-side (the public app reads from Supabase directly, not through the backend API, so filtering happens in the component).

Add the gender views constant and tabs component at the top of the file (after the format functions):

```javascript
const GENDER_VIEWS = [
  { key: null, label: 'Open' },
  { key: 'M', label: 'Mężczyźni' },
  { key: 'K', label: 'Kobiety' },
]

function GenderTabs({ value, onChange }) {
  return (
    <div className="flex justify-center gap-1 mb-8">
      {GENDER_VIEWS.map(v => (
        <button
          key={v.key ?? 'open'}
          onClick={() => onChange(v.key)}
          className={`px-4 py-2 text-xs font-bold tracking-widest uppercase transition-colors border ${
            value === v.key
              ? 'bg-apex-yellow text-black border-apex-yellow'
              : 'text-apex-muted border-apex-border hover:text-apex-text'
          }`}
        >
          {v.label}
        </button>
      ))}
    </div>
  )
}
```

- [ ] **Step 2: Add gender filtering to the component**

Inside the `CategorySection` component, add gender state and filter results before passing to `estimatePositions`:

```javascript
const [gender, setGender] = useState(null)
```

Replace the existing `enrichedResults` / `top3` / `animals` lines (around line 122-124) with:

```javascript
const filteredResults = gender
  ? results.filter(r => r.participant?.gender === gender)
  : results

const enrichedResults = estimatePositions(filteredResults, checkpoints, observations)
const top3 = enrichedResults.slice(0, 3)
const animals = top3.map(r => r.participant?.emoji || '\u{1F3C3}')
```

- [ ] **Step 3: Render the gender tabs**

In the JSX return, add `GenderTabs` after the category header and before the podium. Insert right after the `started_at` line (after line 138):

```javascript
<GenderTabs value={gender} onChange={setGender} />
```

The full header section becomes:

```jsx
<div className="text-center mb-6">
  <div className="font-display text-5xl tracking-widest uppercase text-white mb-1">
    {category?.name || '—'}
  </div>
  {category?.distance_meters && (
    <div className="text-apex-muted text-sm">{(category.distance_meters / 1000).toFixed(1)} km</div>
  )}
  {raceRun?.started_at && (
    <div className="text-apex-text text-sm">Start {formatTime(raceRun.started_at)}</div>
  )}
</div>

<GenderTabs value={gender} onChange={setGender} />
```

Note: the bottom margin on the text-center div changes from `mb-10` to `mb-6` so the tabs sit closer to the header.

- [ ] **Step 4: Verify public results page**

Open `http://localhost:3002/events/<slug>/results/<categoryId>` in the browser. The category section should show Open/Mężczyźni/Kobiety tabs. Switching tabs should filter results client-side and show a separate podium + leaderboard for each gender.

Also check the "Wszystkie" (all categories) view at `http://localhost:3002/events/<slug>/results` — each category section should have its own gender tabs.

- [ ] **Step 5: Commit**

```bash
git add public/src/pages/CategorySection.jsx
git commit -m "feat: add gender sub-tabs to public results page"
```

---

### Task 6: Final verification

- [ ] **Step 1: End-to-end verification**

Test all three surfaces:
1. **Admin Results** (`http://localhost:3000/events/<eventId>/results`) — gender tabs per category, CSV/PDF export with gender filter
2. **Podium** (`http://localhost:3000/events/<eventId>/podium`) — auto-rotation cycles through Open/M/K per category, gender label visible
3. **Public Results** (`http://localhost:3002/events/<slug>/results`) — gender tabs per category in both single and all-categories views

Verify:
- Switching to Mężczyźni shows only male participants, positions renumbered from 1
- Switching to Kobiety shows only female participants, positions renumbered from 1
- Open shows all participants (original behavior unchanged)
- Podium top 3 updates correctly per gender view
- CSV/PDF downloads respect the active gender filter

- [ ] **Step 2: Commit any final fixes if needed**
