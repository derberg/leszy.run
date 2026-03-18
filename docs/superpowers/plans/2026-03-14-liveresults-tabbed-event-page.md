# Liveresults Tabbed Event Page Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the liveresults category-list event page with a tabbed view that shows all categories by default and updates the URL when switching to a specific category.

**Architecture:** Both `/events/:eventId` and `/events/:eventId/:categoryId` render the same `EventPage` component. The component reads `categoryId` from URL params to determine the active tab. A new `CategorySection` component (extracted from the current `Category.jsx`) is self-contained — it fetches its own data, manages its own Supabase Realtime subscription, and renders podium + results + checkpoint tracking for one category.

**Tech Stack:** React 19, React Router v7, Supabase JS v2, Tailwind CSS v4, Vite 6

**Spec:** `docs/superpowers/specs/2026-03-14-liveresults-tabbed-event-page-design.md`

---

## Chunk 1: Extract CategorySection

### Task 1: Create `CategorySection.jsx`

**Files:**
- Create: `liveresults/src/pages/CategorySection.jsx`
- Reference: `liveresults/src/pages/Category.jsx` (existing, read this first)

This task extracts all the data-fetching and rendering logic from `Category.jsx` into a standalone component that can be rendered multiple times on the same page.

- [ ] **Step 1: Read current `Category.jsx` in full**

  Understand exactly what it does before touching anything. Note:
  - The `loadData` callback and what it fetches
  - The Supabase Realtime channel name (`liveresults-${categoryId}`)
  - The `useEffect` cleanup that calls `supabase.removeChannel(channel)`
  - The "waiting / no race run" state rendered at the bottom
  - The `← Kategorie` back-link at the top (this must NOT be in `CategorySection`)
  - The outer page chrome (`min-h-screen`, noise overlay, `max-w-3xl mx-auto`) — this must NOT be in `CategorySection` either

