import { useState } from 'react'
import { Link } from 'react-router-dom'
import { btnGhost, btnPrimary } from '../settingsUi.js'
import { changesSummary } from '../../../lib/pendingChanges.js'

// A8: the bar under a published event while changes are staged.
// „Niezapisane zmiany: N · …” · Odrzuć (asks first) / Podgląd / Opublikuj zmiany.

export default function PendingChangesBar({ diff, previewHref, busy, onDiscard, onPublish }) {
  const [confirming, setConfirming] = useState(false)

  return (
    <div data-testid="pending-bar" className="sticky bottom-0 z-20 -mx-4 md:mx-0 border-t border-apex-cyan bg-apex-surface-2 px-4 md:px-5 py-3.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 basis-full sm:basis-auto sm:flex-1 truncate sm:whitespace-normal font-sans text-[17px] text-apex-text-bright"
          title={changesSummary(diff)}>
          Niezapisane zmiany: <span className="font-mono text-apex-cyan">{diff.length}</span>
          {diff.length > 0 && <span className="text-apex-muted"> · {changesSummary(diff)}</span>}
        </p>
        {confirming ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-sans text-sm text-apex-text-bright">Odrzucić wszystkie zmiany?</span>
            <button type="button" className={btnGhost} disabled={busy} onClick={() => setConfirming(false)}>Anuluj</button>
            <button type="button" className={`${btnGhost} !border-apex-red !text-apex-red`} disabled={busy}
              onClick={async () => { await onDiscard(); setConfirming(false) }}>
              Tak, odrzuć
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <button type="button" className={btnGhost} disabled={busy} onClick={() => setConfirming(true)}>Odrzuć</button>
            <Link to={previewHref} className={`${btnGhost} no-underline inline-block`}>Podgląd</Link>
            <button type="button" className={btnPrimary} disabled={busy} onClick={onPublish}>Opublikuj zmiany</button>
          </div>
        )}
      </div>
    </div>
  )
}
