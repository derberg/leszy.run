import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import useSeo from '../../hooks/useSeo.js'
import { eventPageModel, groupCompetitions, startsByTime, statParts } from '../../lib/eventPageModel.js'
import { isUnlistedRegistration } from '../../lib/eventListing.js'
import { orderableExtras, soldOut } from '../../lib/cartModel.js'
import { linkParts } from '../../lib/linkify.js'
import { pluralPl } from '../../lib/plural.js'
import { labelCls, linkCls } from '../../components/registration/ui.js'
import PartnerLogos from '../../components/PartnerLogos.jsx'
import CoursePanel from '../../components/registration/CoursePanel.jsx'

// RA1: the public page of an event with online registration, from the
// /api/event snapshot (never a per-viewer Supabase query). EventHub renders it
// for /events/:slug; the organizer preview (…/wydarzenia/:eventId/podglad)
// renders it from preview data with `preview`, which keeps the page out of
// search engines and points the links at the preview's own routes.
//
// Layout: the calendar's width (1200 px). EventFrame is the frame RA1 and the
// start list (RA8) share: the header, the tabs „Wydarzenie” / „Lista startowa”
// and the sign-up panel, sticky on the right on a wide screen. The panel says
// which competition and for how much (name, price, places left); start times,
// distances and ages are told once, under „Dzień zawodów”. On a phone a bar at
// the bottom keeps the sign-up in reach.

const warsawDay = new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', day: 'numeric', month: 'numeric' })

export const eventPath = (slug) => `/events/${slug}`
export const coursePath = (slug) => `/events/${slug}/trasa`
export const formPath = (slug, categoryId) => `/events/${slug}/zapis/${categoryId}`
export const startListPath = (slug) => `/events/${slug}/lista`

// The same content width as /kalendarz.
const WRAP = 'max-w-[1200px] mx-auto px-4 sm:px-6'
const h2Cls = 'font-display font-extrabold text-2xl uppercase text-apex-text-bright'

// An inline SVG, not the emoji: an emoji is drawn differently on every phone.
function HeartIcon({ size = 14 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">
      <path d="M12 21s-7.5-4.6-9.6-9.3C.9 8.3 3 4.5 6.6 4.5c2.1 0 3.6 1.2 5.4 3.2 1.8-2 3.3-3.2 5.4-3.2 3.6 0 5.7 3.8 4.2 7.2C19.5 16.4 12 21 12 21z" />
    </svg>
  )
}

/** The description, cut to twelve lines with „Pokaż więcej” when it runs longer. */
function Description({ text }) {
  const ref = useRef(null)
  const [open, setOpen] = useState(false)
  const [long, setLong] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || open) return undefined
    const measure = () => setLong(el.scrollHeight > el.clientHeight + 1)
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [text, open])
  return (
    <>
      <p ref={ref} className={`text-[17px] leading-relaxed text-apex-text-bright whitespace-pre-line break-words${open ? '' : ' line-clamp-[12]'}`} data-testid="event-description-text">
        {linkParts(text).map((p, i) => (p.href
          ? <a key={i} href={p.href} target="_blank" rel="noopener noreferrer nofollow" className={`break-all ${linkCls}`}>{p.text}</a>
          : <span key={i}>{p.text}</span>))}
      </p>
      {(long || open) && (
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
          className={`self-start whitespace-nowrap text-[15px] ${linkCls}`} data-testid="description-toggle">
          {open ? 'Pokaż mniej ↑' : 'Pokaż więcej ↓'}
        </button>
      )}
    </>
  )
}

function PlaceLine({ place, testId }) {
  if (!place) return null
  if (!place.mapUrl) return <span className="text-base text-apex-text-bright break-words" data-testid={testId}>{place.label}</span>
  const mapLink = (href, text, id) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className={`whitespace-nowrap ${linkCls}`} data-testid={`${testId}-${id}`}>{text} ↗</a>
  )
  return (
    <span className="text-base text-apex-text-bright break-words" data-testid={testId}>
      {place.label ? `${place.label} · ` : ''}
      {mapLink(place.mapUrl, 'OpenStreetMap', 'osm')}
      {place.googleMapsUrl && <> · {mapLink(place.googleMapsUrl, 'Google Maps', 'google')}</>}
    </span>
  )
}

