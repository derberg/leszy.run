import { useState, useEffect, useMemo } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { supabase } from '../lib/supabase.js'
import Navbar from '../components/Navbar.jsx'
import Footer from '../components/Footer.jsx'
import EventRow from '../components/EventRow.jsx'
import LandingMap from '../components/LandingMap.jsx'
import useSeo from '../hooks/useSeo.js'
import {
  TYPE_SLUG_TO_DB, REGION_SLUG_TO_DB, DB_TO_REGION_SLUG, REGION_CENTER,
  MONTH_SLUG_TO_NUM, SPECIAL_SLUGS, SPECIAL_H1,
} from '../lib/biegi-mappings.js'

const PAGE_SIZE = 100

// Mirrors parseDistanceToMeters from Kalendarz.jsx
function parseDistanceToMeters(d) {
  if (!d || typeof d !== 'string') return NaN
  const s = d.toLowerCase().trim()
  if (/\d\s*h(\b|$)/.test(s)) return NaN
  if (s.includes('półmaraton') || s.includes('polmaraton')) return 21097
  if (s.includes('maraton')) return 42195
  const match = s.match(/[0-9]+([.,][0-9]+)?/)
  if (!match) return NaN
  const num = parseFloat(match[0].replace(',', '.'))
  if (isNaN(num)) return NaN
  if (/km|kilometr/.test(s)) return Math.round(num * 1000)
  if (/\d\s*m\b|metr/.test(s)) return Math.round(num)
  return Math.round(num * 1000)
}

// Parse URL path segments into filter parameters
function parsePathFilters(pathname) {
  // pathname: /biegi/przelajowe/slaskie/2026/lipiec
  const seg = pathname.replace(/^\/biegi\/?/, '')
  if (!seg) return { special: null, typeDbVal: null, regionDb: null, year: null, month: null }

  const parts = seg.split('/')

  // Special pages
  if (parts.length === 1 && SPECIAL_SLUGS.includes(parts[0])) {
    return { special: parts[0], typeDbVal: null, regionDb: null, year: null, month: null }
  }

  let typeDbVal = null, regionDb = null, year = null, month = null
  for (const part of parts) {
    if (TYPE_SLUG_TO_DB[part]) typeDbVal = TYPE_SLUG_TO_DB[part]
    else if (REGION_SLUG_TO_DB[part]) regionDb = REGION_SLUG_TO_DB[part]
    else if (/^\d{4}$/.test(part)) year = parseInt(part)
    else if (MONTH_SLUG_TO_NUM[part]) month = MONTH_SLUG_TO_NUM[part]
  }
  return { special: null, typeDbVal, regionDb, year, month }
}

