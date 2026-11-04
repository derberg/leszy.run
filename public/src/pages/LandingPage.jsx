import { useState, useEffect, useMemo } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { loadCalendarEvents } from '../lib/calendarData.js'
import { landingEvents } from '../lib/calendarQueries.js'
import { slugify } from '../lib/slugify.js'
import Navbar from '../components/Navbar.jsx'
import EventRow from '../components/EventRow.jsx'
import LandingMap from '../components/LandingMap.jsx'
import LeszyrunBanner from '../components/LeszyrunBanner.jsx'
import NotFound from './NotFound.jsx'
import useSeo from '../hooks/useSeo.js'
import { isLandingIndexable } from '../lib/landingIndexing.js'
import {
  TYPE_SLUG_TO_DB, REGION_SLUG_TO_DB, DB_TO_REGION_SLUG, REGION_CENTER,
  MONTH_SLUG_TO_NUM, SPECIAL_SLUGS, SPECIAL_H1,
} from '../lib/biegi-mappings.js'

const PAGE_SIZE = 100

// Parse URL path segments into filter parameters
function parsePathFilters(pathname) {
  // pathname: /listy/przelajowe/slaskie/2026/lipiec
  const seg = pathname.replace(/^\/listy\/?/, '')
  if (!seg) return { special: null, typeDbVal: null, regionDb: null, year: null, month: null }

  const parts = seg.split('/')

  // Special pages (with optional region: /listy/maratony/slaskie)
  if (SPECIAL_SLUGS.includes(parts[0])) {
    const regionDb = parts[1] ? REGION_SLUG_TO_DB[parts[1]] || null : null
    return { special: parts[0], typeDbVal: null, regionDb, year: null, month: null }
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
  const [manifestChecked, setManifestChecked] = useState(false)
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [view, setView] = useState('list')
  const [linksExpanded, setLinksExpanded] = useState(false)

  // Read static landing-data on mount; fall back to manifest for all SPA nav (h1, relatedLinks, etc.)
  useEffect(() => {
    let active = true
    setLandingData(null)
    setManifestChecked(false)
    setLinksExpanded(false)
    const el = document.getElementById('landing-data')
    if (el) {
      try { setLandingData(JSON.parse(el.textContent)) } catch {}
      setManifestChecked(true)
      return
    }
    const seg = location.pathname.replace(/^\/listy\/?/, '').replace(/\/$/, '')
    if (!seg) { setManifestChecked(true); return }
    fetch('/listy/.manifest.json')
      .then(r => r.ok ? r.json() : null)
      .then(m => {
        if (!active) return
        if (m) { const entry = m[`listy/${seg}`]; if (entry) setLandingData(entry) }
        setManifestChecked(true)
      })
      .catch(() => { if (active) setManifestChecked(true) })
    return () => { active = false }
  }, [location.pathname])

  const filters = useMemo(() => {
    if (landingData?.filters) return landingData.filters
    return parsePathFilters(location.pathname)
  }, [landingData, location.pathname])

  const hasAnyFilter = !!(filters.special || filters.typeDbVal || filters.regionDb || filters.year || filters.month || filters.city)
  const isUnknownSlug = manifestChecked && !landingData && !hasAnyFilter

  const h1 = landingData?.h1 || location.pathname.split('/').pop()
  const intro = landingData?.intro || null
  const relatedLinks = landingData?.relatedLinks || []
  const canonicalPath = landingData?.path ? `/${landingData.path}` : location.pathname
  const regionSlug = filters.regionDb ? DB_TO_REGION_SLUG[filters.regionDb] : null
  const mapCenter = regionSlug ? REGION_CENTER[regionSlug] : null

  // Fetch events from Supabase using display filter
  useEffect(() => {
    if (isUnknownSlug) { setEvents([]); setTotal(0); setLoading(false); return }
    let cancelled = false
    setLoading(true)

    // From the build-time calendar file, never from calendar_events.
    async function fetchEvents() {
      let all
      try {
        all = await loadCalendarEvents()
      } catch (err) {
        if (cancelled) return
        console.error('LandingPage fetch error:', err.message); setLoading(false); return
      }
      if (cancelled) return
      const { events: result, total } = landingEvents(all, filters, { page, pageSize: PAGE_SIZE })
      setEvents(result)
      setTotal(total)
      setLoading(false)
    }

    fetchEvents()
    return () => { cancelled = true }
  }, [filters, page, isUnknownSlug])

  // Build full JSON-LD with events for useSeo after load
  const jsonLd = useMemo(() => {
    if (!events.length) return null
    const pageUrl = `https://www.leszy.run${canonicalPath}`
    const isRoot = canonicalPath === '/listy'
    const breadcrumbItems = [
      { '@type': 'ListItem', position: 1, name: 'Leszy.run', item: 'https://www.leszy.run' },
      { '@type': 'ListItem', position: 2, name: 'Lista kategorii', item: 'https://www.leszy.run/listy' },
    ]
    if (!isRoot) {
      breadcrumbItems.push({ '@type': 'ListItem', position: 3, name: h1, item: pageUrl })
    }
    return {
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'CollectionPage',
          name: h1,
          description: landingData?.description,
          url: pageUrl,
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
                ...(e.price_from != null ? { offers: { '@type': 'Offer', price: String(e.price_from), priceCurrency: 'PLN', availability: 'https://schema.org/InStock', validFrom: e.created_at ? String(e.created_at).slice(0, 10) : String(e.date).slice(0, 10), url: `https://www.leszy.run/kalendarz/${slugify(e.name, e.date)}` } } : {}),
                // The calendar file carries no registration or website address, so each race
                // points at its own /kalendarz page, which links both.
                url: `https://www.leszy.run/kalendarz/${slugify(e.name, e.date)}`,
              },
            })),
          },
        },
        {
          '@type': 'BreadcrumbList',
          itemListElement: breadcrumbItems,
        },
      ],
    }
  }, [events, h1, landingData, canonicalPath])

  useSeo({
    title: landingData?.title?.replace(' — Leszy.run', '') || h1,
    description: landingData?.description,
    path: canonicalPath,
    jsonLd,
    // The static generator's rule, so hydration never flips the robots tag.
    noindex: !isLandingIndexable(landingData),
  })

  if (isUnknownSlug) return <NotFound />

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
              {(linksExpanded ? relatedLinks : relatedLinks.slice(0, 3)).map(link => (
                <Link
                  key={link.path}
                  to={`/${link.path}`}
                  className="font-mono text-[11px] font-semibold tracking-wide px-3 py-1.5 border border-apex-border text-apex-muted hover:border-apex-yellow/40 hover:text-apex-yellow transition-all"
                >
                  {link.h1}
                  {link.eventCount > 0 && <span className="ml-1.5 text-apex-yellow-dim">{link.eventCount}</span>}
                </Link>
              ))}
              {relatedLinks.length > 3 && (
                <button
                  onClick={() => setLinksExpanded(v => !v)}
                  className="font-mono text-[11px] font-semibold tracking-wide px-3 py-1.5 border border-apex-border text-apex-yellow-dim hover:border-apex-yellow/40 hover:text-apex-yellow transition-all"
                >
                  {linksExpanded ? 'Zwiń ↑' : `+${relatedLinks.length - 3} więcej`}
                </button>
              )}
            </div>
          </nav>
        )}

        <LeszyrunBanner className="mb-6" />

        <div className="mb-4 flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2">
          <span className="font-mono text-xs text-apex-muted">
            Znaleziono <strong className="text-apex-yellow">{total}</strong> wydarzeń
          </span>
          <div className="flex items-center gap-1.5 flex-wrap">
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
              className="whitespace-nowrap font-display font-bold text-[11px] tracking-widest uppercase px-4 py-2 border-2 border-apex-yellow text-apex-yellow hover:bg-apex-yellow hover:text-apex-ink transition-all"
            >
              Przeglądaj i filtruj →
            </Link>
          </div>
        </div>

        {loading && <div className="text-apex-muted py-8">Ładowanie...</div>}

        {!loading && view === 'map' && <LandingMap events={events} center={mapCenter} />}

        {!loading && view === 'list' && Object.entries(grouped).map(([key, group]) => (
          <div key={key} className="mb-2">
            <h2 className="font-display font-bold text-base tracking-widest uppercase text-apex-yellow-dim py-5 border-b border-apex-border mb-0.5">
              {group.label}
            </h2>
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
    </>
  )
}