/** „Zapisy do 2.12.2026, 23:59”, Warsaw time; before opening also from when. */
function deadlineText(m, opensLabel) {
  if (m.registrationState === 'closed' || !m.closesLabel) return 'Zapisy zamknięte'
  if (m.registrationState === 'soon' && opensLabel) return `Zapisy od ${opensLabel} do ${m.closesLabel}`
  return `Zapisy do ${m.closesLabel}`
}

/** „7 drużyn”, „12 osób · 2 drużyny”: who is on the list. People and teams are never added together. */
function listedLabel(stats) {
  const all = statParts(stats).registered.map((p) => ({ count: p.count, unit: p.unit ?? pluralPl(p.count, 'osoba', 'osoby', 'osób') }))
  // „1 osoba · 0 drużyn” says nothing with its zero: drop empty parts unless all are empty.
  const parts = all.some((p) => p.count > 0) ? all.filter((p) => p.count > 0) : all
  return parts.map((p) => `${p.count} ${p.unit}`).join(' · ')
}

function stateText(c, opensLabel) {
  if (c.state === 'full') return 'Brak miejsc'
  if (c.state === 'soon') return opensLabel ? `Od ${opensLabel}` : 'Wkrótce'
  return 'Zamknięte'
}

/** Places taken of the limit as a thin bar. */
function CapacityBar({ c, className = '' }) {
  if (c.capacity == null || c.capacity === 0) return null
  const pct = Math.min(100, Math.round((c.taken / c.capacity) * 100))
  return (
    <div className={`bg-apex-surface-3 overflow-hidden ${className}`} aria-hidden="true">
      <div className="h-full bg-apex-yellow" style={{ width: `${Math.max(pct, 2)}%` }} />
    </div>
  )
}

const ctaCls = 'flex items-center justify-center min-h-[52px] px-5 bg-apex-yellow text-apex-ink font-display font-extrabold text-xl uppercase tracking-wide whitespace-nowrap hover:bg-apex-yellow-bright transition-colors'

function Cta({ href, children, className = '' }) {
  return href.startsWith('#')
    ? <a href={href} className={`${ctaCls} ${className}`}>{children}</a>
    : <Link to={href} className={`${ctaCls} ${className}`}>{children}</Link>
}

const ctaLabel = (c) => (c.kind === 'team' ? 'Zapisz drużynę' : 'Zapisz się')

/** One competition of the panel. With one competition it is large and the button sits under it. */
function PanelRow({ c, href, opensLabel, single }) {
  const open = c.state === 'open'
  const body = single ? (
    <>
      <div className="flex justify-between items-baseline gap-3">
        <strong className="text-xl text-apex-text-bright font-bold leading-tight min-w-0">{c.name}</strong>
        <span className="font-mono text-2xl text-apex-text-bright whitespace-nowrap">{c.priceLabel}</span>
      </div>
      <div className="flex justify-between items-center gap-3 mt-1">
        <span className="font-mono text-[11px] uppercase text-apex-muted whitespace-nowrap" data-testid="competition-free">
          {c.free != null ? `wolne ${c.free} / ${c.capacity}` : ''}
        </span>
        <span className="font-mono text-[11px] uppercase text-apex-muted whitespace-nowrap">{c.priceUnit}</span>
      </div>
      {c.nextPriceLabel && <span className="block font-mono text-[11px] uppercase text-apex-muted text-right">{c.nextPriceLabel}</span>}
      <CapacityBar c={c} className="mt-1.5 h-1" />
    </>
  ) : (
    <>
      <div className="flex justify-between items-baseline gap-3">
        <strong className="text-base text-apex-text-bright font-bold leading-tight min-w-0">{c.name}</strong>
        <span className="flex items-baseline gap-3 shrink-0">
          {c.free != null && <span className="font-mono text-[11px] uppercase text-apex-muted whitespace-nowrap" data-testid="competition-free">wolne {c.free}</span>}
          <span className={`font-mono whitespace-nowrap ${open ? 'text-apex-yellow' : 'text-apex-muted text-xs uppercase'}`}>
            {open ? `${c.priceLabel ?? ''} →` : stateText(c, opensLabel)}
          </span>
        </span>
      </div>
      {open && c.nextPriceLabel && <span className="block font-mono text-[11px] uppercase text-apex-muted text-right">{c.nextPriceLabel}</span>}
      <CapacityBar c={c} className="mt-1.5 h-0.5" />
    </>
  )
  const cls = single ? 'block px-5 py-4' : 'block px-5 py-2.5'
  return href
    ? <Link to={href} data-testid="competition" className={`${cls} hover:bg-apex-surface-2 transition-colors`}>{body}</Link>
    : <div data-testid="competition" className={`${cls}${single ? '' : ' opacity-70'}`}>{body}</div>
}

