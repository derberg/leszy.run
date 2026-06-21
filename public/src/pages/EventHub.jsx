import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useEvent } from '../hooks/useEvent.js'
import useSeo from '../hooks/useSeo.js'
import Navbar from '../components/Navbar.jsx'
import Footer from '../components/Footer.jsx'

// Read the static page's embedded stats (baked by generate-leszyrun-event-pages.js).
// Returns the manifest entry ({ ...event, stats }) or null on a plain SPA hit.
function readEmbeddedEvent() {
  if (typeof document === 'undefined') return null
  const el = document.getElementById('event-data')
  if (!el) return null
  try {
    const data = JSON.parse(el.textContent)
    return data && data.stats ? data : null
  } catch {
    return null
  }
}

function formatDuration(ms) {
  if (ms == null) return ''
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = n => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

function PastEventView({ event }) {
  const st = event.stats || {}
  const bestTimes = Array.isArray(st.bestTimes) ? st.bestTimes : []
  return (
    <div className="min-h-[70vh] bg-apex-bg text-apex-text-bright page-watermark">
      <div className="max-w-2xl mx-auto px-6 py-16 text-center">
        <p className="font-mono text-[11px] font-semibold tracking-widest uppercase text-apex-yellow-dim mb-3">Minione wydarzenie</p>
        <h1 className="font-display text-5xl uppercase tracking-widest mb-2">{event.name}</h1>
        {event.date && <p className="text-apex-muted text-sm mb-10">{event.date}{event.location ? ` · ${event.location}` : ''}</p>}

        <div className="inline-flex flex-col items-center border border-apex-border bg-apex-surface px-10 py-5 mb-10">
          <span className="font-mono text-4xl font-bold text-apex-yellow">{st.participants ?? 0}</span>
          <span className="font-mono text-[10px] tracking-widest uppercase text-apex-muted mt-1">Zapisanych</span>
        </div>

        {bestTimes.length > 0 && (
          <div className="mb-10 text-left">
            <p className="font-mono text-[11px] font-semibold tracking-widest uppercase text-apex-yellow-dim mb-3 text-center">Najlepsze czasy</p>
            <div className="border border-apex-border">
              <div className="grid grid-cols-[1fr_5.5rem_5.5rem] gap-x-3 px-4 py-2 bg-apex-surface-2 border-b border-apex-border font-mono text-[10px] tracking-widest uppercase text-apex-muted">
                <span>Kategoria</span>
                <span className="text-right">Kobiety</span>
                <span className="text-right">Mężczyźni</span>
              </div>
              {bestTimes.map(b => (
                <div key={b.category} className="grid grid-cols-[1fr_5.5rem_5.5rem] gap-x-3 px-4 py-2.5 border-b border-apex-border last:border-b-0 items-center">
                  <span className="font-display font-bold text-sm tracking-wide uppercase text-apex-text-bright">{b.category}</span>
                  <span className="text-right font-mono text-sm text-apex-text">{b.k_ms != null ? formatDuration(b.k_ms) : '—'}</span>
                  <span className="text-right font-mono text-sm text-apex-text">{b.m_ms != null ? formatDuration(b.m_ms) : '—'}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div>
          <Link to={`/events/${event.slug}/results`} className="inline-block border-2 border-apex-yellow bg-apex-yellow text-apex-ink px-10 py-4 font-display font-bold uppercase tracking-widest hover:shadow-[0_0_20px_rgba(187,221,0,0.3)] transition-all">
            Zobacz wyniki →
          </Link>
        </div>
      </div>
    </div>
  )
}

function UpcomingEventView({ event }) {
  return (
    <div className="min-h-[70vh] bg-apex-bg text-apex-text-bright page-watermark">
      <div className="max-w-lg mx-auto px-6 py-16 text-center">
        <h1 className="font-display text-5xl uppercase tracking-widest mb-2">{event.name}</h1>
        {event.date && <p className="text-apex-muted text-sm mb-12">{event.date}{event.location ? ` · ${event.location}` : ''}</p>}
        <div className="space-y-3">
          <Link to={`/events/${event.slug}/results`} className="block border border-apex-border bg-apex-surface px-6 py-4 hover:bg-apex-surface-2 transition-colors text-apex-text-bright font-semibold uppercase tracking-wider">
            Wyniki na zywo
          </Link>
        </div>
      </div>
    </div>
  )
}

export default function EventHub() {
  const [embedded] = useState(() => readEmbeddedEvent())
  const { event: liveEvent, loading, error } = useEvent()

  // Past event with baked stats → render from embedded data (no live query needed).
  const event = embedded || liveEvent
  const isPast = !!(embedded && embedded.stats) ||
    (!!event && !!event.date && event.date.slice(0, 10) < new Date().toISOString().slice(0, 10) && !!event.stats)

  useSeo({
    title: event?.name || 'Wydarzenie',
    description: event ? `${event.name}${event.location ? ` — ${event.location}` : ''}${event.date ? ` — ${event.date}` : ''}.${isPast ? ' Wyniki i statystyki wydarzenia.' : ' Wyniki na żywo, lista startowa i informacje o wydarzeniu.'}` : undefined,
    jsonLd: event ? {
      '@context': 'https://schema.org',
      '@type': 'SportsEvent',
      name: event.name,
      startDate: event.date,
      location: event.location ? { '@type': 'Place', name: event.location, address: { '@type': 'PostalAddress', addressCountry: 'PL' } } : undefined,
      url: `https://www.leszy.run/events/${event.slug}`,
      organizer: { '@id': 'https://www.leszy.run/#organization' },
      eventStatus: isPast ? 'https://schema.org/EventCompleted' : 'https://schema.org/EventScheduled',
      eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    } : undefined,
  })

  let content
  if (embedded) content = <PastEventView event={embedded} />
  else if (loading) content = <div className="flex items-center justify-center min-h-[60vh] text-apex-muted">Ładowanie...</div>
  else if (error) content = <div className="flex items-center justify-center min-h-[60vh] text-apex-red">{error}</div>
  else content = <UpcomingEventView event={event} />

  return (
    <>
      <Navbar />
      <main id="main-content">{content}</main>
      <Footer />
    </>
  )
}
