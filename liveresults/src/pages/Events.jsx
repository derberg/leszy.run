import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase.js'

export default function EventsPage() {
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.from('events').select('id, name, date, location').order('date', { ascending: false })
      .then(({ data }) => { setEvents(data || []); setLoading(false) })
  }, [])

  return (
    <div className="max-w-2xl mx-auto px-6 py-10">
      <h1 className="font-display text-5xl uppercase tracking-widest text-apex-text-bright mb-8">Wyniki</h1>
      {loading && <div className="text-apex-muted">Ładowanie...</div>}
      <div className="space-y-2">
        {events.map(ev => (
          <Link key={ev.id} to={`/events/${ev.id}`}
            className="block border border-apex-border bg-apex-surface px-5 py-4 hover:bg-apex-surface-2 transition-colors">
            <div className="font-semibold text-apex-text-bright">{ev.name}</div>
            <div className="text-xs text-apex-muted mt-1">{ev.date} {ev.location && `· ${ev.location}`}</div>
          </Link>
        ))}
      </div>
    </div>
  )
}
