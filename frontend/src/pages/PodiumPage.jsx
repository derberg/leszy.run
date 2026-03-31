import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useWsEvent } from '../lib/ws.js'
import { api } from '../lib/api.js'
import { formatDuration, cn } from '../lib/utils.js'
import { Podium, CheckpointTrackingTable, estimatePositions } from '@leszyrun/ui'
import { QRCodeSVG } from 'qrcode.react'
import PartnerLogosBanner from '../components/PartnerLogosBanner.jsx'

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
    if (!startedAt) return
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
        {isActive ? 'Czas biegu' : 'Czas trwania zawodów'}
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

// Props: { cat, checkpoints }
// Used in both grid (All) view and single-category view.
function CategoryCard({ cat, checkpoints, results: resultsProp }) {
  const run = cat.raceRuns?.[0]
  const rawResults = resultsProp ?? run?.results ?? []

  // AGENT: DO NOT CHANGE THIS LOGIC without asking the user first.
  // estimatePositions MUST come from @leszyrun/ui — never create a local copy (see CLAUDE.md).
  // When resultsProp is provided, it is already enriched with checkpoint observations
  // by the caller (CategoryWithCheckpoints). Re-running estimatePositions here with
  // empty observations would discard checkpoint data and break podium ordering.
  // Only fall back to estimatePositions when no pre-enriched results are passed.
  const ranked = resultsProp
    ? rawResults
    : estimatePositions(rawResults, checkpoints || [], [])
  const active = ranked.filter(r => r.finishTime || (r.status === 'started' && !r.finishTime))

  const top3 = active.slice(0, 3).map(r => ({
    ...r,
    positionType: r.positionType || (r.finishTime ? 'final' : 'started'),
  }))
  const podiumAnimals = top3.map(r => r.participant?.emoji || '🏃')

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
    </div>
  )
}

const ROTATE_INTERVAL_MS = 5000

const GENDER_VIEWS = [
  { key: null, label: 'OPEN' },
  { key: 'M', label: 'MĘŻCZYŹNI' },
  { key: 'K', label: 'KOBIETY' },
]

