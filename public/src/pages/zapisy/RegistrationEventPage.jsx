import { Link } from 'react-router-dom'
import useSeo from '../../hooks/useSeo.js'
import { eventPageModel } from '../../lib/eventPageModel.js'
import { labelCls, linkCls } from '../../components/registration/ui.js'

// RA1: the public page of an event with online registration, from the
// /api/event snapshot (never a per-viewer Supabase query). EventHub renders it
// for /events/:slug; the organizer preview (…/wydarzenia/:eventId/podglad)
// renders it from preview data with `preview`, which keeps the page out of
// search engines and points the links at the preview's own routes.

const warsawDay = new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', day: 'numeric', month: 'numeric' })

export const eventPath = (slug) => `/events/${slug}`
export const coursePath = (slug) => `/events/${slug}/trasa`
export const formPath = (slug, categoryId) => `/events/${slug}/zapis/${categoryId}`

function Stat({ label, value, sub, accent, testId }) {
  return (
    <div className="p-2.5 border-r last:border-r-0 border-apex-border min-w-0" data-testid={testId}>
      <span className={labelCls}>{label}</span>
      <div className={`font-mono text-xl ${accent ? 'text-apex-yellow' : 'text-apex-text-bright'}`}>{value}</div>
      {sub && <div className="font-mono text-xs text-apex-muted uppercase">{sub}</div>}
    </div>
  )
}

function CompetitionRow({ c, href, opensLabel }) {
  const body = (
    <>
      <span className="min-w-0">
        <strong className="block text-[19px] text-apex-text-bright font-bold">{c.name}</strong>
        {c.startLabel && <small className="block text-sm text-apex-muted font-medium">{c.startLabel}</small>}
      </span>
      <span className="text-right shrink-0">
        {c.state === 'open' && (
          <>
            <span className="font-mono text-apex-yellow whitespace-nowrap">{c.priceLabel} →</span>
            {c.nextPriceLabel && <span className="block font-mono text-[11px] text-apex-muted uppercase">{c.nextPriceLabel}</span>}
          </>
        )}
        {c.state === 'full' && <span className="font-mono text-apex-muted whitespace-nowrap">BRAK MIEJSC</span>}
        {c.state === 'soon' && <span className="font-mono text-apex-muted whitespace-nowrap">{opensLabel ? `OD ${opensLabel}` : 'WKRÓTCE'}</span>}
        {c.state === 'closed' && <span className="font-mono text-apex-muted whitespace-nowrap">ZAMKNIĘTE</span>}
      </span>
    </>
  )
  const cls = 'flex justify-between items-center gap-2.5 min-h-16 px-3.5 py-2.5 border bg-apex-surface'
  if (href) {
    return (
      <Link to={href} data-testid="competition" className={`${cls} border-apex-border-mid hover:border-apex-yellow hover:bg-apex-surface-2 transition-colors`}>
        {body}
      </Link>
    )
  }
  return <div data-testid="competition" className={`${cls} border-apex-border`}>{body}</div>
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
 * @param {{ raw: object, now?: Date, preview?: boolean, links?: { course: string|null, form: (categoryId) => string|null } }} p
 */
export default function RegistrationEventPage({ raw, now, preview = false, links }) {
  const m = eventPageModel(raw, now ?? new Date())
  const course = links ? links.course : coursePath(raw.slug)
  const form = links ? links.form : (id) => formPath(raw.slug, id)
  const opensLabel = raw.opensAt ? warsawDay.format(new Date(raw.opensAt)) : null
  const anyOpen = m.competitions.some((c) => c.state === 'open')

  useSeo({
    title: m.title,
    path: eventPath(raw.slug),
    noindex: preview,
    description: `${m.title}${m.dateLabel ? ` — ${m.dateLabel}` : ''}${m.placeLabel ? `, ${m.placeLabel}` : ''}. Zapisy online: ${m.competitions.map((c) => c.name).join(', ')}.`,
    image: raw.posterUrl ?? undefined,
    jsonLd: preview ? undefined : jsonLd(raw, m, `https://www.leszy.run${eventPath(raw.slug)}`),
  })

  const thirdStat = m.stats.daysLeft
    ? (m.competitions.some((c) => c.state === 'soon') ? { label: 'Zapisy od', value: opensLabel } : { label: 'Do końca', value: m.stats.daysLeft })
    : { label: 'Zapisy', value: 'zamknięte' }

  return (
    <div className="bg-apex-bg text-apex-text font-sans" data-testid="registration-event-page">
      <div className={`max-w-2xl mx-auto px-4 sm:px-5 ${preview ? 'pt-6' : 'pt-[78px]'} pb-12 flex flex-col gap-[18px]`}>
        <div className="flex flex-col gap-1.5">
          <div className="flex justify-between items-start gap-3">
            <span className={labelCls}>{[m.dateLabel, m.placeLabel].filter(Boolean).join(' · ')}</span>
            {m.organizerName && <span className="font-mono text-xs text-apex-muted uppercase text-right shrink-0 max-w-[45%] truncate" title={m.organizerName}>{m.organizerName}</span>}
          </div>
          <h1 className="font-display font-extrabold text-[40px] md:text-5xl leading-[0.95] uppercase text-apex-text-bright break-words">{m.title}</h1>
          {m.charityGoal && <span className="text-[17px]">{m.charityGoal}</span>}
        </div>

        <div className="grid grid-cols-3 border border-apex-border">
          <Stat testId="stat-registered" label="Zapisani" value={m.stats.registered} accent />
          <Stat testId="stat-free" label="Wolne" value={m.stats.free} />
          <Stat testId="stat-days" label={thirdStat.label} value={thirdStat.value} />
        </div>

        {(m.office.length > 0 || m.officePlace) && (
          <div className="border border-apex-border px-3.5 py-3 flex flex-col gap-1" data-testid="office">
            <span className={labelCls}>Biuro zawodów</span>
            {m.office.length > 0 && (
              <span className="text-base text-apex-text-bright">
                {m.office.map((h) => <span key={h.label + h.hours} className="block">{h.label} · {h.hours}</span>)}
              </span>
            )}
            {m.officePlace && (m.officePlace.mapUrl
              ? <a href={m.officePlace.mapUrl} target="_blank" rel="noopener noreferrer" className={`text-[15px] ${linkCls}`}>{m.officePlace.label ? `${m.officePlace.label} · ` : ''}mapa ↗</a>
              : <span className="text-[15px]">{m.officePlace.label}</span>)}
          </div>
        )}

        <span className={labelCls}>{anyOpen ? 'Wybierz konkurencję' : 'Konkurencje'}</span>
        <div className="flex flex-col gap-2">
          {m.competitions.map((c) => (
            <CompetitionRow key={c.categoryId} c={c} opensLabel={opensLabel}
              href={c.state === 'open' && form ? form(c.categoryId) : null} />
          ))}
        </div>

        {m.showFeeNote && (
          <span className="text-[15px] text-apex-muted">Do płatności doliczamy jej koszt (0,9%). Wsparcie LESZY.RUN (2%) jest dobrowolne.</span>
        )}
        <div className="flex gap-4 flex-wrap text-base">
          {m.regulaminUrl && (
            <a href={m.regulaminUrl} target="_blank" rel="noopener noreferrer" className={linkCls}>
              Regulamin{raw.regulamin?.kind === 'pdf' ? ' (PDF)' : ''}
            </a>
          )}
          {m.courses.length > 0 && course && <Link to={course} className={linkCls}>Trasa</Link>}
        </div>
      </div>
    </div>
  )
}
