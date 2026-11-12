import { useId, useState } from 'react'
import { formatPln } from '@registration/money.js'
import { callFunction } from '../../../../lib/auth.js'
import { btnPrimary } from '../../settingsUi.js'
import EntryDialog, { FieldMessage, dialogInput, dialogLabel } from './EntryDialog.jsx'

// „Opłacone poza systemem” and „Notatka o wpłacie” (B3): organizer-entry-action mark_paid_offline and
// offline_note. Marking confirms the whole order at its frozen total, as an online payment would, so
// with more than one person in it the dialog names every one; a team's order is the whole team. The
// note is required, the club's own (who took the money, when), and never reaches the runner.

const NOTE_MAX = 300

/**
 * @param {{ row: object, team: object|null, orderRows: object[], edit?: boolean, onClose: () => void,
 *   onDone: (notice: object) => void, onFailed: () => void }} props
 *   `orderRows`: the unpaid rows of the row's order, the row itself included. `edit`: change the note
 *   of an order already marked.
 */
export default function OfflinePaymentDialog({ row, team, orderRows = [row], edit = false, onClose, onDone, onFailed }) {
  const id = useId()
  const [note, setNote] = useState(edit ? (row.offlineNote ?? '') : '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [fieldError, setFieldError] = useState(null)
  const group = !team && !edit && orderRows.length > 1 ? orderRows : null
  const subtitle = team ? `${team.name} · ${team.size} os.` : group ? null : `${row.name} · ${row.competition}`
  const trimmed = note.trim()

  async function save() {
    setBusy(true)
    setError(null)
    setFieldError(null)
    try {
      const action = edit ? 'offline_note' : 'mark_paid_offline'
      await callFunction('organizer-entry-action', { action, registrationId: row.id, note: trimmed })
      const who = team ? team.name : group ? group.map((r) => r.name).join(', ') : row.name
      onDone({ text: edit ? `Notatka zapisana — ${who}.` : `Opłacone poza systemem — ${who}.` })
    } catch (err) {
      if (err.status == null) setError('Brak połączenia.')
      else if (err.fields?.note) setFieldError(err.fields.note)
      else setError(err.message)
      setBusy(false)
      onFailed()
    }
  }

  return (
    <EntryDialog testId="offline-dialog" title={edit ? 'Notatka o wpłacie' : 'Opłacone poza systemem'} subtitle={subtitle}
      busy={busy} onClose={onClose} error={error}
      actions={(
        <button type="button" className={btnPrimary} disabled={busy || !trimmed || trimmed.length > NOTE_MAX} onClick={save}>
          {edit ? 'Zapisz' : 'Oznacz jako opłacone'}
        </button>
      )}>
      {group && (
        <ul className="flex flex-col border-t border-apex-border" data-testid="offline-people">
          {group.map((r) => (
            <li key={r.id} className="py-2 border-b border-apex-border font-sans text-base text-apex-text-bright break-words">
              {r.name} · {r.competition}
            </li>
          ))}
        </ul>
      )}
      {!edit && row.orderTotal > 0 && (
        <p className="font-mono text-sm text-apex-text-bright" data-testid="offline-total">RAZEM · {formatPln(row.orderTotal)}</p>
      )}
      <div className="min-w-0">
        <label htmlFor={id} className={dialogLabel}>Notatka</label>
        <textarea id={id} rows={3} value={note} maxLength={NOTE_MAX} disabled={busy} onChange={(e) => setNote(e.target.value)}
          placeholder="np. gotówka w biurze zawodów, przyjęła Ania"
          aria-invalid={fieldError ? 'true' : undefined} aria-describedby={fieldError ? `${id}-err` : undefined}
          className={`${dialogInput} resize-y ${fieldError ? 'border-apex-red' : ''}`} />
        <FieldMessage id={`${id}-err`} message={fieldError} />
      </div>
    </EntryDialog>
  )
}
