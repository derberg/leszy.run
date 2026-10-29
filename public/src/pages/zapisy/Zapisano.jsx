import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import useSeo from '../../hooks/useSeo.js'
import { callFunction } from '../../lib/auth.js'
import { eventPageModel } from '../../lib/eventPageModel.js'
import PageTop from '../../components/registration/PageTop.jsx'
import DoneActions from '../../components/registration/DoneActions.jsx'
import RegisteredPerson from '../../components/registration/RegisteredPerson.jsx'
import { orderPeople, personGroupLabel, showsConsentTags } from '../../lib/consentTag.js'
import { linkCls } from '../../components/registration/ui.js'
import RegistrationShell from './RegistrationShell.jsx'
import { eventPath } from './RegistrationEventPage.jsx'

// RA5 (free events): the session's own confirmed registrations for this event,
// from my-event-registrations — never from the address bar, which carries no
// person. No bib anywhere (spec §2: bibs are never shown to runners). Actions:
// „Dodaj do kalendarza” and „Napisz do organizatora” (the event's contact
// address, never a person's). In a group each person carries the regulamin tag
// („✓ REGULAMIN” / „✓ OPIEKUN” / „CZEKA NA ZGODĘ”), and an added adult who has not
// accepted gets „Wyślij przypomnienie do <imię> →”. Editing, adding people, changing
// competition and passing the entry on belong to later plans.

function Done({ raw }) {
  const model = eventPageModel(raw)
  const [state, setState] = useState({ status: 'loading', rows: [] })
  // Bumped when a reminder answers 409 (the person accepted meanwhile): the rows are read again.
  const [reads, setReads] = useState(0)

  useEffect(() => {
    let active = true
    callFunction('my-event-registrations', { slug: raw.slug })
      .then((r) => { if (active) setState({ status: 'ok', rows: r.data ?? [] }) })
      .catch((err) => { if (active) setState((s) => (s.status === 'ok' ? s : { status: err.status === 401 ? 'anon' : 'error', rows: [] })) })
    return () => { active = false }
  }, [raw.slug, reads])

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

  const rows = orderPeople(state.rows)
  const first = rows[0]
  const tags = showsConsentTags(rows)

  return (
    <div className="flex flex-col gap-4" data-testid="done">
      <PageTop right="KROK 3/3" />
      <div className="bg-apex-yellow text-apex-ink p-[18px] flex flex-col gap-1">
        <span className="font-mono text-xs uppercase">Zapis potwierdzony</span>
        <span className="font-display font-extrabold text-4xl leading-none uppercase">Jesteście na liście</span>
        <span className="text-base font-semibold">{[model.title, model.dateLabel?.split(' · ')[0]].filter(Boolean).join(' · ')}</span>
      </div>
      {rows.map((r) => (
        <RegisteredPerson key={r.id} person={r} registrationId={r.id} name={`${r.firstName} ${r.lastName}`} showTag={tags}
          onStale={() => setReads((n) => n + 1)} testId="done-person"
          meta={[r.competition, personGroupLabel(r), r.startTime ? `start ${r.startTime}` : null]} />
      ))}
      <DoneActions model={model} raw={raw} eventHref={eventPath(raw.slug)}
        first={{ uid: first.id, name: `${first.firstName} ${first.lastName}`, competition: first.competition, startTime: first.startTime }} />
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
