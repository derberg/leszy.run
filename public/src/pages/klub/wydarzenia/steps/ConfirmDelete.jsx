import { useEffect, useId, useRef } from 'react'
import { btnDanger, btnGhost } from '../../settingsUi.js'

/**
 * Asks before a delete, as the panel asks before „Podpisany w biurze”: a deleted code or partner is
 * gone (9b M-2). „Nie” holds the focus; Escape answers „Nie” unless the delete is running.
 */
export default function ConfirmDelete({ question, busy, onYes, onNo }) {
  const titleId = useId()
  const no = useRef(null)
  useEffect(() => { no.current?.focus() }, [])
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onNo() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [busy, onNo])
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 px-4">
      <div role="alertdialog" aria-modal="true" aria-labelledby={titleId} data-testid="confirm-delete"
        className="w-full max-w-[420px] border border-apex-border-bright bg-apex-surface p-5 flex flex-col gap-4">
        <p id={titleId} className="font-sans font-semibold text-base text-apex-text-bright break-words">{question}</p>
        <div className="flex gap-2 justify-end">
          <button type="button" ref={no} className={btnGhost} disabled={busy} onClick={onNo}>Nie</button>
          <button type="button" className={btnDanger} disabled={busy} onClick={onYes}>Usuń</button>
        </div>
      </div>
    </div>
  )
}