function SignUpPanel({ m, form, startList, opensLabel }) {
  const single = m.competitions.length === 1
  const c0 = m.competitions[0]
  const href = (c) => (c.state === 'open' && form ? form(c.categoryId) : null)
  const groups = groupCompetitions(m.competitions)
  return (
    <div className="border border-apex-border-mid bg-apex-surface flex flex-col lg:max-h-[calc(100vh-150px)]" data-testid="signup-panel">
      <div className="px-5 pt-4 pb-3 border-b border-apex-border flex items-baseline justify-between gap-3">
        <span className="font-display font-extrabold text-2xl uppercase text-apex-text-bright">{single || !m.competitions.some((c) => c.state === 'open') ? 'Zapisy' : 'Wybierz konkurencję'}</span>
        {m.stats.daysLeft && m.registrationState === 'open' && <span className="font-mono text-sm text-apex-yellow uppercase whitespace-nowrap" data-testid="days-left">jeszcze {m.stats.daysLeft}</span>}
      </div>
      {m.competitions.length > 0 && (
        <div className="flex flex-col lg:overflow-y-auto">
          {single ? <PanelRow c={c0} href={href(c0)} opensLabel={opensLabel} single /> : groups.map((g) => (
            <div key={g.name} className="flex flex-col">
              {groups.length > 1 && <span className="px-5 pt-2 pb-1 font-mono text-[11px] tracking-wider uppercase text-apex-muted bg-apex-surface-2 border-b border-apex-border">{g.name}</span>}
              <div className="flex flex-col divide-y divide-apex-border">
                {g.items.map((c) => <PanelRow key={c.categoryId} c={c} href={href(c)} opensLabel={opensLabel} />)}
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="px-5 py-4 border-t border-apex-border flex flex-col gap-2.5">
        {single && (href(c0)
          ? <Cta href={href(c0)}>{ctaLabel(c0)} →</Cta>
          : <span className="min-h-12 flex items-center justify-center border border-apex-border font-mono uppercase text-apex-muted">{stateText(c0, opensLabel)}</span>)}
        {startList && (
          <Link to={startList} data-testid="start-list-link"
            className="min-h-12 flex items-center justify-between gap-3 px-4 border border-apex-border-bright text-apex-text-bright hover:border-apex-yellow hover:text-apex-yellow transition-colors">
            <span className="font-display font-extrabold text-lg uppercase whitespace-nowrap">Lista startowa</span>
            <span className="font-mono text-xs uppercase whitespace-nowrap" data-testid="listed-count">{listedLabel(m.stats)} →</span>
          </Link>
        )}
        <span className="font-mono text-xs uppercase tracking-wide text-apex-text" data-testid="deadline">{deadlineText(m, opensLabel)}</span>
      </div>
    </div>
  )
}

function Tabs({ tab, slug, startList, m }) {
  const cls = (on) => `min-h-12 flex items-center gap-2 px-1 border-b-[3px] font-display font-extrabold text-lg uppercase whitespace-nowrap ${on
    ? 'border-apex-yellow text-apex-text-bright'
    : 'border-transparent text-apex-muted hover:text-apex-text-bright'}`
  return (
    <div className="sticky top-14 z-30 bg-apex-bg/95 backdrop-blur border-b border-apex-border">
      <nav className={`${WRAP} flex gap-7 overflow-x-auto`} aria-label="Strona wydarzenia" data-testid="event-tabs">
        <Link to={eventPath(slug)} className={cls(tab === 'event')} aria-current={tab === 'event' ? 'page' : undefined}>Wydarzenie</Link>
        <Link to={startList} className={cls(tab === 'list')} aria-current={tab === 'list' ? 'page' : undefined} data-testid="tab-start-list">
          Lista startowa
          <span className={`font-mono text-xs font-medium px-1.5 py-0.5 ${tab === 'list' ? 'bg-apex-yellow text-apex-ink' : 'bg-apex-surface-3 text-apex-text'}`}>{listedLabel(m.stats)}</span>
        </Link>
      </nav>
    </div>
  )
}

function Chip({ children }) {
  return <span className="inline-flex items-center min-h-8 px-2.5 border border-apex-border-mid bg-apex-surface font-mono text-[13px] uppercase tracking-wide text-apex-text-bright whitespace-nowrap">{children}</span>
}

/**
 * The frame RA1 and the start list share: header, tabs, sign-up panel, and the page's own content
 * on the left. `links.startList` null (the organizer preview) leaves out the tabs and the list button.
 * @param {{ raw: object, now?: Date, preview?: boolean, tab?: 'event'|'list', links?: object, children: any }} p
 */
export function EventFrame({ raw, now, preview = false, tab = 'event', links, children }) {
  const m = eventPageModel(raw, now ?? new Date())
  const form = links ? links.form : (id) => formPath(raw.slug, id)
  const startList = links ? (links.startList ?? null) : startListPath(raw.slug)
  const opensLabel = raw.opensAt ? warsawDay.format(new Date(raw.opensAt)) : null
  const charity = !!(m.charityGoal || m.charityUrl || m.charityPercent != null)
  const open = m.competitions.filter((c) => c.state === 'open')
  const single = m.competitions.length === 1
  const prices = open.map((c) => raw.competitions.find((x) => x.categoryId === c.categoryId)?.priceGrosze).filter((g) => g != null)
  const cheapest = prices.length ? open.find((c) => raw.competitions.find((x) => x.categoryId === c.categoryId)?.priceGrosze === Math.min(...prices)) : null
  // Below the header the tabs, when there is a start list to switch to; the panel sticks under them.
  const tabs = !!startList

  return (
    <div className={`bg-apex-bg text-apex-text font-sans ${open.length ? 'pb-28 lg:pb-16' : 'pb-16'}`} data-testid="registration-event-page">
      <header className={`${WRAP} ${preview ? 'pt-6' : 'pt-[88px]'} pb-5 flex flex-col gap-3.5`}>
        {m.organizerName && <span className="font-mono text-xs tracking-wider uppercase text-apex-muted" data-testid="organizer">{m.organizerName}</span>}
        <h1 className="font-display font-extrabold text-[40px] md:text-6xl leading-[0.92] uppercase text-apex-text-bright break-words max-w-[900px]">{m.title}</h1>
        <div className="flex flex-wrap gap-2" data-testid="event-chips">
          {m.dateChip && <Chip>{m.dateChip}</Chip>}
          {m.firstStart && <Chip>Start {m.firstStart}</Chip>}
          {m.placeLabel && <Chip>{m.placeLabel}</Chip>}
          {charity && <Chip><span className="text-apex-rose flex items-center gap-1.5"><HeartIcon size={13} />Charytatywny</span></Chip>}
        </div>
      </header>

      {tabs && <Tabs tab={tab} slug={raw.slug} startList={startList} m={m} />}

      <div className={`${WRAP} ${tabs ? 'pt-8' : 'pt-2'} grid gap-8 lg:grid-cols-[minmax(0,1fr)_380px] items-start`}>
        {/* On a phone the panel leads the event tab; on the start list the list comes first. */}
        <aside id="zapisy" className={`scroll-mt-[120px] lg:order-2 lg:sticky ${tabs ? 'lg:top-[128px]' : 'lg:top-[72px]'} ${tab === 'list' ? 'order-2' : ''}`}>
          <SignUpPanel m={m} form={form} startList={tab === 'list' ? null : startList} opensLabel={opensLabel} />
        </aside>
        <div className="lg:order-1 flex flex-col gap-8 min-w-0">{children(m)}</div>
      </div>

      {open.length > 0 && (
        <div data-sticky-cta className="lg:hidden fixed bottom-0 inset-x-0 z-40 bg-apex-surface border-t border-apex-border-mid px-4 py-3 flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <span className="block font-mono text-lg text-apex-text-bright leading-none whitespace-nowrap">{single ? open[0].priceLabel : cheapest && `od ${cheapest.priceLabel}`}</span>
            <span className="block font-mono text-[11px] uppercase text-apex-muted mt-1 truncate">
              {[single ? open[0].priceUnit : `${m.competitions.length} ${pluralPl(m.competitions.length, 'konkurencja', 'konkurencje', 'konkurencji')}`, m.stats.daysLeft && `jeszcze ${m.stats.daysLeft}`].filter(Boolean).join(' · ')}
            </span>
          </div>
          <Cta href={single && form ? form(open[0].categoryId) : '#zapisy'} className="min-h-12 text-lg">{single ? ctaLabel(open[0]) : 'Wybierz'} →</Cta>
        </div>
      )}
    </div>
  )
}

function InfoCell({ label, wide, children, testId, id }) {
  return (
    <div id={id} className={`flex flex-col gap-1 p-4 bg-apex-surface min-w-0 ${wide ? 'sm:col-span-2' : ''}`} data-testid={testId}>
      <span className={labelCls}>{label}</span>
      {children}
    </div>
  )
}

// Plan 7: the extras a competition offers, still orderable today; one with nothing left reads
// „Czapka · brak”. One with a description takes its own line, the description under it.
function ExtrasLine({ extras }) {
  return (
    <small className="flex flex-wrap gap-x-3 gap-y-0.5 text-sm text-apex-text font-medium" data-testid="competition-extras">
      {extras.map((x) => (
        <span key={x.id} className={`[overflow-wrap:anywhere]${x.description ? ' basis-full' : ''}`} data-testid="competition-extra">
          {soldOut(x) ? `${x.name} · brak` : <>{x.name} <span className="font-mono text-apex-yellow whitespace-nowrap">{x.priceLabel}</span></>}
          {x.description && (
            <span className="block text-apex-muted whitespace-pre-line" data-testid="competition-extra-description">{x.description}</span>
          )}
        </span>
      ))}
    </small>
  )
}

/** „Starty”: one line per start time, each competition with its distance, team size and ages. */
function Starts({ m }) {
  return (
    <div className="flex flex-col divide-y divide-apex-border">
      {startsByTime(m.competitions).map(({ time, items }) => (
        <div key={time ?? '-'} className="grid grid-cols-[60px_minmax(0,1fr)] gap-3 py-2 first:pt-1 last:pb-0">
          <span className="font-mono text-lg text-apex-text-bright">{time ?? '—'}</span>
          <div className="flex flex-col gap-0.5">
            {items.map((c) => (
              <span key={c.categoryId} className="text-base text-apex-text-bright" data-testid="start-row">
                {c.name}
                {(c.distanceLabel || c.teamSize || c.ageLabel) && (
                  <span className="text-apex-muted"> · {[c.distanceLabel, c.teamSize, c.ageLabel].filter(Boolean).join(' · ')}</span>
                )}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function EventContent({ raw, m, now, course }) {
  const extrasBy = m.competitions
    .map((c) => ({ c, extras: orderableExtras(raw.extras, c.categoryId, now ?? new Date()) }))
    .filter((x) => x.extras.length > 0)
  return (
    <>
      {(m.charityGoal || m.charityUrl || m.charityPercent != null) && (
        <section className="border-l-[3px] border-apex-rose bg-apex-surface px-5 py-4 flex flex-col gap-1.5 min-w-0" data-testid="charity-goal">
          <span className="font-mono text-xs tracking-wider uppercase text-apex-rose flex items-center gap-1.5"><HeartIcon />Cel charytatywny</span>
          {m.charityPercent != null ? (
            <p className="flex items-center gap-4 text-lg text-apex-text-bright break-words" data-testid="charity-percent">
              <span className="font-display font-extrabold text-6xl text-apex-rose leading-none shrink-0">{m.charityPercent}%</span>
              <span>{' '}dochodu trafia {m.charityGoal ? <>na: {m.charityGoal}</> : 'na cel charytatywny'}</span>
            </p>
          ) : m.charityGoal && <p className="text-lg text-apex-text-bright break-words">{m.charityGoal}</p>}
          {m.charityUrl && (
            <a href={m.charityUrl} target="_blank" rel="noopener noreferrer" className={`self-start whitespace-nowrap text-[15px] ${linkCls}`}
              data-testid="charity-link">Strona celu ↗</a>
          )}
        </section>
      )}

      {(m.description || m.websiteUrl || m.posterUrl) && (
        <section id="o-wydarzeniu" className="flex flex-col gap-3 min-w-0" data-testid="event-description">
          <h2 className={h2Cls}>O wydarzeniu</h2>
          <div className="flex flex-col md:flex-row-reverse gap-6 md:items-start min-w-0">
            {m.posterUrl && (
              <a href={m.posterUrl} target="_blank" rel="noopener noreferrer" data-testid="event-poster"
                className="block self-center md:self-start shrink-0 w-3/5 max-w-[260px] md:w-[240px] border border-apex-border hover:border-apex-yellow-dim focus-visible:outline focus-visible:outline-apex-yellow">
                <img src={m.posterUrl} alt={`Plakat: ${m.title}`} loading="lazy" className="block w-full h-auto" />
              </a>
            )}
            <div className="flex flex-col gap-2 min-w-0 flex-1">
              {m.description && <Description text={m.description} />}
              {m.websiteUrl && (
                <p className="text-base text-apex-text-bright break-words" data-testid="event-website">
                  Więcej informacji:{' '}
                  <a href={m.websiteUrl} target="_blank" rel="noopener noreferrer nofollow" className={`break-all ${linkCls}`}>{m.websiteUrl.replace(/^https?:\/\//i, '').replace(/\/$/, '')}</a>
                </p>
              )}
            </div>
          </div>
        </section>
      )}

      <PartnerLogos partners={raw.partners ?? []} variant="dark" />

      <section className="flex flex-col gap-3" data-testid="race-day">
        <h2 className={h2Cls}>Dzień zawodów{m.raceDayLabel ? ` · ${m.raceDayLabel}` : ''}</h2>
        <div className="grid sm:grid-cols-2 gap-px bg-apex-border border border-apex-border">
          {m.competitions.length > 0 && (
            <InfoCell label={m.competitions.length > 1 ? 'Starty' : 'Start'} wide testId="starts"><Starts m={m} /></InfoCell>
          )}
          {m.startPlace && (
            <InfoCell label="Miejsce startu" testId="start"><PlaceLine place={m.startPlace} testId="start-place" /></InfoCell>
          )}
          {(m.office.length > 0 || m.officePlace) && (
            <InfoCell label="Biuro zawodów" testId="office">
              {m.office.map((h) => (
                <span key={h.label + h.hours + (h.note ?? '')} className="text-base text-apex-text-bright">
                  {h.label} · {h.hours}
                  {h.note && <span className="text-apex-muted" data-testid="office-hours-note"> · {h.note}</span>}
                </span>
              ))}
              {raw.office?.notes && <span className="text-[15px] text-apex-text whitespace-pre-line break-words" data-testid="office-notes">{raw.office.notes}</span>}
              {m.officeAtStart && m.startPlace
                ? <span className="text-[15px]" data-testid="office-at-start">W miejscu startu</span>
                : <PlaceLine place={m.officePlace} testId="office-place" />}
            </InfoCell>
          )}
          <InfoCell label="Regulamin" id="informacje" testId="event-info">
            {m.regulaminUrl
              ? (
                <a href={m.regulaminUrl} target="_blank" rel="noopener noreferrer" className={`text-base ${linkCls}`} data-testid="regulamin-link">
                  Regulamin zawodów{raw.regulamin?.kind === 'pdf' ? ' (PDF)' : ''} ↗
                </a>
              )
              : <span className="text-base text-apex-muted" data-testid="regulamin-missing">Organizator nie dodał jeszcze regulaminu</span>}
          </InfoCell>
          <InfoCell label="Kontakt z organizatorem">
            {m.contactEmail
              ? <a href={`mailto:${m.contactEmail}`} className={`text-base break-all ${linkCls}`} data-testid="contact-link">{m.contactEmail}</a>
              : <span className="text-base text-apex-muted" data-testid="contact-missing">Organizator nie podał jeszcze adresu</span>}
          </InfoCell>
          {extrasBy.length > 0 && (
            <InfoCell label="Dodatki do zamówienia" wide testId="extras">
              <div className="flex flex-col gap-2">
                {extrasBy.map(({ c, extras }) => (
                  <div key={c.categoryId} className="flex flex-col gap-0.5" data-testid="extras-row">
                    {extrasBy.length > 1 || m.competitions.length > 1 ? <span className="text-base text-apex-text-bright font-semibold">{c.name}</span> : null}
                    <ExtrasLine extras={extras} />
                  </div>
                ))}
              </div>
            </InfoCell>
          )}
        </div>
      </section>

      {m.courses.length > 0 && (
        <section id="trasa" className="flex flex-col gap-3 scroll-mt-[130px]" data-testid="event-course">
          <div className="flex justify-between items-baseline gap-3">
            <h2 className={h2Cls}>Trasa</h2>
            {course && <Link to={course} className={`text-base whitespace-nowrap ${linkCls}`}>Pełny widok i GPX →</Link>}
          </div>
          <CoursePanel courses={m.courses} compact />
        </section>
      )}
    </>
  )
}

function jsonLd(raw, m, url) {
  return {
    '@context': 'https://schema.org',
    '@type': 'SportsEvent',
    name: m.title,
    startDate: raw.firstStartTime ? `${raw.eventDate}T${raw.firstStartTime}` : raw.eventDate,
    eventStatus: 'https://schema.org/EventScheduled',
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    location: m.placeLabel ? {
      '@type': 'Place',
      name: m.eventPlace ?? m.placeLabel,
      address: { '@type': 'PostalAddress', addressLocality: m.placeLabel, addressCountry: 'PL' },
      ...(raw.town?.lat != null ? { geo: { '@type': 'GeoCoordinates', latitude: raw.town.lat, longitude: raw.town.lng } } : {}),
    } : undefined,
    organizer: m.organizerName ? { '@type': 'Organization', name: m.organizerName } : undefined,
    url,
    offers: m.competitions.filter((c) => c.priceLabel).map((c) => ({
      '@type': 'Offer',
      name: c.name,
      price: ((raw.competitions.find((x) => x.categoryId === c.categoryId)?.priceGrosze ?? 0) / 100).toFixed(2),
      priceCurrency: 'PLN',
      availability: c.state === 'open' ? 'https://schema.org/InStock' : c.state === 'full' ? 'https://schema.org/SoldOut' : 'https://schema.org/PreOrder',
      url: `https://www.leszy.run${formPath(raw.slug, c.categoryId)}`,
    })),
  }
}

/**
 * @param {{ raw: object, now?: Date, preview?: boolean, links?: { course: string|null, form: (categoryId) => string|null, startList?: string|null } }} p
 * `links.startList` is left out (null) in the organizer preview, like the course: the
 * list is the live event's.
 */
export default function RegistrationEventPage({ raw, now, preview = false, links }) {
  const m = eventPageModel(raw, now ?? new Date())
  const course = links ? links.course : coursePath(raw.slug)

  useSeo({
    title: m.title,
    path: eventPath(raw.slug),
    // A link-only event („Tylko przez link”) stays out of search, like the preview.
    noindex: preview || isUnlistedRegistration(raw),
    description: `${m.title}${m.dateLabel ? ` — ${m.dateLabel}` : ''}${m.placeLabel ? `, ${m.placeLabel}` : ''}. Zapisy online: ${m.competitions.map((c) => c.name).join(', ')}.`,
    image: raw.posterUrl ?? undefined,
    jsonLd: preview ? undefined : jsonLd(raw, m, `https://www.leszy.run${eventPath(raw.slug)}`),
  })

  return (
    <EventFrame raw={raw} now={now} preview={preview} links={links}>
      {(model) => <EventContent raw={raw} m={model} now={now} course={course} />}
    </EventFrame>
  )
}
