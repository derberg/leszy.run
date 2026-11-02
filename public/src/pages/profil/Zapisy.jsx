import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import useSeo from '../../hooks/useSeo.js'
import { callFunction } from '../../lib/auth.js'
import { formatPln } from '@registration/money.js'
import { sectionTitle } from './fields.jsx'

// „Moje zapisy”: the registration events the session bought an order for or is on an entry of,
// from my-registrations (upcoming first, then past).

const linkCls = 'whitespace-nowrap font-mono text-[11px] text-apex-yellow no-underline hover:text-apex-yellow-bright'

/** '2026-12-06' → '06.12.2026', no time zone involved. */
export function dayLabel(isoDate) {
  if (!isoDate) return null
  const [y, m, d] = isoDate.split('-')
  return `${d}.${m}.${y}`
}

function expiryLabel(iso) {
  if (!iso) return null
  return new Date(iso).toLocaleString('pl-PL', {
    timeZone: 'Europe/Warsaw', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}

function OrderBadge({ status, cancelled }) {
  if (cancelled) {
    return <span className="whitespace-nowrap px-1.5 py-0.5 text-[9px] font-mono border border-apex-border-bright text-apex-muted">ANULOWANE</span>
  }
  return status === 'paid'
    ? <span className="whitespace-nowrap px-1.5 py-0.5 text-[9px] font-mono border border-apex-green-dim text-apex-green bg-apex-green-bg">OPŁACONE</span>
    : <span className="whitespace-nowrap px-1.5 py-0.5 text-[9px] font-mono border border-apex-yellow-dim text-apex-yellow">DO ZAPŁATY</span>
}

function Skeleton() {
  return (
    <div className="space-y-3" aria-busy="true" data-testid="zapisy-loading">
      {[0, 1].map((i) => (
        <div key={i} className="border border-apex-border p-3 space-y-2">
          <div className="h-4 w-2/3 bg-apex-surface" />
          <div className="h-3 w-1/3 bg-apex-surface" />
          <div className="h-3 w-1/2 bg-apex-surface" />
        </div>
      ))}
    </div>
  )
}

function EventCard({ ev, today }) {
  const past = ev.eventDate != null && ev.eventDate < today
  // „Twój zapis” opens /zapisano, which lists every confirmed entry of the session's for the event.
  const confirmed = ev.people.filter((p) => p.status === 'confirmed').length
  return (
    <article data-testid="zapisy-event" className="border border-apex-border border-l-2 hover:border-l-apex-yellow p-3 transition-colors">
      <div className="flex items-baseline gap-3 min-w-0">
        <span className={`font-mono text-[11px] font-semibold flex-shrink-0 ${past ? 'text-apex-muted' : 'text-apex-yellow'}`}>
          {dayLabel(ev.eventDate)}{ev.firstStartTime && !past ? ` · ${ev.firstStartTime}` : ''}
        </span>
        <a href={`/events/${ev.slug}`} className="flex-1 min-w-0 truncate font-display font-bold text-sm uppercase text-apex-text-bright no-underline hover:text-apex-yellow">
          {ev.eventName}
        </a>
      </div>

      {ev.people.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {ev.people.map((p) => (
            <li key={p.id} className="flex items-center gap-2 text-xs min-w-0">
              <span className={`truncate ${p.mine ? 'text-apex-text-bright' : 'text-apex-text'}`}>
                {p.firstName} {p.lastName}
                {p.competition && <span className="text-apex-muted"> · {p.competition}</span>}
              </span>
              {p.status === 'pending_payment' && (
                <span className="whitespace-nowrap flex-shrink-0 font-mono text-[9px] text-apex-muted">czeka na wpłatę</span>
              )}
            </li>
          ))}
        </ul>
      )}

      {ev.orders.length > 0 && (
        <ul className="mt-2 space-y-1">
          {ev.orders.map((o) => (
            <li key={o.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <OrderBadge status={o.status} cancelled={o.cancelled} />
              <span className="font-mono text-[11px] text-apex-text-bright whitespace-nowrap">{formatPln(o.total)}</span>
              {o.refunded > 0 && (
                <span className="font-mono text-[10px] text-apex-muted whitespace-nowrap" data-testid="zapisy-refunded">zwrot {formatPln(o.refunded)}</span>
              )}
              {o.status === 'pending' && o.expiresAt && (
                <span className="font-mono text-[10px] text-apex-muted whitespace-nowrap">do {expiryLabel(o.expiresAt)}</span>
              )}
              <Link to={`/zamowienie/${o.id}`} className={`${linkCls} ml-auto`}>Zamówienie →</Link>
            </li>
          ))}
        </ul>
      )}

      {confirmed > 0 && (
        <div className="mt-2 flex justify-end">
          <Link to={`/events/${ev.slug}/zapisano`} className={linkCls}>{confirmed > 1 ? 'Twoje zapisy →' : 'Twój zapis →'}</Link>
        </div>
      )}
    </article>
  )
}

export default function Zapisy() {
  useSeo({ title: 'Moje zapisy — Leszy.run', path: '/profil/zapisy', noindex: true })
  const [state, setState] = useState({ status: 'loading', events: [] })

  useEffect(() => {
    let active = true
    callFunction('my-registrations', {})
      .then((r) => { if (active) setState({ status: 'ok', events: r.data ?? [] }) })
      .catch(() => { if (active) setState({ status: 'error', events: [] }) })
    return () => { active = false }
  }, [])

  // Warsaw calendar day, the same rule the function sorts by.
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Warsaw' })

  return (
    <section>
      <div className={sectionTitle}>Moje zapisy</div>
      {state.status === 'loading' && <Skeleton />}
      {state.status === 'error' && (
        <p className="font-sans text-sm text-apex-red py-4">Nie udało się wczytać zapisów. Odśwież stronę.</p>
      )}
      {state.status === 'ok' && state.events.length === 0 && (
        <p className="font-sans text-sm text-apex-muted py-4" data-testid="zapisy-empty">
          Nie masz jeszcze zapisów na zawody.{' '}
          <a href="/kalendarz" className="whitespace-nowrap text-apex-yellow underline">Kalendarz biegów</a>
        </p>
      )}
      {state.status === 'ok' && state.events.length > 0 && (
        <div className="space-y-3" data-testid="zapisy-list">
          {state.events.map((ev) => <EventCard key={ev.eventId} ev={ev} today={today} />)}
        </div>
      )}
    </section>
  )
}
