import { useState, useEffect, useRef } from 'react'
import { Link, useParams, useNavigate, useLocation } from 'react-router-dom'
import { supabase } from '../lib/supabase.js'
import { useEvent } from '../hooks/useEvent.js'
import CategorySection from './CategorySection.jsx'
import LiveTracking from './LiveTracking.jsx'

export default function Results() {
  const { slug, categoryId } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const { event, loading: eventLoading, error: eventError } = useEvent()
  const [categories, setCategories] = useState([])
  const [catLoading, setCatLoading] = useState(true)
  const activeTabRef = useRef(null)

  const isLiveView = location.pathname.endsWith('/live')
  const activeCategoryId = isLiveView ? null : (categoryId || null)
  const activeView = isLiveView ? 'live' : (activeCategoryId ? 'category' : 'all')

  useEffect(() => {
    if (!event) return
    supabase.from('categories').select('id, name, distance_meters').eq('event_id', event.id)
      .then(({ data }) => {
        setCategories(data || [])
        setCatLoading(false)
      })
  }, [event])

  // Update document title
  useEffect(() => {
    if (!event) return
    if (isLiveView) {
      document.title = `Na Trasie — ${event.name}`
    } else if (categoryId) {
      const cat = categories.find(c => c.id === categoryId)
      document.title = cat ? `${cat.name} — ${event.name}` : event.name
    } else {
      document.title = event.name
    }
  }, [event, categories, categoryId, isLiveView])

  // Scroll active tab into view
  useEffect(() => {
    if (activeTabRef.current) {
      activeTabRef.current.scrollIntoView({ inline: 'nearest', behavior: 'smooth' })
    }
  }, [categoryId, categories, isLiveView])

  if (eventLoading) return <div className="flex items-center justify-center min-h-screen text-apex-muted">Ladowanie...</div>
  if (eventError) return <div className="flex items-center justify-center min-h-screen text-apex-red">{eventError}</div>

  const loading = catLoading

  return (
    <div className="min-h-screen bg-black text-apex-text-bright relative overflow-hidden">
      {/* Logo watermark */}
      <div className="fixed inset-0 opacity-[0.03] pointer-events-none" style={{
        backgroundImage: `url('/logo.svg')`,
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'center center',
        backgroundSize: '100vh',
        filter: 'invert(1) sepia(1) saturate(5) hue-rotate(30deg)',
      }} />
      {/* Noise overlay */}
      <div className="absolute inset-0 opacity-5 pointer-events-none" style={{
        backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E")`
      }} />

      <div className="relative z-10 max-w-3xl mx-auto px-6 py-10">
        <Link to={`/${slug}`} className="text-xs text-apex-muted uppercase tracking-wider hover:text-apex-text mb-6 inline-block">&larr; Powrot</Link>

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
            <>
              {[80, 100, 70].map((w, i) => (
                <div key={i} className="shrink-0 px-5 py-3" style={{ width: w }}>
                  <div className="h-3 bg-apex-surface-2 animate-pulse" style={{ width: w - 20 }} />
                </div>
              ))}
            </>
          ) : (
            <>
              <button
                ref={activeView === 'all' ? activeTabRef : null}
                onClick={() => navigate(`/${slug}/results`)}
                className={`shrink-0 px-5 py-3 text-xs font-bold tracking-widest uppercase transition-colors ${
                  activeView === 'all'
                    ? 'bg-apex-yellow-bright text-apex-bg'
                    : 'text-apex-muted hover:text-apex-text'
                }`}
              >
                Wszystkie
              </button>
              <button
                ref={activeView === 'live' ? activeTabRef : null}
                onClick={() => navigate(`/${slug}/results/live`)}
                className={`shrink-0 px-5 py-3 text-xs font-bold tracking-widest uppercase transition-colors border-l border-apex-border ${
                  activeView === 'live'
                    ? 'bg-apex-cyan text-apex-bg'
                    : 'text-apex-muted hover:text-apex-text'
                }`}
              >
                {activeView !== 'live' && <span className="inline-block w-1.5 h-1.5 rounded-full bg-apex-cyan animate-pulse mr-1.5 align-middle" />}
                Na Trasie
              </button>
              {categories.map(cat => (
                <button
                  key={cat.id}
                  ref={activeCategoryId === cat.id ? activeTabRef : null}
                  onClick={() => navigate(`/${slug}/results/${cat.id}`)}
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
        {!loading && activeView === 'live' && (
          <LiveTracking eventId={event.id} categories={categories} />
        )}

        {!loading && activeView === 'category' && (
          <CategorySection key={activeCategoryId} eventId={event.id} categoryId={activeCategoryId} />
        )}

        {!loading && activeView === 'all' && (
          categories.length === 0 ? (
            <div className="text-center py-16 text-apex-muted">
              <div className="font-display text-3xl uppercase tracking-widest mb-2">Brak kategorii</div>
            </div>
          ) : (
            <div className="space-y-20">
              {categories.map(cat => (
                <div key={cat.id} className="border-t border-apex-border pt-10 first:border-t-0 first:pt-0">
                  <CategorySection key={cat.id} eventId={event.id} categoryId={cat.id} />
                </div>
              ))}
            </div>
          )
        )}
      </div>
    </div>
  )
}
