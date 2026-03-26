import { Link } from 'react-router-dom'
import { useEvent } from '../hooks/useEvent.js'
import useSeo from '../hooks/useSeo.js'

export default function EventHub() {
  const { event, loading, error } = useEvent()

  useSeo({
    title: event?.name || 'Wydarzenie',
    description: event ? `${event.name}${event.location ? ` — ${event.location}` : ''}${event.date ? ` — ${event.date}` : ''}. Wyniki na żywo, lista startowa i informacje o wydarzeniu.` : undefined,
    jsonLd: event ? {
      '@context': 'https://schema.org',
      '@type': 'SportsEvent',
      name: event.name,
      startDate: event.date,
      location: event.location ? { '@type': 'Place', name: event.location, address: { '@type': 'PostalAddress', addressCountry: 'PL' } } : undefined,
      url: `https://leszy.run/events/${event.slug}`,
      organizer: { '@id': 'https://leszy.run/#organization' },
      eventStatus: 'https://schema.org/EventScheduled',
      eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    } : undefined,
  })

  if (loading) return <div className="flex items-center justify-center min-h-screen text-apex-muted">Ladowanie...</div>
  if (error) return <div className="flex items-center justify-center min-h-screen text-apex-red">{error}</div>

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
