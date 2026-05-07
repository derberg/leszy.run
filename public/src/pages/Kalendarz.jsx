import { useState, useEffect, useCallback, useRef } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { supabase } from '../lib/supabase.js'
import Navbar from '../components/Navbar.jsx'
import Footer from '../components/Footer.jsx'
import FilterBar from '../components/FilterBar.jsx'
import EventRow from '../components/EventRow.jsx'
import MapView from '../components/MapView.jsx'
import CalendarGrid from '../components/CalendarGrid.jsx'
import CalendarDetailPanel from '../components/CalendarDetailPanel.jsx'
import useTheme from '../hooks/useTheme.js'
import useSeo from '../hooks/useSeo.js'
import { haversineKm } from '../lib/haversine.js'
import FeedbackModal from '../components/FeedbackModal.jsx'

const PAGE_SIZE = 50

// Events with less than this many days left are considered registration-closed
const REG_CLOSED_DAYS = 5

function LeszyrunBanner() {
  const [events, setEvents] = useState([])
  const [countdowns, setCountdowns] = useState({})

  useEffect(() => {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() + REG_CLOSED_DAYS)
    const cutoffStr = cutoff.toISOString().split('T')[0]

    supabase
      .from('events')
      .select('name, date, location, slug, event_url')
      .eq('visibility', 'public')
      .gte('date', cutoffStr)
      .order('date', { ascending: true })
      .then(({ data }) => {
        if (data?.length) setEvents(data)
      })
  }, [])

  useEffect(() => {
    if (!events.length) return
    const update = () => {
      const now = new Date()
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      const map = {}
      for (const ev of events) {
        const target = new Date(ev.date + 'T00:00:00')
        const days = Math.ceil((target - today) / 86400000)
        map[ev.slug] = days === 0 ? 'Dziś!' : days === 1 ? 'Jutro!' : `za ${days} dni`
      }
      setCountdowns(map)
    }
    update()
    const id = setInterval(update, 60000)
    return () => clearInterval(id)
  }, [events])

  if (!events.length) return null

  return (
    <div className="max-w-[1200px] mx-auto px-6 mb-4 flex flex-col gap-2">
      {events.map(event => {
        const dateFormatted = new Date(event.date).toLocaleDateString('pl-PL', { day: 'numeric', month: 'long', year: 'numeric' })
        const countdown = countdowns[event.slug]

        return (
          <a key={event.slug} href={event.event_url || `/events/${event.slug}`} target={event.event_url ? '_blank' : undefined} rel={event.event_url ? 'noopener' : undefined}
            className="block border-l-[4px] border-l-apex-yellow bg-apex-yellow/[0.06] border border-apex-yellow/20 px-5 py-5 hover:bg-apex-yellow/[0.10] hover:border-apex-yellow/30 transition-all no-underline text-inherit group relative overflow-hidden">
            {/* Diagonal accent stripe */}
            <div className="absolute top-0 right-0 w-32 h-full bg-apex-yellow/[0.04] -skew-x-12 translate-x-8" />

            <div className="relative flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-3 mb-1.5">
                  <span className="font-mono text-[10px] font-semibold tracking-widest px-2.5 py-1 bg-apex-yellow/15 text-apex-yellow border border-apex-yellow/30 flex-shrink-0">
                    POLECAMY
                  </span>
                  {countdown && <span className="font-mono text-[11px] font-semibold text-apex-yellow">{countdown}</span>}
                </div>
                <div className="font-display font-extrabold text-lg md:text-xl tracking-wider uppercase text-apex-text-bright group-hover:text-apex-yellow transition-colors truncate">
                  {event.name}
                </div>
                <div className="flex items-center gap-2 mt-1">
                  <span className="font-mono text-[12px] font-semibold text-apex-yellow">{dateFormatted}</span>
                  {event.location && <span className="text-[13px] text-apex-muted">· {event.location}</span>}
                </div>
              </div>
              <div className="flex-shrink-0 hidden md:block">
                <span className="font-display font-bold text-[12px] tracking-widest uppercase px-5 py-2.5 border-2 border-apex-yellow text-apex-yellow group-hover:bg-apex-yellow group-hover:text-apex-ink transition-all">
                  Szczegóły &rarr;
                </span>
              </div>
            </div>
          </a>
        )
      })}
    </div>
  )
}

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

function toLocalDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function getDateRange(timeRange) {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  let end = null

  // "after-YYYY-MM" — from that month onwards, no end
  if (timeRange.startsWith('after-') && timeRange !== 'after') {
    const parts = timeRange.split('-')
    const year = parseInt(parts[1], 10)
    const month = parseInt(parts[2], 10) - 1
    return [toLocalDateStr(new Date(year, month, 1)), null]
  }

  switch (timeRange) {
    case 'week': end = new Date(start); end.setDate(end.getDate() + 7); break
    case 'month': end = new Date(start.getFullYear(), start.getMonth() + 1, 0); break
    case 'next-month': {
      const nextStart = new Date(start.getFullYear(), start.getMonth() + 1, 1)
      const nextEnd = new Date(nextStart.getFullYear(), nextStart.getMonth() + 1, 0)
      return [toLocalDateStr(nextStart), toLocalDateStr(nextEnd)]
    }
    case 'year': end = new Date(start.getFullYear(), 11, 31); break
    case 'next-year': {
      const nextYearStart = new Date(start.getFullYear() + 1, 0, 1)
      const nextYearEnd = new Date(start.getFullYear() + 1, 11, 31)
      return [toLocalDateStr(nextYearStart), toLocalDateStr(nextYearEnd)]
    }
    default: break
  }

  return [
    toLocalDateStr(start),
    end ? toLocalDateStr(end) : null,
  ]
}

