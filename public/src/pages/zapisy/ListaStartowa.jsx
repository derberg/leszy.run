import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import useSeo from '../../hooks/useSeo.js'
import { startListView } from '../../lib/startList.js'
import PageTop from '../../components/registration/PageTop.jsx'
import { labelCls } from '../../components/registration/ui.js'
import RegistrationShell from './RegistrationShell.jsx'
import { eventPath, startListPath } from './RegistrationEventPage.jsx'

// RA8 (columns only; Plan 4 adds the filters, groups and teams): everyone on
// the list of a published event. Ruling P3-R14: an entry awaiting payment is
// only counted („+N czeka na wpłatę”), never listed by name, and a minor's
// town is never shown; „opłacone” marks an entry that was paid (never a free
// event or a 0 zł entry). The
// event id comes from the /api/event snapshot, the list from /api/startlist:
// both CDN-cached, never a per-viewer Supabase query. No birth date, contact,
// bib or price: start_list() does not return them.

async function loadStartList(eventId) {
  const res = await fetch(`/api/startlist?event=${encodeURIComponent(eventId)}`)
  if (!res.ok) throw new Error(`startlist ${res.status}`)
  return res.json()
}

function Badge({ text }) {
  return (
    <span className="font-mono text-[11px] px-[7px] py-[3px] border uppercase whitespace-nowrap shrink-0 border-apex-yellow text-apex-yellow"
      data-testid="payment-badge">
      {text}
    </span>
  )
}

function CompetitionCount({ c }) {
  return (
    <div className="px-2.5 py-2 border border-apex-border min-w-0" data-testid="list-competition">
      <span className={`${labelCls} text-[11px] block truncate`}>{c.name}</span>
      <div className="font-mono text-lg text-apex-text-bright">
        {c.taken}<span className="text-apex-muted text-[13px]"> / {c.capacity} miejsc</span>
      </div>
      <div className="flex h-1 bg-apex-border my-1.5" aria-hidden="true">
        <div className="bg-apex-yellow" style={{ width: `${c.paidPct}%` }} />
        <div className="bg-apex-text" style={{ width: `${c.freePct}%` }} />
        <div className="bg-apex-cyan" style={{ width: `${c.awaitingPct}%` }} />
      </div>
      {c.paidLabel && <div className="font-mono text-xs text-apex-yellow">{c.paidLabel}</div>}
      {c.freeLabel && <div className="font-mono text-xs text-apex-text">{c.freeLabel}</div>}
      {c.awaitingLabel && <div className="font-mono text-xs text-apex-cyan">{c.awaitingLabel}</div>}
    </div>
  )
}

function StartList({ raw }) {
  const [state, setState] = useState({ status: 'loading', view: null })

  useEffect(() => {
    let active = true
    loadStartList(raw.eventId)
      .then((snap) => { if (active) setState({ status: 'ok', view: startListView(snap, { paidEvent: raw.pricingMode !== 'free' }) }) })
      .catch(() => { if (active) setState({ status: 'error', view: null }) })
    return () => { active = false }
  }, [raw.eventId, raw.pricingMode])

  const { view } = state
  return (
    <div className="flex flex-col gap-3.5" data-testid="start-list">
      <PageTop back={{ to: eventPath(raw.slug), label: 'Zawody' }} right={raw.name} />
      <h1 className="font-display font-extrabold text-4xl leading-none uppercase text-apex-text-bright">Lista startowa</h1>
      {state.status === 'loading' && (
        <div className="flex flex-col gap-2" aria-busy="true">
          <div className="h-20 bg-apex-surface" /><div className="h-16 bg-apex-surface" /><div className="h-16 bg-apex-surface" />
        </div>
      )}
      {state.status === 'error' && <p className="text-apex-red text-base">Nie udało się wczytać listy. Odśwież stronę.</p>}
      {view && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
            {view.competitions.map((c) => <CompetitionCount key={c.categoryId} c={c} />)}
          </div>
          <span className="font-mono text-[13px] text-apex-muted uppercase" data-testid="start-list-header">{view.header}</span>
          {view.entries.length === 0
            ? <p className="text-lg text-apex-text-bright" data-testid="start-list-empty">Na liście nie ma jeszcze nikogo.</p>
            : (
              <ul className="flex flex-col gap-1.5" data-testid="start-list-entries">
                {view.entries.map((e, i) => (
                  <li key={`${e.name}-${i}`} className="border border-apex-border-mid bg-apex-surface px-3.5 py-3 flex flex-col gap-1.5" data-testid="start-list-entry">
                    <div className="flex justify-between items-start gap-2.5">
                      <span className="min-w-0">
                        <span className="block text-[17px] font-bold text-apex-text-bright break-words">{e.name}</span>
                        {e.where && <span className="block text-sm text-apex-muted break-words">{e.where}</span>}
                      </span>
                      {e.badge && <Badge text={e.badge} />}
                    </div>
                    <span className="font-mono text-xs text-apex-muted uppercase">{e.what}</span>
                  </li>
                ))}
              </ul>
            )}
        </>
      )}
    </div>
  )
}

function Seo({ raw }) {
  useSeo({ title: `Lista startowa — ${raw.name}`, path: startListPath(raw.slug), noindex: true })
  return null
}

export default function ListaStartowa() {
  const { slug } = useParams()
  return (
    <RegistrationShell slug={slug}>
      {(raw) => <><Seo raw={raw} /><StartList raw={raw} /></>}
    </RegistrationShell>
  )
}
