# Frontend Podium Tabbed Grid Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the frontend's separate AllResults and CategoryResults pages with a single PodiumPage component that shows a 2-column fixed-height grid of all categories by default, with tabs for per-category detail.

**Architecture:** Both `/events/:id/podium` and `/events/:id/results/:categoryId` render the same `PodiumPage` component. Data is fetched once at the page level via TanStack Query. A `CategoryCard` component (inline in PodiumPage) handles per-category rendering. The All view is a 2-column CSS grid (1 column on mobile) where each cell scrolls independently and fills the viewport. Single-category view is a full-width scrollable column with checkpoint tracking.

**Tech Stack:** React 19, React Router v7, TanStack Query v5, Tailwind CSS v4, shadcn/ui, `@leszyrun/ui` (Podium, CheckpointTrackingTable), WebSocket via `useWsEvent`

**Spec:** `docs/superpowers/specs/2026-03-14-frontend-podium-tabbed-grid-design.md`

---

## Chunk 1: Create PodiumPage.jsx

### Task 1: Create `PodiumPage.jsx`

**Files:**
- Create: `frontend/src/pages/PodiumPage.jsx`
- Reference (read before writing): `frontend/src/pages/AllResults.jsx`, `frontend/src/pages/CategoryResults.jsx`

No automated test suite exists for the frontend pages. Verification is by reading the file and manual testing.

- [ ] **Step 1: Read both source files in full**

  Read `frontend/src/pages/AllResults.jsx` and `frontend/src/pages/CategoryResults.jsx` completely before writing anything. Note:
  - Data shape from `api.results.listForEvent`: `categories[]` with `raceRuns[0].results[]`, `distanceMeters`, `raceRuns[0].startedAt/finishedAt/status`
  - `RaceTimer` and `formatElapsed` are module-private at the bottom of `AllResults.jsx`
  - `estimatePositions` is module-private at the top of `CategoryResults.jsx`
  - WebSocket events: `result:update`, `race:update`, `checkpoint:observation`
  - Query keys in use: `['event-results', eventId]`, `['checkpoints', eventId]`, `['checkpoint-observations', run?.id]`