export default function Kalendarz() {
  useSeo({
    title: 'Kalendarz biegów w Polsce',
    description: 'Przeglądaj setki biegów, marszów nordic walking i wydarzeń sportowych z całej Polski. Filtruj po regionie, dystansie, typie i dacie.',
    path: '/kalendarz',
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: 'Kalendarz biegów w Polsce',
      description: 'Agregowany kalendarz wszystkich biegów i wydarzeń sportowych w Polsce.',
      url: 'https://www.leszy.run/kalendarz',
      isPartOf: { '@id': 'https://www.leszy.run/#website' },
    },
  })

  const [searchParams, setSearchParams] = useSearchParams()
  const [events, setEvents] = useState([])
  const [allFilteredEvents, setAllFilteredEvents] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState(searchParams.get('view') || 'list')
  const [page, setPage] = useState(parseInt(searchParams.get('page') || '1', 10))
  const debounceRef = useRef(null)

  const [userLocation, setUserLocation] = useState(() => {
    const stored = sessionStorage.getItem('leszy_location')
    return stored ? JSON.parse(stored) : null
  })
  const [radius, setRadius] = useState(parseInt(searchParams.get('r') || '50', 10))
  const [locationError, setLocationError] = useState(null)
  const [autoExpanded, setAutoExpanded] = useState(false)

  const [calendarMonth, setCalendarMonth] = useState(() => new Date())
  const [selectedDate, setSelectedDate] = useState(null)
  const detailPanelRef = useRef(null)

  const [showFeedback, setShowFeedback] = useState(false)

  const [filters, setFilters] = useState({
    search: searchParams.get('q') || '',
    type: searchParams.get('type') ? searchParams.get('type').split(',') : [],
    voivodeship: searchParams.get('region') ? searchParams.get('region').split(',') : [],
    distance: searchParams.get('dist') ? searchParams.get('dist').split(',') : [],
    timeRange: searchParams.get('when') || '',
    price: searchParams.get('price') || '',
  })

  const handleLocationRequest = useCallback(() => {
    if (!navigator.geolocation) {
      setLocationError('Twoja przeglądarka nie obsługuje geolokalizacji')
      return
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude }
        setUserLocation(loc)
        sessionStorage.setItem('leszy_location', JSON.stringify(loc))
        setLocationError(null)
        setPage(1)
      },
      () => {
        setLocationError('Nie udało się pobrać lokalizacji')
        setTimeout(() => setLocationError(null), 4000)
      },
      { enableHighAccuracy: false, timeout: 10000 }
    )
  }, [])

  const handleLocationClear = useCallback(() => {
    setUserLocation(null)
    sessionStorage.removeItem('leszy_location')
    setPage(1)
  }, [])

  const [rawData, setRawData] = useState({ data: [], count: 0 })

  // Supabase fetch — only runs when server-side query params change (NOT radius/distance/price)
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

      if (filters.type.length === 1) {
        query = query.contains('event_type', [filters.type[0]])
      } else if (filters.type.length > 1) {
        query = query.or(filters.type.map(t => `event_type.cs.{${t}}`).join(','))
      }

      if (filters.voivodeship.length === 1) {
        query = query.eq('voivodeship', filters.voivodeship[0])
      } else if (filters.voivodeship.length > 1) {
        query = query.in('voivodeship', filters.voivodeship)
      }

      // Map view and client-side filters need all results (no pagination at DB level)
      if (view === 'map' || view === 'calendar' || filters.distance.length || filters.price || userLocation) {
        query = query.limit(2000)
      } else {
        const from = (page - 1) * PAGE_SIZE
        query = query.range(from, from + PAGE_SIZE - 1)
      }

      const { data, count, error } = await query
      if (error) console.error('Calendar fetch error:', error.message)

      setRawData({ data: dedup(data || []), count: count || 0 })
    } catch (err) {
      console.error('Calendar fetch failed:', err)
      setRawData({ data: [], count: 0 })
    }
    setLoading(false)
  }, [filters, page, view, userLocation])

  useEffect(() => { fetchEvents() }, [fetchEvents])

  // Client-side filtering — re-runs instantly when radius/distance/price/page change
  useEffect(() => {
    let filteredData = rawData.data
    if (filteredData.length === 0 && rawData.count === 0) {
      setEvents([])
      setAllFilteredEvents([])
      setTotal(0)
      return
    }

    let isAutoExpanded = false
    if (userLocation && filteredData.length > 0) {
      filteredData = filteredData
        .filter(e => e.lat && e.lng)
        .map(e => ({
          ...e,
          distanceKm: Math.round(haversineKm(userLocation.lat, userLocation.lng, Number(e.lat), Number(e.lng)))
        }))

      let nearby = filteredData.filter(e => e.distanceKm <= radius)

      if (nearby.length === 0 && filteredData.length > 0) {
        nearby = [...filteredData].sort((a, b) => a.distanceKm - b.distanceKm).slice(0, 5)
        isAutoExpanded = true
      }

      filteredData = nearby.sort((a, b) => a.date.localeCompare(b.date) || a.distanceKm - b.distanceKm)
    }

    setAutoExpanded(isAutoExpanded)

    if (filters.distance.length > 0 && filteredData.length > 0) {
      const ranges = filters.distance.map(r => r.split('-').map(Number))
      filteredData = filteredData.filter(e => {
        if (!e.distances || e.distances.length === 0) return false
        return e.distances.some(d => {
          const m = Math.round(parseFloat(d) * 1000)
          if (isNaN(m)) return false
          return ranges.some(([minDist, maxDist]) => m >= minDist && m <= maxDist)
        })
      })
    }

    if (filters.price && filteredData.length > 0) {
      if (filters.price === 'free') {
        filteredData = filteredData.filter(e =>
          e.price_from === 0 || (e.price_from == null && e.price_to === 0)
        )
      } else {
        const maxPrice = parseInt(filters.price.split('-')[1], 10)
        filteredData = filteredData.filter(e => {
          if (e.price_from == null && e.price_to == null) return false
          const lowest = e.price_from ?? e.price_to
          return lowest <= maxPrice
        })
      }
    }

    if (userLocation || filters.distance.length || filters.price) {
      setAllFilteredEvents(filteredData)
      const from = (page - 1) * PAGE_SIZE
      setTotal(filteredData.length)
      setEvents(filteredData.slice(from, from + PAGE_SIZE))
    } else {
      setAllFilteredEvents(filteredData)
      setEvents(filteredData)
      setTotal(rawData.count)
    }
  }, [rawData, radius, filters.distance, filters.price, page, userLocation])

  // Sync filters to URL
  useEffect(() => {
    const params = new URLSearchParams()
    if (filters.search) params.set('q', filters.search)
    if (filters.type.length) params.set('type', filters.type.join(','))
    if (filters.voivodeship.length) params.set('region', filters.voivodeship.join(','))
    if (filters.distance.length) params.set('dist', filters.distance.join(','))
    if (filters.timeRange) params.set('when', filters.timeRange)
    if (filters.price) params.set('price', filters.price)
    if (view !== 'list') params.set('view', view)
    if (userLocation && radius !== 50) params.set('r', String(radius))
    if (page > 1) params.set('page', String(page))
    setSearchParams(params, { replace: true })
  }, [filters, view, page, radius, userLocation, setSearchParams])

  // Debounced filter change
  const handleFilterChange = (newFilters) => {
    setFilters(newFilters)
    setPage(1)
    setSelectedDate(null)
  }

  const handleSelectDate = (dateStr) => {
    setSelectedDate(prev => prev === dateStr ? null : dateStr)
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

  const selectedDateEvents = selectedDate
    ? events.filter(ev => ev.date === selectedDate)
    : []

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
            fetchPriority="high"
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
            <div className="hidden md:flex gap-2 flex-shrink-0 mt-1">
              <button onClick={() => setShowFeedback(true)} className="font-display font-bold text-[11px] tracking-widest uppercase px-4 py-2.5 border-2 border-apex-border text-apex-muted hover:border-apex-text hover:text-apex-text-bright transition-all">
                Pomóż ulepszyć
              </button>
              <Link to="/kalendarz/dodaj" className="font-display font-bold text-[11px] tracking-widest uppercase px-4 py-2.5 border-2 border-apex-yellow text-apex-yellow hover:bg-apex-yellow hover:text-apex-ink transition-all">
                + Dodaj wydarzenie
              </Link>
            </div>
          </div>
        </div>

        <LeszyrunBanner />

        <FilterBar
          filters={filters}
          onChange={handleFilterChange}
          view={view}
          onViewChange={setView}
          userLocation={userLocation}
          radius={radius}
          onLocationRequest={handleLocationRequest}
          onLocationClear={handleLocationClear}
          onRadiusChange={setRadius}
        />

        {locationError && (
          <div className="max-w-[1200px] mx-auto px-6 mt-2">
            <div className="bg-red-500/10 border border-red-500/30 text-red-400 font-sans text-sm px-4 py-2.5">
              {locationError}
            </div>
          </div>
        )}

        <div className="max-w-[1200px] mx-auto px-6 pt-4 pb-2 flex justify-between items-center">
          <span className="font-mono text-xs text-apex-muted tracking-wide">
            Znaleziono <strong className="text-apex-yellow">{total}</strong> wydarzeń
          </span>
        </div>

        {autoExpanded && userLocation && (
          <div className="max-w-[1200px] mx-auto px-6 mt-2">
            <div className="bg-apex-yellow/10 border border-apex-yellow/30 text-apex-yellow font-sans text-sm px-4 py-2.5">
              Brak wydarzeń w promieniu {radius} km — pokazujemy 5 najbliższych
            </div>
          </div>
        )}

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
        ) : view === 'calendar' ? (
          <div className="max-w-[1200px] mx-auto px-6 pb-16">
            {loading && <div className="text-apex-muted py-8">Ładowanie...</div>}
            {!loading && (
              <>
                <CalendarGrid
                  events={events}
                  selectedDate={selectedDate}
                  onSelectDate={handleSelectDate}
                  currentMonth={calendarMonth}
                  onMonthChange={setCalendarMonth}
                />
                {selectedDate && selectedDateEvents.length > 0 && (
                  <CalendarDetailPanel
                    ref={detailPanelRef}
                    date={selectedDate}
                    events={selectedDateEvents}
                  />
                )}
              </>
            )}
            {!loading && events.length === 0 && (
              <div className="text-apex-muted py-12 text-center">Brak wydarzeń dla wybranych filtrów.</div>
            )}
          </div>
        ) : (
          <MapView events={allFilteredEvents} userLocation={userLocation} radius={radius} />
        )}
      </main>
      {showFeedback && <FeedbackModal onClose={() => setShowFeedback(false)} />}
      <Footer />
    </>
  )
}