export default function LandingPage() {
  const location = useLocation()
  const [landingData, setLandingData] = useState(null)
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [view, setView] = useState('list')

  // Read static landing-data on mount; fall back to manifest for city pages (SPA nav)
  useEffect(() => {
    let active = true
    setLandingData(null)
    const el = document.getElementById('landing-data')
    if (el) {
      try { setLandingData(JSON.parse(el.textContent)) } catch {}
      return
    }
    const parsed = parsePathFilters(location.pathname)
    if (parsed.special || parsed.typeDbVal || parsed.regionDb || parsed.year || parsed.month) return
    const seg = location.pathname.replace(/^\/biegi\/?/, '').replace(/\/$/, '')
    if (!seg) return
    fetch('/biegi/.manifest.json')
      .then(r => r.ok ? r.json() : null)
      .then(m => { if (active && m) { const entry = m[`biegi/${seg}`]; if (entry) setLandingData(entry) } })
      .catch(() => {})
    return () => { active = false }
  }, [location.pathname])

  const filters = useMemo(() => {
    if (landingData?.filters) return landingData.filters
    return parsePathFilters(location.pathname)
  }, [landingData, location.pathname])

  const h1 = landingData?.h1 || location.pathname.split('/').pop()
  const intro = landingData?.intro || null
  const relatedLinks = landingData?.relatedLinks || []
  const canonicalPath = landingData?.path ? `/${landingData.path}` : location.pathname
  const regionSlug = filters.regionDb ? DB_TO_REGION_SLUG[filters.regionDb] : null
  const mapCenter = regionSlug ? REGION_CENTER[regionSlug] : null

  // Fetch events from Supabase using display filter
  useEffect(() => {
    let cancelled = false
    setLoading(true)

    async function fetchEvents() {
      const today = new Date().toISOString().slice(0, 10)

      let q = supabase
        .from('calendar_events')
        .select('*', { count: 'exact' })
        .eq('status', 'active')
        .gte('date', today)
        .or(`registration_deadline.is.null,registration_deadline.gte.${today}`)
        .order('date', { ascending: true })

      const { special, typeDbVal, regionDb, year, month, city } = filters

      if (special === 'polmaratony' || special === 'maratony') {
        // Distance-based: fetch broadly then filter client-side
        q = q.limit(2000)
      } else if (special === 'dla-dzieci') {
        // is_kids is not a column in calendar_events; publishToCalendar maps it to event_type=['dzieci']
        const from = (page - 1) * PAGE_SIZE
        q = q.contains('event_type', ['dzieci']).range(from, from + PAGE_SIZE - 1)
      } else if (special === 'darmowe') {
        const from = (page - 1) * PAGE_SIZE
        q = q.eq('price_from', 0).range(from, from + PAGE_SIZE - 1)
      } else {
        if (typeDbVal) q = q.contains('event_type', [typeDbVal])
        if (regionDb) q = q.eq('voivodeship', regionDb)
        if (city) q = q.ilike('location', `${city}%`)
        if (year && month) {
          const monthStr = String(month).padStart(2, '0')
          const lastDay = new Date(year, month, 0).getDate()
          q = q.gte('date', `${year}-${monthStr}-01`).lte('date', `${year}-${monthStr}-${lastDay}`)
        }
        const from = (page - 1) * PAGE_SIZE
        q = q.range(from, from + PAGE_SIZE - 1)
      }

      const { data, count, error } = await q
      if (cancelled) return
      if (error) { console.error('LandingPage fetch error:', error.message); setLoading(false); return }

      let result = data || []

      // Client-side distance filter for polmaratony/maratony (distance range not filterable server-side)
      if (special === 'polmaratony') {
        result = result.filter(e => (e.distances || []).some(d => { const m = parseDistanceToMeters(d); return m >= 19000 && m <= 23000 }))
      } else if (special === 'maratony') {
        result = result.filter(e => (e.distances || []).some(d => { const m = parseDistanceToMeters(d); return m >= 41000 && m <= 44000 }))
      }

      setEvents(result)
      setTotal(['polmaratony', 'maratony'].includes(special) ? result.length : (count || 0))
      setLoading(false)
    }

    fetchEvents()
    return () => { cancelled = true }
  }, [filters, page])

  // Build full JSON-LD with events for useSeo after load
  const jsonLd = useMemo(() => {
    if (!events.length) return null
    return {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: h1,
      description: landingData?.description,
      url: `https://www.leszy.run${canonicalPath}`,
      inLanguage: 'pl-PL',
      mainEntity: {
        '@type': 'ItemList',
        itemListElement: events.slice(0, 50).map((e, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          item: {
            '@type': 'SportsEvent',
            name: e.name,
            startDate: e.date,
            location: {
              '@type': 'Place',
              name: e.location || undefined,
              address: { '@type': 'PostalAddress', addressLocality: e.location || undefined, addressRegion: e.voivodeship || undefined, addressCountry: 'PL' },
            },
            ...(e.price_from != null ? { offers: { '@type': 'Offer', price: String(e.price_from), priceCurrency: 'PLN', availability: 'https://schema.org/InStock' } } : {}),
            ...(e.registration_url || e.website ? { url: e.registration_url || e.website } : {}),
          },
        })),
      },
    }
  }, [events, h1, landingData, canonicalPath])

  useSeo({
    title: landingData?.title?.replace(' — Leszy.run', '') || h1,
    description: landingData?.description,
    path: canonicalPath,
    jsonLd,
  })

  const totalPages = Math.ceil(total / PAGE_SIZE)

  // Group events by month
  const grouped = events.reduce((acc, ev) => {
    const d = new Date(ev.date)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    const label = d.toLocaleDateString('pl-PL', { month: 'long', year: 'numeric' })
    if (!acc[key]) acc[key] = { label, events: [] }
    acc[key].events.push(ev)
    return acc
  }, {})

  const kalendarzParams = new URLSearchParams()
  if (filters.typeDbVal) kalendarzParams.set('type', filters.typeDbVal)
  if (filters.regionDb) kalendarzParams.set('region', filters.regionDb)

  return (
    <>
      <Navbar />
      <main id="main-content" className="pt-20 pb-16 px-6 max-w-[1200px] mx-auto">
        <div className="mb-6">
          <h1 className="font-display font-extrabold text-3xl md:text-5xl tracking-wider uppercase text-apex-text-bright mb-2">
            {h1}
          </h1>
          {intro && <p className="text-base text-apex-text max-w-[700px]">{intro}</p>}
        </div>

        {relatedLinks.length > 0 && (
          <nav aria-label="Powiązane strony" className="mb-8">
            <div className="flex flex-wrap gap-2">
              {relatedLinks.map(link => (
                <Link
                  key={link.path}
                  to={`/${link.path}`}
                  className="font-mono text-[11px] font-semibold tracking-wide px-3 py-1.5 border border-apex-border text-apex-muted hover:border-apex-yellow/40 hover:text-apex-yellow transition-all"
                >
                  {link.h1}
                  {link.eventCount > 0 && <span className="ml-1.5 text-apex-yellow-dim">{link.eventCount}</span>}
                </Link>
              ))}
            </div>
          </nav>
        )}

        <div className="mb-4 flex justify-between items-center">
          <span className="font-mono text-xs text-apex-muted">
            Znaleziono <strong className="text-apex-yellow">{total}</strong> wydarzeń
          </span>
          <div className="flex items-center gap-1.5">
            <button onClick={() => setView('list')}
              className={`font-mono text-[11px] tracking-wide px-3 py-1.5 border transition-all ${view === 'list' ? 'bg-apex-yellow text-apex-ink border-apex-yellow' : 'border-apex-border text-apex-muted hover:border-apex-border-mid hover:text-apex-text-bright'}`}>
              Lista
            </button>
            <button onClick={() => setView('map')}
              className={`font-mono text-[11px] tracking-wide px-3 py-1.5 border transition-all ${view === 'map' ? 'bg-apex-yellow text-apex-ink border-apex-yellow' : 'border-apex-border text-apex-muted hover:border-apex-border-mid hover:text-apex-text-bright'}`}>
              Mapa
            </button>
            <Link
              to={`/kalendarz${kalendarzParams.toString() ? '?' + kalendarzParams.toString() : ''}`}
              className="font-display font-bold text-[11px] tracking-widest uppercase px-4 py-2 border-2 border-apex-yellow text-apex-yellow hover:bg-apex-yellow hover:text-apex-ink transition-all"
            >
              Przeglądaj i filtruj →
            </Link>
          </div>
        </div>

        {loading && <div className="text-apex-muted py-8">Ładowanie...</div>}

        {!loading && view === 'map' && <LandingMap events={events} center={mapCenter} />}

        {!loading && view === 'list' && Object.entries(grouped).map(([key, group]) => (
          <div key={key} className="mb-2">
            <div className="font-display font-bold text-base tracking-widest uppercase text-apex-yellow-dim py-5 border-b border-apex-border mb-0.5">
              {group.label}
            </div>
            {group.events.map(ev => <EventRow key={ev.id} event={ev} />)}
          </div>
        ))}

        {!loading && events.length === 0 && (
          <div className="text-apex-muted py-12 text-center">Brak wydarzeń dla tej kategorii.</div>
        )}

        {view === 'list' && totalPages > 1 && (
          <div className="flex justify-center gap-1 pt-8">
            {page > 1 && (
              <button onClick={() => setPage(page - 1)}
                className="font-mono text-[13px] px-3.5 py-2 border bg-apex-surface border-apex-border text-apex-muted hover:border-apex-border-mid hover:text-apex-text-bright transition-all">
                &larr;
              </button>
            )}
            {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
              const p = totalPages <= 7 ? i + 1 : page <= 4 ? i + 1 : page >= totalPages - 3 ? totalPages - 6 + i : page - 3 + i
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
      </main>
      <Footer />
    </>
  )
}
