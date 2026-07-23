import { useState, useEffect, lazy, Suspense } from 'react'
import { useParams, Link } from 'react-router-dom'
import { supabase } from '../lib/supabase.js'
import { slugify, extractDateFromSlug } from '../lib/slugify.js'
import useSeo from '../hooks/useSeo.js'
import useTheme from '../hooks/useTheme.js'
import Navbar from '../components/Navbar.jsx'
import EventInfoGrid from '../components/EventInfoGrid.jsx'
import NearbyEvents from '../components/NearbyEvents.jsx'
import LeszyrunBanner from '../components/LeszyrunBanner.jsx'
import ReportEventModal from '../components/ReportEventModal.jsx'
import StarButton from '../components/StarButton.jsx'
import useBeta from '../hooks/useBeta.js'

const EventMap = lazy(() => import('../components/EventMap.jsx'))

const TYPE_LABELS = {
  trail: 'trail',
  nocny: 'nocny',
  ocr: 'OCR',
  nordic: 'nordic walking',
  ultra: 'ultramaraton',
  charytatywny: 'charytatywny',
  uliczny: 'uliczny',
}

const baseTag = 'font-mono text-[10px] font-semibold tracking-wide px-2 py-0.5 border uppercase'

function getTypeTagClass(type) {
  if (type === 'nocny') return `${baseTag} border-[rgba(148,130,220,0.3)] text-[#9482dc]`
  if (type === 'charytatywny') return `${baseTag} border-[rgba(45,90,39,0.5)] text-[#5baa52]`
  return `${baseTag} border-apex-cyan/30 text-apex-cyan`
}

const distTagClass = `${baseTag} border-[rgba(187,221,0,0.3)] text-apex-yellow-dim`

/**
 * Format a date in Polish locale.
 * @param {string} dateStr - ISO date string
 * @returns {string}
 */
function formatDatePolish(dateStr) {
  if (!dateStr) return ''
  return new Date(dateStr).toLocaleDateString('pl-PL', {
    day: 'numeric', month: 'long', year: 'numeric',
  })
}

/**
 * Calculate days until a date from today.
 * @param {string} dateStr - ISO date string
 * @returns {number|null}
 */
function daysUntil(dateStr) {
  if (!dateStr) return null
  const now = new Date()
  const target = new Date(dateStr + 'T00:00:00')
  const diff = Math.ceil((target - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000)
  return diff >= 0 ? diff : null
}

function buildSchemaDescription(event) {
  const parts = []
  if (event.date) parts.push(formatDatePolish(event.date))
  if (event.location) parts.push(event.location)
  if (Array.isArray(event.distances) && event.distances.length > 0) {
    parts.push(event.distances.join(', '))
  }
  if (Array.isArray(event.event_type) && event.event_type.length > 0) {
    parts.push(event.event_type.map(t => TYPE_LABELS[t] || t).join(', '))
  }
  return parts.join(' · ')
}

function buildJsonLd(event, slug) {
  const startDate = event.date ? String(event.date).slice(0, 10) : undefined
  const eventUrl = `https://www.leszy.run/kalendarz/${slug}`
  const datePublished = event.created_at ? String(event.created_at).slice(0, 10) : startDate
  const dateModified = event.updated_at ? String(event.updated_at).slice(0, 10) : datePublished

  const sportsEvent = {
    '@type': 'SportsEvent',
    name: event.name,
    description: buildSchemaDescription(event) || undefined,
    startDate,
    endDate: startDate,
    eventStatus: event.status === 'cancelled'
      ? 'https://schema.org/EventCancelled'
      : 'https://schema.org/EventScheduled',
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    image: `${eventUrl}/og.png`,
    url: eventUrl,
    inLanguage: 'pl-PL',
    datePublished,
    dateModified,
    organizer: {
      '@type': 'Organization',
      name: 'Organizator',
      url: event.website || event.registration_url || eventUrl,
    },
  }

  if (event.location) {
    sportsEvent.location = {
      '@type': 'Place',
      name: event.location,
    }
    if (event.lat && event.lng) {
      sportsEvent.location.geo = {
        '@type': 'GeoCoordinates',
        latitude: Number(event.lat),
        longitude: Number(event.lng),
      }
    }
    if (event.voivodeship) {
      sportsEvent.location.address = {
        '@type': 'PostalAddress',
        addressRegion: event.voivodeship,
        addressCountry: 'PL',
      }
    }
  }

  if (event.price_from != null) {
    sportsEvent.offers = {
      '@type': 'AggregateOffer',
      lowPrice: event.price_from,
      highPrice: event.price_to != null ? event.price_to : event.price_from,
      priceCurrency: 'PLN',
      availability: 'https://schema.org/InStock',
      validFrom: new Date().toISOString().slice(0, 10),
      url: event.registration_url || eventUrl,
    }
    if (event.registration_deadline) {
      sportsEvent.offers.priceValidUntil = event.registration_deadline.slice(0, 10)
    } else if (startDate) {
      sportsEvent.offers.priceValidUntil = startDate
    }
  }

  const breadcrumb = {
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Leszy.run', item: 'https://www.leszy.run' },
      { '@type': 'ListItem', position: 2, name: 'Kalendarz', item: 'https://www.leszy.run/kalendarz' },
      { '@type': 'ListItem', position: 3, name: event.name, item: eventUrl },
    ],
  }

  return { '@context': 'https://schema.org', '@graph': [sportsEvent, breadcrumb] }
}

