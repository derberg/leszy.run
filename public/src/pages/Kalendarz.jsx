import { useState, useEffect, useCallback, useRef } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { supabase } from '../lib/supabase.js'
import Navbar from '../components/Navbar.jsx'
import Footer from '../components/Footer.jsx'
import FilterBar from '../components/FilterBar.jsx'
import EventRow from '../components/EventRow.jsx'
import MapView from '../components/MapView.jsx'
import useTheme from '../hooks/useTheme.js'

const PAGE_SIZE = 50

function normName(name) {
  return name.toLowerCase().replace(/[^a-z0-9ąćęłńóśźż ]/g, '').replace(/\s+/g, ' ').trim()
}

function nameSimilar(a, b) {
  const na = normName(a), nb = normName(b)
  // One contains the other or starts with the same prefix (first 60% of shorter)
  if (na.includes(nb) || nb.includes(na)) return true
  const minLen = Math.min(na.length, nb.length)
  const prefixLen = Math.floor(minLen * 0.6)
  if (prefixLen > 5 && na.slice(0, prefixLen) === nb.slice(0, prefixLen)) return true
  return false
}

function dedup(events) {
  const seen = []
  return events.filter(e => {
    const isDup = seen.some(s => s.date === e.date && nameSimilar(s.name, e.name))
    if (!isDup) { seen.push(e); return true }
    return false
  })
}

function getDateRange(timeRange) {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  let end = null

  switch (timeRange) {
    case 'week': end = new Date(start); end.setDate(end.getDate() + 7); break
    case 'month': end = new Date(start.getFullYear(), start.getMonth() + 1, 0); break
    case 'next-month': {
      const nextStart = new Date(start.getFullYear(), start.getMonth() + 1, 1)
      const nextEnd = new Date(nextStart.getFullYear(), nextStart.getMonth() + 1, 0)
      return [nextStart.toISOString().split('T')[0], nextEnd.toISOString().split('T')[0]]
    }
    case 'year': end = new Date(start.getFullYear(), 11, 31); break
    default: break
  }

  return [
    start.toISOString().split('T')[0],
    end ? end.toISOString().split('T')[0] : null,
  ]
}

