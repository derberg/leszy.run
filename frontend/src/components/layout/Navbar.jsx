import { Link, useLocation, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useWsEvent } from '../../lib/ws.js'
import { api } from '../../lib/api.js'
import { useState } from 'react'
import { cn } from '../../lib/utils.js'
import { Activity, Radio, Wifi } from 'lucide-react'

export default function Navbar() {
  const location = useLocation()
  const [syncStatus, setSyncStatus] = useState(null)
  const [syncErrorOpen, setSyncErrorOpen] = useState(false)

  useWsEvent('sync:status', (payload) => setSyncStatus(payload))

  const match = location.pathname.match(/^\/events\/([^/]+)/)
  const eventId = match?.[1]

  const { data: event } = useQuery({
    queryKey: ['events', eventId],
    queryFn: () => api.events.get(eventId),
    enabled: !!eventId,
  })

  const eventLinks = eventId && event
    ? [
        { to: `/events/${eventId}`, label: 'Zawody' },
        { to: `/events/${eventId}/race`, label: 'Sterowanie' },
        { to: `/events/${eventId}/results`, label: 'Wyniki' },
      ]
    : []

  return (
    <header className="relative border-b border-apex-border bg-apex-surface">
      {/* Yellow left accent stripe */}
      <div className="absolute left-0 top-0 bottom-0 w-1 bg-apex-yellow" />

      <div className="flex items-center justify-between pl-5 pr-6 py-0 h-14">
        {/* Left: logo + breadcrumb */}
        <div className="flex items-center gap-0">
          <Link
            to="/events"
            className="flex items-center gap-3 hover:opacity-80 transition-opacity group"
          >
            <span className="font-display text-lg font-black tracking-[0.15em] text-apex-text-bright hidden sm:block">
              LESZYRUN
            </span>
          </Link>

          {event && (
            <div className="flex items-center ml-3 gap-2">
              <span className="text-apex-dim text-base font-mono">/</span>
              <span className="text-apex-muted text-sm font-mono tracking-wider truncate max-w-48 uppercase">
                {event.name}
              </span>
            </div>
          )}
        </div>

        {/* Right: nav links + sync */}
        <div className="flex items-center gap-1">
          {eventLinks.map(link => {
            const isActive = location.pathname === link.to
            return (
              <Link
                key={link.to}
                to={link.to}
                className={cn(
                  'px-3 py-1 text-xs font-bold uppercase tracking-widest transition-all duration-150 border',
                  isActive
                    ? 'border-apex-yellow text-black bg-apex-yellow'
                    : 'border-transparent text-apex-muted hover:text-apex-text hover:border-apex-border-bright',
                )}
              >
                {link.label}
              </Link>
            )
          })}

          {!eventId && (
            <Link
              to="/events"
              className={cn(
                'px-3 py-1 text-xs font-bold uppercase tracking-widest transition-all duration-150 border',
                location.pathname === '/events'
                  ? 'border-apex-yellow text-black bg-apex-yellow'
                  : 'border-transparent text-apex-muted hover:text-apex-text hover:border-apex-border-bright',
              )}
            >
              Zawody
            </Link>
          )}

          <Link
            to="/reader"
            className={cn(
              'px-3 py-1 text-xs font-bold uppercase tracking-widest transition-all duration-150 border',
              location.pathname === '/reader'
                ? 'border-apex-yellow text-black bg-apex-yellow'
                : 'border-transparent text-apex-muted hover:text-apex-text hover:border-apex-border-bright',
            )}
          >
            Czytnik
          </Link>

          {syncStatus && (syncStatus.status === 'online' || syncStatus.status === 'error' || syncStatus.pendingCount > 0) && (
            <div className="relative ml-2">
              <div
                className={cn(
                  'flex items-center gap-1.5 text-xs px-2 py-1 border font-mono tracking-wider',
                  syncStatus.status === 'online'
                    ? 'border-apex-cyan text-apex-cyan'
                    : syncStatus.status === 'error'
                      ? 'border-red-500 text-red-400'
                      : 'border-amber-500 text-amber-400',
                )}
              >
                {syncStatus.status === 'online'
                  ? <Wifi size={10} className="glow-pulse" />
                  : <Activity size={10} />
                }
                {syncStatus.status === 'online' ? 'SYNC' : syncStatus.status === 'error' ? 'SYNC ERR' : `${syncStatus.pendingCount} PKT`}
                {syncStatus.status === 'error' && syncStatus.errors?.length > 0 && (
                  <button
                    onClick={() => setSyncErrorOpen(o => !o)}
                    className="ml-1 underline text-red-400 text-[10px]"
                  >details</button>
                )}
              </div>
              {syncStatus.status === 'error' && syncErrorOpen && syncStatus.errors?.length > 0 && (
                <div className="absolute top-full right-0 mt-1 bg-apex-surface border border-red-500 text-red-300 text-[10px] p-2 whitespace-pre-wrap max-w-sm z-50 select-text">
                  {syncStatus.errors.join('\n')}
                  {'\n\n'}Check backend console for details.
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
