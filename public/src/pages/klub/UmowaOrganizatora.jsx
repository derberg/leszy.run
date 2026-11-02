import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import useSeo from '../../hooks/useSeo.js'
import useOrganizerStatus from '../../hooks/useOrganizerStatus.js'
import { acceptOrganizerAgreement } from '../../lib/organizer.js'
import { organizerAgreement } from '../../legal/organizerAgreement.js'
import { agreementSections, draftNoteSegments } from '../../lib/agreementBlocks.js'
import { organizerFeaturesShown } from '../../lib/organizerGate.js'
import { actionBtnClass, primaryBtnClass } from '../profil/fields.jsx'
import { printDocument } from '../../lib/printDocument.js'
import { useKlub } from './context.js'

const eyebrowClass = 'font-mono text-[10px] tracking-widest uppercase text-apex-muted'

// The organizer agreement, readable by owner and admin; only the owner accepts.
// The body is plain text; agreementSections() finds its paragraphs and points.

function Text({ text }) {
  return draftNoteSegments(text).map((s, i) =>
    s.note
      ? <span key={i} className="block mt-1.5 border-l-2 border-apex-yellow-dim bg-apex-surface px-2 py-1 font-mono text-[11px] leading-snug text-apex-muted">{s.text}</span>
      : <span key={i}>{s.text}</span>,
  )
}

function Block({ block }) {
  if (block.kind === 'point' || block.kind === 'sub') {
    const sub = block.kind === 'sub'
    return (
      <div className={`flex gap-2 ${sub ? 'pl-7' : ''}`}>
        <span className={`shrink-0 font-mono text-xs leading-6 text-apex-muted ${sub ? 'w-5' : 'w-7'}`}>{block.marker}</span>
        <p className="min-w-0 flex-1"><Text text={block.text} /></p>
      </div>
    )
  }
  return <p className={block.kind === 'cont' ? 'pl-9' : ''}><Text text={block.text} /></p>
}

function Blocks({ blocks }) {
  return (
    <div className="space-y-2.5 font-sans text-[15px] leading-6 text-apex-text">
      {blocks.map((b, i) => <Block key={i} block={b} />)}
    </div>
  )
}

export function AgreementText({ body }) {
  const { preamble, sections } = agreementSections(body)
  return (
    <>
      {preamble.length > 0 && (
        <div className="border border-apex-border bg-apex-surface px-4 py-3">
          <Blocks blocks={preamble} />
        </div>
      )}
      {sections.map((s) => (
        <section key={s.number} className="space-y-3 border-t border-apex-border pt-5">
          <h2 className="font-display font-extrabold text-lg uppercase tracking-wide text-apex-text-bright">
            <span className="text-apex-yellow">{s.number}.</span> {s.title}
          </h2>
          <Blocks blocks={s.blocks} />
        </section>
      ))}
    </>
  )
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
    <article data-testid="organizer-agreement" data-print-doc className="space-y-6 max-w-3xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className={eyebrowClass}>Wersja <span className="normal-case">{organizerAgreement.version}</span></div>
          <h1 className="font-display font-extrabold text-2xl uppercase text-apex-text-bright">{organizerAgreement.title}</h1>
        </div>
        <button
          type="button"
          data-print-hide
          onClick={() => printDocument(`Umowa organizatora LESZY.RUN ${organizerAgreement.version}`)}
          className={`${actionBtnClass} whitespace-nowrap border-apex-border-bright text-apex-text-bright hover:border-apex-yellow hover:text-apex-yellow`}
        >
          Pobierz PDF
        </button>
      </div>
      <AgreementText body={organizerAgreement.body} />

      <div data-print-hide>
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
      </div>
    </article>
  )
}
