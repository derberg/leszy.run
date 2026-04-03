import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase.js'
import { slugify } from '../lib/slugify.js'

/**
 * "W okolicy tego weekendu" section.
 * Fetches events from the same voivodeship, date +/-3 days, limit 5, excluding current event.
 *
 * @param {{ event: Object }} props
 */
export default function NearbyEvents({ event }) {
  const [nearby, setNearby] = useState([])

  useEffect(() => {
    if (!event?.voivodeship || !event?.date) return

    const date = new Date(event.date)
    const from = new Date(date)
    from.setDate(from.getDate() - 3)
    const to = new Date(date)
    to.setDate(to.getDate() + 3)

    const fromStr = from.toISOString().slice(0, 10)
    const toStr = to.toISOString().slice(0, 10)

    supabase
      .from('calendar_events')
      .select('id, name, date, location, distances')
      .eq('status', 'active')
      .eq('voivodeship', event.voivodeship)
      .gte('date', fromStr)
      .lte('date', toStr)
      .neq('id', event.id)
      .order('date', { ascending: true })
      .limit(5)
      .then(({ data }) => {
        if (data?.length) setNearby(data)
      })
  }, [event?.id, event?.voivodeship, event?.date])

  if (nearby.length === 0) return null

  return (
    <section className="mt-10">
      <h2 className="font-display font-extrabold text-lg tracking-widest uppercase text-apex-text-bright mb-4">
        W okolicy tego weekendu
      </h2>
      <div className="border-t border-apex-border">
        {nearby.map((ev) => {
          const dateStr = new Date(ev.date).toLocaleDateString('pl-PL', {
            day: '2-digit', month: '2-digit',
          })
          const distLabel = ev.distances?.length
            ? ev.distances.join(' / ')
            : null
          const slug = slugify(ev.name, ev.date)

          return (
            <Link
              key={ev.id}
              to={`/kalendarz/${slug}`}
              className="grid grid-cols-[60px_1fr_auto] items-center gap-3 px-3 py-3 border-b border-apex-border hover:bg-apex-surface-2 transition-all no-underline"
            >
              <span className="font-mono text-[13px] font-semibold text-apex-yellow">
                {dateStr}
              </span>
              <div className="min-w-0">
                <div className="font-display font-bold text-sm tracking-wide uppercase text-apex-text-bright truncate">
                  {ev.name}
                </div>
                {ev.location && (
                  <div className="text-[12px] text-apex-muted truncate">{ev.location}</div>
                )}
              </div>
              {distLabel && (
                <span className="font-mono text-[10px] font-semibold text-apex-yellow-dim flex-shrink-0">
                  {distLabel}
                </span>
              )}
            </Link>
          )
        })}
      </div>
    </section>
  )
}