export default function Kalendarz() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [events, setEvents] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState(searchParams.get('view') || 'list')
  const [page, setPage] = useState(parseInt(searchParams.get('page') || '1', 10))
  const debounceRef = useRef(null)

  const [filters, setFilters] = useState({
    search: searchParams.get('q') || '',
    type: searchParams.get('type') || '',
    voivodeship: searchParams.get('region') || '',
    distance: searchParams.get('dist') || '',
    timeRange: searchParams.get('when') || '',
  })

  const fetchEvents = useCallback(async () => {
    setLoading(true)
    try {
      let query = supabase
        .from('calendar_events')
        .select('*', { count: 'exact' })
        .eq('status', 'active')
        .order('date', { ascending: true })

      const [startDate, endDate] = getDateRange(filters.timeRange)
      query = query.gte('date', startDate)
      if (endDate) query = query.lte('date', endDate)

      if (filters.search) {
        query = query.or(`name.ilike.%${filters.search}%,location.ilike.%${filters.search}%`)
      }

      if (filters.type) {
        query = query.contains('event_type', [filters.type])
      }

      if (filters.voivodeship) {
        query = query.eq('voivodeship', filters.voivodeship)
      }

      // Map view and distance filter need all results (no pagination)
      // (Supabase can't filter "any array element in range" natively)
      if (view === 'map' || filters.distance) {
        query = query.limit(2000)
      } else {
        const from = (page - 1) * PAGE_SIZE
        query = query.range(from, from + PAGE_SIZE - 1)
      }

      const { data, count, error } = await query
      if (error) console.error('Calendar fetch error:', error.message)

      // Deduplicate: same date + similar name → keep first
      let filteredData = dedup(data || [])

      if (filters.distance && filteredData.length > 0) {
        const [minDist, maxDist] = filters.distance.split('-').map(Number)
        filteredData = filteredData.filter(e => {
          if (!e.distances_meters || e.distances_meters.length === 0) return false
          return e.distances_meters.some(d => d >= minDist && d <= maxDist)
        })
        // Client-side pagination for distance-filtered results
        const from = (page - 1) * PAGE_SIZE
        const paged = filteredData.slice(from, from + PAGE_SIZE)
        setTotal(filteredData.length)
        setEvents(paged)
      } else {
        setEvents(filteredData)
        setTotal(count || 0)
      }
    } catch (err) {
      console.error('Calendar fetch failed:', err)
      setEvents([])
      setTotal(0)
    }
    setLoading(false)
  }, [filters, page, view])

  useEffect(() => { fetchEvents() }, [fetchEvents])

  // Sync filters to URL
  useEffect(() => {
    const params = new URLSearchParams()
    if (filters.search) params.set('q', filters.search)
    if (filters.type) params.set('type', filters.type)
    if (filters.voivodeship) params.set('region', filters.voivodeship)
    if (filters.distance) params.set('dist', filters.distance)
    if (filters.timeRange) params.set('when', filters.timeRange)
    if (view !== 'list') params.set('view', view)
    if (page > 1) params.set('page', String(page))
    setSearchParams(params, { replace: true })
  }, [filters, view, page, setSearchParams])

  // Debounced filter change
  const handleFilterChange = (newFilters) => {
    setFilters(newFilters)
    setPage(1)
  }

  // Group events by month
  const grouped = events.reduce((acc, ev) => {
    const d = new Date(ev.date)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    const label = d.toLocaleDateString('pl-PL', { month: 'long', year: 'numeric' })
    if (!acc[key]) acc[key] = { label, events: [] }
    acc[key].events.push(ev)
    return acc
  }, {})

  const totalPages = Math.ceil(total / PAGE_SIZE)

  const { isDark } = useTheme()

  return (
    <>
      <Navbar />
      <main id="main-content" className="relative">
        {/* Background logo */}
        <div className="fixed inset-0 flex items-center justify-center pointer-events-none z-0" aria-hidden="true">
          <img
            src="/logo-bez-napisu.svg"
            alt=""
            className={`w-[80vh] max-w-[90vw] h-auto ${isDark ? 'opacity-[0.04]' : 'opacity-[0.06]'}`}
            style={{ filter: isDark
              ? 'brightness(1.4) drop-shadow(0 0 20px rgba(45,90,39,0.6)) drop-shadow(0 0 50px rgba(45,90,39,0.4)) drop-shadow(0 0 80px rgba(187,221,0,0.15))'
              : 'drop-shadow(0 0 20px rgba(45,90,39,0.1))'
            }}
          />
        </div>
        <div className="pt-20 md:pt-20 pb-8 px-6 max-w-[1200px] mx-auto relative z-10">
          <div className="flex justify-between items-start">
            <div>
              <p className="font-mono text-[11px] font-semibold tracking-widest uppercase text-apex-yellow-dim mb-2">Kalendarz biegów</p>
              <h1 className="font-display font-extrabold text-3xl md:text-5xl tracking-wider uppercase text-apex-text-bright mb-2">Wszystkie wydarzenia w Polsce</h1>
              <p className="text-base text-apex-text max-w-[600px]">Setki biegów, marszów nordic walking i wydarzeń sportowych z całej Polski.</p>
            </div>
            <Link to="/kalendarz/dodaj" className="hidden md:inline-block font-display font-bold text-[11px] tracking-widest uppercase px-4 py-2.5 border-2 border-apex-yellow text-apex-yellow hover:bg-apex-yellow hover:text-apex-ink transition-all flex-shrink-0 mt-1">
              + Dodaj wydarzenie
            </Link>
          </div>
        </div>

        <FilterBar filters={filters} onChange={handleFilterChange} view={view} onViewChange={setView} />

        <div className="max-w-[1200px] mx-auto px-6 pt-4 pb-2 flex justify-between items-center">
          <span className="font-mono text-xs text-apex-muted tracking-wide">
            Znaleziono <strong className="text-apex-yellow">{total}</strong> wydarzeń
          </span>
        </div>

        {view === 'list' ? (
          <div className="max-w-[1200px] mx-auto px-6 pb-16">
            {loading && <div className="text-apex-muted py-8">Ładowanie...</div>}

            {!loading && Object.entries(grouped).map(([key, group]) => (
              <div key={key} className="mb-2">
                <div className="font-display font-bold text-base tracking-widest uppercase text-apex-yellow-dim py-5 border-b border-apex-border mb-0.5">
                  {group.label}
                </div>
                {group.events.map(ev => <EventRow key={ev.id} event={ev} />)}
              </div>
            ))}

            {!loading && events.length === 0 && (
              <div className="text-apex-muted py-12 text-center">Brak wydarzeń dla wybranych filtrów.</div>
            )}

            {totalPages > 1 && (
              <div className="flex justify-center gap-1 pt-8">
                {page > 1 && (
                  <button onClick={() => setPage(page - 1)}
                    className="font-mono text-[13px] px-3.5 py-2 border bg-apex-surface border-apex-border text-apex-muted hover:border-apex-border-mid hover:text-apex-text-bright transition-all">
                    &larr;
                  </button>
                )}
                {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                  let p
                  if (totalPages <= 7) {
                    p = i + 1
                  } else if (page <= 4) {
                    p = i + 1
                  } else if (page >= totalPages - 3) {
                    p = totalPages - 6 + i
                  } else {
                    p = page - 3 + i
                  }
                  return (
                    <button key={p} onClick={() => setPage(p)}
                      className={`font-mono text-[13px] px-3.5 py-2 border transition-all ${p === page ? 'bg-apex-yellow text-apex-ink border-apex-yellow' : 'bg-apex-surface border-apex-border text-apex-muted hover:border-apex-border-mid hover:text-apex-text-bright'}`}>
                      {p}
                    </button>
                  )
                })}
                {page < totalPages && (
                  <button onClick={() => setPage(page + 1)}
                    className="font-mono text-[13px] px-3.5 py-2 border bg-apex-surface border-apex-border text-apex-muted hover:border-apex-border-mid hover:text-apex-text-bright transition-all">
                    &rarr;
                  </button>
                )}
              </div>
            )}
          </div>
        ) : (
          <MapView events={events} />
        )}
      </main>
      <Footer />
    </>
  )
}
