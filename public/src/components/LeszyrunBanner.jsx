import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'

// Events with less than this many days left are considered registration-closed
const REG_CLOSED_DAYS = 5

/**
 * Promoted leszy.run events ("POLECAMY") banner.
 * Reads upcoming public events directly from the `events` table.
 * Shown on the kalendarz, area landing pages and individual event pages.
 *
 * @param {object} props
 * @param {string} [props.className] - layout classes for the outer wrapper. Defaults to a
 *   standalone full-width container (kalendarz). Pass e.g. "mb-6" when the parent already
 *   constrains width/padding (landing & event pages).
 */
export default function LeszyrunBanner({ className = 'max-w-[1200px] mx-auto px-6 mb-4' }) {
  const [events, setEvents] = useState([])
  const [countdowns, setCountdowns] = useState({})

  useEffect(() => {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() + REG_CLOSED_DAYS)
    const cutoffStr = cutoff.toISOString().split('T')[0]

    supabase
      .from('events')
      .select('name, date, location, slug, event_url')
      .eq('visibility', 'public')
      .gte('date', cutoffStr)
      .order('date', { ascending: true })
      .then(({ data }) => {
        if (data?.length) setEvents(data)
      })
  }, [])

  useEffect(() => {
    if (!events.length) return
    const update = () => {
      const now = new Date()
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      const map = {}
      for (const ev of events) {
        const target = new Date(ev.date + 'T00:00:00')
        const days = Math.ceil((target - today) / 86400000)
        map[ev.slug] = days === 0 ? 'Dziś!' : days === 1 ? 'Jutro!' : `za ${days} dni`
      }
      setCountdowns(map)
    }
    update()
    const id = setInterval(update, 60000)
    return () => clearInterval(id)
  }, [events])

  if (!events.length) return null

  return (
    <div className={`${className} flex flex-col gap-2`}>
      {events.map(event => {
        const dateFormatted = new Date(event.date).toLocaleDateString('pl-PL', { day: 'numeric', month: 'long', year: 'numeric' })
        const countdown = countdowns[event.slug]

        return (
          <a key={event.slug} href={event.event_url || `/events/${event.slug}`} target={event.event_url ? '_blank' : undefined} rel={event.event_url ? 'noopener' : undefined}
            className="block border-l-[4px] border-l-apex-yellow bg-apex-yellow/[0.06] border border-apex-yellow/20 px-5 py-5 hover:bg-apex-yellow/[0.10] hover:border-apex-yellow/30 transition-all no-underline text-inherit group relative overflow-hidden">
            {/* Diagonal accent stripe */}
            <div className="absolute top-0 right-0 w-32 h-full bg-apex-yellow/[0.04] -skew-x-12 translate-x-8" />

            <div className="relative flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-3 mb-1.5">
                  <span className="font-mono text-[10px] font-semibold tracking-widest px-2.5 py-1 bg-apex-yellow/15 text-apex-yellow border border-apex-yellow/30 flex-shrink-0">
                    POLECAMY
                  </span>
                  {countdown && <span className="font-mono text-[11px] font-semibold text-apex-yellow">{countdown}</span>}
                </div>
                <div className="font-display font-extrabold text-lg md:text-xl tracking-wider uppercase text-apex-text-bright group-hover:text-apex-yellow transition-colors truncate">
                  {event.name}
                </div>
                <div className="flex items-center gap-2 mt-1">
                  <span className="font-mono text-[12px] font-semibold text-apex-yellow">{dateFormatted}</span>
                  {event.location && <span className="text-[13px] text-apex-muted">· {event.location}</span>}
                </div>
              </div>
              <div className="flex-shrink-0 hidden md:block">
                <span className="font-display font-bold text-[12px] tracking-widest uppercase px-5 py-2.5 border-2 border-apex-yellow text-apex-yellow group-hover:bg-apex-yellow group-hover:text-apex-ink transition-all">
                  Szczegóły &rarr;
                </span>
              </div>
            </div>
          </a>
        )
      })}
    </div>
  )
}
