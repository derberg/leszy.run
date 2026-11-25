import { useState } from 'react'
import { Link } from 'react-router-dom'
import { acceptOrganizerAgreement } from '../../lib/organizer.js'
import { agreementUpdated } from '../../lib/organizerGate.js'
import { primaryBtnClass } from '../profil/fields.jsx'

// The club accepted an older version of the organizer agreement. A new version is an update the
// club is told about by e-mail (§13 ust. 6), never a re-acceptance, so nothing is blocked: this
// strip only says so. „Rozumiem” (owner only) records the acknowledgement through the ordinary
// accept-organizer-agreement call, which stores the current version; an admin sees the strip only.
// `showChanges` lists what changed (the agreement page); elsewhere the strip links there.
export default function AgreementUpdateBanner({ club, status, isOwner, onAcknowledged, showChanges = false }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  if (!agreementUpdated(status)) return null
  const version = status.currentVersion ?? status.version
  const changes = status.agreementChanges ?? []

  async function acknowledge() {
    setBusy(true)
    setError(null)
    try {
      await acceptOrganizerAgreement(club.id, version)
      await onAcknowledged?.()
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return (
    <section data-testid="agreement-updated" data-print-hide
      className="border border-apex-border border-l-2 border-l-apex-yellow bg-apex-surface px-4 py-3 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="min-w-0 font-sans text-sm text-apex-text">
          Zaktualizowaliśmy umowę organizatora (wersja <span className="whitespace-nowrap">{version}</span>)
          {showChanges ? '.' : (
            <>
              {' — '}
              <Link to={`/klub/${club.slug}/wydarzenia/umowa`} className="whitespace-nowrap font-bold text-apex-yellow hover:underline">
                zobacz zmiany
              </Link>
            </>
          )}
        </p>
        {isOwner && (
          <button type="button" onClick={acknowledge} disabled={busy} className={primaryBtnClass}>Rozumiem</button>
        )}
      </div>
      {showChanges && changes.length > 0 && (
        <ul data-testid="agreement-changes" className="list-disc pl-5 space-y-1 font-sans text-sm text-apex-text">
          {changes.map((c) => <li key={c}>{c}</li>)}
        </ul>
      )}
      {showChanges && (
        <p className="font-sans text-xs text-apex-muted">
          Nowa wersja obowiązuje bez ponownej akceptacji. Jeśli nie akceptujesz zmian, napisz do{' '}
          <a href="mailto:lukasz@leszy.run" className="text-apex-text-bright underline">lukasz@leszy.run</a> w ciągu 7 dni od e-maila.
        </p>
      )}
      {error && <p className="text-apex-red font-sans text-xs">{error}</p>}
    </section>
  )
}
