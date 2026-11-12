import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import Navbar from '../../components/Navbar.jsx'
import usePublicRegistrationEvent from '../../hooks/usePublicRegistrationEvent.js'
import NotFound from '../NotFound.jsx'
import useSeo from '../../hooks/useSeo.js'
import { activeFilterCount, filterStartList, splitStartList, startListCountText, startListFilterOptions, startListView } from '../../lib/startList.js'
import { inputCls, labelCls } from '../../components/registration/ui.js'
import { EventFrame, startListPath } from './RegistrationEventPage.jsx'

// RA8 (mobile cards) and RA8d (desktop table): everyone on the list of a published
// event, in the event page's frame (EventFrame: header, tabs, sign-up panel).
// event, with filters. People and teams are two lists; a team shows its whole named squad. Ruling P3-R14: an entry awaiting payment is only counted
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

function CompetitionCount({ c }) {
  return (
    <div className="px-2.5 py-2 border border-apex-border min-w-0" data-testid="list-competition">
      <span className={`${labelCls} text-[11px] block truncate`}>{c.label}</span>
      <div className="font-mono text-lg text-apex-text-bright">
        {c.taken}<span className="text-apex-muted text-[13px]"> / {c.capacity} miejsc</span>
      </div>
      <div className="flex h-1 bg-apex-border my-1.5" aria-hidden="true">
        <div className="bg-apex-yellow" style={{ width: `${c.takenPct}%` }} />
      </div>
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
  const active = activeFilterCount(filters)
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
        <span>Filtry{!open && active > 0 && <span className="font-mono text-apex-yellow" data-testid="filter-count"> ({active})</span>}</span>
        <span className="font-mono text-apex-muted" aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>
      <div id="sl-filter-panel" className="px-3.5 pb-3.5" hidden={!open}>{fields}</div>
    </div>
  )
}

function Members({ e }) {
  return (
    <ul className="flex flex-col" data-testid="team-members">
      {e.members.map((m, i) => <li key={`${m}-${i}`} className="text-base text-apex-text break-words">{m}</li>)}
      {e.unnamedText && <li className="font-mono text-xs text-apex-muted">{e.unnamedText}</li>}
    </ul>
  )
}

function TeamCards({ entries }) {
  return (
    <ul className="flex flex-col gap-1.5" data-testid="start-list-teams">
      {entries.map((e, i) => (
        <li key={`${e.name}-${i}`} className="border border-apex-border-mid bg-apex-surface px-3.5 py-3 flex flex-col gap-1.5" data-testid="start-list-entry">
          <div className="flex justify-between items-start gap-2.5">
            <span className="min-w-0">
              <span className="block text-[17px] font-bold text-apex-text-bright break-words">{e.name}</span>
              {e.town && <span className="block text-sm text-apex-muted break-words">{e.town}</span>}
            </span>
          </div>
          <Members e={e} />
          <span className="font-mono text-xs text-apex-muted uppercase">{e.what}</span>
        </li>
      ))}
    </ul>
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
                <span>{e.name}</span>
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

function TeamTable({ entries }) {
  return (
    <div className="border border-apex-border overflow-x-auto">
      <table className="w-full border-collapse" data-testid="start-list-teams">
        <thead>
          <tr><th className={thCls}>Drużyna</th><th className={thCls}>Skład</th><th className={thCls}>Miejscowość</th><th className={thCls}>Konkurencja</th><th className={thCls}>Liczba osób</th></tr>
        </thead>
        <tbody>
          {entries.map((e, i) => (
            <tr key={`${e.name}-${i}`} data-testid="start-list-entry">
              <td className={`${tdCls} text-apex-text-bright font-bold`}>
                <span>{e.name}</span>
              </td>
              <td className={tdCls}><Members e={e} /></td>
              <td className={tdCls}>{e.town ?? '—'}</td>
              <td className={tdCls}>{e.competition}</td>
              <td className={`${tdCls} font-mono text-sm`}>{e.squad}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Section({ title, count, children }) {
  return (
    <section className="flex flex-col gap-2" data-testid="start-list-section">
      <h2 className="font-display font-extrabold text-2xl leading-none uppercase text-apex-text-bright">
        {title} <span className="font-mono text-base font-medium text-apex-muted">{count}</span>
      </h2>
      {children}
    </section>
  )
}

function StartList({ raw }) {
  const [state, setState] = useState({ status: 'loading', view: null })
  const [filters, setFilters] = useState(NO_FILTERS)
  const desktop = useDesktop()

  useEffect(() => {
    let active = true
    loadStartList(raw.eventId)
      .then((snap) => { if (active) setState({ status: 'ok', view: startListView(snap) }) })
      .catch(() => { if (active) setState({ status: 'error', view: null }) })
    return () => { active = false }
  }, [raw.eventId])

  const { view } = state
  const options = useMemo(() => (view ? startListFilterOptions(view, { categoryId: filters.categoryId }) : null), [view, filters.categoryId])
  const shown = useMemo(() => (view ? filterStartList(view, filters) : null), [view, filters])
  const filtered = shown && shown.entries.length !== shown.total
  const all = useMemo(() => (view ? splitStartList(view.entries) : null), [view])
  const parts = useMemo(() => (shown ? splitStartList(shown.entries) : null), [shown])
  return (
    <div className="flex flex-col gap-3.5" data-testid="start-list">
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
                  Na liście: {startListCountText(parts, all, filtered)}
                </span>
                {shown.entries.length === 0 && <p className="text-lg text-apex-text-bright" data-testid="start-list-no-match">Brak osób dla wybranych filtrów.</p>}
                {all.teams.length === 0
                  ? parts.people.length > 0 && (desktop ? <EntryTable entries={parts.people} /> : <EntryCards entries={parts.people} />)
                  : (
                    <>
                      {parts.people.length > 0 && (
                        <Section title="Zawodnicy" count={parts.people.length}>
                          {desktop ? <EntryTable entries={parts.people} /> : <EntryCards entries={parts.people} />}
                        </Section>
                      )}
                      {parts.teams.length > 0 && (
                        <Section title="Drużyny" count={parts.teams.length}>
                          {desktop ? <TeamTable entries={parts.teams} /> : <TeamCards entries={parts.teams} />}
                        </Section>
                      )}
                    </>
                  )}
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
  const { status, raw } = usePublicRegistrationEvent(slug)
  if (status === 'missing') return <NotFound />
  return (
    <>
      <Navbar />
      <main id="main-content" className="bg-apex-bg min-h-[70vh]">
        {status === 'loading'
          ? (
            <div className="max-w-[1200px] mx-auto px-4 sm:px-6 pt-[88px] flex flex-col gap-4" aria-busy="true">
              <div className="h-12 w-3/4 bg-apex-surface" />
              <div className="h-12 bg-apex-surface" />
              <div className="h-64 bg-apex-surface" />
            </div>
          )
          : (
            <>
              <Seo raw={raw} />
              <EventFrame raw={raw} tab="list">
                {() => <StartList raw={raw} />}
              </EventFrame>
            </>
          )}
      </main>
    </>
  )
}