- [ ] **Step 2: Create `frontend/src/pages/PodiumPage.jsx`**

  Write the file with this exact content:

  ```jsx
  import { useState, useEffect, useRef } from 'react'
  import { useParams, useNavigate } from 'react-router-dom'
  import { useQuery, useQueryClient } from '@tanstack/react-query'
  import { useWsEvent } from '../lib/ws.js'
  import { api } from '../lib/api.js'
  import { formatDuration, getPodiumAnimals, cn } from '../lib/utils.js'
  import { Podium, CheckpointTrackingTable } from '@leszyrun/ui'

  // Copied from AllResults.jsx
  function formatElapsed(ms) {
    const totalSeconds = Math.floor(ms / 1000)
    const hours = Math.floor(totalSeconds / 3600)
    const minutes = Math.floor((totalSeconds % 3600) / 60)
    const seconds = totalSeconds % 60
    const millis = String(ms % 1000).padStart(3, '0')
    if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${millis}`
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${millis}`
  }

  // Copied from AllResults.jsx
  function RaceTimer({ startedAt, finishedAt, status }) {
    const [elapsed, setElapsed] = useState(0)
    const rafRef = useRef(null)

    useEffect(() => {
      const start = new Date(startedAt).getTime()
      if (status === 'active') {
        const tick = () => {
          setElapsed(Date.now() - start)
          rafRef.current = requestAnimationFrame(tick)
        }
        rafRef.current = requestAnimationFrame(tick)
        return () => cancelAnimationFrame(rafRef.current)
      }
      if ((status === 'finished' || status === 'cancelled') && finishedAt) {
        setElapsed(new Date(finishedAt).getTime() - start)
      }
    }, [startedAt, finishedAt, status])

    if (!startedAt) return null
    const isActive = status === 'active'

    return (
      <div className="text-center mb-6">
        <div className="text-xs tracking-widest uppercase text-apex-muted mb-1 font-display">
          {isActive ? 'Czas biegu' : 'Łączny czas'}
        </div>
        <div className={cn(
          'font-display text-5xl tracking-widest tabular-nums leading-none',
          isActive ? 'text-white' : 'text-apex-muted',
        )}>
          {formatElapsed(elapsed)}
        </div>
        {isActive && (
          <div className="mt-2 flex items-center justify-center gap-1.5 text-xs text-apex-yellow">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-apex-yellow animate-pulse" />
            NA ŻYWO
          </div>
        )}
      </div>
    )
  }

  // Copied from CategoryResults.jsx
  function estimatePositions(results, checkpoints, observations) {
    const obsCounts = {}
    for (const obs of observations) {
      obsCounts[obs.participantId] = (obsCounts[obs.participantId] || 0) + 1
    }
    const sorted = [...results].map(r => ({
      ...r,
      _cpCount: obsCounts[r.participant?.id] || 0,
    })).sort((a, b) => {
      if (a.finishTime && b.finishTime) return (a.gunDurationMs || 0) - (b.gunDurationMs || 0)
      if (a.finishTime) return -1
      if (b.finishTime) return 1
      if (b._cpCount !== a._cpCount) return b._cpCount - a._cpCount
      return 0
    })
    return sorted.map((r, i) => ({ ...r, estimatedPosition: r.position || (i + 1) }))
  }

  // Props: { cat, checkpoints }
  // Used in both grid (All) view and single-category view.
  // Grid view: simple gunDurationMs sort (no estimatePositions — observations not available).
  // Single-cat view: PodiumPage renders CheckpointTrackingTable separately with estimatePositions output.
  function CategoryCard({ cat, checkpoints }) {
    const run = cat.raceRuns?.[0]
    const results = run?.results || []

    const finished = results
      .filter(r => r.finishTime)
      .sort((a, b) => (a.gunDurationMs || 0) - (b.gunDurationMs || 0))
      .map(r => ({ ...r, positionType: 'final' }))

    const top3 = finished.slice(0, 3)
    const podiumAnimals = getPodiumAnimals(top3.map(r => r.participant))
    const onTrack = results.filter(r => r.status === 'started' && !r.finishTime)

    if (!run) {
      return (
        <div className="text-center py-8 text-apex-muted">
          <div className="font-display text-2xl uppercase tracking-widest mb-1">Oczekiwanie</div>
          <div className="text-xs">Wyścig jeszcze nie wystartował</div>
        </div>
      )
    }

    return (
      <div>
        <RaceTimer startedAt={run.startedAt} finishedAt={run.finishedAt} status={run.status} />

        {top3.length > 0 && (
          <div className="mb-6">
            <div className="font-display text-lg tracking-widest uppercase text-apex-muted text-center mb-4">Podium</div>
            <Podium top3={top3} animals={podiumAnimals} formatDuration={formatDuration} />
          </div>
        )}

        {finished.length > 0 && (
          <div className="mb-4">
            <div className="font-display text-sm tracking-widest uppercase text-apex-muted mb-2">Klasyfikacja</div>
            <div className="border border-apex-border divide-y divide-apex-border">
              {finished.map((r, i) => (
                <div key={r.id} className={cn('flex items-center gap-3 px-3 py-2', i < 3 && 'bg-apex-surface-2/50')}>
                  <span className="font-display text-lg text-apex-yellow w-6">{r.position || i + 1}</span>
                  <span className="text-xs text-apex-muted font-mono w-9">#{r.participant?.bibNumber}</span>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-sm truncate">{r.participant?.firstName} {r.participant?.lastName}</div>
                    {r.participant?.club && <div className="text-xs text-apex-muted truncate">{r.participant.club}</div>}
                  </div>
                  <div className="text-right shrink-0">
                    <div className="font-mono font-bold text-sm text-apex-yellow">{formatDuration(r.gunDurationMs)}</div>
                    {r.durationMs && r.durationMs !== r.gunDurationMs && (
                      <div className="font-mono text-xs text-apex-muted">netto {formatDuration(r.durationMs)}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {onTrack.length > 0 && (
          <div>
            <div className="font-display text-sm tracking-widest uppercase text-apex-muted mb-2">Na trasie</div>
            <div className="border border-apex-border divide-y divide-apex-border">
              {onTrack.map(r => (
                <div key={r.id} className="flex items-center gap-3 px-3 py-1.5 text-apex-muted text-xs">
                  <span className="font-mono w-9">#{r.participant?.bibNumber}</span>
                  <span>{r.participant?.firstName} {r.participant?.lastName}</span>
                  {r.participant?.club && <span className="ml-auto text-apex-muted">{r.participant.club}</span>}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    )
  }

  export default function PodiumPage() {
    const { id: eventId, categoryId } = useParams()
    const navigate = useNavigate()
    const qc = useQueryClient()
    const activeTabRef = useRef(null)

    const { data: event } = useQuery({
      queryKey: ['events', eventId],
      queryFn: () => api.events.get(eventId),
    })

    const { data: categories = [], isLoading } = useQuery({
      queryKey: ['event-results', eventId],
      queryFn: () => api.results.listForEvent(eventId),
      refetchInterval: 5000,
    })

    const { data: checkpoints = [] } = useQuery({
      queryKey: ['checkpoints', eventId],
      queryFn: () => api.checkpoints.list(eventId),
      enabled: !!eventId,
    })

    // Single-category only: find active run for observations query
    const activeCategory = categoryId ? categories.find(c => c.id === categoryId) : null
    const activeRun = activeCategory?.raceRuns?.[0]

    const { data: observations = [] } = useQuery({
      queryKey: ['checkpoint-observations', activeRun?.id],
      queryFn: () => api.checkpoints.observationsForRace(activeRun?.id),
      enabled: !!activeRun?.id,
      refetchInterval: 5000,
    })

    useWsEvent('result:update', () => qc.invalidateQueries({ queryKey: ['event-results', eventId] }))
    useWsEvent('race:update', () => qc.invalidateQueries({ queryKey: ['event-results', eventId] }))
    useWsEvent('checkpoint:observation', () => {
      if (activeRun?.id) qc.invalidateQueries({ queryKey: ['checkpoint-observations', activeRun.id] })
    })

    // document.title
    useEffect(() => {
      if (!event) return
      if (categoryId) {
        const cat = categories.find(c => c.id === categoryId)
        document.title = cat ? `${cat.name} — ${event.name}` : event.name
      } else {
        document.title = event.name
      }
    }, [event, categories, categoryId])

    // Scroll active tab into view on load or tab change
    useEffect(() => {
      if (activeTabRef.current) {
        activeTabRef.current.scrollIntoView({ inline: 'nearest', behavior: 'smooth' })
      }
    }, [categoryId, categories])

    const activeCategories = categories.filter(c => c.raceRuns?.length > 0)

    // Enriched results for single-cat CheckpointTrackingTable
    const singleCatResults = activeRun?.results || []
    const enrichedResults = categoryId
      ? estimatePositions(singleCatResults, checkpoints, observations)
      : []

    return (
      <div className="h-screen flex flex-col bg-apex-bg text-apex-text-bright relative overflow-hidden">
        {/* Noise overlay */}
        <div className="absolute inset-0 opacity-5 pointer-events-none" style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E")`
        }} />

        {/* Header */}
        <div className="relative z-10 text-center px-6 pt-8 pb-4 shrink-0">
          <div className="font-display text-5xl tracking-widest uppercase text-white mb-1">
            {event?.name || '—'}
          </div>
          {event?.location && (
            <div className="text-apex-muted text-sm">
              {event.location}{event?.date ? ` · ${event.date}` : ''}
            </div>
          )}
        </div>

        {/* Tab bar */}
        <div
          className="relative z-10 flex overflow-x-auto border-b border-apex-border shrink-0 [&::-webkit-scrollbar]:hidden"
          style={{ scrollbarWidth: 'none' }}
        >
          {isLoading ? (
            <>
              {[80, 100, 70].map((w, i) => (
                <div key={i} className="shrink-0 px-5 py-3" style={{ width: w }}>
                  <div className="h-3 bg-apex-surface-2 animate-pulse" style={{ width: w - 20 }} />
                </div>
              ))}
            </>
          ) : (
            <>
              <button
                ref={!categoryId ? activeTabRef : null}
                onClick={() => navigate(`/events/${eventId}/podium`)}
                className={`shrink-0 px-5 py-3 text-xs font-bold tracking-widest uppercase transition-colors ${
                  !categoryId ? 'bg-apex-yellow-bright text-apex-bg' : 'text-apex-muted hover:text-apex-text'
                }`}
              >
                All
              </button>
              {categories.map(cat => (
                <button
                  key={cat.id}
                  ref={categoryId === cat.id ? activeTabRef : null}
                  onClick={() => navigate(`/events/${eventId}/results/${cat.id}`)}
                  className={`shrink-0 px-5 py-3 text-xs font-bold tracking-widest uppercase transition-colors border-l border-apex-border ${
                    categoryId === cat.id
                      ? 'bg-apex-yellow-bright text-apex-bg'
                      : 'text-apex-muted hover:text-apex-text'
                  }`}
                >
                  {cat.name}
                </button>
              ))}
            </>
          )}
        </div>

        {/* Content area */}
        <div className="relative z-10 flex-1 min-h-0 overflow-hidden">

          {/* ALL view — responsive grid */}
          {!categoryId && !isLoading && (
            activeCategories.length === 0 ? (
              <div className="text-center py-16 text-apex-muted">
                <div className="font-display text-3xl uppercase tracking-widest mb-2">Brak aktywnych wyścigów</div>
                <div className="text-sm">Ta strona aktualizuje się automatycznie.</div>
              </div>
            ) : (
              <div
                className="h-full grid grid-cols-1 md:grid-cols-2"
                style={{ gridAutoRows: '1fr' }}
              >
                {activeCategories.map((cat, i) => (
                  <div
                    key={cat.id}
                    className={cn(
                      'overflow-y-auto border-t border-apex-border p-5',
                      i % 2 === 1 ? 'border-l border-apex-border' : '',
                      activeCategories.length % 2 !== 0 && i === activeCategories.length - 1
                        ? 'md:col-span-2'
                        : ''
                    )}
                  >
                    <div className="font-display text-xl tracking-widest uppercase text-apex-yellow-bright mb-4">
                      {cat.name}
                      {cat.distanceMeters && (
                        <span className="text-apex-muted text-sm font-sans font-normal normal-case tracking-normal ml-3">
                          {(cat.distanceMeters / 1000).toFixed(1)} km
                        </span>
                      )}
                    </div>
                    <CategoryCard cat={cat} checkpoints={checkpoints} />
                  </div>
                ))}
              </div>
            )
          )}

          {/* Single-category view */}
          {categoryId && !isLoading && (
            <div className="h-full overflow-y-auto">
              <div className="max-w-3xl mx-auto px-6 py-8">
                {activeCategory ? (
                  <>
                    <div className="font-display text-4xl tracking-widest uppercase text-white text-center mb-2">
                      {activeCategory.name}
                    </div>
                    {activeCategory.distanceMeters && (
                      <div className="text-apex-muted text-sm text-center mb-8">
                        {(activeCategory.distanceMeters / 1000).toFixed(1)} km
                      </div>
                    )}
                    <CategoryCard cat={activeCategory} checkpoints={checkpoints} />
                    {checkpoints.length > 0 && (
                      <div className="mt-8">
                        <div className="font-display text-lg tracking-widest uppercase text-apex-muted mb-3">Tracking na żywo</div>
                        <CheckpointTrackingTable
                          results={enrichedResults}
                          checkpoints={checkpoints}
                          observations={observations}
                          formatTime={(iso) => new Date(iso).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                        />
                      </div>
                    )}
                  </>
                ) : (
                  <div className="text-center py-16 text-apex-muted">
                    <div className="font-display text-3xl uppercase tracking-widest mb-2">Oczekiwanie</div>
                    <div className="text-sm">Wyścig jeszcze nie wystartował. Ta strona aktualizuje się automatycznie.</div>
                  </div>
                )}
              </div>
            </div>
          )}

        </div>
      </div>
    )
  }
  ```

- [ ] **Step 3: Verify the file**

  Read `frontend/src/pages/PodiumPage.jsx` and confirm:
  - `RaceTimer`, `formatElapsed`, `estimatePositions`, `CategoryCard` are all defined before `PodiumPage`
  - `h-screen flex flex-col` on root div, `shrink-0` on header and tabs, `flex-1 min-h-0` on content
  - `grid-cols-1 md:grid-cols-2` and `gridAutoRows: '1fr'` on the grid div
  - `md:col-span-2` applied only on the last item when count is odd
  - `[&::-webkit-scrollbar]:hidden` on tab bar div
  - `activeTabRef` scrollIntoView effect present

- [ ] **Step 4: Commit**

  ```bash
  git add frontend/src/pages/PodiumPage.jsx
  git commit -m "feat(frontend): add PodiumPage with tabbed grid view"
  ```

---

## Chunk 2: Routing, cleanup, verification

### Task 2: Update `App.jsx` routing

**Files:**
- Modify: `frontend/src/App.jsx`

- [ ] **Step 1: Read current `App.jsx`**

  Read `frontend/src/App.jsx`. Note the two public routes at the bottom (outside `<Layout>`):
  - `<Route path="/events/:id/podium" element={<AllResults />} />`
  - `<Route path="/events/:id/results/:categoryId" element={<CategoryResults />} />`

  The internal admin route `<Route path="/events/:id/results" element={<Results />} />` is inside `<Layout>` and must NOT be touched.

- [ ] **Step 2: Update imports and routes in `App.jsx`**

  Make these changes:
  1. Remove: `import AllResults from './pages/AllResults.jsx'`
  2. Remove: `import CategoryResults from './pages/CategoryResults.jsx'`
  3. Add: `import PodiumPage from './pages/PodiumPage.jsx'`
  4. Replace: `<Route path="/events/:id/podium" element={<AllResults />} />`
     With: `<Route path="/events/:id/podium" element={<PodiumPage />} />`
  5. Replace: `<Route path="/events/:id/results/:categoryId" element={<CategoryResults />} />`
     With: `<Route path="/events/:id/results/:categoryId" element={<PodiumPage />} />`

- [ ] **Step 3: Verify `App.jsx`**

  Read `frontend/src/App.jsx` and confirm:
  - No `AllResults` or `CategoryResults` imports remain
  - Both public routes point to `<PodiumPage />`
  - The internal `<Route path="/events/:id/results" element={<Results />} />` inside `<Layout>` is unchanged

- [ ] **Step 4: Commit**

  ```bash
  git add frontend/src/App.jsx
  git commit -m "feat(frontend): route podium and category results to PodiumPage"
  ```

---

### Task 3: Delete old pages

**Files:**
- Delete: `frontend/src/pages/AllResults.jsx`
- Delete: `frontend/src/pages/CategoryResults.jsx`

- [ ] **Step 1: Confirm no remaining imports**

  ```bash
  grep -r "AllResults\|CategoryResults" frontend/src/ --include="*.jsx" --include="*.js"
  ```

  Expected: no output (zero matches).

- [ ] **Step 2: Delete both files**

  ```bash
  git rm frontend/src/pages/AllResults.jsx frontend/src/pages/CategoryResults.jsx
  git commit -m "chore(frontend): remove AllResults and CategoryResults (replaced by PodiumPage)"
  ```

---

### Task 4: Manual verification

No automated test suite for frontend pages. Verify in the browser.

- [ ] **Step 1: Start the frontend**

  ```bash
  docker compose up
  ```

  Frontend available at `http://localhost:3000`

