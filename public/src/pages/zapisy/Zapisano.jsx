import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import useSeo from '../../hooks/useSeo.js'
import { callFunction } from '../../lib/auth.js'
import { eventPageModel } from '../../lib/eventPageModel.js'
import { icsFor } from '../../lib/calendarFile.js'
import PageTop from '../../components/registration/PageTop.jsx'
import { labelCls, linkCls } from '../../components/registration/ui.js'
import RegistrationShell from './RegistrationShell.jsx'
import { eventPath } from './RegistrationEventPage.jsx'

// RA5 (free events): the session's own confirmed registrations for this event,
// from my-event-registrations — never from the address bar, which carries no
// person. No bib anywhere (spec §2: bibs are never shown to runners). Actions:
// „Dodaj do kalendarza” and „Napisz do organizatora” (the event's contact
// address, never a person's). Editing, adding people, changing competition and
// passing the entry on belong to later plans.

const act = 'flex justify-between items-center gap-3 min-h-[50px] px-3.5 border border-apex-border-mid bg-apex-surface text-apex-text-bright text-[17px] font-semibold hover:border-apex-yellow-dim'

function downloadIcs(text, name) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/calendar;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function Done({ raw }) {
  const model = eventPageModel(raw)
  const [state, setState] = useState({ status: 'loading', rows: [] })

  useEffect(() => {
    let active = true
    callFunction('my-event-registrations', { slug: raw.slug })
      .then((r) => { if (active) setState({ status: 'ok', rows: r.data ?? [] }) })
      .catch((err) => { if (active) setState({ status: err.status === 401 ? 'anon' : 'error', rows: [] }) })
    return () => { active = false }
  }, [raw.slug])

  const loginHref = `/login?from=${encodeURIComponent(`/events/${raw.slug}/zapisano`)}`

  if (state.status === 'loading') {
    return <div className="flex flex-col gap-4" aria-busy="true"><div className="h-28 bg-apex-surface" /><div className="h-16 bg-apex-surface" /></div>
  }
  if (state.status !== 'ok' || state.rows.length === 0) {
    return (
      <div className="flex flex-col gap-4" data-testid="done-empty">
        <PageTop back={{ to: eventPath(raw.slug), label: 'Zawody' }} right={model.title} />
        <p className="text-lg text-apex-text-bright">
          {state.status === 'anon' ? 'Zaloguj się, żeby zobaczyć swój zapis.'
            : state.status === 'error' ? 'Nie udało się wczytać zapisu. Odśwież stronę.'
              : 'Nie masz zapisu na te zawody.'}
        </p>
        {state.status === 'anon' && <Link to={loginHref} className={linkCls}>Zaloguj się</Link>}
      </div>
    )
  }

  const first = state.rows[0]
  const mailSubject = `${model.title} — ${first.firstName} ${first.lastName}`
  const addToCalendar = () => {
    const r = first
    downloadIcs(icsFor({
      uid: r.id, title: `${model.title}, ${r.competition}`, eventDate: raw.eventDate, startTime: r.startTime,
      location: model.eventPlace, url: `https://www.leszy.run${eventPath(raw.slug)}`,
    }), `${raw.slug}.ics`)
  }

  return (
    <div className="flex flex-col gap-4" data-testid="done">
      <PageTop right="KROK 3/3" />
      <div className="bg-apex-yellow text-apex-ink p-[18px] flex flex-col gap-1">
        <span className="font-mono text-xs uppercase">Zapis potwierdzony</span>
        <span className="font-display font-extrabold text-4xl leading-none uppercase">Jesteście na liście</span>
        <span className="text-base font-semibold">{[model.title, model.dateLabel?.split(' · ')[0]].filter(Boolean).join(' · ')}</span>
      </div>
      {state.rows.map((r) => (
        <div key={r.id} className="border border-apex-border-mid bg-apex-surface p-3.5" data-testid="done-person">
          <span className="block text-lg font-bold text-apex-text-bright">{r.firstName} {r.lastName}</span>
          <span className="block font-mono text-[13px] text-apex-muted uppercase">
            {[r.competition, r.ageGroupLabel, r.startTime ? `start ${r.startTime}` : null].filter(Boolean).join(' · ')}
          </span>
        </div>
      ))}
      <span className={labelCls}>Co dalej</span>
      <button type="button" onClick={addToCalendar} className={act}>
        <span className="whitespace-nowrap">Dodaj do kalendarza</span><span className="font-mono text-apex-muted" aria-hidden="true">→</span>
      </button>
      {model.contactEmail && (
        <a href={`mailto:${model.contactEmail}?subject=${encodeURIComponent(mailSubject)}`} className={`${act} py-2`} data-testid="write-organizer">
          <span className="min-w-0">
            <span className="block whitespace-nowrap">Napisz do organizatora</span>
            <span className="block font-mono text-sm text-apex-muted font-normal break-all">{model.contactEmail}</span>
          </span>
          <span className="font-mono text-apex-muted" aria-hidden="true">→</span>
        </a>
      )}
      <Link to={eventPath(raw.slug)} className={`text-base ${linkCls}`}>Strona zawodów</Link>
    </div>
  )
}

function Seo({ raw }) {
  useSeo({ title: `Zapisano — ${raw.name}`, path: eventPath(raw.slug), noindex: true })
  return null
}

export default function Zapisano() {
  const { slug } = useParams()
  return (
    <RegistrationShell slug={slug}>
      {(raw) => <><Seo raw={raw} /><Done raw={raw} /></>}
    </RegistrationShell>
  )
}