export default function EventPage() {
  const { slug } = useParams()
  const { isDark } = useTheme()
  const [event, setEvent] = useState(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [showReport, setShowReport] = useState(false)
  const beta = useBeta() // dark-launch: hide report button when off

  // Load event data — reset when slug changes
  useEffect(() => {
    async function loadEvent() {
      setEvent(null)
      setLoading(true)
      setNotFound(false)

      // 1. Try embedded JSON (direct URL hit with static HTML)
      const embedded = document.getElementById('event-data')
      if (embedded) {
        try {
          const data = JSON.parse(embedded.textContent)
          // Remove the script tag so SPA navigation to other events
          // doesn't reuse this stale embedded data
          embedded.remove()
          if (data && slugify(data.name, data.date) === slug) {
            setEvent(data)
            setLoading(false)
            return
          }
        } catch {
          // Fall through to Supabase query
        }
      }

      // 2. SPA navigation fallback: extract date from slug, query Supabase
      const date = extractDateFromSlug(slug)
      if (!date) {
        setNotFound(true)
        setLoading(false)
        return
      }

      const { data, error } = await supabase
        .from('calendar_events')
        .select('*')
        .in('status', ['active', 'cancelled'])
        .eq('date', date)

      if (error || !data?.length) {
        setNotFound(true)
        setLoading(false)
        return
      }

      // Match by slug
      const match = data.find((ev) => slugify(ev.name, ev.date) === slug)
      if (match) {
        setEvent(match)
      } else {
        // Try with ID suffix variants
        const matchWithId = data.find((ev) => slugify(ev.name, ev.date, ev.id) === slug)
        if (matchWithId) {
          setEvent(matchWithId)
        } else {
          setNotFound(true)
        }
      }

      setLoading(false)
    }

    loadEvent()
  }, [slug])

  // SEO
  const seoSlug = slug || ''
  const seoTitle = event
    ? `${event.name} — ${formatDatePolish(event.date)} — ${event.location || ''}`
    : 'Wydarzenie'
  const seoDescription = event
    ? [
        formatDatePolish(event.date),
        event.location,
        event.distances?.length ? event.distances.join(', ') : null,
        event.event_type?.length ? event.event_type.map(t => TYPE_LABELS[t] || t).join(', ') : null,
      ].filter(Boolean).join(' \u00b7 ')
    : ''

  useSeo({
    title: seoTitle,
    description: seoDescription,
    path: `/kalendarz/${seoSlug}`,
    image: `https://www.leszy.run/kalendarz/${seoSlug}/og.png`,
    jsonLd: event ? buildJsonLd(event, seoSlug) : undefined,
    // Stale/renamed event slugs orphan the old URL: no static file → SPA fallback → this
    // not-found state at HTTP 200 with a self-canonical reads as an indexable soft-404 and
    // Google clusters them as "duplicate, different canonical". noindex stops that bleed.
    noindex: notFound,
  })

  // Loading state
  if (loading) {
    return (
      <>
        <Navbar />
        <main className="min-h-screen flex items-center justify-center">
          <div className="font-mono text-sm text-apex-muted animate-pulse">Ładowanie...</div>
        </main>
      </>
    )
  }

  // Not found state
  if (notFound || !event) {
    return (
      <>
        <Navbar />
        <main className="min-h-screen flex flex-col items-center justify-center px-6">
          <h1 className="font-display font-extrabold text-2xl tracking-widest uppercase text-apex-text-bright mb-4">
            Nie znaleziono wydarzenia
          </h1>
          <p className="text-apex-muted mb-6">Wydarzenie mogło zostać usunięte lub link jest nieprawidłowy.</p>
          <Link
            to="/kalendarz"
            className="font-display font-bold text-[11px] tracking-widest uppercase px-5 py-2.5 border-2 border-apex-yellow text-apex-yellow no-underline hover:bg-apex-yellow hover:text-apex-ink transition-all"
          >
            Wróć do kalendarza
          </Link>
        </main>
      </>
    )
  }

  // Computed values
  const types = (event.event_type || []).filter(t => t !== 'bieg')
  const distances = event.distances || []
  const days = daysUntil(event.date)
  const dateFormatted = new Date(event.date).toLocaleDateString('pl-PL', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  })

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

        <div className="pt-20 md:pt-24 pb-16 px-6 max-w-[900px] mx-auto relative z-10">
          {/* Breadcrumb */}
          <nav className="mb-6" aria-label="Nawigacja okruszkowa">
            <ol className="flex items-center gap-2 font-mono text-[11px] tracking-wide text-apex-muted list-none p-0 m-0">
              <li>
                <Link to="/kalendarz" className="hover:text-apex-yellow transition-colors no-underline text-apex-muted">
                  Kalendarz
                </Link>
              </li>
              <li aria-hidden="true">/</li>
              <li className="text-apex-text-bright truncate max-w-[300px]">{event.name}</li>
            </ol>
          </nav>

          {/* Promoted leszy.run events */}
          <LeszyrunBanner className="mb-8" />

          {/* Date badge + countdown */}
          <div className="flex items-center gap-3 mb-4">
            <span className="font-mono text-[13px] font-semibold text-apex-yellow">
              {dateFormatted}
            </span>
            {event.status === 'cancelled' && (
              <span data-testid="cancelled-badge" className="font-mono text-[11px] font-semibold px-2 py-0.5 border border-apex-red/30 text-apex-red bg-apex-red/10 uppercase">
                Odwołany
              </span>
            )}
            {event.status !== 'cancelled' && days != null && (
              <span className="font-mono text-[11px] font-semibold px-2 py-0.5 border border-apex-cyan/30 text-apex-cyan">
                {days === 0 ? 'Dziś!' : days === 1 ? 'Jutro!' : `za ${days} dni`}
              </span>
            )}
            <StarButton eventId={event.id} />
          </div>

          {/* Title */}
          <h1 className="font-display font-extrabold text-[30px] md:text-[42px] tracking-[3px] uppercase text-apex-text-bright leading-tight mb-3">
            {event.name}
          </h1>

          {/* Location */}
          {event.location && (
            <div className="flex items-center gap-2 text-apex-muted mb-5">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0">
                <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                <circle cx="12" cy="10" r="3" />
              </svg>
              <span className="font-sans text-base">
                {event.location}
                {event.voivodeship && <span className="text-apex-dim">, {event.voivodeship}</span>}
              </span>
            </div>
          )}

          {/* Tags row */}
          {(types.length > 0 || distances.length > 0) && (
            <div className="flex flex-wrap gap-1.5 mb-6">
              {types.map(t => (
                <span key={t} className={getTypeTagClass(t)}>
                  {TYPE_LABELS[t] || t}
                </span>
              ))}
              {distances.map((d, i) => (
                <span key={i} className={distTagClass}>{d}</span>
              ))}
            </div>
          )}

          {/* CTA buttons */}
          <div className="flex flex-wrap gap-3 mb-8">
            {event.status !== 'cancelled' && event.registration_url && (
              <a
                href={event.registration_url}
                target="_blank"
                rel="noopener noreferrer"
                className="font-display font-bold text-[12px] tracking-widest uppercase px-6 py-2.5 bg-apex-yellow text-apex-ink hover:bg-apex-yellow-bright transition-all no-underline"
              >
                Zapisy
              </a>
            )}
            {event.website && (
              <a
                href={event.website}
                target="_blank"
                rel="noopener noreferrer"
                className="font-display font-bold text-[12px] tracking-widest uppercase px-6 py-2.5 border-2 border-apex-border text-apex-text-bright hover:border-apex-text hover:text-apex-yellow transition-all no-underline"
              >
                Strona wydarzenia
              </a>
            )}
            {event.regulamin_url && (
              <a
                href={event.regulamin_url}
                target="_blank"
                rel="noopener noreferrer"
                className="font-display font-bold text-[12px] tracking-widest uppercase px-6 py-2.5 border-2 border-apex-border text-apex-text-bright hover:border-apex-text hover:text-apex-yellow transition-all no-underline"
              >
                Regulamin
              </a>
            )}
          </div>

          {/* Info grid */}
          <EventInfoGrid event={event} />

          {/* Map (lazy loaded) */}
          <div className="mt-8">
            <Suspense fallback={<div className="border border-apex-border bg-apex-surface" style={{ height: 220 }} />}>
              <EventMap
                lat={event.lat}
                lng={event.lng}
                name={event.name}
                location={event.location}
              />
            </Suspense>
          </div>

          {/* Report button */}
          {beta && (
            <div className="flex justify-end mt-6">
              <button
                data-testid="report-event-btn"
                onClick={() => setShowReport(true)}
                className="font-display font-bold text-[10px] tracking-widest uppercase px-4 py-2 border border-apex-border text-apex-muted hover:border-apex-text hover:text-apex-text-bright transition-all"
              >
                Zgłoś poprawkę
              </button>
            </div>
          )}

          {/* Nearby events */}
          <NearbyEvents event={event} />
        </div>
      </main>

      {showReport && <ReportEventModal event={event} onClose={() => setShowReport(false)} />}
    </>
  )
}