- [ ] **Step 2: Create `CategorySection.jsx`**

  Create `liveresults/src/pages/CategorySection.jsx` with this exact content:

  ```jsx
  import { useState, useEffect, useCallback } from 'react'
  import { supabase } from '../lib/supabase.js'
  import { Podium, CheckpointTrackingTable, estimatePositions } from '../ui/index.js'

  const ANIMAL_POOL = ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🦄','🐝','🦋','🐢','🦎','🦖','🐙','🦑','🦐','🦞','🦀','🐡','🐠','🐟','🦈','🐬','🐳','🦭','🦜','🦚','🦩','🦢','🦔','🐿️','🦦','🦥','🦨','🦡','🐓','🦃']

  function getPodiumAnimals(participants) {
    return participants.map(p => {
      if (!p?.id) return '🏃'
      let hash = 0
      for (let i = 0; i < p.id.length; i++) hash = ((hash << 5) - hash) + p.id.charCodeAt(i)
      return ANIMAL_POOL[Math.abs(hash) % ANIMAL_POOL.length]
    })
  }

  function formatDuration(ms) {
    if (!ms) return '—'
    const s = Math.floor(ms / 1000)
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
    if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
    return `${m}:${String(sec).padStart(2,'0')}`
  }

  function formatTime(iso) {
    return new Date(iso).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }

  export default function CategorySection({ eventId, categoryId }) {
    const [category, setCategory] = useState(null)
    const [raceRun, setRaceRun] = useState(null)
    const [results, setResults] = useState([])
    const [checkpoints, setCheckpoints] = useState([])
    const [observations, setObservations] = useState([])

    const loadData = useCallback(async () => {
      const [catRes, runRes, cpRes] = await Promise.all([
        supabase.from('categories').select('id, name, distance_meters').eq('id', categoryId).single(),
        supabase.from('race_runs').select('id, started_at, status').eq('category_id', categoryId)
          .in('status', ['active', 'finished']).order('created_at', { ascending: false }).limit(1).single(),
        supabase.from('checkpoints').select('id, name, km_marker')
          .eq('event_id', eventId).order('km_marker'),
      ])

      if (catRes.data) setCategory(catRes.data)
      if (cpRes.data) setCheckpoints(cpRes.data)

      const run = runRes.data
      if (!run) return
      setRaceRun(run)

      const [resultRows, participantRows] = await Promise.all([
        supabase.from('results').select('id, race_run_id, participant_id, start_time, finish_time, duration_ms, gun_duration_ms, status').eq('race_run_id', run.id),
        supabase.from('participants').select('id, bib_number, first_name, last_name, club, category_id').eq('category_id', categoryId),
      ])

      const pMap = Object.fromEntries((participantRows.data || []).map(p => [p.id, {
        ...p, firstName: p.first_name, lastName: p.last_name, bibNumber: p.bib_number,
      }]))

      const enrichedResults = (resultRows.data || []).map(r => ({
        ...r,
        participantId: r.participant_id,
        startTime: r.start_time,
        finishTime: r.finish_time,
        durationMs: r.duration_ms,
        gunDurationMs: r.gun_duration_ms,
        participant: pMap[r.participant_id],
      }))

      setResults(enrichedResults)

      if (cpRes.data?.length) {
        const cpIds = cpRes.data.map(c => c.id)
        const { data: obsData } = await supabase.from('checkpoint_observations')
          .select('id, checkpoint_id, participant_id, bib_number, observed_at')
          .in('checkpoint_id', cpIds)
          .gte('observed_at', run.started_at)
        setObservations((obsData || []).map(o => ({
          ...o,
          checkpointId: o.checkpoint_id,
          participantId: o.participant_id,
          bibNumber: o.bib_number,
          observedAt: o.observed_at,
        })))
      }
    }, [eventId, categoryId])

    useEffect(() => { loadData() }, [loadData])

    useEffect(() => {
      if (!raceRun?.id) return

      const channel = supabase.channel(`liveresults-${categoryId}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'results',
          filter: `race_run_id=eq.${raceRun.id}` }, () => loadData())
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'checkpoint_observations' },
          (payload) => {
            const obs = payload.new
            setObservations(prev => {
              const exists = prev.some(o => o.id === obs.id)
              if (exists) return prev
              return [...prev, {
                id: obs.id,
                checkpointId: obs.checkpoint_id,
                participantId: obs.participant_id,
                bibNumber: obs.bib_number,
                observedAt: obs.observed_at,
              }]
            })
          })
        .subscribe()

      return () => { supabase.removeChannel(channel) }
    }, [raceRun?.id, categoryId, loadData])

    const enrichedResults = estimatePositions(results, checkpoints, observations)
    const top3 = enrichedResults.slice(0, 3)
    const animals = getPodiumAnimals(top3.map(r => r.participant))

    return (
      <div>
        <div className="text-center mb-10">
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

        {top3.length > 0 && (
          <div className="mb-10">
            <div className="font-display text-2xl tracking-widest uppercase text-apex-text text-center mb-6">Podium</div>
            <Podium top3={top3} animals={animals} formatDuration={formatDuration} />
          </div>
        )}

        {enrichedResults.length > 0 && (
          <div className="mb-8">
            <div className="font-display text-xl tracking-widest uppercase text-apex-text mb-3">Wyniki</div>
            <CheckpointTrackingTable
              results={enrichedResults}
              checkpoints={checkpoints}
              observations={observations}
              formatTime={formatTime}
            />
          </div>
        )}

        {!raceRun && (
          <div className="text-center py-12 text-apex-text">
            <div className="font-display text-4xl uppercase tracking-widest mb-2">Oczekiwanie</div>
            <div className="text-sm">Wyścig jeszcze nie wystartował. Ta strona aktualizuje się automatycznie.</div>
          </div>
        )}
      </div>
    )
  }
  ```

- [ ] **Step 3: Verify the file was written correctly**

  Read `liveresults/src/pages/CategorySection.jsx` and confirm:
  - No back-link present
  - No page-level chrome (`min-h-screen`, noise overlay, `max-w-3xl`) — those will live in `EventPage`
  - `useEffect` cleanup (`supabase.removeChannel`) is present
  - Props are `{ eventId, categoryId }`

- [ ] **Step 4: Commit**

  ```bash
  git add liveresults/src/pages/CategorySection.jsx
  git commit -m "feat(liveresults): extract CategorySection component"
  ```

---

## Chunk 2: Rewrite EventPage and update routing

### Task 2: Rewrite `Event.jsx` as tabbed page

**Files:**
- Modify: `liveresults/src/pages/Event.jsx` (full rewrite)

- [ ] **Step 1: Rewrite `Event.jsx`**

  Replace the entire contents of `liveresults/src/pages/Event.jsx` with:

  ```jsx
  import { useState, useEffect, useRef } from 'react'
  import { Link, useParams, useNavigate } from 'react-router-dom'
  import { supabase } from '../lib/supabase.js'
  import CategorySection from './CategorySection.jsx'

  export default function EventPage() {
    const { eventId, categoryId } = useParams()
    const navigate = useNavigate()
    const [event, setEvent] = useState(null)
    const [categories, setCategories] = useState([])
    const [loading, setLoading] = useState(true)
    const activeTabRef = useRef(null)

    useEffect(() => {
      Promise.all([
        supabase.from('events').select('id, name, date, location').eq('id', eventId).single(),
        supabase.from('categories').select('id, name, distance_meters').eq('event_id', eventId),
      ]).then(([evRes, catRes]) => {
        if (evRes.data) setEvent(evRes.data)
        if (catRes.data) setCategories(catRes.data)
        setLoading(false)
      })
    }, [eventId])

    // Update document title
    useEffect(() => {
      if (!event) return
      if (categoryId) {
        const cat = categories.find(c => c.id === categoryId)
        document.title = cat ? `${cat.name} — ${event.name}` : event.name
      } else {
        document.title = event.name
      }
    }, [event, categories, categoryId])

    // Scroll active tab into view when categories load or URL changes
    useEffect(() => {
      if (activeTabRef.current) {
        activeTabRef.current.scrollIntoView({ inline: 'nearest', behavior: 'smooth' })
      }
    }, [categoryId, categories])

    const activeCategoryId = categoryId || null

    return (
      <div className="min-h-screen bg-apex-bg text-apex-text-bright relative overflow-hidden">
        <div className="absolute inset-0 opacity-5 pointer-events-none" style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E")`
        }} />

        <div className="relative z-10 max-w-3xl mx-auto px-6 py-10">
          <Link to="/" className="text-xs text-apex-muted uppercase tracking-wider hover:text-apex-text mb-6 inline-block">← Wszystkie eventy</Link>

          <div className="text-center mb-8">
            <div className="font-display text-5xl tracking-widest uppercase text-white mb-1">
              {event?.name || '—'}
            </div>
            {event?.date && (
              <div className="text-apex-muted text-sm">{event.date}{event.location ? ` · ${event.location}` : ''}</div>
            )}
          </div>

          {/* Tab bar */}
          <div className="flex overflow-x-auto border-b border-apex-border mb-10" style={{ scrollbarWidth: 'none' }}>
            {loading ? (
              // Skeleton tabs while categories are loading
              <>
                {[80, 100, 70].map((w, i) => (
                  <div key={i} className="shrink-0 px-5 py-3" style={{ width: w }} >
                    <div className="h-3 bg-apex-surface-2 animate-pulse" style={{ width: w - 20 }} />
                  </div>
                ))}
              </>
            ) : (
              <>
                <button
                  ref={!activeCategoryId ? activeTabRef : null}
                  onClick={() => navigate(`/events/${eventId}`)}
                  className={`shrink-0 px-5 py-3 text-xs font-bold tracking-widest uppercase transition-colors ${
                    !activeCategoryId
                      ? 'bg-apex-yellow-bright text-apex-bg'
                      : 'text-apex-muted hover:text-apex-text'
                  }`}
                >
                  All
                </button>
                {categories.map(cat => (
                  <button
                    key={cat.id}
                    ref={activeCategoryId === cat.id ? activeTabRef : null}
                    onClick={() => navigate(`/events/${eventId}/${cat.id}`)}
                    className={`shrink-0 px-5 py-3 text-xs font-bold tracking-widest uppercase transition-colors border-l border-apex-border ${
                      activeCategoryId === cat.id
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

          {/* Content */}
          {!loading && activeCategoryId && (
            <CategorySection key={activeCategoryId} eventId={eventId} categoryId={activeCategoryId} />
          )}

          {!loading && !activeCategoryId && (
            <div className="space-y-20">
              {categories.map(cat => (
                <div key={cat.id} className="border-t border-apex-border pt-10 first:border-t-0 first:pt-0">
                  <CategorySection key={cat.id} eventId={eventId} categoryId={cat.id} />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    )
  }
  ```

  Key design notes:
  - `key={activeCategoryId}` on the single-tab `CategorySection` ensures React fully remounts it (and re-fetches data) when switching between category tabs.
  - `scrollbarWidth: none` hides the horizontal scrollbar on the tab bar (the bar is still scrollable via touch/trackpad).
  - The acid yellow `#D4FF00` maps to `bg-apex-yellow-bright` / `text-apex-yellow-bright` in this theme (not `apex-yellow`, which is the dimmer `#BBDD00`).

- [ ] **Step 2: Commit**

  ```bash
  git add liveresults/src/pages/Event.jsx
  git commit -m "feat(liveresults): rewrite EventPage with category tabs"
  ```

---

### Task 3: Update App.jsx routing

**Files:**
- Modify: `liveresults/src/App.jsx`

- [ ] **Step 1: Update `App.jsx`**

  Replace the entire contents of `liveresults/src/App.jsx` with:

  ```jsx
  import { Routes, Route, Navigate } from 'react-router-dom'
  import EventsPage from './pages/Events.jsx'
  import EventPage from './pages/Event.jsx'

  export default function App() {
    return (
      <Routes>
        <Route path="/" element={<EventsPage />} />
        <Route path="/events/:eventId" element={<EventPage />} />
        <Route path="/events/:eventId/:categoryId" element={<EventPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    )
  }
  ```

  Note: the `CategoryPage` import and route are removed. The same `EventPage` handles both URLs.

- [ ] **Step 2: Commit**

  ```bash
  git add liveresults/src/App.jsx
  git commit -m "feat(liveresults): add category route to EventPage"
  ```

---

## Chunk 3: Cleanup and verification

### Task 4: Delete `Category.jsx`

**Files:**
- Delete: `liveresults/src/pages/Category.jsx`

- [ ] **Step 1: Verify nothing imports `Category.jsx` anymore**

  Run:
  ```bash
  grep -r "Category" liveresults/src/ --include="*.jsx" --include="*.js"
  ```

  Expected output: only `CategorySection.jsx` appears — no references to `Category.jsx` or `CategoryPage`.

- [ ] **Step 2: Delete `Category.jsx`**

  ```bash
  git rm liveresults/src/pages/Category.jsx
  git commit -m "chore(liveresults): remove Category.jsx (replaced by CategorySection)"
  ```

---

### Task 5: Manual verification

No automated test suite exists for liveresults. Verify manually.

- [ ] **Step 1: Start the liveresults dev server**

  ```bash
  cd liveresults && npm run dev
  ```

  Expected: Vite starts on `http://localhost:5175`

- [ ] **Step 2: Test the All tab (default view)**

  Open `http://localhost:5175/events/<any-valid-eventId>`.

  Expected:
  - Page title = event name
  - Tab bar shows "ALL" (yellow/active) + one tab per category
  - All category sections render below (podium, results, checkpoint table per category)
  - No console errors

- [ ] **Step 3: Test switching to a category tab**

  Click a category tab.

  Expected:
  - URL changes to `/events/:eventId/:categoryId`
  - Only that category's content is shown
  - Tab bar: clicked tab is yellow/active, others are muted
  - Page title = `${category.name} — ${event.name}`

- [ ] **Step 4: Test direct navigation to a category URL**

  Paste `http://localhost:5175/events/<eventId>/<categoryId>` directly in the browser (simulates opening a shared link).

  Expected:
  - Correct category tab is active
  - Active tab is scrolled into view in the tab bar (not off-screen to the right)
  - Content shows only that category

- [ ] **Step 5: Test switching back to All**

  Click "ALL" tab.

  Expected:
  - URL changes back to `/events/:eventId`
  - All categories re-appear
  - Page title = event name

- [ ] **Step 6: Test Realtime in All view (if a live race is available)**

  With the All tab open, trigger a result update (via the admin app or direct Supabase update).

  Expected: The relevant category section updates without a page reload, other sections unaffected.
