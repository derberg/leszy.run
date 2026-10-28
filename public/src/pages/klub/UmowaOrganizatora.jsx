import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import useSeo from '../../hooks/useSeo.js'
import useOrganizerStatus from '../../hooks/useOrganizerStatus.js'
import { acceptOrganizerAgreement } from '../../lib/organizer.js'
import { organizerAgreement } from '../../legal/organizerAgreement.js'
import { organizerFeaturesShown } from '../../lib/organizerGate.js'
import { primaryBtnClass } from '../profil/fields.jsx'
import { useKlub } from './context.js'

const eyebrowClass = 'font-mono text-[10px] tracking-widest uppercase text-apex-muted'

// The organizer agreement, readable by owner and admin; only the owner accepts.
// The body is plain text: paragraphs separated by a blank line.
function paragraphs(body) {
  return (body || '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
}

export default function UmowaOrganizatora() {
  const { club, canManage, isOwner } = useKlub()
  const navigate = useNavigate()
  const { ready, status, error } = useOrganizerStatus(club.id)
  const [busy, setBusy] = useState(false)
  const [acceptError, setAcceptError] = useState(null)

  useSeo({ title: `Umowa organizatora — ${club.name} — Leszy.run`, noindex: true })

  const back = `/klub/${club.slug}/wydarzenia`
  if (!canManage) return <Navigate to={back} replace />
  // The agreement exists only for a club with online registration switched on:
  // nothing of it renders until organizer-status says so.
  if (ready && status && !organizerFeaturesShown(status)) return <Navigate to={back} replace />
  if (!ready) return <p className="font-mono text-sm text-apex-muted animate-pulse">Ładowanie…</p>
  if (!status) return <p className="text-apex-red font-sans text-xs">{error}</p>

  async function accept() {
    setBusy(true)
    setAcceptError(null)
    try {
      await acceptOrganizerAgreement(club.id, organizerAgreement.version)
      navigate(back)
    } catch (err) {
      setAcceptError(err.message)
      setBusy(false)
    }
  }

  return (
    <article data-testid="organizer-agreement" className="space-y-4 max-w-3xl">
      <div>
        <div className={eyebrowClass}>Wersja <span className="normal-case">{organizerAgreement.version}</span></div>
        <h1 className="font-display font-extrabold text-2xl uppercase text-apex-text-bright">{organizerAgreement.title}</h1>
      </div>
      <div className="space-y-3">
        {paragraphs(organizerAgreement.body).map((p, i) => (
          <p key={i} className="font-sans text-sm text-apex-text whitespace-pre-line">{p}</p>
        ))}
      </div>

      {status.agreementAccepted ? (
        <p data-testid="agreement-accepted" className="font-sans text-sm font-semibold text-apex-yellow">Umowa zaakceptowana</p>
      ) : !isOwner ? (
        <p className="font-sans text-sm text-apex-text">Umowę akceptuje właściciel klubu</p>
      ) : (
        <div>
          <button type="button" onClick={accept} disabled={busy} className={primaryBtnClass}>Akceptuję umowę</button>
          {acceptError && <p className="text-apex-red font-sans text-xs mt-1.5">{acceptError}</p>}
        </div>
      )}
    </article>
  )
}
