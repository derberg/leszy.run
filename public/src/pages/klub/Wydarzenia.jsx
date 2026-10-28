import { useState } from 'react'
import { Link } from 'react-router-dom'
import useSeo from '../../hooks/useSeo.js'
import useOrganizerStatus from '../../hooks/useOrganizerStatus.js'
import { joinRegistrationWaitlist } from '../../lib/organizer.js'
import { nextOrganizerStep } from '../../lib/organizerGate.js'
import { primaryBtnClass } from '../profil/fields.jsx'
import { useKlub } from './context.js'

const cardClass = 'border border-apex-border bg-apex-surface p-5 space-y-3'
const eyebrowClass = 'font-mono text-[10px] tracking-widest uppercase text-apex-muted'

// Club as organizer (mockup A1). The tab is there for every active member;
// what it offers follows nextOrganizerStep(). The event list and the wizard
// arrive in Plan 2, so "+ Nowe wydarzenie" is shown disabled for now.

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

export default function Wydarzenia() {
  const { club, isOwner } = useKlub()
  const { ready, status, error, reload } = useOrganizerStatus(club.id)

  useSeo({ title: `Wydarzenia — ${club.name} — Leszy.run`, noindex: true })

  const step = status ? nextOrganizerStep(status) : null

  return (
    <div data-testid="klub-wydarzenia" className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className={eyebrowClass}>Klub jako organizator</div>
          <h1 className="font-display font-extrabold text-2xl uppercase text-apex-text-bright">Wydarzenia klubu</h1>
        </div>
        {step === 'wizard' && (
          <button type="button" disabled className={primaryBtnClass}>
            + Nowe wydarzenie <span className="ml-1 font-mono normal-case tracking-normal text-[10px]">wkrótce</span>
          </button>
        )}
      </div>

      {!ready && <p className="font-mono text-sm text-apex-muted animate-pulse">Ładowanie…</p>}
      {ready && error && <p className="text-apex-red font-sans text-xs">{error}</p>}
      {status && !status.enabled && (
        <WaitlistCard club={club} status={status} canJoin={step === 'waitlist'} onJoined={reload} />
      )}
      {step === 'agreement' && <AgreementCard club={club} isOwner={isOwner} version={status.version} />}
    </div>
  )
}
