import { useState, useEffect, useRef } from 'react'
import { Link, useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase.js'
import CategorySection from './CategorySection.jsx'

export default function EventPage() {
  const { eventId, categoryId } = useParams()
  const navigate = useNavigate()
  const [event, setEvent] = useState(null)
  const [categories, setCategories] = useState([])
  const [loading, setLoading] = useState(true)
  const activeTabRef = useRef(null)

  useEffect(() => {
    Promise.all([
      supabase.from('events').select('id, name, date, location').eq('id', eventId).single(),
      supabase.from('categories').select('id, name, distance_meters').eq('event_id', eventId),
    ]).then(([evRes, catRes]) => {
      if (evRes.data) setEvent(evRes.data)
      if (catRes.data) setCategories(catRes.data)
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [eventId])

  // Update document title
  useEffect(() => {
    if (!event) return
    if (categoryId) {
      const cat = categories.find(c => c.id === categoryId)
      document.title = cat ? `${cat.name} — ${event.name}` : event.name
    } else {
      document.title = event.name
    }
  }, [event, categories, categoryId])

  // Scroll active tab into view when categories load or URL changes
  useEffect(() => {
    if (activeTabRef.current) {
      activeTabRef.current.scrollIntoView({ inline: 'nearest', behavior: 'smooth' })
    }
  }, [categoryId, categories])

  const activeCategoryId = categoryId || null

  return (
    <div className="min-h-screen bg-apex-bg text-apex-text-bright relative overflow-hidden">
      <div className="absolute inset-0 opacity-5 pointer-events-none" style={{
        backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E")`
      }} />

      <div className="relative z-10 max-w-3xl mx-auto px-6 py-10">
        <Link to="/" className="text-xs text-apex-muted uppercase tracking-wider hover:text-apex-text mb-6 inline-block">← Wszystkie eventy</Link>

        <div className="text-center mb-8">
          <div className="font-display text-5xl tracking-widest uppercase text-white mb-1">
            {event?.name || '—'}
          </div>
          {event?.date && (
            <div className="text-apex-muted text-sm">{event.date}{event.location ? ` · ${event.location}` : ''}</div>
          )}
        </div>

        {/* Tab bar */}
        <div className="flex overflow-x-auto border-b border-apex-border mb-10 [&::-webkit-scrollbar]:hidden" style={{ scrollbarWidth: 'none' }}>
          {loading ? (
            // Skeleton tabs while categories are loading
            <>
              {[80, 100, 70].map((w, i) => (
                <div key={i} className="shrink-0 px-5 py-3" style={{ width: w }} >
                  <div className="h-3 bg-apex-surface-2 animate-pulse" style={{ width: w - 20 }} />
                </div>
              ))}
            </>
          ) : (
            <>
              <button
                ref={!activeCategoryId ? activeTabRef : null}
                onClick={() => navigate(`/events/${eventId}`)}
                className={`shrink-0 px-5 py-3 text-xs font-bold tracking-widest uppercase transition-colors ${
                  !activeCategoryId
                    ? 'bg-apex-yellow-bright text-apex-bg'
                    : 'text-apex-muted hover:text-apex-text'
                }`}
              >
                All
              </button>
              {categories.map(cat => (
                <button
                  key={cat.id}
                  ref={activeCategoryId === cat.id ? activeTabRef : null}
                  onClick={() => navigate(`/events/${eventId}/${cat.id}`)}
                  className={`shrink-0 px-5 py-3 text-xs font-bold tracking-widest uppercase transition-colors border-l border-apex-border ${
                    activeCategoryId === cat.id
                      ? 'bg-apex-yellow-bright text-apex-bg'
                      : 'text-apex-muted hover:text-apex-text'
                  }`}
                >
                  {cat.name}
                </button>
              ))}
            </>
          )}
        </div>

        {/* Content */}
        {!loading && activeCategoryId && (
          <CategorySection key={activeCategoryId} eventId={eventId} categoryId={activeCategoryId} />
        )}

        {!loading && !activeCategoryId && (
          categories.length === 0 ? (
            <div className="text-center py-16 text-apex-muted">
              <div className="font-display text-3xl uppercase tracking-widest mb-2">Brak kategorii</div>
            </div>
          ) : (
            <div className="space-y-20">
              {categories.map(cat => (
                <div key={cat.id} className="border-t border-apex-border pt-10 first:border-t-0 first:pt-0">
                  <CategorySection key={cat.id} eventId={eventId} categoryId={cat.id} />
                </div>
              ))}
            </div>
          )
        )}
      </div>
    </div>
  )
}