export default function PodiumPage() {
  const { id: eventId, categoryId } = useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const activeTabRef = useRef(null)

  // Auto-rotate state for podium (no categoryId) view
  const [rotateIndex, setRotateIndex] = useState(0)
  const [singleGenderIndex, setSingleGenderIndex] = useState(0)
  const [progress, setProgress] = useState(0)
  const rotateTimerRef = useRef(null)
  const progressRafRef = useRef(null)
  const rotateStartRef = useRef(null)

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

  // IMPORTANT: Must include 'finished' — podium must keep showing results after race stops.
  // Filtering only 'active' causes the podium to go blank when the race ends.
  const activeCategories = categories.filter(c =>
    c.raceRuns?.some(r => r.status === 'active' || r.status === 'finished')
  )

  // Build rotation slots: [{ category, gender }] for each active category × gender view
  const rotationSlots = activeCategories.flatMap(cat =>
    GENDER_VIEWS.map(g => ({ category: cat, gender: g.key, genderLabel: g.label }))
  )

  // Current slot in auto-rotate mode
  const currentSlot = !categoryId && rotationSlots.length > 0
    ? rotationSlots[rotateIndex % rotationSlots.length]
    : null

  // For single-category view, also rotate through gender views
  const singleGenderView = categoryId ? GENDER_VIEWS[singleGenderIndex % GENDER_VIEWS.length] : null

  // For single-category view OR the currently-rotating category, find the active run
  const activeCategory = categoryId
    ? categories.find(c => c.id === categoryId)
    : currentSlot?.category
  const activeRun = activeCategory?.raceRuns?.[0]
  const activeGender = categoryId ? singleGenderView?.key : currentSlot?.gender
  const activeGenderLabel = categoryId ? singleGenderView?.label : currentSlot?.genderLabel

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

  // Auto-rotate timer for podium view
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

  // Gender rotation for single-category mode
  useEffect(() => {
    if (!categoryId) return
    const timer = setInterval(() => {
      setSingleGenderIndex(prev => prev + 1)
    }, ROTATE_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [categoryId])

  // Reset rotate index when slots change so we don't get stuck on stale index
  useEffect(() => {
    if (rotationSlots.length > 0) {
      setRotateIndex(prev => prev % rotationSlots.length)
    }
  }, [rotationSlots.length])

  // document.title
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

  // Scroll active tab into view on load or tab change
  useEffect(() => {
    if (activeTabRef.current) {
      activeTabRef.current.scrollIntoView({ inline: 'nearest', behavior: 'smooth' })
    }
  }, [categoryId, categories, rotateIndex])

  // Filter checkpoints to only those assigned to the active category (or with no category restriction)
  const categoryCheckpoints = activeCategory
    ? checkpoints.filter(cp => cp.categoryIds.length === 0 || cp.categoryIds.includes(activeCategory.id))
    : []

  // Fetch gender-filtered results when a gender is active
  const { data: genderResults } = useQuery({
    queryKey: ['results-gender', activeRun?.id, activeGender],
    queryFn: () => api.results.list(activeRun.id, activeGender),
    enabled: !!activeRun?.id && !!activeGender,
    refetchInterval: 5000,
  })

  const displayedResults = activeGender ? (genderResults || []) : (activeRun?.results || [])
  const enrichedResults = activeCategory
    ? estimatePositions(displayedResults, categoryCheckpoints, observations)
    : []

  // Which category ID is visually active (for tab highlight)
  const visibleCategoryId = categoryId || currentSlot?.category?.id

  return (
    <div className="h-screen flex flex-col bg-apex-bg text-apex-text-bright relative overflow-hidden">
      {/* Noise overlay */}
      <div className="absolute inset-0 opacity-5 pointer-events-none" style={{
        backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E")`
      }} />

      {/* Partners */}
      <div className="relative z-10 shrink-0 px-6">
        <PartnerLogosBanner eventId={eventId} />
      </div>

      {/* Header */}
      <div className="relative z-10 flex items-center justify-between px-6 pt-8 pb-4 shrink-0">
        <div className="flex-1" />
        <div className="text-center">
          <div className="font-display text-5xl tracking-widest uppercase text-white mb-1">
            {event?.name || '—'}
          </div>
          {event?.location && (
            <div className="text-apex-muted text-sm">
              {event.location}{event?.date ? ` · ${event.date}` : ''}
            </div>
          )}
        </div>
        <div className="flex-1 flex justify-end">
          {event?.slug && (
            <div className="bg-white p-2 rounded">
              <QRCodeSVG value={`https://www.leszy.run/events/${event.slug}/results`} size={80} />
            </div>
          )}
        </div>
      </div>

      {/* Tab bar with progress indicator */}
      <div className="relative z-10 shrink-0">
        <div
          className="flex overflow-x-auto border-b border-apex-border [&::-webkit-scrollbar]:hidden"
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
              {categories.map(cat => {
                const isActive = visibleCategoryId === cat.id
                return (
                  <button
                    key={cat.id}
                    ref={isActive ? activeTabRef : null}
                    onClick={() => navigate(`/events/${eventId}/results/${cat.id}`)}
                    className={cn(
                      'shrink-0 px-5 py-3 text-xs font-bold tracking-widest uppercase transition-colors relative',
                      isActive
                        ? 'bg-apex-yellow-bright text-apex-bg'
                        : 'text-apex-muted hover:text-apex-text'
                    )}
                  >
                    {cat.name}
                    {/* Progress bar on the active rotating tab */}
                    {isActive && !categoryId && rotationSlots.length > 1 && (
                      <span
                        className="absolute bottom-0 left-0 h-0.5 bg-apex-bg/40"
                        style={{ width: `${progress * 100}%`, transition: 'none' }}
                      />
                    )}
                  </button>
                )
              })}
              {/* Auto-rotate toggle: clicking the podium link re-enables auto mode */}
              {categoryId && (
                <button
                  onClick={() => navigate(`/events/${eventId}/podium`)}
                  className="shrink-0 px-5 py-3 text-xs font-bold tracking-widest uppercase text-apex-muted hover:text-apex-text border-l border-apex-border"
                >
                  ▶ Auto
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Content area */}
      <div className="relative z-10 flex-1 min-h-0 overflow-hidden">

        {/* Auto-rotate OR single-category view — both render the same full-screen layout */}
        {!isLoading && activeCategory && (
          <div className="h-full overflow-y-auto">
            <div className="px-6 py-8">
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
              <CategoryCard cat={activeCategory} checkpoints={categoryCheckpoints} results={enrichedResults} />
              <div className="mt-8">
                <CheckpointTrackingTable
                  results={enrichedResults}
                  checkpoints={categoryCheckpoints}
                  observations={observations}
                  formatTime={(iso) => new Date(iso).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  formatDuration={formatDuration}
                />
              </div>
            </div>
          </div>
        )}

        {/* No active categories */}
        {!isLoading && !activeCategory && !categoryId && (
          <div className="text-center py-16 text-apex-muted">
            <div className="font-display text-3xl uppercase tracking-widest mb-2">Brak aktywnych wyścigów</div>
            <div className="text-sm">Ta strona aktualizuje się automatycznie.</div>
          </div>
        )}

        {/* Category selected but no race yet */}
        {!isLoading && !activeCategory && categoryId && (
          <div className="text-center py-16 text-apex-muted">
            <div className="font-display text-3xl uppercase tracking-widest mb-2">Oczekiwanie</div>
            <div className="text-sm">Wyścig jeszcze nie wystartował. Ta strona aktualizuje się automatycznie.</div>
          </div>
        )}

      </div>
    </div>
  )
}
