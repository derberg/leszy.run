import { useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import useSeo from '../../../hooks/useSeo.js'
import { previewRegistrationEvent } from '../../../lib/organizer.js'
import { mergePending } from '../../../lib/eventPageModel.js'
import RegistrationEventPage from '../../zapisy/RegistrationEventPage.jsx'
import { ZapisView } from '../../zapisy/Zapis.jsx'
import { CourseView } from '../../zapisy/Trasa.jsx'
import { btnGhost } from '../settingsUi.js'
import { useKlub } from '../context.js'

// /klub/:slug/wydarzenia/:eventId/podglad — „Podgląd jako zawodnik” for club
// members (preview-registration-event; anyone else gets 404). The runner's
// own pages, drafts and staged changes included, with the form's submit
// disabled. The course and a competition's form stay on this address
// (?trasa, ?zapis=<categoryId>), so the preview never opens a public URL.

/** A draft before its registration window shows the window as open, so every competition can be opened. */
function previewNow(raw) {
  const now = Date.now()
  const opens = raw.opensAt ? Date.parse(raw.opensAt) : null
  const closes = raw.closesAt ? Date.parse(raw.closesAt) : null
  if (opens != null && now < opens && (closes == null || opens < closes)) return new Date(opens)
  return new Date(now)
}

export default function Podglad() {
  const { eventId } = useParams()
  const { club } = useKlub()
  const [params] = useSearchParams()
  const [load, setLoad] = useState({ ready: false, raw: null, notFound: false, error: null })
  const base = `/klub/${club.slug}/wydarzenia/${eventId}`

  useSeo({ title: `Podgląd — ${load.raw?.name ?? 'Wydarzenie'} — Leszy.run`, noindex: true })

  useEffect(() => {
    let live = true
    previewRegistrationEvent(eventId, true)
      .then(({ raw, pending }) => { if (live) setLoad({ ready: true, raw: pending ? mergePending(raw, pending) : raw, notFound: false, error: null }) })
      .catch((err) => { if (live) setLoad({ ready: true, raw: null, notFound: err.status === 404 || err.status === 403, error: err.message }) })
    return () => { live = false }
  }, [eventId])

  if (!load.ready) {
    return (
      <div className="space-y-4" aria-busy="true">
        <div className="h-10 w-full bg-apex-surface animate-pulse" />
        <div className="h-64 w-full bg-apex-surface animate-pulse" />
      </div>
    )
  }
  if (!load.raw) {
    return (
      <div data-testid="event-not-found" className="py-12 text-center space-y-3">
        <div className="font-mono text-5xl font-bold text-apex-yellow">404</div>
        <h1 className="font-display font-extrabold text-2xl uppercase text-apex-text-bright">Nie znaleziono wydarzenia</h1>
        <Link to={`/klub/${club.slug}/wydarzenia`} className={`${btnGhost} inline-block no-underline`}>Wydarzenia klubu</Link>
      </div>
    )
  }

  const raw = load.raw
  const zapis = params.get('zapis')
  const here = `${base}/podglad`
  return (
    <div data-testid="preview" className="space-y-4">
      <div className="flex flex-wrap justify-between items-center gap-3 border border-apex-cyan px-3.5 py-2.5">
        <span className="font-mono text-xs uppercase tracking-wide text-apex-cyan">Podgląd jako zawodnik · zapis wyłączony</span>
        <Link to={`${base}/publikacja`} className={`${btnGhost} no-underline inline-block`}>Wróć do edycji</Link>
      </div>
      {zapis ? (
        <div className="max-w-2xl mx-auto">
          <ZapisView raw={raw} categoryId={zapis} preview backTo={here} />
        </div>
      ) : params.has('trasa') ? (
        <div className="max-w-2xl mx-auto">
          <CourseView raw={raw} backTo={here} />
        </div>
      ) : (
        <RegistrationEventPage raw={raw} now={previewNow(raw)} preview
          links={{ course: `${here}?trasa`, form: (id) => `${here}?zapis=${id}` }} />
      )}
    </div>
  )
}
