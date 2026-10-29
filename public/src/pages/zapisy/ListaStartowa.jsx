import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import useSeo from '../../hooks/useSeo.js'
import { filterStartList, startListFilterOptions, startListView } from '../../lib/startList.js'
import PageTop from '../../components/registration/PageTop.jsx'
import { inputCls, labelCls } from '../../components/registration/ui.js'
import RegistrationShell from './RegistrationShell.jsx'
import { eventPath, startListPath } from './RegistrationEventPage.jsx'

// RA8 (mobile cards) and RA8d (desktop table): everyone on the list of a published
// event, with filters. Ruling P3-R14: an entry awaiting payment is only counted
// („+N czeka na wpłatę”), never listed by name, so there is no „Wpłata” filter or
// column (D4-19), and a minor's town is never shown; „opłacone” marks an entry that
// was paid (never a free event or a 0 zł entry). The event id comes from the
// /api/event snapshot, the list from /api/startlist: both CDN-cached, never a
// per-viewer Supabase query. No birth date, contact, bib or price: start_list()
// does not return them. The filters live in component state, never in the URL: a
// search names a person, and analytics sees the address (CLAUDE.md).

const DESKTOP = '(min-width: 768px)'

/** Whether the viewport is RA8d's (768 px and up). One layout is rendered, never both. */
function useDesktop() {
  const get = () => typeof window !== 'undefined' && window.matchMedia?.(DESKTOP).matches === true
  const [desktop, setDesktop] = useState(get)
  useEffect(() => {
    const mq = window.matchMedia?.(DESKTOP)
    if (!mq) return undefined
    const onChange = () => setDesktop(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return desktop
}

const NO_FILTERS = { q: '', categoryId: '', category: '', gender: '', club: '' }

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
      </div>
      {c.paidLabel && <div className="font-mono text-xs text-apex-yellow">{c.paidLabel}</div>}
      {c.freeLabel && <div className="font-mono text-xs text-apex-text">{c.freeLabel}</div>}
      {c.awaitingLabel && <div className="font-mono text-xs text-apex-cyan">{c.awaitingLabel}</div>}
    </div>
  )
}

function Select({ id, label, value, onChange, options, all, testId }) {
  return (
    <label htmlFor={id} className="flex flex-col gap-1.5 min-w-0">
      <span className={`${labelCls} whitespace-nowrap truncate`}>{label}</span>
      <select id={id} data-testid={testId} className={inputCls} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{all}</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  )
}

function Filters({ options, filters, setFilters, desktop }) {
  const [open, setOpen] = useState(false)
  const set = (key) => (value) => setFilters((f) => ({ ...f, [key]: value }))
  const fields = (
    <div className="flex flex-col gap-3" data-testid="start-list-filter-fields">
      <label htmlFor="sl-q" className="flex flex-col gap-1.5">
        <span className={labelCls}>Szukaj</span>
        <input id="sl-q" type="search" data-testid="filter-q" className={inputCls} value={filters.q}
          placeholder="Imię, nazwisko, miejscowość, klub" autoComplete="off" onChange={(e) => set('q')(e.target.value)} />
      </label>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
        <Select id="sl-comp" testId="filter-competition" label="Konkurencja" all="Wszystkie" value={filters.categoryId}
          onChange={set('categoryId')} options={options.competitions} />
        <Select id="sl-cat" testId="filter-category" label="Kategoria wiekowa" all="Wszystkie" value={filters.category}
          onChange={set('category')} options={options.categories.map((c) => ({ value: c, label: c }))} />
        <Select id="sl-gender" testId="filter-gender" label="Płeć" all="Wszyscy" value={filters.gender}
          onChange={set('gender')} options={options.genders} />
        <Select id="sl-club" testId="filter-club" label="Klub" all="Wszystkie" value={filters.club}
          onChange={set('club')} options={options.clubs} />
      </div>
      <button type="button" data-testid="filter-clear" onClick={() => setFilters(NO_FILTERS)}
        className="self-start min-h-11 px-4 border border-apex-border-bright text-apex-text-bright font-sans font-bold text-base whitespace-nowrap hover:border-apex-yellow-dim">
        Wyczyść filtry
      </button>
    </div>
  )
  if (desktop) {
    return <div className="border border-apex-border-mid bg-apex-surface p-4" data-testid="start-list-filters">{fields}</div>
  }
  return (
    <div className="border border-apex-border-mid bg-apex-surface" data-testid="start-list-filters">
      <button type="button" aria-expanded={open} aria-controls="sl-filter-panel" data-testid="filter-toggle"
        onClick={() => setOpen((o) => !o)}
        className="w-full min-h-12 px-3.5 flex justify-between items-center text-apex-text-bright font-sans font-bold text-[17px] whitespace-nowrap">
        Filtry<span className="font-mono text-apex-muted" aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>
      {open && <div id="sl-filter-panel" className="px-3.5 pb-3.5">{fields}</div>}
    </div>
  )
}

function EntryCards({ entries }) {
  return (
    <ul className="flex flex-col gap-1.5" data-testid="start-list-entries">
      {entries.map((e, i) => (
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
  )
}

const thCls = 'font-mono text-xs font-medium text-apex-muted text-left uppercase px-3 py-2.5 border-b border-apex-border-mid whitespace-nowrap'
const tdCls = 'px-3 py-2.5 border-b border-apex-border text-base text-apex-text align-top'

function EntryTable({ entries }) {
  return (
    <div className="border border-apex-border overflow-x-auto">
      <table className="w-full border-collapse" data-testid="start-list-entries">
        <thead>
          <tr><th className={thCls}>Zawodnik</th><th className={thCls}>Miejscowość</th><th className={thCls}>Klub</th><th className={thCls}>Konkurencja</th><th className={thCls}>Kategoria</th></tr>
        </thead>
        <tbody>
          {entries.map((e, i) => (
            <tr key={`${e.name}-${i}`} data-testid="start-list-entry">
              <td className={`${tdCls} text-apex-text-bright font-bold`}>
                <span className="inline-flex items-center gap-2.5 flex-wrap">{e.name}{e.badge && <Badge text={e.badge} />}</span>
              </td>
              <td className={tdCls}>{e.town ?? '—'}</td>
              <td className={tdCls}>{e.club ?? '—'}</td>
              <td className={tdCls}>{e.competition}</td>
              <td className={`${tdCls} font-mono text-sm`}>{e.category ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function StartList({ raw }) {
  const [state, setState] = useState({ status: 'loading', view: null })
  const [filters, setFilters] = useState(NO_FILTERS)
  const desktop = useDesktop()

  useEffect(() => {
    let active = true
    loadStartList(raw.eventId)
      .then((snap) => { if (active) setState({ status: 'ok', view: startListView(snap, { paidEvent: raw.pricingMode !== 'free' }) }) })
      .catch(() => { if (active) setState({ status: 'error', view: null }) })
    return () => { active = false }
  }, [raw.eventId, raw.pricingMode])

  const { view } = state
  const options = useMemo(() => (view ? startListFilterOptions(view) : null), [view])
  const shown = useMemo(() => (view ? filterStartList(view, filters) : null), [view, filters])
  const filtered = shown && shown.entries.length !== shown.total
  return (
    <div className="flex flex-col gap-3.5" data-testid="start-list">
      <PageTop back={{ to: eventPath(raw.slug), label: 'Zawody' }} right={raw.name} />
      <h1 className="font-display font-extrabold text-4xl md:text-[40px] leading-none uppercase text-apex-text-bright">Lista startowa</h1>
      {state.status === 'loading' && (
        <div className="flex flex-col gap-2" aria-busy="true">
          <div className="h-20 bg-apex-surface" /><div className="h-16 bg-apex-surface" /><div className="h-16 bg-apex-surface" />
        </div>
      )}
      {state.status === 'error' && <p className="text-apex-red text-base">Nie udało się wczytać listy. Odśwież stronę.</p>}
      {view && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-1.5 md:gap-2">
            {view.competitions.map((c) => <CompetitionCount key={c.categoryId} c={c} />)}
          </div>
          <span className="font-mono text-[13px] text-apex-muted uppercase" data-testid="start-list-header">{view.header}</span>
          {view.entries.length === 0
            ? <p className="text-lg text-apex-text-bright" data-testid="start-list-empty">Na liście nie ma jeszcze nikogo.</p>
            : (
              <>
                <Filters options={options} filters={filters} setFilters={setFilters} desktop={desktop} />
                <span className="font-mono text-[13px] text-apex-muted uppercase" data-testid="start-list-count" aria-live="polite">
                  Na liście: {shown.entries.length}{filtered ? ` z ${shown.total}` : ''}
                </span>
                {shown.entries.length === 0
                  ? <p className="text-lg text-apex-text-bright" data-testid="start-list-no-match">Brak osób dla wybranych filtrów.</p>
                  : desktop ? <EntryTable entries={shown.entries} /> : <EntryCards entries={shown.entries} />}
              </>
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
    <RegistrationShell slug={slug} wide>
      {(raw) => <><Seo raw={raw} /><StartList raw={raw} /></>}
    </RegistrationShell>
  )
}