- [ ] **Step 2: Test All tab — grid view**

  Navigate to `http://localhost:3000/events/<eventId>/podium`

  Expected:
  - "ALL" tab is yellow/active
  - 2-column grid fills the screen (below header + tab bar)
  - Each cell shows category name + podium + results + on-track
  - Cells scroll independently if content overflows
  - Page itself does not scroll (grid is fixed-height)
  - On mobile viewport (resize browser to <768px): single column, page scrolls

- [ ] **Step 3: Test odd number of categories**

  If the event has an odd number of active categories, confirm the last cell spans both columns (full width).

- [ ] **Step 4: Test switching to a category tab**

  Click a category tab.

  Expected:
  - URL changes to `/events/:id/results/:categoryId`
  - Tab highlights yellow
  - Full-width single-category view with podium + results + checkpoint tracking table (if checkpoints exist)
  - Page title updates to `${cat.name} — ${event.name}`

- [ ] **Step 5: Test direct navigation to a category URL**

  Paste `http://localhost:3000/events/<id>/results/<categoryId>` directly in the browser.

  Expected:
  - Correct category tab active and visible (not off-screen)
  - Content renders correctly

- [ ] **Step 6: Test switching back to All**

  Click "ALL" tab.

  Expected:
  - URL changes to `/events/:id/podium`
  - Grid re-appears
  - Page title updates to event name

- [ ] **Step 7: Verify internal admin Results page is unaffected**

  Navigate to `http://localhost:3000/events/<eventId>/results` (no category ID).

  Expected: the admin Results page (inside the navbar Layout) still renders correctly — this route was NOT changed.
