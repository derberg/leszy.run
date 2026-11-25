import { useEffect, useState } from 'react'
import useSeo from '../../hooks/useSeo.js'
import { callFunction } from '../../lib/auth.js'
import { formatPln } from '@registration/money.js'
import { sectionTitle } from './fields.jsx'
import EntryActions from '../../components/registration/EntryActions.jsx'
import ActionMenu from '../../components/ActionMenu.jsx'
import { cardLinks, linksInPersonMenu } from '../../lib/zapisyCard.js'

// „Moje zapisy”: the registration events the session bought an order for or is on an entry of,
// from my-registrations (upcoming first, then past). At the end of each person's line a „⋯” menu of
// the runner's own actions („Zmień konkurencję”, „Popraw dane”, „Przekaż pakiet”), and under it an
// open surcharge's „Zapłać” (EntryActions), where the server offers them.
//
// The card's links, „Zamówienie” (each order's page) and „Twój zapis” (/zapisano, when an entry is
// confirmed), sit in a menu too: on a card with one person, in that person's „⋯” after the actions
// (behind a divider); on a card with several people (or none), in one „⋯” at the end of the card's
// header line, while each person's „⋯” keeps only their actions.

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

function EventCard({ ev, today, onChanged }) {
  const past = ev.eventDate != null && ev.eventDate < today
  const links = cardLinks(ev)
  const onePerson = linksInPersonMenu(ev)
  return (
    <article data-testid="zapisy-event" className="border border-apex-border border-l-2 hover:border-l-apex-yellow p-3 transition-colors">
      <div className="flex items-center gap-3 min-w-0">
        <span className={`font-mono text-[11px] font-semibold flex-shrink-0 ${past ? 'text-apex-muted' : 'text-apex-yellow'}`}>
          {dayLabel(ev.eventDate)}{ev.firstStartTime && !past ? ` · ${ev.firstStartTime}` : ''}
        </span>
        <a href={`/events/${ev.slug}`} className="flex-1 min-w-0 truncate font-display font-bold text-sm uppercase text-apex-text-bright no-underline hover:text-apex-yellow">
          {ev.eventName}
        </a>
        {!onePerson && (
          <ActionMenu label={`Zgłoszenie: ${ev.eventName}`} items={links} size="sm" itemWeight="font-medium" testId="zapisy-card-menu" />
        )}
      </div>

      {ev.people.length > 0 && (
        <ul className={`${onePerson ? 'mt-2' : 'mt-3'} space-y-1`}>
          {ev.people.map((p) => (
            <li key={p.id} className="text-xs min-w-0" data-testid="zapisy-person">
              <EntryActions entry={{ ...p, name: `${p.firstName} ${p.lastName}` }} slug={ev.slug} onChanged={onChanged}
                links={onePerson ? links : []}>
                {({ menu, details }) => (<>
                  <div className="flex items-center justify-between gap-2 min-w-0 min-h-7">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`truncate ${p.mine ? 'text-apex-text-bright' : 'text-apex-text'}`}>
                        {p.firstName} {p.lastName}
                        {p.competition && <span className="text-apex-muted" data-testid="zapisy-competition"> · {p.competition}</span>}
                      </span>
                      {p.status === 'pending_payment' && (
                        <span className="whitespace-nowrap flex-shrink-0 font-mono text-[9px] text-apex-muted">czeka na wpłatę</span>
                      )}
                    </div>
                    {menu}
                  </div>
                  {details}
                </>)}
              </EntryActions>
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
            </li>
          ))}
        </ul>
      )}
    </article>
  )
}

export default function Zapisy() {
  useSeo({ title: 'Moje zapisy — Leszy.run', path: '/profil/zapisy', noindex: true })
  const [state, setState] = useState({ status: 'loading', events: [] })
  // Bumped after a change or an edit: the list is read again (the list stays on screen meanwhile).
  const [reads, setReads] = useState(0)

  useEffect(() => {
    let active = true
    callFunction('my-registrations', {})
      .then((r) => { if (active) setState({ status: 'ok', events: r.data ?? [] }) })
      .catch(() => { if (active) setState((s) => (s.status === 'ok' ? s : { status: 'error', events: [] })) })
    return () => { active = false }
  }, [reads])

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
          {state.events.map((ev) => <EventCard key={ev.eventId} ev={ev} today={today} onChanged={() => setReads((n) => n + 1)} />)}
        </div>
      )}
    </section>
  )
}
