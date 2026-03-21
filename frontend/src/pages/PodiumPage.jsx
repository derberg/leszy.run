import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useWsEvent } from '../lib/ws.js'
import { api } from '../lib/api.js'
import { formatDuration, cn } from '../lib/utils.js'
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
    // Earlier start = more time on course = higher estimated position
    if (a.startTime && b.startTime) return new Date(a.startTime) - new Date(b.startTime)
    return 0
  })
  return sorted.map((r, i) => ({ ...r, estimatedPosition: r.position || (i + 1) }))
}

// Wrapper for "All" grid view — fetches observations per category and renders card + checkpoint table
function CategoryWithCheckpoints({ cat, checkpoints }) {
  const run = cat.raceRuns?.[0]

  const { data: observations = [] } = useQuery({
    queryKey: ['checkpoint-observations', run?.id],
    queryFn: () => api.checkpoints.observationsForRace(run?.id),
    enabled: !!run?.id && checkpoints.length > 0,
    refetchInterval: 5000,
  })

  const rawResults = run?.results ?? []
  const enrichedResults = estimatePositions(rawResults, checkpoints, observations)

  return (
    <div>
      <CategoryCard cat={cat} checkpoints={checkpoints} results={enrichedResults} />
      {run && (
        <div className="mt-4">
          <CheckpointTrackingTable
            results={enrichedResults}
            checkpoints={checkpoints}
            observations={observations}
            formatTime={(iso) => new Date(iso).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            formatDuration={formatDuration}
          />
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

  // Rank all runners (finished + on-track) so podium updates in real time
  const ranked = estimatePositions(rawResults, checkpoints || [], [])
  const active = ranked.filter(r => r.finishTime || (r.status === 'started' && !r.finishTime))

  const top3 = active.slice(0, 3).map(r => ({
    ...r,
    positionType: r.finishTime ? 'final' : 'started',
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
                  <CategoryWithCheckpoints cat={cat} checkpoints={checkpoints} />
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
                  <CategoryCard cat={activeCategory} checkpoints={checkpoints} results={enrichedResults} />
                  <div className="mt-8">
                    <CheckpointTrackingTable
                      results={enrichedResults}
                      checkpoints={checkpoints}
                      observations={observations}
                      formatTime={(iso) => new Date(iso).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                      formatDuration={formatDuration}
                    />
                  </div>
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
