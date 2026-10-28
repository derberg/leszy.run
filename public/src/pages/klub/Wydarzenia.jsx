import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import useSeo from '../../hooks/useSeo.js'
import useOrganizerStatus from '../../hooks/useOrganizerStatus.js'
import useClubRegistrationEvents from '../../hooks/useClubRegistrationEvents.js'
import { createRegistrationEvent, joinRegistrationWaitlist } from '../../lib/organizer.js'
import { nextOrganizerStep, organizerFeaturesShown } from '../../lib/organizerGate.js'
import { primaryBtnClass } from '../profil/fields.jsx'
import { useKlub } from './context.js'
import { btnGhost, fieldInput, fieldLabel } from './settingsUi.js'

const cardClass = 'border border-apex-border bg-apex-surface p-5 space-y-3'
const eyebrowClass = 'font-mono text-[10px] tracking-widest uppercase text-apex-muted'

// Club as organizer (mockup A1). The tab is there for every active member;
// what it offers follows nextOrganizerStep(). Once the club is enabled and the
// agreement accepted every member sees the club's events; owner and admin
// also get „+ Nowe wydarzenie”, which asks for a name and opens the wizard.

const PHONE_DISPLAY = '+48 784 640 977'
const PHONE_TEL = 'tel:+48784640977'
const JOINED = 'Klub jest na liście. Odezwiemy się, gdy przyjdzie jego kolej.'

