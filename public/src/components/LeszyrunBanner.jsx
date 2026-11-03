import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'

// Events with less than this many days left are considered registration-closed
const REG_CLOSED_DAYS = 5

// Per-event highlight chips, keyed by event slug. Surfaces distances and
// disciplines that the event NAME hides — e.g. "Wilczy Półmaraton" reads like a
// single 21 km road race, so Nordic Walking (11 km), Canicross (21 km) and the
// fact that it's a trail run are invisible to the people who'd sign up for them.
// `terrain` renders as a leading label; `options` render as chips.
const EVENT_HIGHLIGHTS = {
  'wilczy-pmaraton': {
    terrain: 'TRAIL',
    options: ['Bieg 21 km', 'Canicross 21 km', 'Nordic Walking 11 km'],
  },
}

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
      .select('id, name, date, location, slug, event_url')
      .eq('visibility', 'public')
      .gte('date', cutoffStr)
      .order('date', { ascending: true })
      .then(async ({ data }) => {
        if (!data?.length) return
        // Type and distances live on the published calendar row, not on `events`.
        const { data: rows } = await supabase
          .from('calendar_events')
          .select('leszyrun_event_id, event_type, distances')
          .in('leszyrun_event_id', data.map(ev => ev.id))
        const byId = Object.fromEntries((rows || []).map(r => [r.leszyrun_event_id, r]))
        setEvents(data.map(ev => ({
          ...ev,
          charity: byId[ev.id]?.event_type?.includes('charytatywny') ?? false,
          distances: byId[ev.id]?.distances || [],
        })))
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
        const highlights = EVENT_HIGHLIGHTS[event.slug]

        const accent = event.charity
          ? 'border-l-apex-rose bg-apex-rose/[0.07] border-apex-rose/35 hover:bg-apex-rose/[0.12] hover:border-apex-rose/50'
          : 'border-l-apex-yellow bg-apex-yellow/[0.10] border-apex-yellow/35 hover:bg-apex-yellow/[0.16] hover:border-apex-yellow/50'
        const chips = highlights?.options || event.distances

        return (
          <a key={event.slug} href={event.event_url || `/events/${event.slug}`} target={event.event_url ? '_blank' : undefined} rel={event.event_url ? 'noopener' : undefined}
            className={`block border-l-[6px] border ${accent} px-5 py-5 md:px-6 md:py-6 transition-all no-underline text-inherit group relative overflow-hidden`}>
            {/* Diagonal accent stripe */}
            <div className={`absolute top-0 right-0 w-40 h-full ${event.charity ? 'bg-apex-rose/[0.06]' : 'bg-apex-yellow/[0.06]'} -skew-x-12 translate-x-8`} />

            <div className="relative flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 mb-2">
                  <span className="font-mono text-[10px] font-bold tracking-widest px-2.5 py-1 bg-apex-yellow text-apex-bg flex-shrink-0">
                    POLECAMY
                  </span>
                  {event.charity && (
                    <span className="font-mono text-[10px] font-bold tracking-widest px-2.5 py-1 bg-apex-rose/15 text-apex-rose border border-apex-rose/40 flex-shrink-0 whitespace-nowrap">
                      ♥ CHARYTATYWNY
                    </span>
                  )}
                  {countdown && <span className="font-mono text-[12px] font-semibold text-apex-yellow whitespace-nowrap">{countdown}</span>}
                </div>
                <div className="font-display font-extrabold text-xl md:text-2xl tracking-wider uppercase text-apex-text-bright group-hover:text-apex-yellow transition-colors md:truncate">
                  {event.name}
                </div>
                <div className="flex items-center gap-2 mt-1">
                  <span className="font-mono text-[12px] font-semibold text-apex-yellow">{dateFormatted}</span>
                  {event.location && <span className="text-[13px] text-apex-muted">· {event.location}</span>}
                </div>
                {(highlights?.terrain || chips.length > 0) && (
                  <div className="flex flex-wrap items-center gap-1.5 mt-2.5">
                    {highlights?.terrain && (
                      <span className="font-mono text-[10px] font-semibold tracking-widest px-2 py-0.5 bg-apex-cyan/15 text-apex-cyan border border-apex-cyan/30 uppercase">
                        {highlights.terrain}
                      </span>
                    )}
                    {chips.map(option => (
                      <span key={option} className="font-mono text-[11px] font-medium px-2 py-0.5 bg-apex-yellow/[0.06] text-apex-text-bright border border-apex-yellow/25">
                        {option}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex-shrink-0 hidden md:block">
                <span className="font-display font-bold text-[13px] tracking-widest uppercase px-6 py-3 bg-apex-yellow text-apex-bg border-2 border-apex-yellow group-hover:bg-transparent group-hover:text-apex-yellow transition-all whitespace-nowrap">
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
