import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useEvent } from '../hooks/useEvent.js'
import useSeo from '../hooks/useSeo.js'

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

function Stat({ value, label }) {
  return (
    <div className="flex flex-col items-center border border-apex-border bg-apex-surface px-4 py-5">
      <span className="font-mono text-3xl md:text-4xl font-bold text-apex-yellow">{value}</span>
      <span className="font-mono text-[10px] tracking-widest uppercase text-apex-muted mt-1">{label}</span>
    </div>
  )
}

function PastEventView({ event }) {
  const st = event.stats || {}
  return (
    <div className="min-h-screen bg-apex-bg text-apex-text-bright page-watermark">
      <div className="max-w-2xl mx-auto px-6 py-16 text-center">
        <p className="font-mono text-[11px] font-semibold tracking-widest uppercase text-apex-yellow-dim mb-3">Minione wydarzenie</p>
        <h1 className="font-display text-5xl uppercase tracking-widest mb-2">{event.name}</h1>
        {event.date && <p className="text-apex-muted text-sm mb-10">{event.date}{event.location ? ` · ${event.location}` : ''}</p>}

        <div className="grid grid-cols-2 md:grid-cols-4 gap-0.5 mb-4">
          <Stat value={st.participants ?? 0} label="Zapisanych" />
          <Stat value={st.finishers ?? 0} label="Na mecie" />
          <Stat value={Array.isArray(st.distances) ? st.distances.length : 0} label="Kategorii" />
          <Stat value={st.fastest_ms != null ? formatDuration(st.fastest_ms) : '—'} label="Najlepszy czas" />
        </div>

        {Array.isArray(st.distances) && st.distances.length > 0 && (
          <div className="flex flex-wrap gap-2 justify-center mb-3">
            {st.distances.map(d => (
              <span key={d} className="font-mono text-[10px] font-semibold tracking-wide px-2 py-0.5 border border-apex-yellow/30 text-apex-yellow-dim uppercase">{d}</span>
            ))}
          </div>
        )}
        {st.fastest_name && st.fastest_ms != null && (
          <p className="text-apex-muted text-xs mb-10">Najszybszy zawodnik: <span className="text-apex-text-bright">{st.fastest_name}</span></p>
        )}

        <Link to={`/events/${event.slug}/results`} className="inline-block border-2 border-apex-yellow bg-apex-yellow text-apex-ink px-10 py-4 font-display font-bold uppercase tracking-widest hover:shadow-[0_0_20px_rgba(187,221,0,0.3)] transition-all">
          Zobacz wyniki →
        </Link>
      </div>
    </div>
  )
}

function UpcomingEventView({ event }) {
  return (
    <div className="min-h-screen bg-apex-bg text-apex-text-bright page-watermark">
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

  if (embedded) return <PastEventView event={embedded} />
  if (loading) return <div className="flex items-center justify-center min-h-screen text-apex-muted">Ładowanie...</div>
  if (error) return <div className="flex items-center justify-center min-h-screen text-apex-red">{error}</div>
  return <UpcomingEventView event={event} />
}