// Copy verbatim from spec §17.
function WaitlistCard({ club, status, canJoin, onJoined }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function join() {
    setBusy(true)
    setError(null)
    try {
      await joinRegistrationWaitlist(club.id)
      await onJoined()
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return (
    <section data-testid="waitlist" className={cardClass}>
      <h2 className="font-display font-extrabold text-xl uppercase text-apex-text-bright">Zapisy online na LESZY.RUN</h2>
      <p className="font-sans text-sm text-apex-text">
        Organizujesz zawody? Niedługo przeprowadzisz je tutaj od początku do końca: zapisy, płatności, lista startowa i pomiar czasu.
      </p>
      <p className="font-sans text-sm text-apex-text">
        Na razie włączamy zapisy klubom po kolei. Płatności i obsługa zawodów to realne koszty, a LESZY.RUN prowadzi mały zespół, więc najpierw chcemy mieć pewność, że wszystko działa, jak trzeba.
      </p>
      {status.waitlisted ? (
        <p data-testid="waitlist-joined" className="font-sans text-sm font-semibold text-apex-yellow">{JOINED}</p>
      ) : canJoin ? (
        <div>
          <button type="button" onClick={join} disabled={busy} className={primaryBtnClass}>
            Dopisz klub do listy oczekujących
          </button>
          {error && <p className="text-apex-red font-sans text-xs mt-1.5">{error}</p>}
        </div>
      ) : null}
      <p className="font-sans text-sm text-apex-text">
        Chcesz ruszyć wcześniej? Zadzwoń:{' '}
        <a href={PHONE_TEL} className="whitespace-nowrap font-bold text-apex-text-bright underline">{PHONE_DISPLAY}</a>
      </p>
    </section>
  )
}

function AgreementCard({ club, isOwner, version }) {
  return (
    <section data-testid="agreement-pending" className={cardClass}>
      <div className={eyebrowClass}>Umowa organizatora · wersja <span className="normal-case">{version}</span></div>
      {!isOwner && (
        <p className="font-sans text-sm text-apex-text">Umowę akceptuje właściciel klubu</p>
      )}
      <Link to={`/klub/${club.slug}/wydarzenia/umowa`} className={`${primaryBtnClass} inline-block no-underline`}>
        Umowa organizatora →
      </Link>
    </section>
  )
}

const STATE_TAG = { draft: 'SZKIC', published: 'OPUBLIKOWANE', closed: 'ZAMKNIĘTE' }

function dateLabel(iso) {
  if (!iso) return 'Bez daty'
  const [y, m, d] = iso.split('-').map(Number)
  return `${d}.${String(m).padStart(2, '0')}.${y}`
}

function EventCard({ club, event, canManage }) {
  const draft = event.state === 'draft'
  const to = `/klub/${club.slug}/wydarzenia/${event.eventId}${draft ? '/podstawy' : ''}`
  const parts = [dateLabel(event.eventDate)]
  if (!draft) parts.push(`${event.taken} / ${event.capacity} zapisanych`)
  return (
    <article data-testid="event-card" className={`border bg-apex-surface p-5 flex flex-col gap-2.5 ${draft ? 'border-apex-yellow-dim' : 'border-apex-border'}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 className="min-w-0 font-display font-extrabold text-2xl uppercase leading-tight text-apex-text-bright break-words">{event.name}</h2>
        <span className="whitespace-nowrap font-mono text-xs px-2 py-0.5 border border-apex-border-bright text-apex-text">{STATE_TAG[event.state] ?? event.state}</span>
      </div>
      <span className="font-sans text-base text-apex-text">{parts.join(' · ')}</span>
      <Link to={to} className="self-start whitespace-nowrap font-sans font-bold text-base text-apex-yellow no-underline hover:underline">
        {draft && canManage ? 'Dokończ konfigurację →' : 'Otwórz →'}
      </Link>
    </article>
  )
}

function NewEventForm({ club, onCancel }) {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function submit(e) {
    e.preventDefault()
    if (!name.trim()) {
      setError('Podaj nazwę wydarzenia.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const { eventId } = await createRegistrationEvent(club.id, name.trim())
      navigate(`/klub/${club.slug}/wydarzenia/${eventId}/podstawy`)
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return (
    <form data-testid="new-event" onSubmit={submit} className={`${cardClass} max-w-[640px]`}>
      <label htmlFor="new-event-name" className={fieldLabel}>Nazwa wydarzenia</label>
      <input id="new-event-name" className={fieldInput} value={name} autoFocus maxLength={120}
        onChange={(e) => setName(e.target.value)} />
      {error && <p className="text-apex-red font-sans text-sm">{error}</p>}
      <div className="flex flex-wrap gap-3">
        <button type="submit" disabled={busy} className={primaryBtnClass}>Utwórz</button>
        <button type="button" onClick={onCancel} className={btnGhost}>Anuluj</button>
      </div>
    </form>
  )
}

export default function Wydarzenia() {
  const { club, isOwner } = useKlub()
  const { ready, status, error, reload } = useOrganizerStatus(club.id)
  const [creating, setCreating] = useState(false)

  useSeo({ title: `Wydarzenia — ${club.name} — Leszy.run`, noindex: true })

  const step = status ? nextOrganizerStep(status) : null
  const canManage = step === 'wizard'
  // The list answers only once the club is on and the agreement accepted.
  const listable = !ready ? null : !!(status && organizerFeaturesShown(status) && status.agreementAccepted)
  const list = useClubRegistrationEvents(club.id, listable)
  const events = list.events

  return (
    <div data-testid="klub-wydarzenia" className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className={eyebrowClass}>Klub jako organizator</div>
          <h1 className="font-display font-extrabold text-2xl uppercase text-apex-text-bright">Wydarzenia klubu</h1>
        </div>
        {canManage && !creating && (
          <button type="button" onClick={() => setCreating(true)} className={primaryBtnClass}>+ Nowe wydarzenie</button>
        )}
      </div>

      {!ready && <p className="font-mono text-sm text-apex-muted animate-pulse">Ładowanie…</p>}
      {ready && error && <p className="text-apex-red font-sans text-xs">{error}</p>}
      {creating && <NewEventForm club={club} onCancel={() => setCreating(false)} />}
      {status && step === null && list.ready && !events.length && (
        <p data-testid="member-no-events" className="font-sans text-sm text-apex-text">Ten klub jeszcze nie organizuje żadnych wydarzeń.</p>
      )}
      {status && step !== null && !organizerFeaturesShown(status) && (
        <WaitlistCard club={club} status={status} canJoin={step === 'waitlist'} onJoined={reload} />
      )}
      {step === 'agreement' && <AgreementCard club={club} isOwner={isOwner} version={status.version} />}
      {list.error && <p className="text-apex-red font-sans text-xs">{list.error}</p>}
      {events.length > 0 && (
        <div data-testid="event-list" className="space-y-4">
          {events.map((e) => <EventCard key={e.eventId} club={club} event={e} canManage={canManage} />)}
        </div>
      )}
    </div>
  )
}
