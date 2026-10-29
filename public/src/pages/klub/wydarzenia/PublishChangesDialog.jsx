import { useEffect, useId, useRef, useState } from 'react'
import { publishRegistrationChanges } from '../../../lib/organizer.js'
import { changeValue, defaultNotice, noticeTarget, peopleLabel } from '../../../lib/pendingChanges.js'
import { btnGhost, btnPrimary, fieldInput } from '../settingsUi.js'
import { FieldError, monoLabel } from './wizardUi.jsx'

// A8a: what „Opublikuj zmiany” changes (before → after) and the optional
// e-mail to the registrants concerned. The box starts unticked; the subject
// and body show only once it is ticked. Offered only when someone would get it.

export default function PublishChangesDialog({ eventId, eventName, competitions, preview, onCancel, onPublished }) {
  const titleId = useId()
  const { diff, affected, recipientCount } = preview
  const [send, setSend] = useState(false)
  const [notice, setNotice] = useState(() => defaultNotice(eventName, diff))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [fields, setFields] = useState({})
  const dialog = useRef(null)
  const offered = recipientCount > 0
  const target = noticeTarget(affected, competitions, eventName)

  useEffect(() => {
    dialog.current?.focus()
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onCancel() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [busy, onCancel])

  async function publish() {
    setBusy(true)
    setError(null)
    setFields({})
    const wanted = offered && send
    try {
      const result = await publishRegistrationChanges(eventId, wanted ? { send: true, ...notice } : { send: false })
      await onPublished(result, wanted)
    } catch (err) {
      if (err.fields) setFields(err.fields)
      setError(err.message)
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-apex-bg/90 px-4 py-10 sm:py-16">
      <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId}
        className="mx-auto w-full max-w-[640px] border border-apex-border-bright bg-apex-surface p-5 sm:p-6 flex flex-col gap-4 outline-none">
        <h2 id={titleId} className="font-display font-extrabold text-[28px] sm:text-[32px] uppercase leading-none text-apex-text-bright">
          Opublikować zmiany?
        </h2>

        <div>
          {diff.map((d, i) => (
            <div key={`${d.field}:${d.categoryId ?? ''}:${i}`} data-testid="change-row"
              className="flex flex-wrap justify-between gap-x-3 gap-y-1 py-2.5 border-b border-apex-border text-[17px]">
              <span className="text-apex-text-bright min-w-0">{d.label}</span>
              <span className="font-mono text-sm min-w-0 text-right break-words">
                <span data-testid="change-before" className="text-apex-muted line-through">{changeValue(d, d.before)}</span>
                <span className="text-apex-text"> → </span>
                <span data-testid="change-after" className="text-apex-cyan">{changeValue(d, d.after)}</span>
              </span>
            </div>
          ))}
        </div>

        {offered && (
          <div className="border border-apex-border-mid p-3.5 flex flex-col gap-3">
            <label className="flex gap-2.5 items-start text-[17px] text-apex-text-bright leading-snug cursor-pointer">
              <input type="checkbox" checked={send} onChange={(e) => setSend(e.target.checked)}
                className="accent-apex-yellow w-[18px] h-[18px] mt-0.5 flex-none" />
              <span>Powiadom mailem zapisanych na {target} <span className="font-mono text-apex-yellow uppercase">· {peopleLabel(recipientCount)}</span></span>
            </label>
            {send && (
              <>
                <div>
                  <label htmlFor={`${titleId}-subject`} className={monoLabel}>Temat</label>
                  <input id={`${titleId}-subject`} className={`${fieldInput} mt-1.5`} value={notice.subject} maxLength={200}
                    onChange={(e) => setNotice({ ...notice, subject: e.target.value })} />
                  <FieldError message={fields.subject} />
                </div>
                <div>
                  <label htmlFor={`${titleId}-body`} className={monoLabel}>Treść</label>
                  <textarea id={`${titleId}-body`} rows={7} className={`${fieldInput} mt-1.5 resize-y`} value={notice.body} maxLength={5000}
                    onChange={(e) => setNotice({ ...notice, body: e.target.value })} />
                  <FieldError message={fields.body} />
                </div>
              </>
            )}
          </div>
        )}

        {error && !Object.keys(fields).length && <p role="alert" className="text-apex-red font-sans text-sm">{error}</p>}

        <div className="flex flex-wrap justify-end gap-2.5">
          <button type="button" className={btnGhost} disabled={busy} onClick={onCancel}>Anuluj</button>
          <button type="button" className={btnPrimary} disabled={busy} onClick={publish}>
            {busy ? 'Publikowanie…' : offered && send ? 'Opublikuj i wyślij' : 'Opublikuj'}
          </button>
        </div>
      </div>
    </div>
  )
}
