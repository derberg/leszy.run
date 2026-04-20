import { useState, useEffect, lazy, Suspense } from 'react'
import { useParams, Link } from 'react-router-dom'
import { supabase } from '../lib/supabase.js'
import { slugify, extractDateFromSlug } from '../lib/slugify.js'
import useSeo from '../hooks/useSeo.js'
import useTheme from '../hooks/useTheme.js'
import Navbar from '../components/Navbar.jsx'
import Footer from '../components/Footer.jsx'
import EventInfoGrid from '../components/EventInfoGrid.jsx'
import NearbyEvents from '../components/NearbyEvents.jsx'
import ReportEventModal from '../components/ReportEventModal.jsx'

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

/**
 * Build JSON-LD SportsEvent schema.
 * @param {Object} event
 * @param {string} slug
 * @returns {Object}
 */
function buildJsonLd(event, slug) {
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'SportsEvent',
    name: event.name,
    startDate: event.date,
    url: `https://leszy.run/kalendarz/${slug}`,
  }

  if (event.location) {
    ld.location = {
      '@type': 'Place',
      name: event.location,
    }
    if (event.lat && event.lng) {
      ld.location.geo = {
        '@type': 'GeoCoordinates',
        latitude: Number(event.lat),
        longitude: Number(event.lng),
      }
    }
    if (event.voivodeship) {
      ld.location.address = {
        '@type': 'PostalAddress',
        addressRegion: event.voivodeship,
        addressCountry: 'PL',
      }
    }
  }

  if (event.price_from != null) {
    ld.offers = {
      '@type': 'Offer',
      priceCurrency: 'PLN',
      price: event.price_from,
      availability: 'https://schema.org/InStock',
      validFrom: new Date().toISOString().slice(0, 10),
    }
    if (event.registration_deadline) {
      ld.offers.priceValidUntil = event.registration_deadline.slice(0, 10)
    } else if (event.date) {
      ld.offers.priceValidUntil = event.date.slice(0, 10)
    }
    if (event.registration_url) {
      ld.offers.url = event.registration_url
    }
  }

  return ld
}

export default function EventPage() {
  const { slug } = useParams()
  const { isDark } = useTheme()
  const [event, setEvent] = useState(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [showReport, setShowReport] = useState(false)

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
        .eq('status', 'active')
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
    image: `https://leszy.run/kalendarz/${seoSlug}/og.png`,
    jsonLd: event ? buildJsonLd(event, seoSlug) : undefined,
  })

  // Loading state
  if (loading) {
    return (
      <>
        <Navbar />
        <main className="min-h-screen flex items-center justify-center">
          <div className="font-mono text-sm text-apex-muted animate-pulse">Ładowanie...</div>
        </main>
        <Footer />
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
        <Footer />
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

          {/* Date badge + countdown */}
          <div className="flex items-center gap-3 mb-4">
            <span className="font-mono text-[13px] font-semibold text-apex-yellow">
              {dateFormatted}
            </span>
            {days != null && (
              <span className="font-mono text-[11px] font-semibold px-2 py-0.5 border border-apex-cyan/30 text-apex-cyan">
                {days === 0 ? 'Dziś!' : days === 1 ? 'Jutro!' : `za ${days} dni`}
              </span>
            )}
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
            {event.registration_url && (
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
          <div className="flex justify-end mt-6">
            <button
              onClick={() => setShowReport(true)}
              className="font-display font-bold text-[10px] tracking-widest uppercase px-4 py-2 border border-apex-border text-apex-muted hover:border-apex-text hover:text-apex-text-bright transition-all"
            >
              Zgłoś poprawkę
            </button>
          </div>

          {/* Nearby events */}
          <NearbyEvents event={event} />
        </div>
      </main>

      {showReport && <ReportEventModal event={event} onClose={() => setShowReport(false)} />}
      <Footer />
    </>
  )
}
